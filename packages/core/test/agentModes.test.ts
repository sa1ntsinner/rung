// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { effectiveAgentMode, workspaceModeKey, type AgentModeStore } from "../src/agentModes.js";

const root = process.cwd();
const config = defaultConfig("fixture.ap20", "V20", "", ["PLC_1", "PLC_2"]);
const key = workspaceModeKey(root);

describe("agent mode policy", () => {
  it("defaults unknown and real PLCs to manual", () => {
    expect(effectiveAgentMode({}, root, "PLC_1", config).mode).toBe("manual");
  });
  it.each(["manual", "ask", "auto", "bypass"] as const)("resolves workspace %s and a PLC override", mode => {
    const store: AgentModeStore = { workspaces: { [key]: { default: { mode }, plcs: { PLC_2: { mode: "ask" } } } } };
    expect(effectiveAgentMode(store, root, "PLC_1", config)).toMatchObject({ mode, source: "workspace" });
    expect(effectiveAgentMode(store, root, "PLC_2", config)).toMatchObject({ mode: "ask", source: "plc" });
  });
  it("follows previous entries on expiry, then falls back to workspace", () => {
    const store: AgentModeStore = { workspaces: { [key]: { default: { mode: "ask" }, plcs: { PLC_1: {
      mode: "bypass", expires: "2020-01-01T00:00:00Z", previous: { mode: "auto", actions: ["write"] },
    } } } } };
    expect(effectiveAgentMode(store, root, "PLC_1", config)).toMatchObject({ mode: "auto", actions: ["write"] });
    store.workspaces![key]!.plcs!.PLC_1!.previous!.expires = "2020-01-01T00:00:00Z";
    expect(effectiveAgentMode(store, root, "PLC_1", config).mode).toBe("ask");
  });
  it("defaults PLCSIM to auto, never an IP address or vague simulation name", () => {
    const c = defaultConfig("fixture.ap20", "V20");
    c.plc.PLC_1 = { mode: "PN/IE", pcInterface: "PLCSIM Virtual Ethernet Adapter", pcInterfaceNumber: 1 };
    expect(effectiveAgentMode({}, root, "PLC_1", c)).toMatchObject({ mode: "auto", actions: ["download", "write", "run-stop"] });
    c.plc.PLC_1.pcInterface = "Ethernet"; c.plc.PLC_1.address = "127.0.0.1";
    expect(effectiveAgentMode({}, root, "PLC_1", c).mode).toBe("manual");
    expect(effectiveAgentMode({}, root, "PLC_1", c, { simulator: true }).mode).toBe("manual");
    delete c.plc.PLC_1;
    expect(effectiveAgentMode({}, root, "PLC_1", c, { simulator: true }).mode).toBe("auto");
  });
  it("normalizes absolute workspace roots case insensitively only on Windows", () => {
    expect(workspaceModeKey(root + "/.")).toBe(key);
    expect(workspaceModeKey(root.toUpperCase()) === key).toBe(process.platform === "win32");
  });
});
