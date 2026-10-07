// SPDX-License-Identifier: MIT
// Choosing how to reach a PLC. `rung online` / `rung download` find the PLC by themselves and save
// [plc.<device>]; when they cannot decide (NO_TARGET) this asks: `rung connect --json` lists what answers,
// a quick pick chooses, `rung connect --use …` saves it. Nothing found: rung's explanation in a modal,
// with Retry and a manual choice among all PG/PC interfaces (`rung interfaces`).
import * as vscode from "vscode";
import { Args, parseInterfaces, type InterfaceOption } from "../core/args";
import { automaticChoice, connectAddressArgs, connectUseArgs, parseConnectJson, plcPasswordKey, sameTarget, splitExplanation, type ConnectChoice, type ConnectReport, type ConnectTarget, type NoTarget } from "../core/connect";
import type { Output } from "../output";
import { RungCli } from "../runner/cli";
import type { RungWorkspace } from "../workspace";

type PickItem = vscode.QuickPickItem & { target?: ConnectTarget; manual?: boolean; change?: ConnectChoice["addressChange"] };

const via = (t: ConnectTarget) => `${t.pcInterface}${t.targetInterface ? ` → ${t.targetInterface}` : ""}`;

export class Connector {
  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    private readonly out: Output,
    private readonly secrets?: vscode.SecretStorage,
  ) {}

  /** Per project, bridge host and PLC: a rebound folder never sends one PLC's password to another. */
  private passwordKey(device: string): string {
    return plcPasswordKey(this.ws.root, this.ws.config?.projectPath, this.ws.config?.bridgeHost, device);
  }

  /** The environment that gives `rung online` / `rung compare` the PLC's password (and user), when typed before. */
  async passwordEnv(device: string): Promise<Record<string, string>> {
    const kept = await this.secrets?.get(this.passwordKey(device));
    if (!kept) return {};
    const user = await this.secrets?.get(`${this.passwordKey(device)}|user`);
    return { RUNG_PLC_PASSWORD: kept, ...(user ? { RUNG_PLC_USER: user } : {}) };
  }

  /**
   * The PLC asked for a password (or refused the kept one): ask for it (and for a user when its user management
   * wants one), keep both in VS Code's secret storage and return the environment to try again with; undefined
   * when the person cancels.
   */
  async askPassword(device: string, output = ""): Promise<Record<string, string> | undefined> {
    const key = this.passwordKey(device);
    await this.secrets?.delete(key);
    let user = await this.secrets?.get(`${key}|user`);
    if (/a user and a password/.test(output)) {
      user = await vscode.window.showInputBox({ title: `User of ${device}`, prompt: `${device} asks for a user of its user management to go online.`, value: (await this.secrets?.get(`${key}|user`)) ?? "", ignoreFocusOut: true });
      if (!user) return undefined;
    }
    const typed = await vscode.window.showInputBox({
      title: `Password of ${device}`,
      prompt: `${device} asks for a password to go online${user ? ` (user ${user})` : " (its access protection)"}. Kept in VS Code's secret storage, never in files.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!typed) return undefined;
    await this.secrets?.store(key, typed);
    if (user) await this.secrets?.store(`${key}|user`, user);
    else await this.secrets?.delete(`${key}|user`);
    return { RUNG_PLC_PASSWORD: typed, ...(user ? { RUNG_PLC_USER: user } : {}) };
  }
  /** `rung connect --json` with a progress notification; undefined (after telling the user) when it fails. */
  async scan(device: string): Promise<ConnectReport | undefined> {
    const r = await this.cli.capture(["connect", "--json", "--plc", device], { progress: `rung: looking for ${device} on the network…`, cancellable: true });
    if (r.error) return undefined;
    const report = r.code === 0 ? parseConnectJson(r.output) : undefined;
    if (!report) {
      if (r.code !== null) void this.failure(`rung connect failed: ${RungCli.summary(r.output)}`);
      return undefined;
    }
    return report;
  }

  /**
   * Lets the user choose a connection for `device` and saves it. `known` is the NO_TARGET error that led
   * here (saves a second network scan when rung already said nothing answers). Returns the saved target.
   */
  async choose(device: string, known?: NoTarget): Promise<ConnectTarget | undefined> {
    let notFound = known?.kind === "notFound" ? known.message : undefined;
    for (;;) {
      if (!notFound) {
        const report = await this.scan(device);
        if (!report) return undefined;
        if (report.candidates.length || report.reachable.length) return this.pickFrom(device, report);
        notFound = report.notFound ?? `${device} was not found on the network.`;
      }
      const next = await this.explainNotFound(device, notFound);
      if (next === "retry") {
        notFound = undefined;
        continue;
      }
      if (next === "manual") return this.pickManually(device);
      return undefined;
    }
  }

  /**
   * For a download: makes sure [plc.<device>] exists before the confirmation dialog names it. Takes the
   * one obvious match silently (as rung does), otherwise asks.
   */
  async ensure(device: string): Promise<ConnectTarget | undefined> {
    const saved = this.ws.config?.plc[device];
    if (saved) return saved;
    const report = await this.scan(device);
    if (!report) return undefined;
    const auto = automaticChoice(report);
    if (auto) return (await this.save(device, auto.target, auto.label)) ? auto.target : undefined;
    if (report.candidates.length || report.reachable.length) return this.pickFrom(device, report);
    const next = await this.explainNotFound(device, report.notFound ?? `${device} was not found on the network.`);
    if (next === "retry") return this.choose(device);
    if (next === "manual") return this.pickManually(device);
    return undefined;
  }

  private async pickFrom(device: string, report: ConnectReport): Promise<ConnectTarget | undefined> {
    const current = this.ws.config?.plc[device] ?? report.saved ?? undefined;
    const item = (c: ConnectChoice): PickItem => ({
      label: `${sameTarget(c.target, current) ? "$(check) " : ""}${c.label}`,
      description: c.reason === "address-match" ? "project address" : c.reason === "simulation" ? "S7-PLCSIM" : "other address",
      detail: `${c.target.mode} · ${via(c.target)}${(c.target.pcInterfaceNumber ?? 1) !== 1 ? ` · number ${c.target.pcInterfaceNumber}` : ""}`,
      target: c.target,
      ...(c.addressChange ? { change: c.addressChange } : {}),
    });
    const seen = new Set<string>();
    const unique = (list: ConnectChoice[]) =>
      list.filter((c) => {
        const k = JSON.stringify([c.target, c.found?.address]);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const candidates = unique(report.candidates);
    // rung lists a matching device under "reachable" too (without the CPU interface): show it once
    const others = unique(report.reachable.filter((r) => !report.candidates.some((c) => c.target.pcInterface === r.target.pcInterface && c.found?.address === r.found?.address)));
    const items: PickItem[] = [
      ...(candidates.length ? [{ label: "matches the project", kind: vscode.QuickPickItemKind.Separator } as PickItem, ...candidates.map(item)] : []),
      ...(others.length ? [{ label: "other reachable devices", kind: vscode.QuickPickItemKind.Separator } as PickItem, ...others.map(item)] : []),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(list-selection) Choose a PG/PC interface manually…", detail: "all interfaces TIA Portal offers on this PC", manual: true },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `How to reach ${device}`,
      placeHolder: candidates.length > 1 ? `${candidates.length} interfaces reach ${device}: choose the one to use` : `Choose the connection for ${device}`,
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!pick) return undefined;
    if (pick.manual) return this.pickManually(device);
    if (!(await this.save(device, pick.target!, pick.label.replace(/^\$\(check\) /, "")))) return undefined;
    if (pick.change) await this.offerAddress(device, pick.change);
    return pick.target;
  }

  /** V21 can use an online address; every version can edit the project address. */
  private async offerAddress(device: string, change: NonNullable<ConnectChoice["addressChange"]>): Promise<void> {
    const use = `Use ${change.to} in the Project`;
    const online = this.ws.config?.tiaVersion === "V21" ? `Go Online at ${change.to}` : undefined;
    const pick = await vscode.window.showWarningMessage(
      `${device} answers at ${change.to}, but the project gives it ${change.from} (${change.interface}).${online ? " V21 can go online at that address without changing the project." : " TIA Portal goes online only at the project's address."}`,
      { modal: true, detail: `${online ? "Go Online saves the address in rung.toml; the project stays unchanged. " : ""}Use in the Project writes ${change.to} into plc/${device}/hardware/network.yaml; sync takes it to TIA Portal like any edit (with writes on).` },
      ...(online ? [online] : []),
      use,
    );
    if (pick !== use && (!online || pick !== online)) return;
    const r = await this.cli.capture([...connectAddressArgs(device, change.to), ...(pick === use ? ["--project-address"] : [])]);
    if (!r.error && r.code === 0) await this.ws.reload();
    if (!r.error && r.code !== 0) void this.failure(`Could not change the address: ${RungCli.summary(r.output)}`);
  }

  private async explainNotFound(device: string, text: string): Promise<"retry" | "manual" | undefined> {
    const { title, detail } = splitExplanation(text);
    this.out.error(`${device}: ${text.replace(/\r?\n/g, "\n    ")}`);
    const pick = await vscode.window.showWarningMessage(title, { modal: true, detail }, "Retry", "Choose manually", "Show details");
    if (pick === "Retry") return "retry";
    if (pick === "Choose manually") return "manual";
    if (pick === "Show details") {
      const doc = await vscode.workspace.openTextDocument({ content: `${text}\n`, language: "plaintext" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    return undefined;
  }

  /** Every (mode, PG/PC interface, target interface) TIA Portal offers, from `rung interfaces`. */
  async pickManually(device: string): Promise<ConnectTarget | undefined> {
    const r = await this.cli.capture(Args.interfaces(device, false), { progress: `rung: listing PG/PC interfaces for ${device}…`, cancellable: true });
    if (r.error) return undefined;
    if (r.code !== 0) {
      void this.failure(`rung interfaces failed: ${RungCli.summary(r.output)}`);
      return undefined;
    }
    return this.pickInterface(device, parseInterfaces(r.output), `Connection for ${device}`);
  }

  /** Quick pick over interface options (also used by "Interfaces…"); saves the choice. */
  async pickInterface(device: string, options: InterfaceOption[], title: string, placeHolder?: string): Promise<ConnectTarget | undefined> {
    if (!options.length) {
      void vscode.window.showWarningMessage(`TIA Portal offers no PG/PC interface with a target interface for ${device} on this PC.`);
      return undefined;
    }
    const current = this.ws.config?.plc[device];
    const pick = await vscode.window.showQuickPick(
      options.map((o): PickItem => {
        const target: ConnectTarget = { mode: o.mode, pcInterface: o.pcInterface, pcInterfaceNumber: o.pcInterfaceNumber, targetInterface: o.targetInterface };
        return {
          label: `${sameTarget(target, current) ? "$(check) " : ""}${o.pcInterface}`,
          description: `${o.mode} · ${o.targetInterface}${o.pcInterfaceNumber !== 1 ? ` · number ${o.pcInterfaceNumber}` : ""}`,
          detail: o.reachable.length ? `reachable: ${o.reachable.join("; ")}` : undefined,
          target,
        };
      }),
      { title, placeHolder: placeHolder ?? `PG/PC interface and CPU interface to use for ${device}`, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true },
    );
    if (!pick?.target) return undefined;
    return (await this.save(device, pick.target, `${pick.target.pcInterface} → ${pick.target.targetInterface}`)) ? pick.target : undefined;
  }

  /** `rung connect --use …`; rung writes [plc.<device>] into rung.toml. */
  async save(device: string, t: ConnectTarget, label: string): Promise<boolean> {
    const r = await this.cli.capture(connectUseArgs(device, t));
    if (r.error) return false;
    if (r.code !== 0) {
      void this.failure(`Could not save the connection: ${RungCli.summary(r.output)}`);
      return false;
    }
    await this.ws.reload();
    if (this.ws.configError || !this.ws.config?.plc[device]) {
      const pick = await vscode.window.showErrorMessage(
        `rung saved the connection, but rung.toml ${this.ws.configError ? `no longer reads: ${this.ws.configError}` : `has no [plc.${device}] table now`}. Fix it by hand (for example a second [plc.${device}] table).`,
        "Open rung.toml",
      );
      if (pick) await vscode.commands.executeCommand("rung.openConfig");
      return false;
    }
    void vscode.window.setStatusBarMessage(`rung: ${device} via ${label} (saved in rung.toml)`, 6000);
    return true;
  }

  private async failure(message: string): Promise<void> {
    const pick = await vscode.window.showErrorMessage(message, "Show output");
    if (pick) this.out.show();
  }
}
