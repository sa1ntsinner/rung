// SPDX-License-Identifier: MIT
// Live Values: values pinned from the PLC (its Web API, or rung simulate), read twice a second while the view is
// visible, each with its age and a short history (`rung live watch <names> --json`, read-only). For commissioning:
// the handful of values that matter, side by side, wherever they live. A flight recorder keeps the last ten minutes of
// reads with the person's bookmarks, for a CSV to look at later; integers show in decimal, hex or binary.
import { spawn, type ChildProcess } from "node:child_process";
import { basename, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { sparkline } from "../core/sparkline";
import { Recorder, formatted, recordingAsTest, type Format, type Role } from "../core/recording";
import { readError } from "../core/monitorText";
import type { Lsp } from "../lsp";
import type { DeclModel, DeclRow } from "../protocol/declarations";
import type { RungCli } from "../runner/cli";
import { stopLive } from "../runner/terminal";
import type { RungWorkspace } from "../workspace";
import { takeLiveFrame, type LiveFrame, type Seen } from "../core/liveFrames";
import type { LiveAccess } from "../liveAccess";
import { mutateLive } from "../liveMutation";

const KEY = "rung.liveValues";
const FORMATS = "rung.liveValues.formats";
const INTERVAL = 500;
const TABLE_GROUP = "watch:table";
interface Table { name: string; rows: { key: string; name?: string; address?: string; displayFormat?: string; modifyValue?: string; comments: Record<string, string> }[] }

/** The FB an instance DB belongs to: the name on a line of its own between DATA_BLOCK and BEGIN (none for a global DB). */
function instanceOf(text: string): string | undefined {
  for (const line of text.split(/\r?\n/).slice(1)) {
    const l = line.trim();
    if (/^(BEGIN|VAR|STRUCT)\b/i.test(l)) return undefined;
    const m = /^"([^"]+)"$/.exec(l) ?? /^([A-Za-z_]\w*)$/.exec(l);
    if (m && !/^NON_RETAIN$/i.test(m[1]!)) return m[1];
  }
  return undefined;
}

export class LiveView implements vscode.TreeDataProvider<string>, vscode.Disposable {
  private names: string[];
  private formats: Record<string, Format>;
  readonly seen = new Map<string, Seen>();
  readonly recorder = new Recorder();
  private proc?: ChildProcess;
  private paused = false;
  private retry?: NodeJS.Timeout;
  private generation = 0;
  private scope?: LiveFrame["scope"];
  private device?: string;
  private tableFile?: string;
  private table?: Table;
  private workspaceScope: string;
  private readonly changed = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<string>;
  private readonly timer: NodeJS.Timeout;
  private readonly subs: vscode.Disposable[] = [this.changed];

  constructor(
    private readonly ws: RungWorkspace,
    private readonly cli: RungCli,
    private readonly memento: vscode.Memento,
    private readonly lsp: Lsp | undefined,
    private readonly access: LiveAccess,
  ) {
    this.workspaceScope = access.scope;
    this.names = memento.get<string[]>(KEY, []);
    this.formats = memento.get<Record<string, Format>>(FORMATS, {});
    this.view = vscode.window.createTreeView("rung.live", { treeDataProvider: this });
    this.subs.push(
      ws.onDidChange(() => {
        if (this.workspaceScope === access.scope) return;
        this.workspaceScope = access.scope; this.device = undefined; this.scope = undefined; this.tableFile = undefined; this.table = undefined;
        this.seen.clear(); this.recorder.clear(); this.restart();
      }),
      this.view,
      // read only while someone looks: no PLC traffic for a hidden view
      this.view.onDidChangeVisibility(() => this.restart()),
      vscode.commands.registerCommand("rung.live.add", (arg?: unknown) => this.add(typeof arg === "string" ? arg : undefined)),
      vscode.commands.registerCommand("rung.live.table", (arg?: string | vscode.Uri) => this.watchTable(typeof arg === "string" ? arg : arg?.fsPath)),
      vscode.commands.registerCommand("rung.live.modify", (name?: string, draft?: string, device?: string) => {
        const row = this.table?.rows.find(row => row.key === name);
        return mutateLive(this.ws, this.cli, this.access, "modify", row ? row.name || row.address : name, draft ?? row?.modifyValue, device ?? this.device);
      }),
      vscode.commands.registerCommand("rung.live.remove", (name: string) => this.remove(name)),
      vscode.commands.registerCommand("rung.live.clear", () => this.set([])),
      vscode.commands.registerCommand("rung.live.pause", () => this.pause(true)),
      vscode.commands.registerCommand("rung.live.resume", () => this.pause(false)),
      vscode.commands.registerCommand("rung.live.format", (name?: string, format?: Format) => this.format(name, format)),
      vscode.commands.registerCommand("rung.live.bookmark", (label?: string) => this.bookmark(label)),
      vscode.commands.registerCommand("rung.live.export", () => this.export()),
      vscode.commands.registerCommand("rung.live.exportTest", (db?: string, from?: number) => this.exportTest(db, from)),
    );
    // ages go on while values come in (or stop coming)
    this.timer = setInterval(() => this.view.visible && [...this.seen.values()].some(s => s.state === "stale" || s.state === "disconnected") && this.changed.fire(undefined), 1000);
    void vscode.commands.executeCommand("setContext", "rung.live.paused", false);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stop();
    for (const s of this.subs) s.dispose();
  }

  /** The pinned names (tests). */
  get pinned(): readonly string[] {
    return this.names;
  }

  private set(names: string[]) {
    this.tableFile = undefined; this.table = undefined;
    this.names = names;
    void this.memento.update(KEY, names);
    for (const k of [...this.seen.keys()]) if (!names.includes(k)) this.seen.delete(k);
    this.changed.fire(undefined);
    this.restart();
  }

  private labels(): string[] { return this.tableFile ? this.table?.rows.map(r => r.key) ?? [] : this.names; }

  private async watchTable(file?: string): Promise<void> {
    if (!this.ws.root) return;
    if (!file) {
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.ws.root, "plc/*/watch/*.xml"));
      file = (await vscode.window.showQuickPick(files.map(uri => ({ label: relative(this.ws.root!, uri.fsPath), file: uri.fsPath })), { title: "Watch a TIA table" }))?.file;
    }
    if (!file) return;
    const rel = relative(this.ws.root, resolve(this.ws.root, file)).split(sep).join("/");
    const device = /^plc\/([^/]+)\/watch\/[^/]+\.xml$/i.exec(rel)?.[1];
    if (!device) return;
    this.tableFile = rel; this.table = { name: basename(file), rows: [] }; this.device = device;
    this.seen.clear(); this.recorder.clear(); this.restart();
  }

  async add(name?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : undefined;
    const typed =
      name ??
      (await vscode.window.showInputBox({
        title: "Pin a value from the PLC",
        prompt: 'A PLC tag or a DB member, as TIA Portal writes it: "Line_DB".Speed, "Start_PB"',
        value: selected ?? "",
        validateInput: (v) => (/^#/.test(v.trim()) ? "A block's local (#name) lives in an instance: write it through its DB, \"Motor_DB\".name" : undefined),
      }));
    const n = typed?.trim();
    if (!n || this.names.includes(n)) return;
    this.set([...this.names, n]);
  }

  /** Decimal, hex or binary for a pinned integer, as TIA Portal's display formats. */
  private async format(name?: string, format?: Format): Promise<void> {
    if (!name) return;
    const pick =
      format ??
      (await vscode.window.showQuickPick(
        (["dec", "hex", "bin"] as const).map((f) => ({ label: f === "dec" ? "Decimal" : f === "hex" ? "Hex (16#…)" : "Binary (2#…)", f, picked: (this.formats[name] ?? "dec") === f })),
        { title: `Show ${name} as` },
      ))?.f;
    if (!pick) return;
    this.formats = { ...this.formats, [name]: pick };
    if (pick === "dec") delete this.formats[name];
    void this.memento.update(FORMATS, this.formats);
    this.changed.fire(undefined);
  }

  /** A mark in the recording at this moment ("start pressed"), found again in the CSV. */
  private async bookmark(label?: string): Promise<void> {
    const n = this.recorder.bookmarks.length + 1;
    const text = label ?? (await vscode.window.showInputBox({ title: "Bookmark in the recording", prompt: "What happens now (it goes into the CSV at this moment)", value: `bookmark ${n}` }));
    if (text === undefined) return;
    this.recorder.mark(Date.now(), text.trim() || `bookmark ${n}`);
    void vscode.window.setStatusBarMessage(`Live Values: bookmark "${text.trim() || `bookmark ${n}`}" set`, 3000);
  }

  /** The recorded reads (the last ten minutes) as CSV in a new editor; the text itself for the tests. */
  private async export(): Promise<string | undefined> {
    if (!this.recorder.frames.length) {
      void vscode.window.showInformationMessage("Nothing recorded yet: Live Values records while the view is open and values come in.");
      return undefined;
    }
    const text = this.recorder.csv(this.names, this.formats);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: text, language: "csv" }));
    return text;
  }

  /**
   * The recording as a unit test of the FB whose instance DB the pinned values belong to ("Conv_DB".Start): its inputs
   * set as they changed, its outputs expected as they settled. From the start of the recording or a bookmark.
   */
  private async exportTest(db?: string, from?: number): Promise<vscode.Uri | undefined> {
    const byDb = new Map<string, string[]>();
    for (const n of this.names) {
      const m = /^"([^"]+)"\.(.+)$/.exec(n);
      if (m) byDb.set(m[1]!, [...(byDb.get(m[1]!) ?? []), n]);
    }
    if (!byDb.size || !this.recorder.frames.length || !this.ws.root || !this.lsp) {
      void vscode.window.showInformationMessage('Pin the inputs and outputs of an FB through its instance DB ("Conveyor_DB".Start, "Conveyor_DB".Motor) and let Live Values record them first.');
      return undefined;
    }
    const pick = db ?? (byDb.size === 1 ? [...byDb.keys()][0] : await vscode.window.showQuickPick([...byDb.keys()], { title: "A test of the FB of which instance DB?" }));
    if (!pick || !byDb.has(pick)) return undefined;
    const start = from ?? (this.recorder.bookmarks.length ? (await vscode.window.showQuickPick([{ label: "The whole recording", at: 0 }, ...this.recorder.bookmarks.map((b) => ({ label: `From "${b.label}"`, at: b.at }))], { title: "Which part of the recording?" }))?.at : 0);
    if (start === undefined) return undefined;
    // the FB of the instance DB, and the sections of its members: what the test sets and what it expects
    // by name, in the DB's own PLC once it is known: another PLC may have an FB of that name
    const find = async (name: string, plc?: string) =>
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", name))?.find((s) => s.name.replace(/^"|"$/g, "") === name && (!plc || plcOf(s.location.uri) === plc))?.location.uri;
    const plcOf = (u: vscode.Uri) => /\/plc\/([^/]+)\//.exec(decodeURIComponent(u.path))?.[1];
    const dbUri = await find(pick);
    const plc = dbUri && plcOf(dbUri);
    const fb = dbUri && instanceOf((await vscode.workspace.fs.readFile(dbUri)).toString());
    const fbUri = fb ? await find(fb, plc) : undefined;
    // the language server reads the declarations of an open document
    if (fbUri) await vscode.workspace.openTextDocument(fbUri);
    const model = fbUri ? await this.lsp.request<DeclModel | null>("rung/declarations", { textDocument: { uri: fbUri.toString() } }).catch(() => undefined) : undefined;
    if (!fb || !model || model.block?.kind !== "FB") {
      void vscode.window.showWarningMessage(`${pick} is no instance DB of an FB in this workspace.`);
      return undefined;
    }
    const dirOf = new Map<string, Role["dir"]>();
    const walk = (rows: DeclRow[], prefix: string, dir: Role["dir"]) => {
      for (const r of rows) {
        const path = prefix ? `${prefix}.${r.name}` : r.name;
        dirOf.set(path.toUpperCase(), dir);
        if (r.children) walk(r.children, path, dir);
      }
    };
    for (const s of model.sections) if (/^VAR(_INPUT|_IN_OUT|_OUTPUT)?$/i.test(s.keyword)) walk(s.rows, "", /^VAR_(INPUT|IN_OUT)$/i.test(s.keyword) ? "in" : "out");
    const roles: Record<string, Role> = {};
    for (const n of byDb.get(pick)!) {
      const member = n.slice(pick.length + 3);
      const dir = dirOf.get(member.replace(/"/g, "").toUpperCase());
      if (dir) roles[n] = { member: member.replace(/"/g, ""), dir };
    }
    const frames = this.recorder.frames.filter((f) => f.at >= start);
    if (!Object.values(roles).some((r) => r.dir === "out") || !frames.length) {
      void vscode.window.showWarningMessage(`Pin at least one output of ${fb} through ${pick} to have something to expect.`);
      return undefined;
    }
    const when = new Date(frames[0]!.at).toLocaleString(undefined, { hour12: false });
    let text: string;
    try {
      text = recordingAsTest(frames, roles, fb, `recorded on the PLC ${when}`, plc);
    } catch (e) {
      void vscode.window.showWarningMessage((e as Error).message);
      return undefined;
    }
    let file = vscode.Uri.joinPath(vscode.Uri.file(this.ws.root), "tests", `${fb}.recorded.test.yaml`);
    for (let i = 2; await vscode.workspace.fs.stat(file).then(() => true, () => false); i++) file = vscode.Uri.joinPath(vscode.Uri.file(this.ws.root), "tests", `${fb}.recorded-${i}.test.yaml`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(text));
    await vscode.window.showTextDocument(file);
    return file;
  }

  private remove(name: string) {
    this.set(this.names.filter((n) => n !== name));
  }

  private pause(on: boolean) {
    this.paused = on;
    void vscode.commands.executeCommand("setContext", "rung.live.paused", on);
    this.restart();
  }

  private stop() {
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    // through the rung.cmd shim the watch is a child of cmd.exe: end the whole tree
    if (this.proc) stopLive(this.proc);
    this.proc = undefined;
    for (const s of this.seen.values()) s.state = "stale";
    this.changed.fire(undefined);
  }

  private restart() {
    this.stop();
    void this.start(this.generation).catch(error => { this.view.message = (error as Error).message; });
  }

  private async start(generation: number, retryEnv?: Record<string, string>, authAttempt = 0) {
    if (this.paused || !this.view.visible || !this.names.length && !this.tableFile || !this.ws.root) return;
    const connection = await this.access.select(this.device);
    if (!connection || generation !== this.generation) return;
    const env = retryEnv ?? await this.access.environment(connection);
    if (!env || generation !== this.generation || connection.workspace !== this.access.scope) return;
    this.device = connection.device;
    this.scope = undefined;
    const inv = this.cli.invocation(["live", "watch", ...(this.tableFile ? ["--table", this.tableFile] : this.names), "--json", "--parent-stdio", "--device", connection.device, "--interval", String(connection.target.transport === "s7commplus" ? 250 : INTERVAL)]);
    const proc = spawn(inv.file, inv.args, { cwd: this.ws.root, env: { ...process.env, ...env }, windowsVerbatimArguments: inv.shell, windowsHide: true });
    this.proc = proc;
    let buf = "";
    let err = "";
    proc.stdout.on("data", (d: Buffer) => {
      if (generation !== this.generation || this.proc !== proc) return;
      buf += d.toString();
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.take(line);
      }
    });
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", error => { if (this.proc === proc) { this.proc = undefined; this.view.message = error.message; } });
    proc.on("exit", async (code) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      for (const s of this.seen.values()) s.state = "disconnected";
      this.changed.fire(undefined);
      if (authAttempt === 0 && /AUTHENTICATION_(REQUIRED|FAILED)|Api\.Login|401|Invalid credentials/i.test(err)) {
        const env = await this.access.environment(connection, true, err);
        if (env && generation === this.generation) void this.start(generation, env, 1);
        return;
      }
      if (code) this.view.message = err.trim().split(/\r?\n/).pop()?.replace(/^rung live:\s*/, "") || `rung live watch ended (${code})`;
      if (/CERTIFICATE_UNTRUSTED|TLS_UNSUPPORTED|TARGET_REFUSED|AUTHENTICATION_|ACCESS_DENIED|Api\.Login|401/i.test(err)) return;
      // the PLC may come back (switched on, network back): try again while someone looks
      this.retry = setTimeout(() => this.restart(), 5000);
    });
    this.view.message = `${connection.device} · ${connection.target.transport} · ${connection.target.address}`;
  }

  private take(line: string) {
    let m: LiveFrame & { plan?: { table?: Table; errors?: Record<string, string> } };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.plan?.table && this.tableFile) {
      this.table = m.plan.table; this.seen.clear(); this.recorder.clear();
      for (const [key, error] of Object.entries(m.plan.errors ?? {})) this.seen.set(key, { error, at: 0, history: [] });
      this.changed.fire(undefined);
    }
    if (m.at === undefined) return;
    if (m.scope) {
      if (this.scope && (m.scope.device !== this.scope.device || m.scope.address !== this.scope.address || m.scope.transport !== this.scope.transport || m.scope.epoch < this.scope.epoch)) return;
      this.scope = m.scope;
    }
    const recorded = takeLiveFrame(this.seen, this.labels(), { ...m, values: m.values ?? {} });
    if (recorded) this.recorder.add(recorded);
    this.changed.fire(undefined);
  }

  getChildren(parent?: string): string[] {
    if (this.tableFile) return parent === TABLE_GROUP ? this.labels() : parent ? [] : [TABLE_GROUP];
    return parent ? [] : this.names;
  }

  getTreeItem(name: string): vscode.TreeItem {
    if (name === TABLE_GROUP && this.table) return new vscode.TreeItem(this.table.name, vscode.TreeItemCollapsibleState.Expanded);
    const row = this.tableFile ? this.table?.rows.find(r => r.key === name) : undefined;
    const s = this.seen.get(name);
    const item = new vscode.TreeItem(row?.name || row?.address || name);
    item.contextValue = row ? "rung.watchRow" : "rung.liveValue";
    const comment = row ? Object.entries(row.comments).map(([culture, text]) => `${culture}: ${text}`).join("\n") : "";
    item.tooltip = comment;
    if (!s) {
      item.description = this.paused ? "paused" : "…";
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      return item;
    }
    const age = Date.now() - s.at;
    const stale = s.state === "stale" || s.state === "disconnected";
    if (s.error) {
      item.description = readError(s.error);
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    } else {
      const line = sparkline(s.history);
      const format = row?.displayFormat === "Hex" ? "hex" : row?.displayFormat === "Bin" ? "bin" : this.formats[name];
      item.description = `${formatted(s.value, format, s.display)}${line ? `  ${line}` : ""}${stale ? `  · ${Math.round(age / 1000)} s old` : ""}`;
      item.iconPath = new vscode.ThemeIcon(stale ? "circle-outline" : "circle-filled", stale ? undefined : new vscode.ThemeColor("charts.green"));
    }
    item.tooltip = `${item.label}\n${comment ? `${comment}\n` : ""}${this.scope ? `${this.scope.device} · ${this.scope.transport} · ${this.scope.address}\n` : ""}${s.error ? `${s.error}\n` : ""}read ${new Date(s.at).toLocaleTimeString(undefined, { hour12: false })}${s.history.length > 1 ? `\nlast values: ${s.history.slice(-10).map((v) => formatted(v, this.formats[name])).join(", ")}` : ""}`;
    return item;
  }
}
