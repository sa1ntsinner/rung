// SPDX-License-Identifier: BUSL-1.1
// An output handed on to an in/out further down: still only its writes count for the caller's destination.
import { expect, it } from "vitest";
import { WorkspaceIndex } from "../src/workspace.js";
import { usagesAt } from "../src/features.js";

const uri = (name: string) => "file:///w/plc/PLC_1/blocks/" + name;

it("does not read a caller's destination through an output copy forwarded to an in/out", () => {
  const index = new WorkspaceIndex();
  const db = 'DATA_BLOCK "Plant"\nVAR\n Value : Int;\nEND_VAR\nBEGIN\nEND_DATA_BLOCK\n';
  const produce = 'FUNCTION "Produce" : Void\nVAR_OUTPUT\n N : Int;\nEND_VAR\nBEGIN\n "Increment"(N := #N);\nEND_FUNCTION\n';
  const increment = 'FUNCTION "Increment" : Void\nVAR_IN_OUT\n N : Int;\nEND_VAR\nBEGIN\n #N := #N + 1;\nEND_FUNCTION\n';
  const main = 'ORGANIZATION_BLOCK "Main"\nBEGIN\n "Produce"(N => "Plant".Value);\nEND_ORGANIZATION_BLOCK\n';
  index.set(uri("Plant.db"), db, 0);
  index.set(uri("Produce.scl"), produce, 0);
  index.set(uri("Increment.scl"), increment, 0);
  index.set(uri("Main.scl"), main, 0);

  const uses = usagesAt(index, uri("Plant.db"), db.indexOf("Value"));
  expect(uses.writes.map((s) => s.block)).toEqual(["Increment"]);
  // Increment reads Produce's local output copy, never the previous value in Plant.Value.
  expect(uses.reads).toEqual([]);
});
