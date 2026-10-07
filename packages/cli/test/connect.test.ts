// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import type { ConnectionOptions } from "@rung/bridge-client";
import { addressChange, notFoundMessage, withNetworkAddress } from "../src/connect.js";

const options = (accessible: { address: string }[], scanError?: string): ConnectionOptions => ({
  device: "PLC_1",
  configured: false,
  plcAddresses: [
    { interface: "PROFINET interface_1", address: "192.168.250.9" },
    { interface: "PROFINET interface_2", address: "192.168.253.1" },
  ],
  modes: [{ name: "PN/IE", pcInterfaces: [{ name: "Intel(R) Ethernet", number: 1, targetInterfaces: ["1 X1", "1 X2"], subnets: [], accessible: accessible.map((a) => ({ name: "plc_1", deviceSeries: "S7-1500", ...a })), ...(scanError ? { scanError } : {}) }] }],
});

const YAML = `# Network settings of PLC_1
"PLC_1 / PROFINET interface_1":
  ip: 192.168.250.9
  subnetMask: 255.255.255.0

"PLC_1 / PROFINET interface_2":
  ip: 192.168.253.1
  subnetMask: 255.255.255.0
`;

describe("a PLC that answers at another address than the project gives it", () => {
  it("is told apart from one the project knows", () => {
    expect(addressChange(options([]), "192.168.253.1")).toBeUndefined();
    // the interface in the same subnet changes; TIA Portal goes online only at the project's address (V19/V20, measured)
    expect(addressChange(options([]), "192.168.250.1")).toEqual({ interface: "PROFINET interface_1", from: "192.168.250.9", to: "192.168.250.1" });
    expect(addressChange(options([]), "10.0.0.5")).toEqual({ interface: "PROFINET interface_1", from: "192.168.250.9", to: "10.0.0.5" });
    // a PROFIBUS or MAC address is not an IP the project could take
    expect(addressChange(options([]), "2")).toBeUndefined();
    expect(addressChange(options([]), "999.168.0.2")).toBeUndefined();
  });

  it("changes only that interface's ip in network.yaml, and nothing else of the file", () => {
    const next = withNetworkAddress(YAML, "PLC_1", "PROFINET interface_1", "192.168.250.1");
    expect(next).toBe(YAML.replace("ip: 192.168.250.9", "ip: 192.168.250.1"));
    expect(() => withNetworkAddress(YAML, "PLC_1", "PROFINET interface_7", "192.168.250.1")).toThrow(/PROFINET interface_7/);
  });

  it("an interface TIA Portal could not scan is named, not taken for an empty network", () => {
    expect(notFoundMessage("PLC_1", options([], "The interface is not connected"))).toMatch(/Intel\(R\) Ethernet could not be scanned: The interface is not connected/);
  });
});
