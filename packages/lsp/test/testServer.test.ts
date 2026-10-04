// SPDX-License-Identifier: BUSL-1.1
// The language server reads an open test file for the test table (rung/testModel: the cases, the block's symbols,
// keys that name nothing) and plans its edits against the version the table showed (rung/testEdit). A test file is
// no SCL: it gets no SCL diagnostics and joins no index.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorServer } from "./monitorHarness.js";

const TEST = "block: Motor\ncases:\n  - name: counts\n    steps:\n      - set: { flag: true, cuont: 1 }\n      - cycle: 1\n";

describe("test files and the SCL features", () => {
  it("every SCL request on a test file answers nothing, without an error", async () => {
    const s = await monitorServer();
    try {
      const uri = pathToFileURL(join(s.root, "tests", "motor.test.yaml")).href;
      await s.client.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "yaml", version: 1, text: TEST } });
      const at = { textDocument: { uri }, position: { line: 4, character: 16 } };
      const range = { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } };
      const asks: [string, unknown][] = [
        ["textDocument/documentSymbol", { textDocument: { uri } }],
        ["textDocument/foldingRange", { textDocument: { uri } }],
        ["textDocument/hover", at],
        ["textDocument/completion", at],
        ["textDocument/definition", at],
        ["textDocument/references", { ...at, context: { includeDeclaration: true } }],
        ["textDocument/documentHighlight", at],
        ["textDocument/inlayHint", { textDocument: { uri }, range }],
        ["textDocument/codeAction", { textDocument: { uri }, range, context: { diagnostics: [] } }],
        ["textDocument/signatureHelp", at],
        ["textDocument/rename", { ...at, newName: "count2" }],
      ];
      for (const [method, params] of asks) {
        const r = await s.client.sendRequest(method, params).then((x) => ({ ok: x }), (e: Error) => ({ error: `${method}: ${e.message}` }));
        expect((r as { error?: string }).error).toBeUndefined();
      }
    } finally {
      await s.dispose();
    }
  });
});

describe("test files in the language server", () => {
  it("rung/testModel: cases, the block's symbols, keys that name nothing; no SCL diagnostics", async () => {
    const s = await monitorServer();
    const diagnostics: { uri: string }[] = [];
    s.client.onNotification("textDocument/publishDiagnostics", (p: { uri: string }) => diagnostics.push(p));
    try {
      const uri = pathToFileURL(join(s.root, "tests", "motor.test.yaml")).href;
      await s.client.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "yaml", version: 3, text: TEST } });
      const m = await s.client.sendRequest<{ version: number; model: { cases: { name: { value: string } }[] }; symbols: { name: string }[]; problems: { key: string; message: string }[] }>("rung/testModel", { textDocument: { uri } });
      expect(m.version).toBe(3);
      expect(m.model.cases.map((c) => c.name.value)).toEqual(["counts"]);
      expect(m.symbols.map((x) => x.name)).toEqual(["count", "flag"]);
      expect(m.problems).toEqual([expect.objectContaining({ key: "cuont", message: "Motor has no cuont (did you mean count?)" })]);
      const edit = await s.client.sendRequest<{ ok: boolean; edits: { newText: string; old: string }[] }>("rung/testEdit", { textDocument: { uri, version: 3 }, op: { op: "setKey", case: 0, step: 0, part: "set", key: "cuont", newKey: "count" } });
      expect(edit).toMatchObject({ ok: true, edits: [{ old: "cuont", newText: "count" }] });
      // what rung test would refuse is refused before it is written
      const edit2 = (op: unknown) => s.client.sendRequest<{ ok: boolean; reason?: string }>("rung/testEdit", { textDocument: { uri, version: 3 }, op });
      expect(await edit2({ op: "setValue", case: 0, step: 0, part: "set", key: "cuont", value: "1" })).toMatchObject({ ok: false, reason: "Motor has no cuont (did you mean count?)" });
      expect(await edit2({ op: "addEntry", case: 0, step: 0, part: "set", key: "count", value: "40000" })).toMatchObject({ ok: false, reason: expect.stringContaining("does not fit an Int") });
      expect(await edit2({ op: "setValue", case: 0, step: 0, part: "set", key: "flag", value: "yes" })).toMatchObject({ ok: false, reason: "Bool takes true or false." });
      expect(await edit2({ op: "setValue", case: 0, step: 0, part: "set", key: "flag", value: "false" })).toMatchObject({ ok: true });
      const stale = await s.client.sendRequest("rung/testEdit", { textDocument: { uri, version: 2 }, op: { op: "setKey", case: 0, step: 0, part: "set", key: "cuont", newKey: "count" } });
      expect(stale).toEqual({ ok: false, reason: "The file changed. Review this value again." });
      await new Promise((r) => setTimeout(r, 400));
      expect(diagnostics.filter((d) => d.uri === uri)).toEqual([]);
    } finally {
      await s.dispose();
    }
  });
});
