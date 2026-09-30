// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { blankIds, renumberIds, splitNetworks } from "../src/index.js";

describe("SimaticML object IDs", () => {
  const xml = [
    '<SW.Blocks.FC ID="0">',
    '  <MultilingualText ID="1" CompositionName="Title"><Text>asset ID="pump-007"</Text></MultilingualText>',
    "  <ConstantValue>'asset ID=\"x\"'</ConstantValue>",
    '  <Access Scope="LocalVariable" UId="21" />',
    '  <!-- <Old ID="9"> -->',
    '  <![CDATA[ <Raw ID="8"> ]]>',
    '  <Note Text="a > b" ID="2" />',
    "</SW.Blocks.FC>",
  ].join("\n");

  it("changes only the ID attributes of start tags: text, constants, UId, comments and CDATA stay", () => {
    const blank = blankIds(xml);
    expect(blank).toContain('<SW.Blocks.FC ID="*">');
    expect(blank).toContain('<MultilingualText ID="*" CompositionName="Title"><Text>asset ID="pump-007"</Text>');
    expect(blank).toContain("<ConstantValue>'asset ID=\"x\"'</ConstantValue>");
    expect(blank).toContain('UId="21"');
    expect(blank).toContain('<!-- <Old ID="9"> -->');
    expect(blank).toContain('<![CDATA[ <Raw ID="8"> ]]>');
    expect(blank).toContain('<Note Text="a > b" ID="*" />');
    expect(renumberIds(blank)).toBe(xml.replace('ID="1"', 'ID="1"').replace('<Note Text="a > b" ID="2" />', '<Note Text="a > b" ID="2" />'));
  });

  it('leaves ID="…" alone inside another attribute\'s value, in either quote style', () => {
    expect(renumberIds(`<X Note='asset ID="pump"' ID="9"/><Y ID='3' Title="ID='x'" />`)).toBe(`<X Note='asset ID="pump"' ID="0"/><Y ID='1' Title="ID='x'" />`);
  });

  it("numbers in hex as TIA Portal does", () => {
    const many = Array.from({ length: 12 }, () => '<X ID="*" />').join("");
    expect(renumberIds(many)).toContain('<X ID="9" /><X ID="A" /><X ID="B" />');
  });

  it("a watch table is no block with networks", () => {
    expect(splitNetworks('<SW.WatchAndForceTables.PlcWatchTable ID="0" />', "xml")).toBeUndefined();
  });
});
