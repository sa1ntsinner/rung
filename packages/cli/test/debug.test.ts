// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { startDebugAdapter } from "../src/debug.js";

const MOTOR = readFileSync(fileURLToPath(new URL("../../../tools/fixtures/scl/Fx_Motor.scl", import.meta.url)), "utf8");
const TEST = `block: Fx_Motor\ncases:\n  - name: starts and stops\n    steps:\n      - set: { Start: true, SpeedSetpoint: 1500 }\n      - cycle: 1\n      - expect: { Running: true }\n      - set: { Start: false, Stop: true }\n      - cycle: 1\n      - expect: { Running: true }\n`;

/** A DAP client on streams: requests by command, answers and events in arrival order. */
function client(dir: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = startDebugAdapter({ cwd: dir, stdout: () => {}, stderr: () => {}, env: {} }, input, output);
  const messages: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let buf = Buffer.alloc(0);
  output.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    for (;;) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) break;
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, end).toString())![1]);
      if (buf.length < end + 4 + len) break;
      messages.push(JSON.parse(buf.subarray(end + 4, end + 4 + len).toString()));
      buf = buf.subarray(end + 4 + len);
      waiters.splice(0).forEach((w) => w());
    }
  });
  let seq = 1;
  const until = async (pred: (m: Record<string, unknown>) => boolean) => {
    for (;;) {
      const i = messages.findIndex(pred);
      if (i >= 0) return messages.splice(i, 1)[0]!;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const request = async (command: string, args: Record<string, unknown> = {}) => {
    const s = seq++;
    const body = Buffer.from(JSON.stringify({ seq: s, type: "request", command, arguments: args }));
    input.write(`Content-Length: ${body.length}\r\n\r\n`);
    input.write(body);
    return (await until((m) => m.type === "response" && m.request_seq === s)) as { success: boolean; body?: any; message?: string };
  };
  const eventOf = (name: string) => until((m) => m.type === "event" && m.event === name) as Promise<{ body?: any }>;
  return { request, eventOf, done, input };
}

describe("rung debug (DAP)", () => {
  it("launches a case, stops at a breakpoint, steps back, shows variables and reports the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-dbg-"));
    mkdirSync(join(dir, "plc", "PLC_1", "blocks"), { recursive: true });
    mkdirSync(join(dir, "tests"));
    const block = join(dir, "plc", "PLC_1", "blocks", "Fx_Motor.scl");
    writeFileSync(block, MOTOR);
    writeFileSync(join(dir, "tests", "motor.test.yaml"), TEST);
    const c = client(dir);

    const init = await c.request("initialize", { adapterID: "rung" });
    expect(init.body).toMatchObject({ supportsStepBack: true, supportsConditionalBreakpoints: true, supportsSetVariable: true });
    await c.eventOf("initialized");
    expect((await c.request("launch", { test: "tests/motor.test.yaml", case: 0 })).success).toBe(true);
    const bp = await c.request("setBreakpoints", { source: { path: block }, breakpoints: [{ line: 27 }] });
    expect(bp.body.breakpoints).toEqual([{ verified: true, line: 27 }]);
    await c.request("configurationDone");
    const stopped = await c.eventOf("stopped");
    expect(stopped.body).toMatchObject({ reason: "breakpoint", threadId: 1, description: "t = 20 ms" });

    const st = await c.request("stackTrace", { threadId: 1 });
    expect(st.body.stackFrames[0]).toMatchObject({ id: 0, name: "Fx_Motor", line: 27, source: { name: "Fx_Motor.scl" } });
    expect(st.body.stackFrames[0].source.path.toLowerCase()).toBe(block.toLowerCase());
    const scopes = await c.request("scopes", { frameId: 0 });
    const locals = await c.request("variables", { variablesReference: scopes.body.scopes[0].variablesReference });
    expect(locals.body.variables.find((v: { name: string }) => v.name === "Stop")).toMatchObject({ value: "TRUE", type: "Bool", evaluateName: "#Stop" });
    expect((await c.request("evaluate", { expression: "Latch", frameId: 0 })).body.result).toBe("FALSE");
    expect((await c.request("evaluate", { expression: "#Nope", frameId: 0 })).success).toBe(false);

    await c.request("stepBack", { threadId: 1 });
    await c.eventOf("stopped");
    expect((await c.request("stackTrace", { threadId: 1 })).body.stackFrames[0].line).toBe(24);

    await c.request("setBreakpoints", { source: { path: block }, breakpoints: [] });
    await c.request("continue", { threadId: 1 });
    // the failed expectation stops first, where it shows
    expect((await c.eventOf("stopped")).body).toMatchObject({ reason: "exception", text: "step 6: Running expected true, got false" });
    await c.request("continue", { threadId: 1 });
    const out = await c.eventOf("output");
    expect(out.body).toMatchObject({ category: "stderr" });
    expect(out.body.output).toContain("FAILED: starts and stops");
    expect(out.body.output).toContain("step 6: Running expected true got false");
    await c.eventOf("terminated");
    await c.request("disconnect");
    await c.done;
  });

  it("says why a launch cannot start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-dbg-"));
    const c = client(dir);
    await c.request("initialize");
    const r = await c.request("launch", { test: "tests/none.test.yaml" });
    expect(r).toMatchObject({ success: false });
    expect(r.message).toMatch(/no test file at/);
    c.input.end();
    await c.done;
  });
});
