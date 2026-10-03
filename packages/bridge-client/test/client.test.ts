// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeClient, BridgeError, ErrorCodes } from "../src/index.js";

const script = fileURLToPath(new URL("./fake-bridge.mjs", import.meta.url));
const fake = (mode: string, extra: Partial<Parameters<typeof BridgeClient.spawn>[0]> = {}) => ({
  command: process.execPath,
  args: [script],
  env: { FAKE_MODE: mode },
  ...extra,
});

const open: BridgeClient[] = [];
async function spawn(opts: Parameters<typeof BridgeClient.spawn>[0]) {
  const c = await BridgeClient.spawn(opts);
  open.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe("BridgeClient", () => {
  it("handshakes and lists", async () => {
    const c = await spawn(fake("ok"));
    expect(c.info.tiaVersion).toBe("V20");
    expect((await c.listObjects("PLC_1"))[0]!.address).toBe("plc:PLC_1/blocks/10_Drives/Motors/Fx_Motor");
  });

  it("maps error codes", async () => {
    const c = await spawn(fake("ok"));
    await expect(c.projectInfo()).rejects.toMatchObject({ code: ErrorCodes.TIA_NOT_RUNNING });
  });

  it("rejects pending calls when bridge dies", async () => {
    const c = await spawn(fake("crash-after-hello"));
    await new Promise((r) => setTimeout(r, 100));
    await expect(c.listObjects("PLC_1")).rejects.toMatchObject({ code: "BRIDGE_EXITED" });
  });

  it("lets go of the pipes when the bridge dies and what it started keeps them open", async () => {
    const c = await spawn(fake("orphan-after-hello"));
    const child = (c as unknown as { child: { stdout: { destroyed: boolean } } }).child;
    await new Promise((r) => setTimeout(r, 1600));
    await expect(c.listObjects("PLC_1")).rejects.toMatchObject({ code: "BRIDGE_EXITED" });
    expect(child.stdout.destroyed).toBe(true);
  });

  it("says when the first request is slow (TIA Portal opening a project) and stops saying it once answered", async () => {
    let slow = 0;
    const c = await spawn(fake("slow", { requestTimeoutMs: 600, onSlowStart: () => slow++, slowStartMs: 100 }));
    await expect(c.listObjects("PLC_1")).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(slow).toBe(1);
  });

  it.runIf(process.platform === "win32")("a bridge that will not end is ended with what it started (a TIA Portal opening a project)", async () => {
    const c = await BridgeClient.spawn({ ...fake("stuck-with-child"), closeTimeoutMs: 300 });
    let pid = 0;
    c.onEvent((e) => {
      const m = e.event === "stderr" ? /child (\d+)/.exec(String(e.params)) : null;
      if (m) pid = Number(m[1]);
    });
    await expect(c.listObjects("PLC_1")).resolves.toBeDefined();
    for (let i = 0; !pid && i < 50; i++) await new Promise((r) => setTimeout(r, 20));
    expect(pid).toBeGreaterThan(0);
    await c.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("times out read requests with TIMEOUT", async () => {
    const c = await spawn(fake("slow", { requestTimeoutMs: 1000 }));
    await expect(c.listObjects("PLC_1")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("times out mutations with OUTCOME_UNKNOWN and never replays them", async () => {
    const c = await spawn(fake("write-no-response", { requestTimeoutMs: 1000 }));
    await expect(c.importObject("plc:PLC_1/blocks/X", "scl", "C:/x.scl", "fp:1", "op-1")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(c.sentMethods.filter((m) => m === "objects.import")).toHaveLength(1);
  });

  it("reports non-JSON stdout lines as events", async () => {
    const c = await spawn(fake("garbage-line"));
    const events: string[] = [];
    c.onEvent((e) => events.push(e.event));
    await c.listObjects("PLC_1");
    expect(events).toContain("stdout-noise");
  });

  it("forwards bridge events", async () => {
    const c = await spawn(fake("event"));
    const events: unknown[] = [];
    c.onEvent((e) => events.push(e));
    await c.listObjects("PLC_1");
    expect(events).toContainEqual({ event: "log", params: { level: "info", message: "listing" } });
  });

  it("keeps non-ASCII intact", async () => {
    const c = await spawn(fake("unicode"));
    expect((await c.listObjects("PLC_1"))[0]!.address).toBe("plc:PLC_1/blocks/Überwachung 😀");
  });

  it("merges env with the parent environment", async () => {
    const c = await spawn(fake("ok"));
    expect(await c.request("echo.env", {})).toEqual({ fake: "ok", path: "set" });
  });

  it("refuses unknown protocol and kills the child", async () => {
    await expect(BridgeClient.spawn(fake("protocol2"))).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("fails the handshake on hang", async () => {
    await expect(BridgeClient.spawn(fake("hang-hello", { requestTimeoutMs: 300 }))).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("reports a missing executable", async () => {
    await expect(BridgeClient.spawn({ command: join(tmpdir(), "does-not-exist-rung-bridge.exe") })).rejects.toBeInstanceOf(BridgeError);
  });

  it("handles spaces and non-ASCII in the executable path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung dir Ü "));
    const copy = join(dir, "fake bridge.mjs");
    copyFileSync(script, copy);
    const c = await spawn({ command: process.execPath, args: [copy], env: { FAKE_MODE: "ok" } });
    expect(c.info.protocol).toBe(1);
  });

  it("close is idempotent and bounded", async () => {
    const c = await BridgeClient.spawn(fake("ok"));
    await c.close();
    await c.close();
    await expect(c.listObjects("PLC_1")).rejects.toMatchObject({ code: "BRIDGE_EXITED" });
  });
});
