// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reviewChanges, reviewMarkdown } from "../src/review.js";
import { createMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", root, ...args], { encoding: "utf8", windowsHide: true });
const block = (input = "Bool", value = "TRUE") => `FUNCTION_BLOCK "FB_Batch"\nVAR_INPUT\n  Enable : ${input};\nEND_VAR\nBEGIN\nREGION Fill\n  "Mix_DB".Valve := ${value};\nEND_REGION\nREGION Drain\n  ;\nEND_REGION\nEND_FUNCTION_BLOCK\n`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rung-review-"));
  const dir = join(root, "plc", "MixingStation", "blocks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "rung.toml"), "");
  writeFileSync(join(dir, "FB_Batch.scl"), block());
  writeFileSync(join(dir, "Batch_DB.db"), 'DATA_BLOCK "Batch_DB"\n"FB_Batch"\nBEGIN\nEND_DATA_BLOCK\n');
  writeFileSync(join(dir, "Mix_DB.db"), 'DATA_BLOCK "Mix_DB"\nVAR\n Valve : Bool;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n');
  writeFileSync(join(dir, "Main.scl"), 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "Batch_DB"(Enable := TRUE);\nEND_ORGANIZATION_BLOCK\n');
  git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "fixture base");
  return { root, dir };
}

describe("offline change review", () => {
  it("reports interfaces, only the changed region, callers and data blocks without changing files", async () => {
    const { root, dir } = fixture();
    writeFileSync(join(dir, "FB_Batch.scl"), block("Int", "FALSE"));
    const before = git(root, "status", "--porcelain");
    const report = await reviewChanges(root);
    expect(report.blocks).toHaveLength(1);
    const b = report.blocks[0]!;
    expect(b).toMatchObject({ name: "FB_Batch", kind: "FB", change: "modified" });
    expect(b.interfaceChanges).toContainEqual(expect.objectContaining({ name: "Enable", kind: "retyped", after: "Int" }));
    expect(b.logic.filter((r) => r.kind === "region").map((r) => r.name)).toEqual(["Fill"]);
    expect(b.affected.callers).toContain("plc/MixingStation/blocks/Main.scl");
    expect(b.affected.dataBlocks).toEqual(expect.arrayContaining(["plc/MixingStation/blocks/Batch_DB.db", "plc/MixingStation/blocks/Mix_DB.db"]));
    expect(b.namesMatched).toContain("Enable");
    const md = reviewMarkdown(report);
    expect(md).toContain("FB\\_Batch"); expect(md).toContain("Fill"); expect(md).toContain("not run");
    expect(git(root, "status", "--porcelain")).toBe(before);
  });

  it("compares a committed range instead of accidentally including the working tree", async () => {
    const { root, dir } = fixture();
    writeFileSync(join(dir, "FB_Batch.scl"), block("Bool", "FALSE"));
    git(root, "add", "."); git(root, "commit", "-qm", "fixture change");
    writeFileSync(join(dir, "FB_Batch.scl"), block("Real", "TRUE"));
    const report = await reviewChanges(root, { base: "HEAD~1..HEAD" });
    expect(report.blocks[0]!.interfaceChanges).toEqual([]);
    expect(report.blocks[0]!.logic.map((r) => r.name)).toEqual(["Fill"]);
  });

  it("keeps removed objects' callers and includes untracked and renamed sources", async () => {
    const { root, dir } = fixture();
    unlinkSync(join(dir, "FB_Batch.scl"));
    renameSync(join(dir, "Mix_DB.db"), join(dir, "Mixing_DB.db"));
    writeFileSync(join(dir, "New.scl"), 'FUNCTION "New" : Void\nBEGIN\nEND_FUNCTION\n');
    const report = await reviewChanges(root);
    expect(report.blocks.find((b) => b.name === "FB_Batch")).toMatchObject({ change: "deleted", affected: { callers: ["plc/MixingStation/blocks/Main.scl"] } });
    expect(report.blocks.find((b) => b.path.endsWith("New.scl"))?.change).toBe("added");
    expect(report.blocks.some((b) => b.path.endsWith("Mix_DB.db") && b.change === "deleted")).toBe(true);
    expect(report.blocks.some((b) => b.path.endsWith("Mixing_DB.db") && b.change === "added")).toBe(true);
  });

  it("rejects bad revisions and reports an unchanged tree with no changes", async () => {
    const { root } = fixture();
    expect((await reviewChanges(root)).blocks).toEqual([]);
    await expect(reviewChanges(root, { base: "--output=oops" })).rejects.toThrow(/revision/);
    await expect(reviewChanges(root, { base: "missing" })).rejects.toThrow(/revision/);
  });

  it("keeps PLC identities separate and reports global DB layouts", async () => {
    const { root, dir } = fixture();
    const other = join(root, "plc", "OtherPLC", "blocks"); mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "FB_Batch.scl"), block());
    writeFileSync(join(other, "Main.scl"), 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "FB_Batch"();\nEND_ORGANIZATION_BLOCK\n');
    git(root, "add", "."); git(root, "commit", "-qm", "second PLC fixture");
    writeFileSync(join(dir, "FB_Batch.scl"), block("Int"));
    writeFileSync(join(dir, "Mix_DB.db"), 'DATA_BLOCK "Mix_DB"\nVAR\n Valve : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n');
    const report = await reviewChanges(root);
    const fb = report.blocks.find((b) => b.name === "FB_Batch")!;
    expect(fb.affected.callers).toEqual(["plc/MixingStation/blocks/Main.scl"]);
    const db = report.blocks.find((b) => b.name === "Mix_DB")!;
    expect(db.interfaceChanges).toContainEqual(expect.objectContaining({ name: "Valve", kind: "retyped", after: "Int" }));
    expect(db.reinitializesData).toBe(true);
  });

  it("reports the changed LAD network with its title", async () => {
    const { root, dir } = fixture();
    const network = (value: string) => `<SW.Blocks.CompileUnit ID="1" CompositionName="CompileUnits"><AttributeList><NetworkSource><StructuredText><Token Text="${value}" /></StructuredText></NetworkSource><ProgrammingLanguage>SCL</ProgrammingLanguage></AttributeList><ObjectList><MultilingualText CompositionName="Title"><ObjectList><MultilingualTextItem><AttributeList><Culture>en-US</Culture><Text>Fill valve</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText></ObjectList></SW.Blocks.CompileUnit>`;
    const xml = (value: string) => `<?xml version="1.0"?><Document><SW.Blocks.OB ID="0"><AttributeList><Name>Ladder</Name><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList>${network(value)}</ObjectList></SW.Blocks.OB></Document>`;
    writeFileSync(join(dir, "Ladder.xml"), xml("TRUE"));
    git(root, "add", "."); git(root, "commit", "-qm", "network fixture");
    writeFileSync(join(dir, "Ladder.xml"), xml("FALSE"));
    const report = await reviewChanges(root);
    expect(report.blocks[0]!.logic).toContainEqual(expect.objectContaining({ name: "Network 1: Fill valve", kind: "network" }));
  });

  it("reports DB member order and nested layout changes", async () => {
    const { root, dir } = fixture();
    const db = (vars: string) => `DATA_BLOCK "Mix_DB"\nVAR\n${vars}\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n`;
    writeFileSync(join(dir, "Mix_DB.db"), db(" First : Int;\n Second : Bool;\n Data : Struct\n Nested : Struct\n Value : Int;\n END_STRUCT;\n END_STRUCT;"));
    git(root, "add", "."); git(root, "commit", "-qm", "nested fixture");
    writeFileSync(join(dir, "Mix_DB.db"), db(" Second : Bool;\n First : Int;\n Data : Struct\n Nested : Struct\n Value : Real;\n END_STRUCT;\n END_STRUCT;"));
    const b = (await reviewChanges(root)).blocks[0]!;
    expect(b.interfaceChanges).toContainEqual(expect.objectContaining({ kind: "reordered" }));
    expect(b.interfaceChanges).toContainEqual(expect.objectContaining({ kind: "retyped", name: "Data" }));
    expect(b.reinitializesData).toBe(true);
  });

  it("targets each block in a multi-block source separately", async () => {
    const { root, dir } = fixture();
    const fc = (name: string, type: string) => `FUNCTION "${name}" : Void\nVAR_INPUT\n Speed : ${type};\nEND_VAR\nBEGIN\nEND_FUNCTION\n`;
    writeFileSync(join(dir, "Group.scl"), fc("A", "Int") + fc("B", "Bool"));
    git(root, "add", "."); git(root, "commit", "-qm", "group fixture");
    writeFileSync(join(dir, "Group.scl"), fc("A", "DInt") + fc("B", "Real"));
    const blocks = (await reviewChanges(root)).blocks;
    expect(blocks.find((b) => b.name === "A")!.interfaceChanges[0]!.after).toBe("DInt");
    expect(blocks.find((b) => b.name === "B")!.interfaceChanges[0]!.after).toBe("Real");
  });

  it("includes the source diff and readers when a tag table changes", async () => {
    const { root, dir } = fixture();
    const tags = join(root, "plc", "MixingStation", "tags"); mkdirSync(tags);
    const table = (address: string) => `VAR_GLOBAL\n Start AT ${address} : Bool;\nEND_VAR\n`;
    writeFileSync(join(tags, "Inputs.tags.st"), table("%I0.0"));
    writeFileSync(join(dir, "ReadTags.scl"), 'FUNCTION "ReadTags" : Bool\nBEGIN\n #ReadTags := "Start";\nEND_FUNCTION\n');
    git(root, "add", "."); git(root, "commit", "-qm", "tag fixture");
    writeFileSync(join(tags, "Inputs.tags.st"), table("%I1.0"));
    const b = (await reviewChanges(root)).blocks[0]!;
    expect(b.logic[0]!.diff).toContain("%I1.0");
    expect(b.affected.tags).toContain("MixingStation/Start");
    expect(b.affected.dependants).toContain("plc/MixingStation/blocks/ReadTags.scl");
  });

  it("exposes a read-only MCP report with independent block and detail pages", async () => {
    const { root, dir } = fixture();
    writeFileSync(join(dir, "FB_Batch.scl"), block("Bool", "FALSE").replace("REGION Drain\n  ;", "REGION Drain\n  #Enable := FALSE;"));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ root }); await server.connect(a);
    const client = new Client({ name: "review-test", version: "1" }); await client.connect(b);
    try {
      expect((await client.listTools()).tools.find((t) => t.name === "rung_review")!.annotations?.readOnlyHint).toBe(true);
      const result = await client.callTool({ name: "rung_review", arguments: { offset: 0, limit: 1, detailOffset: 1, detailLimit: 1 } });
      expect(result.isError).not.toBe(true);
      const data = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(data.blocks.items[0]).toMatchObject({ name: "FB_Batch", logic: { total: 2, items: [{ name: "Drain" }] } });
      expect(result.structuredContent).toBeTruthy();
    } finally { await client.close(); await server.close(); }
  });

  it("shows changed constants, start values and retention attributes in declaration diffs", async () => {
    const { root, dir } = fixture();
    const fb = (retain: string, value: number) => `FUNCTION_BLOCK "Limits"\nVAR ${retain}\n State : Int := ${value};\nEND_VAR\nVAR CONSTANT\n MaxLevel : Real := ${value}.0;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n`;
    writeFileSync(join(dir, "Limits.scl"), fb("NON_RETAIN", 80));
    git(root, "add", "."); git(root, "commit", "-qm", "declaration fixture");
    writeFileSync(join(dir, "Limits.scl"), fb("RETAIN", 90));
    const b = (await reviewChanges(root)).blocks[0]!;
    const declarations = b.logic.find((c) => c.name === "Declarations");
    expect(declarations?.diff).toContain("+ State : Int := 90;");
    expect(declarations?.diff).toContain("+ MaxLevel : Real := 90.0;");
    expect(declarations?.diff).toContain("+VAR RETAIN");
  });
});
