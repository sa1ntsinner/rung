// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mergeText, mergeBundle } from "../src/index.js";

const base = "FUNCTION_BLOCK \"M\"\nBEGIN\n  #a := 1;\n  #b := 2;\n  #c := 3;\n  #d := 4;\nEND_FUNCTION_BLOCK\n";

describe("mergeText", () => {
  it("merges non-overlapping edits from both sides", () => {
    const file = base.replace("#a := 1;", "#a := 10;");
    const tia = base.replace("#d := 4;", "#d := 40;");
    const r = mergeText(base, file, tia);
    expect(r).toEqual({ kind: "clean", text: base.replace("#a := 1;", "#a := 10;").replace("#d := 4;", "#d := 40;") });
  });

  it("reports overlapping edits as a conflict with labelled markers", () => {
    const file = base.replace("#b := 2;", "#b := 20;");
    const tia = base.replace("#b := 2;", "#b := 200;");
    const r = mergeText(base, file, tia);
    expect(r.kind).toBe("conflict");
    if (r.kind !== "conflict") return;
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("<<<<<<< file\n  #b := 20;\n||||||| base\n  #b := 2;\n=======\n  #b := 200;\n>>>>>>> tia\n");
    expect(r.text.startsWith('FUNCTION_BLOCK "M"\nBEGIN\n  #a := 1;\n')).toBe(true);
  });

  it("accepts identical edits on both sides", () => {
    const both = base.replace("#c := 3;", "#c := 33;");
    expect(mergeText(base, both, both)).toEqual({ kind: "clean", text: both });
  });

  it("ignores CRLF and BOM differences", () => {
    const file = "﻿" + base.replace(/\n/g, "\r\n");
    expect(mergeText(base, file, base)).toEqual({ kind: "clean", text: base });
  });

  it("treats new-on-both-sides with different content as a conflict", () => {
    const r = mergeText(null, "A\n", "B\n");
    expect(r.kind).toBe("conflict");
  });

  it("accepts new-on-both-sides with identical content", () => {
    expect(mergeText(null, "A\n", "A\n")).toEqual({ kind: "clean", text: "A\n" });
  });

  it("keeps keyword casing and whitespace inside strings/comments as real changes", () => {
    const file = base.replace("#a := 1;", "#a := 1; // Kommentar");
    const tia = base.replace("#a := 1;", "#a := 1; // kommentar");
    expect(mergeText(base, file, tia).kind).toBe("conflict");
  });

  it("takes one side when only that side changed", () => {
    const tia = base.replace("#d := 4;", "#d := 5;");
    expect(mergeText(base, base, tia)).toEqual({ kind: "clean", text: tia });
    expect(mergeText(base, tia, base)).toEqual({ kind: "clean", text: tia });
  });
});

describe("mergeBundle", () => {
  const b = { primary: "x\n", ".s7res": "r\n" };
  it("merges source forms per file", () => {
    const r = mergeBundle("scl", { ".scl": base }, { ".scl": base.replace("#a := 1;", "#a := 9;") }, { ".scl": base.replace("#d := 4;", "#d := 8;") });
    expect(r.kind).toBe("clean");
  });
  it("conflicts conservatively on concurrent changes to SD/XML bundles", () => {
    const r = mergeBundle("s7dcl", b, { ...b, primary: "y\n" }, { ...b, ".s7res": "q\n" });
    expect(r.kind).toBe("conflict");
  });
  it("takes the only changed side of an SD bundle, including resource-only changes", () => {
    const r = mergeBundle("s7dcl", b, b, { ...b, ".s7res": "q\n" });
    expect(r).toEqual({ kind: "clean", files: { ...b, ".s7res": "q\n" } });
  });
});

// a LAD block as TIA Portal exports it: object IDs numbered in document order, one CompileUnit per network
function ladXml(nets: { operand: string; title: string }[], iface = "A") {
  let id = 0;
  const next = () => (id++).toString(16).toUpperCase();
  const text = (comp: string, s: string) =>
    `          <MultilingualText ID="${next()}" CompositionName="${comp}">\n            <ObjectList>\n              <MultilingualTextItem ID="${next()}" CompositionName="Items">\n                <AttributeList>\n                  <Culture>en-US</Culture>\n                  <Text>${s}</Text>\n                </AttributeList>\n              </MultilingualTextItem>\n            </ObjectList>\n          </MultilingualText>\n`;
  const root = next();
  const units = nets
    .map(
      (n) =>
        `      <SW.Blocks.CompileUnit ID="${next()}" CompositionName="CompileUnits">\n        <AttributeList>\n          <NetworkSource><FlgNet><Parts><Access Scope="LocalVariable" UId="21"><Symbol><Component Name="${n.operand}" /></Symbol></Access><Part Name="Contact" UId="22" /></Parts></FlgNet></NetworkSource>\n          <ProgrammingLanguage>LAD</ProgrammingLanguage>\n        </AttributeList>\n        <ObjectList>\n${text("Title", n.title)}        </ObjectList>\n      </SW.Blocks.CompileUnit>\n`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<Document>\n  <Engineering version="V20" />\n  <SW.Blocks.FC ID="${root}">\n    <AttributeList>\n      <Interface><Sections><Section Name="Input"><Member Name="${iface}" Datatype="Bool" /></Section></Sections></Interface>\n      <Name>Fx_L</Name>\n    </AttributeList>\n    <ObjectList>\n${units}    </ObjectList>\n  </SW.Blocks.FC>\n</Document>\n`;
}
const nets = (...ops: string[]) => ops.map((operand, i) => ({ operand, title: `network ${i + 1}` }));

describe("LAD and FBD blocks merge network by network", () => {
  it("changes to different networks both stay, with fresh object IDs", () => {
    const base = ladXml(nets("A", "B", "C"));
    const file = ladXml(nets("A1", "B", "C"));
    const tia = ladXml(nets("A", "B", "C3"));
    const r = mergeBundle("xml", { ".xml": base }, { ".xml": file }, { ".xml": tia });
    expect(r.kind).toBe("clean");
    expect(r.files[".xml"]).toBe(ladXml(nets("A1", "B", "C3")));
  });

  it("a network inserted on one side (every ID after it renumbered) and a change on the other merge", () => {
    const base = ladXml(nets("A", "B", "C"));
    const file = ladXml([{ operand: "N", title: "new first network" }, ...nets("A", "B", "C")]);
    const tia = ladXml(nets("A", "B", "C3"));
    const r = mergeBundle("xml", { ".xml": base }, { ".xml": file }, { ".xml": tia });
    expect(r.kind).toBe("clean");
    expect(r.files[".xml"]).toBe(ladXml([{ operand: "N", title: "new first network" }, ...nets("A", "B", "C3")]));
  });

  it("the same network changed on both sides is a conflict; so is the interface changed on both", () => {
    const base = ladXml(nets("A", "B"));
    expect(mergeBundle("xml", { ".xml": base }, { ".xml": ladXml(nets("A", "B1")) }, { ".xml": ladXml(nets("A", "B2")) }).kind).toBe("conflict");
    expect(mergeBundle("xml", { ".xml": base }, { ".xml": ladXml(nets("A", "B"), "X") }, { ".xml": ladXml(nets("A", "B"), "Y") }).kind).toBe("conflict");
    // an interface change on one side and a network change on the other merge
    expect(mergeBundle("xml", { ".xml": base }, { ".xml": ladXml(nets("A", "B"), "X") }, { ".xml": ladXml(nets("A2", "B")) })).toEqual({ kind: "clean", files: { ".xml": ladXml(nets("A2", "B"), "X") } });
  });

  it("SIMATIC SD text: networks as units; its texts file only when one side left it alone", () => {
    const net = (c: string) => `    {\n      S7_Language := "LAD"\n    }\n    NETWORK\n        RUNG wire#powerrail\n            Contact( #${c} )\n        END_RUNG\n    END_NETWORK\n\n`;
    const sd = (...cs: string[]) => `FUNCTION "Fx_S" : Void\n    VAR_INPUT\n        A : Bool;\n    END_VAR\n\n${cs.map(net).join("")}END_FUNCTION\n`;
    const r = mergeBundle("s7dcl", { ".s7dcl": sd("A", "B"), ".s7res": "<root />\n" }, { ".s7dcl": sd("A1", "B"), ".s7res": "<root />\n" }, { ".s7dcl": sd("A", "B2"), ".s7res": "<root />\n" });
    expect(r).toEqual({ kind: "clean", files: { ".s7dcl": sd("A1", "B2"), ".s7res": "<root />\n" } });
    const texts = mergeBundle("s7dcl", { ".s7dcl": sd("A", "B"), ".s7res": "<root />\n" }, { ".s7dcl": sd("A1", "B"), ".s7res": "<root a='1' />\n" }, { ".s7dcl": sd("A", "B2"), ".s7res": "<root a='2' />\n" });
    expect(texts.kind).toBe("conflict");
  });

  it("XML that is no block (a watch table) still conflicts", () => {
    const table = (x: string) => `<Document>\n  <SW.WatchAndForceTables.PlcWatchTable ID="0">\n    <AttributeList><Name>${x}</Name></AttributeList>\n  </SW.WatchAndForceTables.PlcWatchTable>\n</Document>\n`;
    expect(mergeBundle("xml", { ".xml": table("a") }, { ".xml": table("b") }, { ".xml": table("c") }).kind).toBe("conflict");
  });
});
