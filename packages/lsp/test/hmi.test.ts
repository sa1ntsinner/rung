// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { HmiIndex, hmiTagsOf, screenTagsOf } from "../src/hmi.js";

const table = `<Document><Hmi.Tag.TagTable><ObjectList>
<Hmi.Tag.Tag ID="A" CompositionName="Tags"><AttributeList><Length>1</Length><Name>M_AutoMode</Name></AttributeList>
<LinkList><Connection TargetID="@OpenLink"><Name>HMI_Connection_1</Name></Connection><ControllerTag TargetID="@OpenLink"><Name>M_AutoMode</Name></ControllerTag></LinkList></Hmi.Tag.Tag>
<Hmi.Tag.Tag ID="B" CompositionName="Tags"><AttributeList><Name>Speed_HMI</Name></AttributeList>
<LinkList><ControllerTag TargetID="@OpenLink"><Name>Line_DB.Speed</Name></ControllerTag></LinkList></Hmi.Tag.Tag>
<Hmi.Tag.Tag ID="C" CompositionName="Tags"><AttributeList><Name>Tag_ScreenNumber</Name></AttributeList><LinkList></LinkList></Hmi.Tag.Tag>
</ObjectList></Hmi.Tag.TagTable></Document>`;
const screen = `<Hmi.Screen.Property><LinkList><Tag TargetID="@OpenLink">
  <Name>M_AutoMode</Name></Tag></LinkList></Hmi.Screen.Property>`;

describe("HMI tags bound to the PLC", () => {
  it("reads which PLC tag or DB member each HMI tag is bound to, and skips internal ones", () => {
    expect(hmiTagsOf(table, "HMI_1", "Default tag table")).toEqual([
      { panel: "HMI_1", table: "Default tag table", tag: "M_AutoMode", plc: "M_AutoMode", connection: "HMI_Connection_1" },
      { panel: "HMI_1", table: "Default tag table", tag: "Speed_HMI", plc: "Line_DB.Speed" },
    ]);
    expect([...screenTagsOf(screen)]).toEqual(["M_AutoMode"]);
  });
  it("answers for a PLC name with the screens that show the HMI tag", () => {
    const index = new HmiIndex(hmiTagsOf(table, "HMI_1", "Default tag table"), [{ panel: "HMI_1", screen: "Main Overview", tags: screenTagsOf(screen) }]);
    expect(index.usesOf('"M_AutoMode"')).toMatchObject([{ tag: "M_AutoMode", screens: ["Main Overview"] }]);
    expect(index.usesOf('"Line_DB".Speed')).toMatchObject([{ tag: "Speed_HMI", screens: [] }]);
    expect(index.usesOf("Other")).toEqual([]);
  });
});
