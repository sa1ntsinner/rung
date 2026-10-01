// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { complete, documentHighlights, signatureHelp } from "../src/features.js";
import { WorkspaceIndex } from "../src/workspace.js";

const URI = "file:///w/plc/P/blocks/User.scl";
const FC = `FUNCTION "Convert" : Void
VAR_OUTPUT
   Out : Int;
END_VAR
VAR_IN_OUT
   State : Int;
END_VAR
VAR_INPUT
   In : Int;
END_VAR
BEGIN
END_FUNCTION
`;
const USER = `FUNCTION "User" : Void
VAR_TEMP
   x : Int;
   i : Int;
   a : Array[0..3] of Int;
END_VAR
BEGIN
   BODY
END_FUNCTION
`;

function setup(body: string) {
  const index = new WorkspaceIndex();
  index.set("file:///w/plc/P/blocks/Convert.scl", FC, 0);
  const offset = USER.indexOf("BODY") + body.indexOf("|");
  const text = USER.replace("BODY", body.replace("|", ""));
  index.set(URI, text, 0);
  return { index, text, offset };
}

describe("call completion", () => {
  it("includes every FC parameter with inputs first, keeps labels, and replaces the quoted prefix", () => {
    const { index, offset, text } = setup('"Con|');
    const plain = complete(index, URI, offset);
    const snippets = complete(index, URI, offset, true);
    expect(snippets.map((c) => c.label)).toEqual(plain.map((c) => c.label));
    const item = snippets.find((c) => c.label === "Convert")!;
    expect(item.insertText).toBe('"Convert"(In := ${1}, State := ${2}, Out => ${3})');
    expect(item.replaceStart).toBe(text.indexOf('"Con'));
    expect(plain.find((c) => c.label === "Convert")).toEqual({ label: "Convert", kind: "class", detail: "FC", insertText: 'Convert"' });
  });

  it("gives an instruction its call, but an FB type like TON none: it is called through an instance", () => {
    const { index, offset } = setup("LI|");
    const items = complete(index, URI, offset, true);
    expect(items.find((c) => c.label === "LIMIT")).toMatchObject({ insertText: "LIMIT(MN := ${1}, IN := ${2}, MX := ${3})", snippet: true });
    const ton = items.find((c) => c.label === "TON")!;
    expect(ton.snippet).toBeUndefined();
    expect(ton.insertText).toBeUndefined();
  });

  it("calls an instance where a statement starts, and leaves it a name inside an expression", () => {
    const index = new WorkspaceIndex();
    index.set("file:///w/plc/P/blocks/Motor.scl", 'FUNCTION_BLOCK "Motor"\nVAR_INPUT\n   Start : Bool;\nEND_VAR\nVAR_OUTPUT\n   Running : Bool;\nEND_VAR\nBEGIN\nEND_FUNCTION_BLOCK\n', 0);
    index.set("file:///w/plc/P/blocks/Motor_DB.db", 'DATA_BLOCK "Motor_DB"\n"Motor"\nBEGIN\nEND_DATA_BLOCK\n', 0);
    const at = (body: string) => {
      const text = 'FUNCTION_BLOCK "Line"\nVAR\n   m : "Motor";\n   t : TON;\n   x : Bool;\nEND_VAR\nBEGIN\n' + body.replace("|", "") + "\nEND_FUNCTION_BLOCK\n";
      const uri = "file:///w/plc/P/blocks/Line.scl";
      index.set(uri, text, 0);
      return complete(index, uri, text.indexOf("BEGIN\n") + 6 + body.indexOf("|"), true);
    };
    expect(at("   #|").find((c) => c.label === "m")?.insertText).toBe("#m(Start := ${1}, Running => ${2})");
    expect(at("   #x := TRUE; #|").find((c) => c.label === "t")?.insertText).toBe("#t(IN := ${1}, PT := ${2}, Q => ${3}, ET => ${4})");
    expect(at('   "Motor|').find((c) => c.label === "Motor_DB")?.insertText).toBe('"Motor_DB"(Start := ${1}, Running => ${2})');
    expect(at("   IF #x THEN #|").find((c) => c.label === "m")?.snippet).toBe(true);
    expect(at("   IF #x THEN_ #|").find((c) => c.label === "m")?.snippet).toBeUndefined();
    // reading a member: the name only
    expect(at("   IF #|").find((c) => c.label === "m")).toMatchObject({ label: "m" });
    expect(at("   IF #|").find((c) => c.label === "m")?.snippet).toBeUndefined();
    expect(at('   #x := "Motor|').find((c) => c.label === "Motor_DB")?.snippet).toBeUndefined();
  });

  it("leaves completion in declarations alone even with snippet support", () => {
    const { index } = setup(";");
    const text = USER.replace("x : Int;", "x : TO").replace("BODY", ";");
    index.set(URI, text, 1);
    const offset = text.indexOf("x : TO") + "x : TO".length;
    expect(complete(index, URI, offset, true)).toEqual(complete(index, URI, offset));
  });

  it("resolves templates and signatures in the caller's PLC", () => {
    const { index, offset } = setup('"Con|');
    index.set("file:///w/plc/Other/blocks/Convert.scl", FC.replace("In : Int", "Other : Bool"), 0);
    expect(complete(index, URI, offset, true).find((c) => c.label === "Convert")?.insertText).toBe('"Convert"(In := ${1}, State := ${2}, Out => ${3})');
    const text = USER.replace("BODY", '"Convert"(In := 1);');
    index.set(URI, text, 1);
    expect(signatureHelp(index, URI, text.indexOf("In :=") + 6)?.signatures[0]?.label).toBe('"Convert"(In : Int, State : Int, Out => Int)');
  });
});

describe("document highlights", () => {
  it("uses the declaration resolver when requested on an FC local declaration", () => {
    const { index, text } = setup("#x := #x + 1;");
    expect(documentHighlights(index, URI, text.indexOf("x : Int"))).toEqual([
      { uri: URI, start: text.indexOf("#x"), end: text.indexOf("#x") + 2, kind: "write" },
      { uri: URI, start: text.lastIndexOf("#x"), end: text.lastIndexOf("#x") + 2, kind: "read" },
    ]);
  });

  it("marks an InOut destination as written while reading its array index", () => {
    const { index, text, offset } = setup('"Convert"(In := #x, State := #a|[#i], Out => #x);');
    expect(documentHighlights(index, URI, offset).map((h) => h.kind)).toEqual(["write"]);
    expect(documentHighlights(index, URI, text.indexOf("#i") + 1).map((h) => h.kind)).toEqual(["read"]);
    expect(documentHighlights(index, URI, text.indexOf("#x") + 1).map((h) => h.kind)).toEqual(["read", "write"]);
  });

  it("resolves tag and member uses and excludes matching uses in another file", () => {
    const { index, text, offset } = setup('"Level" := "Level" + 1;\n   "Data".Count := "Data".Cou|nt + 1;');
    index.set("file:///w/plc/P/tags/IO.tags.st", "VAR_GLOBAL\nLevel AT %MW10 : Int;\nEND_VAR\n", 0);
    index.set("file:///w/plc/P/blocks/Data.db", 'DATA_BLOCK "Data"\nVAR\nCount : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
    index.set("file:///w/plc/P/blocks/Other.scl", USER.replace('"User"', '"Other"').replace("BODY", '"Level" := "Data".Count;'), 0);
    const tags = documentHighlights(index, URI, text.indexOf('"Level"') + 2);
    expect(tags.map((h) => [h.uri, h.kind])).toEqual([[URI, "write"], [URI, "read"]]);
    expect(documentHighlights(index, URI, offset).map((h) => [h.uri, h.kind])).toEqual([[URI, "write"], [URI, "read"]]);
  });

  it("does not confuse identical local names in different blocks", () => {
    const { index, text } = setup("#x := #x + 1;");
    index.set(URI, text + text.replace('"User"', '"Other"'), 1);
    expect(documentHighlights(index, URI, text.indexOf("#x") + 1)).toHaveLength(2);
  });
});
