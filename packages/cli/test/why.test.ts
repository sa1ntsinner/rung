// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.js";

it("why refuses LAD XML with navigation advice and emits no false explanation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rung-why-xml-"));
  writeFileSync(join(cwd, "FB_Lad.xml"), readFileSync(fileURLToPath(new URL("../../lsp/test/vci/Program blocks/Lad/FB_Lad.xml", import.meta.url))));
  const out: string[] = [], err: string[] = [];
  const result = await main(["why", "FB_Lad.xml", "Running", "--json"], { cwd, env: {}, stdout: s => out.push(s), stderr: s => err.push(s) });
  expect(result).toBe(1);
  expect(out).toEqual([]);
  expect(err.join("")).toMatch(/Why.*SCL\/ST.*who.*xref/);
});
