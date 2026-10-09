// SPDX-License-Identifier: BUSL-1.1
// Finding the PLC on the network, the way TIA Portal's "Go online" dialog does, but without the dialog:
// the project knows the CPU's addresses, the bridge lists what every PG/PC interface can reach, and the one
// match is remembered in rung.toml. Several matches or none: rung explains and lets the user choose.
import { spawnSync } from "node:child_process";
import { isIPv4 } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceError, writeFileAtomic, type RungConfig } from "@rung/core";
import type { ConnectionOptions, ConnectionTarget } from "@rung/bridge-client";

export interface Candidate {
  target: ConnectionTarget;
  /** what answered on that interface */
  found?: { name: string; address: string; deviceSeries: string };
  /** why it is a candidate */
  reason: "address-match" | "simulation" | "reachable";
}

/** The target interface ("1 X1") that belongs to the project interface with this address. */
function targetInterfaceFor(options: ConnectionOptions, address: string, available: string[]): string | undefined {
  if (available.length === 1) return available[0];
  const pn = options.plcAddresses.filter((a) => /\d+\.\d+\.\d+\.\d+/.test(a.address));
  const i = pn.findIndex((a) => a.address === address);
  if (i < 0) return undefined;
  // TIA names the CPU's PROFINET interfaces X1, X2, ... in the order the project lists them
  return available.find((t) => new RegExp(`X${i + 1}$`).test(t));
}

export function candidates(options: ConnectionOptions): Candidate[] {
  const ours = new Set(options.plcAddresses.map((a) => a.address));
  const out: Candidate[] = [];
  for (const m of options.modes)
    for (const p of m.pcInterfaces) {
      for (const d of p.accessible ?? []) {
        if (!ours.has(d.address)) continue;
        const ti = targetInterfaceFor(options, d.address, p.targetInterfaces);
        out.push({ target: { mode: m.name, pcInterface: p.name, pcInterfaceNumber: p.number, ...(ti ? { targetInterface: ti } : {}) }, found: d, reason: "address-match" });
      }
      if (/plcsim/i.test(p.name) && p.targetInterfaces.length)
        out.push({ target: { mode: m.name, pcInterface: p.name, pcInterfaceNumber: p.number, targetInterface: p.targetInterfaces[0]! }, reason: "simulation" });
    }
  return out;
}

/** Every reachable Siemens device, for the case where the PLC answers under another address. */
export function reachable(options: ConnectionOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const m of options.modes)
    for (const p of m.pcInterfaces)
      for (const d of p.accessible ?? [])
        out.push({ target: { mode: m.name, pcInterface: p.name, pcInterfaceNumber: p.number, ...(p.targetInterfaces.length === 1 ? { targetInterface: p.targetInterfaces[0]! } : {}) }, found: d, reason: "reachable" });
  return out;
}

export function describe(c: Candidate): string {
  const via = `${c.target.pcInterface}${c.target.targetInterface ? ` → ${c.target.targetInterface}` : ""}`;
  if (c.reason === "simulation") return `S7-PLCSIM (${via})`;
  return `${c.found!.name || "device"} at ${c.found!.address}${c.found!.deviceSeries ? ` (${c.found!.deviceSeries})` : ""} via ${via}`;
}

const IPV4 = { test: (s: string) => isIPv4(s) };

/**
 * The PLC answered at an address the project does not give it. TIA Portal V19/V20 go online only at the project's
 * address (measured: ApplyConfiguration with another address is refused as invalid), as TIA Portal's own dialog does,
 * so the way there is the project's address: the interface in that subnet, else the first PROFINET one.
 */
export function addressChange(options: ConnectionOptions, found: string): { interface: string; from: string; to: string } | undefined {
  if (!IPV4.test(found)) return undefined;
  const pn = options.plcAddresses.filter((a) => IPV4.test(a.address));
  if (!pn.length || pn.some((a) => a.address === found)) return undefined;
  const net = (ip: string) => ip.split(".").slice(0, 3).join(".");
  const same = pn.find((a) => net(a.address) === net(found)) ?? pn[0]!;
  return { interface: same.interface, from: same.address, to: found };
}

/** network.yaml with one interface's ip changed; the rest of the file stays as it is. */
export function withNetworkAddress(yaml: string, device: string, iface: string, ip: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.trim() === `"${device} / ${iface}":`);
  if (start < 0) throw new WorkspaceError("CONFIG_INVALID", `network.yaml has no "${device} / ${iface}"`);
  for (let i = start + 1; i < lines.length && /^\s/.test(lines[i]!); i++)
    if (/^\s+ip:/.test(lines[i]!)) {
      lines[i] = lines[i]!.replace(/(ip:\s*)\S+/, `$1${ip}`);
      return lines.join("\n");
    }
  throw new WorkspaceError("CONFIG_INVALID", `"${device} / ${iface}" in network.yaml has no ip`);
}

export function notFoundMessage(device: string, options: ConnectionOptions): string {
  const addrs = options.plcAddresses.filter((a) => /\d+\.\d+\.\d+\.\d+/.test(a.address));
  const adapters = options.modes.flatMap((m) => m.pcInterfaces.map((p) => p.name));
  const failed = options.modes.flatMap((m) => m.pcInterfaces.filter((p) => p.scanError).map((p) => `${p.name} could not be scanned: ${p.scanError}`));
  const seen = reachable(options);
  return [
    `${device} was not found on the network.`,
    addrs.length ? `The project gives it ${addrs.map((a) => `${a.address} (${a.interface})`).join(", ")}.` : "The project gives it no IP address.",
    adapters.length ? `rung looked on: ${adapters.join(", ")}.` : "TIA Portal offers no PG/PC interface on this PC.",
    ...failed,
    seen.length ? `Found there instead: ${seen.map(describe).join("; ")}. Choose one with: rung connect --pick` : "No Siemens device answered.",
    addrs[0] ? `Check the cable and that this PC has an address in the PLC's subnet (for ${addrs[0].address}, e.g. ${addrs[0].address.replace(/\.\d+$/, ".100")}/24).` : "Check the cable and the PLC's address in the project.",
    // TIA Portal lists the PLCSIM interface only when it started after PLCSIM: every TIA Portal on the PC, not only rung's
    adapters.some((a) => /plcsim/i.test(a))
      ? "For a simulation: S7-PLCSIM is listed; check that its instance runs and has the project's address (after the first download it does)."
      : plcsimRunning()
        ? "S7-PLCSIM runs, but TIA Portal does not list its interface: TIA Portal shows it only when it started after PLCSIM. Close every TIA Portal (and stop rung watch), then run this again."
        : "For a simulation, start S7-PLCSIM first, then TIA Portal.",
  ].join("\n");
}

/** Whether S7-PLCSIM (V18 and newer) runs on this PC. */
function plcsimRunning(): boolean {
  if (process.platform !== "win32") return false;
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return /"S7PLCSIMV\d+\.exe"/i.test(r.stdout ?? "");
}

/** Adds (or replaces) [plc.<device>] in rung.toml, keeping everything else of the file as the user wrote it. */
export async function saveTarget(ws: string, device: string, t: ConnectionTarget): Promise<void> {
  const file = join(ws, "rung.toml");
  const text = await readFile(file, "utf8");
  const header = `[plc.${/^[A-Za-z0-9_-]+$/.test(device) ? device : JSON.stringify(device)}]`;
  const block = [
    header,
    `# found by rung connect; change it with rung connect --pick`,
    `mode = ${JSON.stringify(t.mode)}`,
    `pc_interface = ${JSON.stringify(t.pcInterface)}`,
    `pc_interface_number = ${t.pcInterfaceNumber ?? 1}`,
    ...(t.targetInterface ? [`target_interface = ${JSON.stringify(t.targetInterface)}`] : []),
    ...(t.address ? [`address = ${JSON.stringify(t.address)}`] : []),
    "",
  ].join("\n");
  const lines = text.split(/\r?\n/);
  // [plc.X], [ plc.X ] # comment, [plc."X"]: every spelling of the same table counts
  const esc = device.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isHeader = new RegExp(`^\\s*\\[\\s*plc\\s*\\.\\s*(?:${esc}|"${esc}"|'${esc}')\\s*\\]\\s*(#.*)?$`);
  const start = lines.findIndex((l) => isHeader.test(l));
  let next: string;
  if (start < 0) next = text.replace(/\s*$/, "\n\n") + block;
  else {
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    next = [...lines.slice(0, start), ...block.trimEnd().split("\n"), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  await writeFileAtomic(file, next.endsWith("\n") ? next : next + "\n");
}

export function targetOf(config: RungConfig, device: string): ConnectionTarget | undefined {
  const c = config.plc[device];
  return c ? { mode: c.mode, pcInterface: c.pcInterface, pcInterfaceNumber: c.pcInterfaceNumber, ...(c.targetInterface ? { targetInterface: c.targetInterface } : {}), ...(c.address ? { address: c.address } : {}) } : undefined;
}

export class NoTargetError extends WorkspaceError {
  constructor(message: string) {
    super("CONFIG_INVALID", message);
  }
}
