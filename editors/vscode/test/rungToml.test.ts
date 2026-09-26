// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { formatPlcSection, parseRungToml, upsertPlcSection } from "../src/core/rungToml";

const toml = `# rung workspace
format = 1
devices = ["PLC_1"]

[project]
path = "C:/p/Plant.ap20"
tiaVersion = "V20"

[download]
enabled = true
allow = ["stop-cpu"]
start_after = false
hardware = true

[plc.PLC_1]
mode = "PN/IE"
pc_interface = "Old NIC"
pc_interface_number = 1

# live data
[live.webapi]
url = "https://192.168.0.1"
user = "rung"
`;

const conn = { mode: "PN/IE", pcInterface: "Intel(R) Ethernet", pcInterfaceNumber: 1, targetInterface: "1 X1" };

describe("parseRungToml", () => {
  it("reads devices, connections and download defaults", () => {
    const c = parseRungToml(toml);
    expect(c.devices).toEqual(["PLC_1"]);
    expect(c.projectPath).toBe("C:/p/Plant.ap20");
    expect(c.plc.PLC_1).toEqual({ mode: "PN/IE", pcInterface: "Old NIC", pcInterfaceNumber: 1 });
    expect(c.download).toMatchObject({ allow: ["stop-cpu"], startAfter: false, hardware: true, onlyChanges: true, confirm: "type-name" });
  });
  it("falls back to defaults", () => {
    const c = parseRungToml("format = 1\n");
    expect(c.devices).toEqual([]);
    expect(c.download.enabled).toBe(true);
    expect(c.download.allow).toEqual([]);
  });
  it("throws on TOML syntax errors", () => {
    expect(() => parseRungToml("[broken")).toThrow();
  });
});

describe("upsertPlcSection", () => {
  it("replaces the existing table and keeps the rest", () => {
    const next = upsertPlcSection(toml, "PLC_1", conn);
    expect(parseRungToml(next).plc.PLC_1).toEqual(conn);
    expect(next).toContain("# live data\n[live.webapi]");
    expect(next).not.toContain("Old NIC");
    expect(next.match(/\[plc\.PLC_1\]/g)).toHaveLength(1);
  });

  it("appends a new table", () => {
    const next = upsertPlcSection(toml, "PLC 2", conn);
    expect(next.endsWith('[plc."PLC 2"]\nmode = "PN/IE"\npc_interface = "Intel(R) Ethernet"\npc_interface_number = 1\ntarget_interface = "1 X1"\n')).toBe(true);
    const parsed = parseRungToml(next);
    expect(parsed.plc["PLC 2"]).toEqual(conn);
    expect(parsed.plc.PLC_1?.pcInterface).toBe("Old NIC");
  });

  it("matches quoted headers and keeps CRLF", () => {
    const crlf = 'format = 1\r\n\r\n[plc."PLC_1"]\r\nmode = "x"\r\npc_interface = "y"\r\n';
    const next = upsertPlcSection(crlf, "PLC_1", conn);
    expect(next).not.toMatch(/[^\r]\n/);
    expect(parseRungToml(next).plc.PLC_1).toEqual(conn);
  });

  it("escapes quotes and backslashes", () => {
    const s = formatPlcSection("A", { mode: 'm"', pcInterface: "C:\\x", pcInterfaceNumber: 3 });
    expect(parseRungToml(s).plc.A).toEqual({ mode: 'm"', pcInterface: "C:\\x", pcInterfaceNumber: 3 });
  });

  it("works on an empty file", () => {
    expect(parseRungToml(upsertPlcSection("", "P", conn)).plc.P).toEqual(conn);
  });
});
