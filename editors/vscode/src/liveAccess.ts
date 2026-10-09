// SPDX-License-Identifier: MIT
import * as vscode from "vscode";
import type { RungWorkspace } from "./workspace";
import type { LivePlc } from "./core/rungToml";
import { plcPasswordKey } from "./core/connect";

export interface LiveConnection { device: string; target: LivePlc | { transport: "codesys"; address: string }; key: string; workspace: string }
export class LiveAccess {
  constructor(private readonly ws: RungWorkspace, private readonly secrets: vscode.SecretStorage) {}
  get scope(): string { return JSON.stringify([this.ws.root, this.ws.config?.projectPath, this.ws.config?.bridgeHost, this.ws.config?.live, this.ws.devices()]); }
  async select(device?: string): Promise<LiveConnection | undefined> {
    await this.ws.reload();
    const scope = this.scope;
    const config = this.ws.config;
    const devices = [...new Set([...this.ws.devices(), ...Object.keys(config?.live?.plc ?? {})])];
    const selected = device ?? (devices.length === 1 ? devices[0] : await vscode.window.showQuickPick(devices, { title: "Monitor which PLC?" }));
    if (!selected || scope !== this.scope) return undefined;
    const legacy = config?.live?.webapi;
    const target = config?.tiaVersion === "CODESYS" ? { transport: "codesys" as const, address: selected }
      : config?.live?.plc[selected] ?? (legacy && devices.length === 1 ? { transport: "webapi" as const, address: new URL(legacy.url).hostname, webapi: legacy } : undefined);
    if (!target) { void vscode.window.showWarningMessage(`Configure [live.plc.${selected}] in rung.toml before monitoring.`); return undefined; }
    const key = `${plcPasswordKey(this.ws.root, config?.projectPath, config?.bridgeHost, selected)}|live|${JSON.stringify([this.ws.root, target])}`;
    return { device: selected, target, key, workspace: scope };
  }
  async environment(connection: LiveConnection, ask = false, output = ""): Promise<Record<string, string> | undefined> {
    const { target, key } = connection;
    if (target.transport === "codesys") return {};
    const variable = target.transport === "s7commplus" ? "RUNG_PLC_PASSWORD" : "RUNG_WEBAPI_PASSWORD";
    let user = target.transport === "s7commplus" ? process.env.RUNG_PLC_USER ?? target.user ?? await this.secrets.get(`${key}|user`) : undefined;
    const password = ask ? undefined : process.env[variable] ?? await this.secrets.get(key);
    if (password !== undefined) return { [variable]: password, ...(user ? { RUNG_PLC_USER: user } : {}) };
    if (!ask && target.transport === "s7commplus") return user ? { RUNG_PLC_USER: user } : {};
    if (ask && target.transport === "s7commplus" && !target.user && /a user and a password|AUTHENTICATION_REQUIRED/.test(output)) {
      user = await vscode.window.showInputBox({ title: `User of ${connection.device}`, value: user ?? "", ignoreFocusOut: true });
      if (user === undefined || connection.workspace !== this.scope) return undefined;
    }
    const typed = await vscode.window.showInputBox({ title: `Password of ${connection.device}`, prompt: `${target.address}${user ? ` · ${user}` : ""}. Kept in VS Code's secret storage, never in files.`, password: true, ignoreFocusOut: true });
    if (typed === undefined || connection.workspace !== this.scope) return undefined;
    await this.secrets.store(key, typed);
    if (user) await this.secrets.store(`${key}|user`, user);
    return { [variable]: typed, ...(user ? { RUNG_PLC_USER: user } : {}) };
  }
}
