// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@rung/core";
import { S7CommPlusClient, selectLiveTarget } from "../src/index.js";

describe("native online client", () => {
  it("keeps ordered per-item typed values, scope and read-only requests", async () => {
    const methods: string[] = [];
    const client = new S7CommPlusClient({
      async request(method: string, params: Record<string, unknown>) {
        methods.push(method);
        if (method === "online.connect") return { sessionId: "s", scope: { device: params.device, address: params.address, transport: "s7commplus", epoch: 1 }, identity: {} };
        if (method === "online.read") return { at: 100, scope: { device: "P", address: "192.168.250.1", transport: "s7commplus", epoch: 1 }, items: [
          { name: '"DB".Big', value: "18446744073709551615", display: "18446744073709551615", type: "ULINT", observedAt: 100 },
          { name: "DB.Bad", error: "denied", errorCode: "ACCESS_DENIED" },
        ] };
        return { disconnected: true };
      },
    });
    await client.connect({ device: "P", address: "192.168.250.1", certificateSha256: "A".repeat(64) });
    expect(await client.read(['"DB".Big', "DB.Bad"])).toMatchObject([
      { value: "18446744073709551615", type: "ULINT" }, { errorCode: "ACCESS_DENIED" },
    ]);
    await expect(client.call("online.commit", {})).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await client.close();
    await client.close();
    expect(methods).toEqual(["online.connect", "online.read", "online.disconnect"]);
  });
  it("requires explicit multi-PLC binding and keeps a file's PLC scope", () => {
    const config = defaultConfig("p", "V20", "", ["A", "B"]);
    config.live = { plc: {
      A: { transport: "s7commplus", address: "192.168.250.1", allowWrites: false },
      B: { transport: "s7commplus", address: "192.168.250.2", allowWrites: false },
    } };
    expect(() => selectLiveTarget(config)).toThrow(/device/);
    expect(selectLiveTarget(config, { file: "plc/B/blocks/DB.scl" }).device).toBe("B");
    expect(() => selectLiveTarget(config, { device: "A", file: "plc/B/blocks/DB.scl" })).toThrow(/scope/);
    config.live.plc!.B!.address = "192.168.1.1";
    expect(() => selectLiveTarget(config, { device: "B" })).toThrow(/refused/);
  });
});
