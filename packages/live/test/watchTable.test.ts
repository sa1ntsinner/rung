// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { loadWatchTable, watchTableVariables } from "../src/watchTable.js";

it("forwards native I/Q/M rows for metadata resolution and keeps DB offsets unsupported", () => {
  const table = { name: "Watch", rows: [{ key: "row:1", address: "%MW2", comments: {} }, { key: "row:2", address: "%DB1.DBW0", comments: {} }] };
  expect(watchTableVariables(table, { "row:1": "%MW2" })).toEqual({ vars: { "row:1": "%MW2" }, errors: { "row:2": "Absolute address requires a verified mapping: %DB1.DBW0" } });
});

it("parses through the local host and preserves duplicate row labels without committing draft values", async () => {
  const calls: string[] = [];
  const table = await loadWatchTable({ async request(method, params) {
    calls.push(method);
    expect(params).toEqual({ xml: "exported XML" });
    return { name: "Watch", engineeringVersion: "V20", rows: [
      { key: "row:1", name: '"DB".items[2].value', modifyValue: "17", comments: { "en-US": "Comment" } },
      { key: "row:2", name: '"DB".items[2].value', comments: {} },
      { key: "row:3", address: "%MW2", comments: {} },
      { key: "row:4", comments: {} },
    ] };
  } }, "exported XML");
  expect(calls).toEqual(["online.watchTable"]);
  expect(watchTableVariables(table)).toEqual({ vars: { "row:1": '"DB".items[2].value', "row:2": '"DB".items[2].value' }, errors: {
    "row:3": "Absolute address requires a verified mapping: %MW2", "row:4": "Empty watch table row",
  } });
  expect(table.rows[0].modifyValue).toBe("17");
});
