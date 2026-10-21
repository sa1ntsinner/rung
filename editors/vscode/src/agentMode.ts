// SPDX-License-Identifier: MIT
// Modes are read through the CLI; changes always ask for a name in a real terminal.
import * as vscode from "vscode";
import type { RungCli } from "./runner/cli";
import type { RungWorkspace } from "./workspace";

interface PlcMode {
  plc: string;
  mode: "manual" | "ask" | "auto" | "bypass";
  source: string;
  expires?: string;
  actions: string[];
}

export class AgentMode implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("rung.agentMode", vscode.StatusBarAlignment.Left, 49);
  private readonly subs: vscode.Disposable[];
  private plcs: PlcMode[] = [];
  private pending: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly ws: RungWorkspace, private readonly cli: RungCli) {
    this.item.name = "rung agent mode";
    this.item.command = "rung.agentMode";
    const refresh = () => void this.refresh();
    let root = ws.root;
    const timer = setInterval(refresh, 30_000);
    this.subs = [this.item, ws.onDidChange(() => { if (root !== ws.root) { root = ws.root; refresh(); } }), vscode.window.onDidChangeWindowState((s) => { if (s.focused) refresh(); }),
      vscode.window.onDidCloseTerminal(refresh), vscode.commands.registerCommand("rung.agentMode", () => this.choose()),
      { dispose: () => clearInterval(timer) }];
    refresh();
  }

  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const root = this.ws.root;
    if (!root || !this.ws.hasConfig) { this.plcs = []; this.item.hide(); return; }
    this.pending = (async () => {
      try {
        const r = await this.cli.capture(["agent-mode", "--json"], { quiet: true, timeoutMs: 10_000 });
        if (this.disposed || root !== this.ws.root) return;
        const data = r.code === 0 ? JSON.parse(r.output) as { plcs?: PlcMode[] } : undefined;
        this.plcs = Array.isArray(data?.plcs) ? data.plcs : [];
        const active = this.plcs.filter((p) => p.mode !== "manual");
        if (!active.length) { this.item.hide(); return; }
        this.item.text = `$(shield) agent: ${[...new Set(active.map((p) => p.mode))].join(" / ")}`;
        this.item.backgroundColor = active.some((p) => p.mode === "bypass") ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
        this.item.tooltip = this.plcs.map((p) => `${p.plc}: ${p.mode} (${p.source})${p.expires ? ` until ${p.expires}` : ""}`).join("\n");
        this.item.show();
      } catch { this.plcs = []; if (!this.disposed) this.item.hide(); }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async choose(): Promise<void> {
    await this.refresh();
    const root = this.ws.root;
    if (!root || !this.ws.hasConfig) return;
    const mode = await vscode.window.showQuickPick([
      { label: "manual", description: "Refuse PLC changes by agents" },
      { label: "ask", description: "Ask in a native dialog for each action" },
      { label: "auto", description: "Allow selected actions; ask for others" },
      { label: "bypass", description: "Allow every action, including force" },
    ], { title: "rung: Agent Mode…" });
    if (!mode) return;
    const plc = await vscode.window.showQuickPick([
      { label: "Workspace default", description: root, plc: undefined as string | undefined },
      ...this.plcs.filter((p) => p.plc).map((p) => ({ label: p.plc, description: p.mode, plc: p.plc })),
    ], { title: "Apply agent mode to" });
    if (!plc) return;
    const args = ["agent-mode", mode.label];
    if (plc.plc) args.push("--plc", plc.plc);
    if (mode.label === "auto") {
      const actions = await vscode.window.showQuickPick(["download", "write", "run-stop", "force", "alarm-ack", "writes-on", "openness-setup", "bridge"].map((label, i) => ({ label, picked: i < 3 })), { title: "Actions allowed without asking", canPickMany: true });
      if (!actions) return;
      args.push("--actions", actions.map((a) => a.label).join(","));
    }
    const duration = await vscode.window.showQuickPick([{ label: "8 hours", duration: "8h" }, { label: "Until I change it", duration: undefined }], { title: "How long should this mode last?" });
    if (!duration || this.ws.root !== root) return;
    if (duration.duration) args.push("--for", duration.duration);
    const inv = this.cli.invocation(args);
    // Keep the inherited environment: an agent cannot set modes through this command either.
    vscode.window.createTerminal({ name: "rung agent mode", cwd: root, shellPath: inv.file, shellArgs: inv.args }).show();
  }

  dispose(): void { this.disposed = true; for (const sub of this.subs) sub.dispose(); }
}
