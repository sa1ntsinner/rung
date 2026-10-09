// SPDX-License-Identifier: BUSL-1.1
import { isIPv4 } from "node:net";
import { WorkspaceError, type RungConfig, type LivePlcConfig } from "@rung/core";
import { BridgeError, type OnlineConnectRequest, type OnlineConnectResult, type OnlineReadResult, type OnlineStateResult, type OnlineMethods } from "@rung/bridge-client";

export interface OnlineRpc { request(method: string, params: Record<string, unknown>): Promise<unknown> }
const READ_METHODS = new Set(["online.connect", "online.browse", "online.read", "online.state", "online.disconnect", "online.certificate", "online.subscribe", "online.unsubscribe", "online.watchTable", "online.alarms", "online.capture"]);

/** Read-only adapter over the existing bridge envelope. The caller owns the host process. */
export class S7CommPlusClient {
  info?: OnlineConnectResult;
  constructor(private readonly rpc: OnlineRpc) {}
  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!READ_METHODS.has(method)) throw new BridgeError("UNSUPPORTED_CAPABILITY", `${method} is not a read-only online method`);
    return await this.rpc.request(method, params) as T;
  }
  async connect(target: OnlineConnectRequest): Promise<OnlineConnectResult> {
    if (this.info) throw new BridgeError("BUSY", "Disconnect before changing PLC");
    validateLiveAddress(target.address);
    if (!/^[a-fA-F0-9]{64}$/.test(target.certificateSha256 ?? "")) throw new BridgeError("CERTIFICATE_UNTRUSTED", "Verify and pin the PLC certificate with rung live trust --device <PLC>");
    return this.info = await this.call<OnlineConnectResult>("online.connect", { ...target });
  }
  private session(): string {
    if (!this.info) throw new BridgeError("NOT_FOUND", "No online session");
    return this.info.sessionId;
  }
  async readFrame(names: string[]): Promise<OnlineReadResult> { return this.call("online.read", { sessionId: this.session(), names }); }
  async read(names: string[]) { return (await this.readFrame(names)).items; }
  browse(options: { filter?: string; offset?: number; limit?: number } = {}): Promise<OnlineMethods["online.browse"]["result"]> { return this.call("online.browse", { sessionId: this.session(), ...options }); }
  state(): Promise<OnlineStateResult> { return this.call("online.state", { sessionId: this.session() }); }
  async close(): Promise<void> {
    if (!this.info) return;
    const sessionId = this.info.sessionId;
    this.info = undefined;
    await this.call("online.disconnect", { sessionId });
  }
}

/** Shared target boundary for host callers and the workspace broker. */
export function validateLiveAddress(address: string): void {
  // Reject alternate textual forms before canonical validation; none can reach the host.
  if (/^(?:::ffff:)?192\.168\.(?:0*1)\.(?:0*1)$/i.test(address)) throw new BridgeError("TARGET_REFUSED", "192.168.1.1 is refused before connection");
  if (!isIPv4(address)) throw new WorkspaceError("CONFIG_INVALID", "Live address must be a canonical IPv4 literal");
}

export function selectLiveTarget(config: RungConfig, opts: { device?: string; file?: string } = {}): { device: string; target: LivePlcConfig } {
  const fileDevice = opts.file?.replace(/\\/g, "/").match(/^plc\/([^/]+)\//)?.[1];
  if (fileDevice && opts.device && fileDevice !== opts.device) throw new WorkspaceError("CONFIG_INVALID", "Selected device conflicts with the file's PLC scope");
  const devices = [...new Set([...config.devices, ...Object.keys(config.plc), ...Object.keys(config.live?.plc ?? {})])];
  const device = fileDevice ?? opts.device ?? (devices.length === 1 ? devices[0] : undefined);
  if (!device) throw new WorkspaceError("CONFIG_INVALID", "Choose --device <PLC>; the workspace has no unambiguous live target");
  const target = config.live?.plc?.[device];
  if (!target) throw new WorkspaceError("CONFIG_INVALID", `No [live.plc.${device}] configured`);
  validateLiveAddress(target.address);
  if (target.webapi && new URL(target.webapi.url).hostname !== target.address) throw new WorkspaceError("CONFIG_INVALID", "Web API fallback must bind to the selected PLC");
  return { device, target };
}
