// SPDX-License-Identifier: BUSL-1.1
// A LAD block edited in two places at once, against a real TIA Portal: one person changes network 1 in the file,
// another changes network 3 in TIA Portal (a second Openness client). rung sync merges network by network, TIA
// Portal takes the result, and both changes are in the block and in the file.
//   RUNG_E2E=1 pnpm vitest run tests/e2e/lad-merge.e2e.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { main } from "../../packages/cli/src/main.js";
import { BridgeClient } from "../../packages/bridge-client/src/index.js";

const enabled = process.env.RUNG_E2E === "1";
const project = process.env.RUNG_PROJECT ?? join(homedir(), "rung-fixtures", "RungFixture", "RungFixture.ap20");
const repo = fileURLToPath(new URL("../..", import.meta.url));
const bridgeExe = join(repo, "bridge", "src", "Rung.Bridge.V20", "bin", "Release", "net48", "rung-bridge-v20.exe");
const address = "plc:PLC_1/blocks/Fx_LadMerge";

const text = (comp: string, id: string, s: string) =>
  `<MultilingualText ID="${id}" CompositionName="${comp}"><ObjectList><MultilingualTextItem ID="${id}1" CompositionName="Items"><AttributeList><Culture>en-US</Culture><Text>${s}</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText>`;
const net = (n: number, operand: string) => `
      <SW.Blocks.CompileUnit ID="${n}0" CompositionName="CompileUnits">
        <AttributeList>
          <NetworkSource><FlgNet xmlns="http://www.siemens.com/automation/Openness/SW/NetworkSource/FlgNet/v4">
  <Parts>
    <Access Scope="LocalVariable" UId="21"><Symbol><Component Name="${operand}" /></Symbol></Access>
    <Access Scope="LocalVariable" UId="22"><Symbol><Component Name="Out${n}" /></Symbol></Access>
    <Part Name="Contact" UId="24" />
    <Part Name="Coil" UId="26" />
  </Parts>
  <Wires>
    <Wire UId="27"><Powerrail /><NameCon UId="24" Name="in" /></Wire>
    <Wire UId="28"><IdentCon UId="21" /><NameCon UId="24" Name="operand" /></Wire>
    <Wire UId="29"><NameCon UId="24" Name="out" /><NameCon UId="26" Name="in" /></Wire>
    <Wire UId="30"><IdentCon UId="22" /><NameCon UId="26" Name="operand" /></Wire>
  </Wires>
</FlgNet></NetworkSource>
          <ProgrammingLanguage>LAD</ProgrammingLanguage>
        </AttributeList>
        <ObjectList>
          ${text("Comment", `${n}1`, `comment of network ${n}`)}
          ${text("Title", `${n}2`, `title of network ${n}`)}
        </ObjectList>
      </SW.Blocks.CompileUnit>`;
const block = `<?xml version="1.0" encoding="utf-8"?>
<Document>
  <Engineering version="V20" />
  <SW.Blocks.FC ID="0">
    <AttributeList>
      <Interface><Sections xmlns="http://www.siemens.com/automation/Openness/SW/Interface/v5">
  <Section Name="Input"><Member Name="A" Datatype="Bool" /><Member Name="B" Datatype="Bool" /><Member Name="C" Datatype="Bool" /></Section>
  <Section Name="Output"><Member Name="Out1" Datatype="Bool" /><Member Name="Out2" Datatype="Bool" /><Member Name="Out3" Datatype="Bool" /></Section>
  <Section Name="InOut" /><Section Name="Temp" /><Section Name="Constant" />
  <Section Name="Return"><Member Name="Ret_Val" Datatype="Void" /></Section>
</Sections></Interface>
      <MemoryLayout>Optimized</MemoryLayout>
      <Name>Fx_LadMerge</Name>
      <Namespace />
      <Number>12</Number>
      <ProgrammingLanguage>LAD</ProgrammingLanguage>
    </AttributeList>
    <ObjectList>
      ${text("Comment", "91", "block comment")}${net(1, "A")}${net(2, "B")}${net(3, "C")}
      ${text("Title", "92", "block title")}
    </ObjectList>
  </SW.Blocks.FC>
</Document>
`;

describe.runIf(enabled)("e2e: a LAD block changed in the file and in TIA Portal at once", () => {
  const dir = enabled ? mkdtempSync(join(tmpdir(), "rung-e2e-lad-")) : "";
  const out: string[] = [];
  const io = { cwd: dir, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s), env: process.env };
  const file = join(dir, "plc", "PLC_1", "blocks", "Fx_LadMerge.xml");
  let other: BridgeClient | undefined;
  const tiaText = async () => {
    const r = await other!.exportObject(address, "auto", mkdtempSync(join(tmpdir(), "rung-lad-tia-")));
    return { r, xml: readFileSync(r.files.find((f) => f.role === "primary")!.path, "utf8") };
  };

  afterAll(async () => {
    if (!other) return;
    const left = (await other.listObjects("PLC_1")).find((o) => o.address === address);
    if (left) await other.deleteObject(address, left.fingerprint, randomUUID()).catch(() => {});
    await other.close();
  });

  it("merges network 1 from the file and network 3 from TIA Portal, and TIA Portal takes the result", async () => {
    // the other person, in TIA Portal
    other = await BridgeClient.spawn({ command: bridgeExe, args: ["--project", project, "--allow-fixture-import"] });
    const left = (await other.listObjects("PLC_1")).find((o) => o.address === address);
    if (left) await other.deleteObject(address, left.fingerprint, randomUUID());
    const src = join(mkdtempSync(join(tmpdir(), "rung-lad-src-")), "obj.xml");
    writeFileSync(src, block);
    await other.importObject(address, "xml", src, "absent", randomUUID());

    expect(await main(["init", "--project", project], io)).toBe(0);
    expect([0, 2]).toContain(await main(["pull"], io));
    const pulled = readFileSync(file, "utf8");
    expect(pulled).toContain("title of network 3");

    // the file: network 1 reads B instead of A
    const units = pulled.split("<SW.Blocks.CompileUnit ");
    expect(units).toHaveLength(4);
    units[1] = units[1]!.replace('<Component Name="A" />', '<Component Name="B" />');
    writeFileSync(file, units.join("<SW.Blocks.CompileUnit "));
    // TIA Portal: network 3 gets another title
    const { r, xml } = await tiaText();
    const tiaFile = join(mkdtempSync(join(tmpdir(), "rung-lad-edit-")), "obj.xml");
    writeFileSync(tiaFile, xml.replace("title of network 3", "network 3, changed in TIA Portal"));
    await other.importObject(address, "xml", tiaFile, r.fingerprint, randomUUID());

    out.length = 0;
    expect([0, 2]).toContain(await main(["sync"], io));
    const report = out.join("");
    expect(report, report).toMatch(/merged 1/);
    expect(report).toMatch(/conflicts 0/);
    const mine = readFileSync(file, "utf8");
    const theirs = (await tiaText()).xml;
    for (const both of [mine, theirs]) {
      expect(both).toContain("network 3, changed in TIA Portal");
      expect(both.split("<SW.Blocks.CompileUnit ")[1]).toContain('<Component Name="B" />');
      expect(both).toContain("title of network 1");
    }
    out.length = 0;
    await main(["sync"], io);
    expect(out.join("")).toMatch(/exported 0\s+imported 0\s+created 0\s+merged 0/);
  }, 600_000);
});
