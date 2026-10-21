// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Activity } from "../src/core/activity";
import { ActivityView } from "../src/views/activityView";

const handlers = vi.hoisted(() => ({ change: () => {}, workspace: () => {} }));
vi.mock("vscode", () => ({
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  window: { createTreeView: () => ({ dispose() {} }) },
  workspace: { createFileSystemWatcher: () => ({
    dispose() {}, onDidChange: (cb: () => void) => { handlers.change = cb; return { dispose() {} }; },
    onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }),
  }) },
}));

it("loads agent action history without watch and follows audit changes and workspace switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "rung-activity-"));
  await mkdir(join(root, ".rung"));
  const file = join(root, ".rung", "agent-actions.jsonl");
  const record = { time: "2026-10-22T10:00:00Z", plc: "PLC_1", action: "download", mode: "manual", allowedBy: "refused", outcome: 1 };
  await writeFile(file, JSON.stringify(record) + "\n");
  const ws = { root, onDidChange: (cb: () => void) => { handlers.workspace = cb; return { dispose() {} }; } };
  const events = { onEvent: () => ({ dispose() {} }) };
  const view = new ActivityView(ws as never, new Activity(), events as never);
  try {
    await vi.waitFor(() => expect(view.getChildren()[0]?.label).toContain("agent download (manual, refused)"));
    await writeFile(file, JSON.stringify({ ...record, action: "write" }) + "\n");
    handlers.change();
    await vi.waitFor(() => expect(view.getChildren()[0]?.label).toContain("agent write"));
    ws.root = await mkdtemp(join(tmpdir(), "rung-activity-other-"));
    handlers.workspace();
    await vi.waitFor(() => expect(view.getChildren()).toHaveLength(0));
  } finally { view.dispose(); }
});
