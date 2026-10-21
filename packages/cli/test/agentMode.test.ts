// SPDX-License-Identifier: BUSL-1.1
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "smol-toml";
import { agentModesPath, defaultConfig, readAgentModes, saveConfig, workspaceAgentModes, workspaceModeKey, type AgentMode } from "@rung/core";
import { createHash } from "node:crypto";
import { liveMutations } from "../src/liveMutation.js";
import * as trust from "../src/liveTrust.js";
import { withAgentPermission, type DialogRunner } from "../src/agentMode.js";
import { assertHuman, commandAction, commandTokens, guardCommand, guardHook } from "../src/guard.js";
import { main } from "../src/main.js";

async function fixture(mode: AgentMode, actions?: string[]) {
  const parent = await mkdtemp(join(tmpdir(), "rung-modes-"));
  const root = join(parent, "workspace");
  await mkdir(root);
  const env = { RUNG_AGENT: "1", APPDATA: join(parent, "settings"), XDG_CONFIG_HOME: join(parent, "settings") };
  const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1"]);
  await saveConfig(root, config);
  const file = agentModesPath(env);
  await mkdir(join(parent, "settings", "rung"), { recursive: true });
  await writeFile(file, stringify({ workspaces: { [workspaceModeKey(root)]: { default: { mode, ...(actions ? { actions } : {}) } } } }));
  const io = { cwd: root, env, stdout: () => {}, stderr: () => {} };
  return { root, env, config, io };
}

describe("agent permission execution", () => {
  it("keeps manual refusal text and never invokes a dialog", async () => {
    const { io, root } = await fixture("manual");
    await expect(withAgentPermission(root, "download", "PLC_1", io, async () => 0, async () => { throw new Error("dialog called"); })).rejects.toThrow(/download belongs to the person/);
    expect(JSON.parse(await readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8"))).toMatchObject({ mode: "manual", action: "download", outcome: 1, allowedBy: "refused" });
  });
  it.each(["auto", "bypass"] as const)("allows %s once within the execution scope and audits the exit code", async mode => {
    const { io, root } = await fixture(mode);
    expect(await withAgentPermission(root, "download", "PLC_1", io, async () => { assertHuman(io.env); return 7; }, async () => { throw new Error("dialog called"); })).toBe(7);
    expect(() => assertHuman(io.env)).toThrow(/ask the person/i);
    expect(JSON.parse(await readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8"))).toMatchObject({ agent: "RUNG_AGENT", plc: "PLC_1", action: "download", mode, allowedBy: "mode", outcome: 7 });
  });
  it("audits only actions on a PLC, not the commands that read (status, pull)", async () => {
    const { io, root } = await fixture("bypass");
    await main(["status"], io);
    await expect(readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8")).rejects.toThrow(/ENOENT/);
  });
  it.each(["PLC_1", "wrong", undefined])("ask uses only the native runner result %s", async answer => {
    const { io, root } = await fixture("ask");
    const runner: DialogRunner = async request => { expect(request).toMatchObject({ plc: "PLC_1", action: "write", timeoutMs: 120000 }); return { answer }; };
    const operation = withAgentPermission(root, "write", "PLC_1", { ...io, prompt: async () => "PLC_1" }, async () => 0, runner);
    if (answer === "PLC_1") expect(await operation).toBe(0);
    else await expect(operation).rejects.toThrow(/refused|cancelled|expired/i);
  });
  it("auto asks for force and explicit empty actions, bypass does not", async () => {
    for (const [mode, actions, calls] of [["auto", undefined, 1], ["auto", [], 1], ["bypass", [], 0]] as const) {
      const { io, root } = await fixture(mode, actions ? [...actions] : undefined);
      let dialogs = 0;
      await withAgentPermission(root, "force", "PLC_1", io, async () => 0, async () => { dialogs++; return { answer: "PLC_1" }; });
      expect(dialogs).toBe(calls);
    }
  });
  it("read-only locks win before native consent in every mode", async () => {
    for (const mode of ["manual", "ask", "auto", "bypass"] as const) {
      const { io, root, config } = await fixture(mode);
      config.plc.PLC_1 = { mode: "PN/IE", pcInterface: "Ethernet", pcInterfaceNumber: 1, readOnly: true };
      await saveConfig(root, config);
      await expect(withAgentPermission(root, "download", "PLC_1", io, async () => 0, async () => { throw new Error("dialog called"); })).rejects.toThrow(/read-only lock/);
      expect(JSON.parse(await readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8"))).toMatchObject({ outcome: 2 });
    }
  });
  it("audits a thrown command and dialog refusal", async () => {
    const { io, root } = await fixture("ask");
    await expect(withAgentPermission(root, "write", "PLC_1", io, async () => { throw new Error("failed"); }, async () => ({ answer: "PLC_1" }))).rejects.toThrow("failed");
    await expect(withAgentPermission(root, "write", "PLC_1", io, async () => 0, async () => ({ reason: "Native dialog expired after 120 seconds" }))).rejects.toThrow(/expired/);
    const lines = (await readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.every(line => line.outcome === 1)).toBe(true);
  });
  it("audits live commands rejected before a broker or dialog is started", async () => {
    const { io, root } = await fixture("auto");
    expect(await main(["live", "run", "unexpected-argument"], io)).toBe(1);
    expect(JSON.parse(await readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8"))).toMatchObject({ action: "run-stop", mode: "auto", outcome: 1 });
  });
  it("agents may inspect modes but never change them or confirm on stdin", async () => {
    const { root, io } = await fixture("bypass");
    expect(await main(["agent-mode", "--json"], io)).toBe(0);
    expect(await main(["agent-mode", "auto"], io)).toBe(1);
    expect(await main(["live", "run", "--confirm-stdin"], io)).toBe(1);
    expect(guardCommand("rung agent-mode bypass").allowed).toBe(false);
    expect(guardCommand("rung agent-mode --json").allowed).toBe(true);
    expect(guardHook({ tool_name: "Edit", tool_input: { file_path: join(root, "rung", "agent-modes.toml") } }, "claude")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(guardCommand('Set-Content "C:\\Users\\Person\\AppData\\Roaming\\rung\\agent-modes.toml" x').allowed).toBe(false);
    for (const command of ["Clear-Content", "Set-Item", "truncate -s 0", "dd of="]) expect(guardCommand(command + " C:/settings/rung/agent-modes.toml").allowed).toBe(false);
    expect(guardHook({ tool_name: "apply_patch", tool_input: { patch: "*** Add File: C:/settings/rung/agent-modes.toml\n+x" } }, "claude")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  it("a human types the exact folder or PLC name to set, expire and reset a mode", async () => {
    const { root, io, config } = await fixture("ask");
    const env = { ...io.env, RUNG_AGENT: "0" };
    let expected = "workspace";
    const human = { ...io, env, prompt: async (question: string) => { expect(question).toContain(expected); return expected; } };
    expect(await main(["agent-mode", "auto", "--for", "8h", "--actions", "write"], human)).toBe(0);
    let store = await readAgentModes(env);
    const entry = store.workspaces![workspaceModeKey(root)]!.default!;
    expect(entry).toMatchObject({ mode: "auto", actions: ["write"], previous: { mode: "ask" } });
    expect(Date.parse(entry.expires!) - Date.now()).toBeGreaterThan(7 * 3600000);
    expected = "PLC_1";
    expect(await main(["agent-mode", "bypass", "--plc", "PLC_1"], human)).toBe(0);
    expect((await workspaceAgentModes(root, config, env))[0]!.mode).toBe("bypass");
    expect(await main(["agent-mode", "reset", "--plc", "PLC_1"], human)).toBe(0);
    expect((await workspaceAgentModes(root, config, env))[0]!.mode).toBe("auto");
    store = await readAgentModes(env);
    store.workspaces![workspaceModeKey(root)]!.default!.expires = "2020-01-01T00:00:00Z";
    await writeFile(agentModesPath(env), stringify(store));
    expect((await workspaceAgentModes(root, config, env))[0]!.mode).toBe("ask");
    const before = await readFile(agentModesPath(env), "utf8");
    expect(await main(["agent-mode", "manual"], { ...human, prompt: async () => "wrong" })).toBe(1);
    expect(await readFile(agentModesPath(env), "utf8")).toBe(before);
  });
  it.skipIf(process.platform !== "win32")("updates a workspace entry whose stored root uses another case", async () => {
    const { io, root, config } = await fixture("manual");
    await writeFile(agentModesPath(io.env), stringify({ workspaces: { [root.toUpperCase()]: { default: { mode: "ask" } } } }));
    expect(await main(["agent-mode", "auto"], { ...io, env: { ...io.env, RUNG_AGENT: "0" }, prompt: async () => "workspace" })).toBe(0);
    expect((await workspaceAgentModes(root, config, io.env))[0]!.mode).toBe("auto");
  });
  it.each(["acknowledged", "unknown"] as const)("broker asks once before preparing, binds the client marker, audits %s and rejects reuse", async outcome => {
    const { root, io, config } = await fixture("ask");
    const target = { transport: "s7commplus" as const, address: "10.20.0.1", allowWrites: true, certificateSha256: "A".repeat(64) };
    config.live = { plc: { PLC_1: target } }; await saveConfig(root, config);
    const configRevision = createHash("sha256").update(await readFile(join(root, "rung.toml"))).digest("hex");
    const binding = { workspace: root, device: "PLC_1", address: target.address, certificateSha256: target.certificateSha256,
      cpu: "S7-1500", serial: "fixture", plcName: "PLC_1", epoch: 1, programRevision: "fixture", configRevision, allowWrites: true };
    const calls: string[] = [];
    const host = { close: async () => {}, request: async (method: string) => {
      calls.push(method);
      if (method === "online.connect") return { sessionId: "session" };
      if (method === "online.prepare") return { operationId: "host", preview: "run PLC_1", expiresAt: Date.now() + 30000, context: { binding } };
      if (method === "online.state") return { scope: { epoch: 1 }, identity: binding };
      if (method === "online.commit") return { outcome };
      throw new Error(method);
    } };
    const hostMock = vi.spyOn(trust, "onlineHost").mockResolvedValue(host as never);
    let dialogs = 0;
    const broker = liveMutations(root, { ...io.env, RUNG_AGENT: "0" }, async () => ({ device: "PLC_1", transport: "s7commplus", target }) as never, async request => {
      dialogs++; expect(calls).toEqual([]); expect(request.command).toBe("rung live run --device PLC_1"); expect(request.agent).toBe("CODEX_TEST"); return { answer: "PLC_1" };
    });
    try {
      const prepared = await broker.prepare("agent", { device: "PLC_1" }, { action: "run" }, {}, "CODEX_TEST", "rung live run --device PLC_1");
      expect((await broker.commit("agent", prepared.operationId, prepared.preview, true)).outcome).toBe(outcome);
      expect(dialogs).toBe(1);
      expect(calls.filter(c => c === "online.commit")).toHaveLength(1);
      await expect(broker.commit("agent", prepared.operationId, prepared.preview, true)).rejects.toThrow(/expired/);
      expect(JSON.parse(await readFile(join(root, ".rung", "agent-actions.jsonl"), "utf8"))).toMatchObject({ agent: "CODEX_TEST", allowedBy: "dialog", outcome: outcome === "acknowledged" ? 0 : 2 });
    } finally { await broker.close(); hostMock.mockRestore(); }
  });
  it.each([["download", "download"], ["live modify X true", "write"], ["live unforce", "force"], ["live stop", "run-stop"], ["live reset", "alarm-ack"], ["init --writes", "writes-on"], ["setup openness", "openness-setup"], ["bridge", "bridge"]])("classifies %s as %s", (line, action) => {
    const tokens = line.split(" "); expect(commandAction(commandTokens(tokens), tokens)).toBe(action);
  });
});
