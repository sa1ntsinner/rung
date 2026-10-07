// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { WorkspaceIndex, diagnostics } from "../src/index.js";

describe("a name SCL reserves", () => {
  it("is refused as a variable's name unless it is quoted, as TIA Portal refuses it", () => {
    const i = new WorkspaceIndex();
    const uri = "file:///w/plc/P/blocks/FB_T.scl";
    i.set(uri, 'FUNCTION_BLOCK "FB_T"\nVAR_INPUT\n  tod : Time_Of_Day;\n  "date" : Date;\n  plain : Int;\n  s : Struct\n    time : Time;\n  END_STRUCT;\nEND_VAR\nBEGIN\n  ;\nEND_FUNCTION_BLOCK\n', 0);
    const d = diagnostics(i, uri).filter((x) => x.code === "RESERVED_NAME");
    expect(d.map((x) => x.message)).toEqual([
      'tod is a word SCL reserves: TIA Portal refuses it as a name; call it otherwise, or write it in quotes ("tod")',
      'time is a word SCL reserves: TIA Portal refuses it as a name; call it otherwise, or write it in quotes ("time")',
    ]);
  });
});
