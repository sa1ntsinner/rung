// SPDX-License-Identifier: BUSL-1.1
// Who writes a value handed to an in/out of a call that is itself an argument (ABS("Increment"(N := x))).
import { expect, it } from "vitest";
import { WorkspaceIndex } from "../src/workspace.js";
import { usagesAt } from "../src/features.js";

const uri = (name: string) => "file:///w/plc/PLC_1/blocks/" + name;

it("follows an in/out passed to a nested FC expression to its actual writer", () => {
  const index = new WorkspaceIndex();
  const db = 'DATA_BLOCK "Plant"\nVAR\n Value : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n';
  const increment = 'FUNCTION "Increment" : Int\nVAR_IN_OUT\n N : Int;\nEND_VAR\nBEGIN\n #N := #N + 1;\n #Increment := #N;\nEND_FUNCTION\n';
  const main = 'ORGANIZATION_BLOCK "Main"\nVAR_TEMP\n x : Int;\nEND_VAR\nBEGIN\n #x := ABS("Increment"(N := "Plant".Value));\nEND_ORGANIZATION_BLOCK\n';
  index.set(uri("Plant.db"), db, 0);
  index.set(uri("Increment.scl"), increment, 0);
  index.set(uri("Main.scl"), main, 0);

  const uses = usagesAt(index, uri("Plant.db"), db.indexOf("Value"));
  expect(uses.writes.map((s) => s.block)).toEqual(["Increment"]);
  expect(uses.handedOn?.map((s) => s.handedTo)).toEqual([{ block: "Increment", param: "N" }]);
});
