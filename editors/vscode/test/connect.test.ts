// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { isCompileSummary } from "../src/core/args";
import { automaticChoice, connectAddressArgs, connectUseArgs, parseConnectJson, parseNoTarget, sameTarget, splitExplanation, type ConnectReport } from "../src/core/connect";

const NOT_FOUND = [
  "PLC_1 was not found on the network.",
  "The project gives it 192.168.0.1 (PROFINET interface_1), 192.168.1.1 (PROFINET interface_2).",
  "rung looked on: Ethernet, Wi-Fi.",
  "No Siemens device answered.",
  "Check the cable and that this PC has an address in the PLC's subnet (for 192.168.0.1, e.g. 192.168.0.100/24). For a simulation, start S7-PLCSIM.",
].join("\n");

describe("parseNoTarget", () => {
  it("recognises rung's not-found explanation (several lines)", () => {
    const out = `rung: looking for PLC_1 on the network (up to half a minute)…\nrung: NO_TARGET: ${NOT_FOUND}\n`;
    expect(parseNoTarget(out)).toEqual({ kind: "notFound", message: NOT_FOUND });
  });

  it("recognises the ambiguous case", () => {
    const out = "rung: NO_TARGET: 2 ways to reach PLC_1: a; b. Choose one with rung connect --pick (or rung connect --json for editors).\n";
    expect(parseNoTarget(out)?.kind).toBe("choose");
  });

  it("drops hint lines and ignores other errors", () => {
    expect(parseNoTarget("rung: NO_TARGET: no connection chosen\nhint: something\n")).toEqual({ kind: "other", message: "no connection chosen" });
    expect(parseNoTarget("rung: NO_PROJECT: not open\n")).toBeUndefined();
  });
});

describe("parseConnectJson", () => {
  const json = {
    device: "PLC_1",
    saved: null,
    configuredInTia: false,
    plcAddresses: [],
    candidates: [{ target: { mode: "PN/IE", pcInterface: "Ethernet", pcInterfaceNumber: 1, targetInterface: "1 X1" }, reason: "address-match", label: "plc_1 at 192.168.0.1 via Ethernet → 1 X1", found: { address: "192.168.0.1" } }],
    reachable: [{ target: { mode: "PN/IE", pcInterface: "Ethernet", pcInterfaceNumber: 1 }, reason: "reachable", label: "x" }, { bad: true }],
    notFound: null,
  };

  it("reads the report and skips malformed entries", () => {
    const r = parseConnectJson(`rung: something on stderr\n${JSON.stringify(json, null, 2)}\n`)!;
    expect(r.device).toBe("PLC_1");
    expect(r.candidates).toHaveLength(1);
    expect(r.reachable).toHaveLength(1);
    expect(r.notFound).toBeNull();
  });

  it("returns undefined for anything else", () => {
    expect(parseConnectJson("rung: NO_PROJECT: …")).toBeUndefined();
    expect(parseConnectJson("{ not json }")).toBeUndefined();
    expect(parseConnectJson('{"candidates": []}')).toBeUndefined();
  });

  it("automaticChoice picks like rung: one address match, else one simulation", () => {
    const base = parseConnectJson(JSON.stringify(json))!;
    expect(automaticChoice(base)?.target.pcInterface).toBe("Ethernet");
    const two: ConnectReport = { ...base, candidates: [base.candidates[0]!, { ...base.candidates[0]!, target: { mode: "PN/IE", pcInterface: "USB" } }] };
    expect(automaticChoice(two)).toBeUndefined();
    const sim: ConnectReport = { ...base, candidates: [{ target: { mode: "PN/IE", pcInterface: "PLCSIM", targetInterface: "1 X1" }, reason: "simulation", label: "S7-PLCSIM" }] };
    expect(automaticChoice(sim)?.target.pcInterface).toBe("PLCSIM");
    expect(automaticChoice({ ...base, candidates: [] })).toBeUndefined();
  });
});

describe("connect helpers", () => {
  it("connectUseArgs builds rung connect --use", () => {
    expect(connectUseArgs("PLC_1", { mode: "PN/IE", pcInterface: "Intel(R) Ethernet", pcInterfaceNumber: 2, targetInterface: "1 X2" })).toEqual([
      "connect",
      "--use",
      "Intel(R) Ethernet",
      "--target",
      "1 X2",
      "--mode",
      "PN/IE",
      "--number",
      "2",
      "--plc",
      "PLC_1",
    ]);
    expect(connectUseArgs("PLC_1", { mode: "PN/IE", pcInterface: "Wi-Fi" })).toEqual(["connect", "--use", "Wi-Fi", "--mode", "PN/IE", "--number", "1", "--plc", "PLC_1"]);
  });

  it("sameTarget treats a missing number as 1", () => {
    expect(sameTarget({ mode: "PN/IE", pcInterface: "A", targetInterface: "1 X1" }, { mode: "PN/IE", pcInterface: "A", pcInterfaceNumber: 1, targetInterface: "1 X1" })).toBe(true);
    expect(sameTarget({ mode: "PN/IE", pcInterface: "A" }, { mode: "PN/IE", pcInterface: "A", pcInterfaceNumber: 1, targetInterface: "1 X1" })).toBe(false);
    expect(sameTarget(undefined, { mode: "PN/IE", pcInterface: "A" })).toBe(false);
  });

  it("splitExplanation: first line is the title", () => {
    const { title, detail } = splitExplanation(NOT_FOUND);
    expect(title).toBe("PLC_1 was not found on the network.");
    expect(detail.split("\n\n")).toHaveLength(4);
  });

  it("isCompileSummary", () => {
    expect(isCompileSummary("Compiling finished (errors: 1; warnings: 0)")).toBe(true);
    expect(isCompileSummary("Tag #Missing not defined.")).toBe(false);
  });
});

describe("a PLC answering at another address", () => {
  it("keeps the address change rung reports and builds the command that puts it into the project", () => {
    const r = parseConnectJson(JSON.stringify({ device: "PLC_1", saved: null, configuredInTia: false, candidates: [], reachable: [{ target: { mode: "PN/IE", pcInterface: "Wi-Fi" }, label: "plc_1 at 10.0.0.7", reason: "reachable", found: { address: "10.0.0.7" }, addressChange: { interface: "PROFINET interface_1", from: "192.168.0.1", to: "10.0.0.7" } }], notFound: null }));
    expect(r?.reachable[0]?.addressChange).toEqual({ interface: "PROFINET interface_1", from: "192.168.0.1", to: "10.0.0.7" });
    expect(connectAddressArgs("PLC_1", "10.0.0.7")).toEqual(["connect", "--address", "10.0.0.7", "--plc", "PLC_1"]);
  });
});
