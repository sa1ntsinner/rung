// SPDX-License-Identifier: MIT
// The Zed extension's tasks: each says what it saves first (Zed saves nothing unless told).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const tasks = JSON.parse(readFileSync(new URL("../../editors/zed/languages/scl/tasks.json", import.meta.url), "utf8")) as { label: string; args: string[]; save?: string }[];

describe("Zed tasks", () => {
  it("offers only the noninteractive agent mode display", () => {
    expect(tasks.filter((t) => t.args[0] === "agent-mode")).toEqual([expect.objectContaining({ label: "rung: agent mode (show)", args: ["agent-mode"], save: "none" })]);
  });
  it("save the edited buffers before a task reads the files, and nothing before one that does not", () => {
    const reads = new Set(["sync", "watch", "compile", "test", "impact", "who", "why"]);
    for (const t of tasks) expect([t.label, t.save]).toEqual([t.label, t.args.includes("--ours") ? "current" : reads.has(t.args[0]!) ? "all" : "none"]);
  });
});
