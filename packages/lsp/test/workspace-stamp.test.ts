// SPDX-License-Identifier: BUSL-1.1
import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceStamp } from "../src/workspace.js";

it("changes the source stamp when content changes at the same size and mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-stamp-"));
  await mkdir(join(root, "plc", "P", "blocks"), { recursive: true });
  const file = join(root, "plc", "P", "blocks", "A.scl");
  await writeFile(file, "old\n");
  await utimes(file, 1700000000, 1700000000);
  const before = await stat(file);
  const stamp = await sourceStamp(root);
  await writeFile(file, "new\n");
  await utimes(file, before.atime, before.mtime);
  const after = await stat(file);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(await sourceStamp(root)).not.toBe(stamp);
});
