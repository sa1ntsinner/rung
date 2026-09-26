// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebApiClient } from "@rung/live";
import { startVirtualPlc } from "../src/simulate.js";
import { main } from "../src/main.js";

const MAIN = `ORGANIZATION_BLOCK "Main"
VERSION : 0.1
   VAR_TEMP
      t : Bool;
   END_VAR
BEGIN
\t"Plant".cycles := "Plant".cycles + 1;
\t"Plant".blink(IN := NOT "Plant".blink.Q, PT := T#50ms);
\tIF "Plant".blink.Q THEN
\t    "Plant".lamp := NOT "Plant".lamp;
\tEND_IF;
\t"Plant".speed := "Plant".setpoint * 2.5;
END_ORGANIZATION_BLOCK
`;
const PLANT = `DATA_BLOCK "Plant"
VERSION : 0.1
   VAR
      cycles : DInt;
      lamp : Bool;
      setpoint : Real;
      speed : Real;
      blink : TON_TIME;
   END_VAR
BEGIN
   setpoint := 4.0;
END_DATA_BLOCK
`;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "rung-sim-"));
  mkdirSync(join(dir, "plc", "PLC_1", "blocks"), { recursive: true });
  writeFileSync(join(dir, "plc", "PLC_1", "blocks", "Main.scl"), MAIN);
  writeFileSync(join(dir, "plc", "PLC_1", "blocks", "Plant.db"), PLANT);
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("rung simulate (virtual S7-1500)", () => {
  it("runs the cyclic OB and serves changing values over the Web API", async () => {
    const plc = await startVirtualPlc(workspace(), { host: "127.0.0.1", port: 0, cycleMs: 5 });
    try {
      const c = new WebApiClient({ url: plc.url, user: "any", password: "x" });
      const a = await c.read(['"Plant".cycles', '"Plant".speed', '"Plant".nope']);
      await sleep(200);
      const b = await c.read(['"Plant".cycles']);
      expect(a[1]).toMatchObject({ value: 10 }); // start value 4.0 * 2.5
      expect(Number(b[0]!.value)).toBeGreaterThan(Number(a[0]!.value));
      expect(a[2]!.error).toMatch(/Address does not exist/);
      expect(plc.cycles()).toBeGreaterThan(10);
      await c.logout();
    } finally {
      await plc.close();
    }
  });

  it("accepts writes (to drive inputs in a test) and rejects calls without a login", async () => {
    const plc = await startVirtualPlc(workspace(), { host: "127.0.0.1", port: 0, cycleMs: 5 });
    try {
      const post = async (body: unknown, token?: string) =>
        (await fetch(plc.url + "/api/jsonrpc", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-auth-token": token } : {}) }, body: JSON.stringify(body) })).json() as Promise<{ result?: unknown; error?: { code: number } }>;
      expect((await post({ jsonrpc: "2.0", id: 1, method: "PlcProgram.Read", params: { var: '"Plant".speed' } })).error?.code).toBe(2);
      const login = (await post({ jsonrpc: "2.0", id: 2, method: "Api.Login", params: { user: "u", password: "p" } })).result as { token: string };
      expect(typeof login.token).toBe("string"); // the shape a real S7-1500 answers with
      await post({ jsonrpc: "2.0", id: 3, method: "PlcProgram.Write", params: { var: '"Plant".setpoint', value: 8 } }, login.token);
      await sleep(50);
      expect((await post({ jsonrpc: "2.0", id: 4, method: "PlcProgram.Read", params: { var: '"Plant".speed' } }, login.token)).result).toBe(20);
    } finally {
      await plc.close();
    }
  });

  it("rung live read works against it end to end", async () => {
    const dir = workspace();
    const plc = await startVirtualPlc(dir, { host: "127.0.0.1", port: 0, cycleMs: 5 });
    try {
      writeFileSync(join(dir, "rung.toml"), `format = 1\ndevices = []\n[project]\npath = "C:\\\\x.ap20"\ntiaVersion = "V20"\n[bridge]\ncommand = "x"\n[live.webapi]\nurl = "${plc.url}"\nuser = "any"\n`);
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["live", "read", '"Plant".speed'], { cwd: dir, stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: { RUNG_WEBAPI_PASSWORD: "x" } });
      expect(err.join("")).toBe("");
      expect(code).toBe(0);
      expect(out.join("")).toContain('"Plant".speed  10');
    } finally {
      await plc.close();
    }
  });

  it("explains when there is nothing it can run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rung-sim-"));
    mkdirSync(join(dir, "plc", "PLC_1", "blocks"), { recursive: true });
    await expect(startVirtualPlc(dir, { host: "127.0.0.1", port: 0, cycleMs: 5 })).rejects.toThrow(/no SCL organization block/);
  });
});
