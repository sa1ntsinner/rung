// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, semanticTokens } from "../src/index.js";

const FB = `FUNCTION_BLOCK "Fb_Pump"
VAR_INPUT
  start : Bool;
END_VAR
VAR_OUTPUT
  running : Bool;
END_VAR
VAR
  timer : TON;
  data : "Ud_Pump";
END_VAR
VAR_TEMP
  t : Int;
END_VAR
VAR CONSTANT
  LIMIT_MS : Int := 500;
END_VAR
BEGIN
  #timer(IN := #start, PT := T#1s);
  #t := LIMIT(MN := 0, IN := #data.speed, MX := #LIMIT_MS);
  #running := #timer.Q AND "Plant".ready AND "Run_Tag";
  "Fc_Log"();
END_FUNCTION_BLOCK
`;

function idx() {
  const i = new WorkspaceIndex();
  i.set("file:///w/plc/P/blocks/Fb_Pump.scl", FB, 0);
  i.set("file:///w/plc/P/blocks/Plant.db", 'DATA_BLOCK "Plant"\n   VAR\n      ready : Bool;\n   END_VAR\nBEGIN\nEND_DATA_BLOCK\n', 0);
  i.set("file:///w/plc/P/blocks/Fc_Log.scl", 'FUNCTION "Fc_Log" : Void\nBEGIN\nEND_FUNCTION\n', 0);
  i.set("file:///w/plc/P/types/Ud_Pump.udt", 'TYPE "Ud_Pump"\n   STRUCT\n      speed : Int;\n   END_STRUCT;\nEND_TYPE\n', 0);
  i.set("file:///w/plc/P/tags/Tags.tags.st", "VAR_GLOBAL\n    Run_Tag AT %M0.0 : Bool;\nEND_VAR\n", 0);
  return i;
}

describe("semantic tokens", () => {
  it("colour names by what they are: sections, globals, standard instructions, members", () => {
    const i = idx();
    const tokens = semanticTokens(i, "file:///w/plc/P/blocks/Fb_Pump.scl");
    const at = (text: string, nth = 0) => {
      let from = -1;
      for (let k = 0; k <= nth; k++) from = FB.indexOf(text, from + 1);
      const t = tokens.find((x) => x.start === from);
      return t && `${t.type}${t.modifiers.length ? `.${t.modifiers.join(".")}` : ""}`;
    };
    expect(at('"Fb_Pump"')).toBe("class.declaration");
    expect(at("start :")).toBe("parameter.readonly.declaration");
    expect(at("#start")).toBe("parameter.readonly");
    expect(at("#running")).toBe("parameter.modification");
    expect(at("#timer(")).toBe("property");
    expect(at("#t :=")).toBe("variable");
    expect(at("#LIMIT_MS")).toBe("variable.readonly");
    expect(at("LIMIT(")).toBe("function.defaultLibrary");
    expect(at('"Plant"')).toBe("namespace.static");
    expect(at("ready", 0)).toBe("property");
    expect(at('"Run_Tag"')).toBe("variable.static");
    expect(at('"Fc_Log"')).toBe("function");
    expect(at("speed")).toBe("property");
    // in order, no overlaps
    for (let k = 1; k < tokens.length; k++) expect(tokens[k]!.start).toBeGreaterThanOrEqual(tokens[k - 1]!.end);
  });
});
