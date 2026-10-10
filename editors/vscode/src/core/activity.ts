// SPDX-License-Identifier: MIT
// The save loop as the editor shows it: rung watch's events (owner IPC: phase, report, error, and the owner's status
// when the editor connects) become what is happening now (one status bar phrase) and a short history (the Activity
// view). No VS Code here.

export type ActivityKind = "import" | "create" | "export" | "merge" | "remove" | "restore" | "refused" | "error";

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  label: string;
  path?: string;
  /** how long the object took to reach TIA Portal (from the start of its pass) */
  ms?: number;
  /** TIA Portal's compile errors for this object after the pass */
  errors?: number;
  /** the first of them, to open the file there */
  line?: number;
  /** the same error again and again (a retry loop): one row, counted */
  count?: number;
}

interface Diagnostic { path?: string; address?: string; severity: string; code?: string; message?: string; line?: number }
interface Report {
  conflicts: number;
  diagnostics: Diagnostic[];
  changes?: { path: string; action: Exclude<ActivityKind, "error" | "refused"> }[];
  compiled?: string[];
}

type Now =
  | { kind: "connecting"; since: number }
  /** the bridge starts TIA Portal (rung's keeper in the background, or a window for "Open in TIA Portal") */
  | { kind: "starting"; window: boolean; since: number }
  | { kind: "sending"; path: string; since: number }
  | { kind: "compiling"; detail?: string; since: number }
  | { kind: "archiving"; since: number }
  | { kind: "retrying"; message: string; since: number }
  /** refused until a person acts (Openness access): rung waits for them, not for TIA Portal */
  | { kind: "blocked"; message: string; code: string; since: number }
  | undefined;

const MAX = 200;
/** a first pass that mirrors a whole project is one line, not hundreds */
const FOLD = 20;
/** a phase this long without news: TIA Portal may be waiting for a dialog */
export const STUCK_MS = 15_000;
/** diagnostics that mean "this was not sent"; COMPILE is TIA's verdict on what was sent, the rest stand in Problems */
const NOT_REFUSALS = new Set(["COMPILE", "CONFLICT", "DELETE_PENDING"]);

/** "plc/PLC_1/blocks/Station/FB_Batch.scl" -> "FB_Batch"; "UDT_Recipe.udt.xml" -> "UDT_Recipe" */
export const objectName = (path: string) => path.replace(/^.*[\\/]/, "").replace(/(\.(scl|db|udt|awl|st|xml|s7dcl|s7res|yaml|tags))+$/i, "");

const WHAT: Record<Exclude<ActivityKind, "error" | "refused">, string> = {
  import: "sent to TIA",
  create: "created in TIA",
  export: "updated from TIA",
  merge: "merged with TIA's change",
  remove: "removed: deleted in TIA",
  restore: "restored from TIA",
};

const firstSentence = (s: string) => s.replace(/\s+/g, " ").replace(/^(.{0,140}?[.;:])\s.*$/, "$1").slice(0, 160);

export class Activity {
  entries: ActivityEntry[] = [];
  now: Now;
  /** when the last pass that sent something to TIA Portal ended */
  lastInTia: number | undefined;
  /** TIA Portal's compile errors standing after the last pass */
  errors = 0;
  /** saves that were not sent (archive failed, a dependency failed, tag checks, TIA Portal refused the import) */
  refused = 0;
  private passStart: number | undefined;
  /** refusals already in the history (they stand in every report until fixed) */
  private readonly seenRefusals = new Set<string>();
  /** the PLCs paths have named: with more than one, a label says which PLC an object is on */
  private readonly plcs = new Set<string>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** A watch (re)connected: forget the last one's state; until its first pass nothing is known. */
  reset(): void {
    this.now = { kind: "connecting", since: this.clock() };
    this.errors = 0;
    this.refused = 0;
    this.passStart = undefined;
    this.seenRefusals.clear();
  }

  /** `at`: when it happened, for a pass replayed to an editor that came later. */
  event(event: string, params: unknown, at?: number): void {
    const t = at ?? this.clock();
    if (event === "connected") return this.reset();
    if (event === "disconnected") {
      this.now = undefined;
      return;
    }
    if (event === "phase") {
      const p = params as { phase?: string; detail?: string };
      this.passStart ??= t;
      if (p.phase === "sending") this.now = { kind: "sending", path: p.detail ?? "", since: t };
      // sync.compile = "all" names the PLC; otherwise the detail is a phrase, not shown
      else if (p.phase === "compiling") this.now = { kind: "compiling", ...(p.detail && !/\s/.test(p.detail) ? { detail: p.detail } : {}), since: t };
      else if (p.phase === "archiving") this.now = { kind: "archiving", since: t };
      else if (p.phase === "starting-tia") this.now = { kind: "starting", window: p.detail === "window", since: t };
      else if (p.phase === "tia-started") this.now = { kind: "connecting", since: t };
    } else if (event === "error") {
      const p = params as { message?: string; code?: string; blocked?: boolean };
      const message = p.message ?? "rung watch lost TIA Portal";
      this.now = p.blocked ? { kind: "blocked", message, code: p.code ?? "", since: t } : { kind: "retrying", message, since: this.now?.kind === "retrying" ? this.now.since : t };
      this.passStart = undefined;
      const top = this.entries[0];
      if (top?.kind === "error" && top.label === message) {
        top.at = t;
        top.count = (top.count ?? 1) + 1;
      } else this.add({ at: t, kind: "error", label: message });
    } else if (event === "report") {
      this.report(params as Report, t);
    } else if (event === "status") {
      // the owner's own account, asked for on connecting: a pass already done, or the error it retries after
      const o = (params as { owner?: { lastPassAt?: number; lastError?: string | null } | null }).owner;
      if (o?.lastError) this.now = { kind: "retrying", message: o.lastError, since: t };
      else if (o?.lastPassAt && this.now?.kind === "connecting") this.now = undefined;
    }
  }

  /** An object's name, with its PLC once the workspace has shown more than one (`PLC_2 · FB_Motor`). */
  private name(path: string): string {
    const plc = /(?:^|[\\/])plc[\\/:]([^\\/]+)[\\/]/.exec(path)?.[1] ?? /^plc:([^/]+)\//.exec(path)?.[1];
    if (plc) this.plcs.add(plc);
    return this.plcs.size > 1 && plc ? `${decodeURIComponent(plc)} · ${objectName(path)}` : objectName(path);
  }

  private report(r: Report, t: number): void {
    for (const c of r.changes ?? []) this.name(c.path); // every PLC of the pass is known before the first label
    const start = this.passStart;
    this.passStart = undefined;
    this.now = undefined;
    const compileErrors = r.diagnostics.filter((d) => d.severity === "error" && d.code === "COMPILE");
    this.errors = compileErrors.length;
    const changes = r.changes ?? [];
    const pass: ActivityEntry[] = [];
    if (changes.length > FOLD && changes.every((c) => c.action === "export" || c.action === "restore")) {
      pass.push({ at: t, kind: "export", label: `${changes.length} objects updated from TIA` });
    } else {
      for (const c of changes) {
        const toTia = c.action === "import" || c.action === "create";
        const mine = compileErrors.filter((d) => d.path === c.path);
        let label = `${this.name(c.path)} ${WHAT[c.action]}`;
        if (toTia && mine.length) label += ` · ${mine.length} compile error${mine.length > 1 ? "s" : ""}`;
        else if (toTia && r.compiled?.some((a) => a.endsWith("/" + objectName(c.path)))) label += " · compiled";
        pass.push({
          at: t,
          kind: c.action,
          label,
          path: c.path,
          ...(toTia && start !== undefined ? { ms: t - start } : {}),
          ...(toTia ? { errors: mine.length } : {}),
          ...(mine[0]?.line ? { line: mine[0].line } : {}),
        });
        if (toTia) this.lastInTia = t;
      }
    }
    // saves that did not go: new ones get a line; ones that stand were told before
    const refusals = r.diagnostics.filter((d) => d.severity === "error" && d.code && !NOT_REFUSALS.has(d.code));
    this.refused = new Set(refusals.map((d) => d.path ?? d.address)).size;
    const now = new Set<string>();
    for (const d of refusals) {
      const key = `${d.path ?? d.address}\0${d.code}\0${d.message}`;
      now.add(key);
      if (this.seenRefusals.has(key)) continue;
      const name = this.name(d.path ?? d.address ?? "");
      pass.push({ at: t, kind: "refused", label: `${name} not sent: ${firstSentence(d.message ?? d.code ?? "")}`, ...(d.path ? { path: d.path } : {}), ...(d.line ? { line: d.line } : {}) });
    }
    this.seenRefusals.clear();
    for (const k of now) this.seenRefusals.add(k);
    // newest pass on top, its own lines in the order they happened
    for (const e of pass.reverse()) this.add(e);
  }

  private add(e: ActivityEntry): void {
    this.entries.unshift(e);
    if (this.entries.length > MAX) this.entries.length = MAX;
  }
}

export interface StatusContext {
  watching: boolean;
  writes: "on" | "off" | "manual";
  conflicts: number;
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The one phrase the status bar shows: what is happening, else the most important standing fact. */
export function statusPhrase(a: Activity, c: StatusContext, now = Date.now()): { text: string; tone?: "error" | "warning" } {
  const conflict = { text: `$(warning) rung · ${c.conflicts} conflict${c.conflicts > 1 ? "s" : ""}`, tone: "warning" as const };
  // a conflict stands whether watch runs or not
  if (!c.watching) return c.conflicts ? { ...conflict, text: `${conflict.text} · watch off` } : { text: "$(circle-slash) rung · watch off" };
  const n = a.now;
  // a cold start of TIA Portal takes minutes: that is no dialog
  const stuck = n && n.kind !== "retrying" && n.kind !== "blocked" && n.kind !== "connecting" && n.kind !== "starting" && now - n.since > STUCK_MS;
  if (stuck) return { text: "$(watch) rung · waiting for TIA Portal (a dialog may be open)", tone: "warning" };
  if (n?.kind === "connecting") return { text: "$(sync~spin) rung · connecting to TIA Portal" };
  if (n?.kind === "starting") return { text: n.window ? "$(sync~spin) rung · opening a TIA Portal window" : "$(sync~spin) rung · starting TIA Portal" };
  if (n?.kind === "sending") return { text: `$(sync~spin) rung · ${objectName(n.path)} → TIA` };
  if (n?.kind === "compiling") return { text: `$(sync~spin) rung · compiling${n.detail ? ` ${n.detail}` : ""} in TIA` };
  if (n?.kind === "archiving") return { text: "$(sync~spin) rung · archiving the project" };
  if (n?.kind === "blocked") return { text: n.code === "ACCESS_DENIED" ? "$(shield) rung · Openness access needed" : "$(warning) rung · needs you", tone: "warning" };
  // without TIA Portal nothing else on this list is current
  if (n?.kind === "retrying") return { text: "$(debug-disconnect) rung · waiting for TIA Portal", tone: "warning" };
  if (c.conflicts) return conflict;
  if (a.refused) return { text: `$(error) rung · ${a.refused} not sent`, tone: "error" };
  if (a.errors) return { text: `$(error) rung · ${a.errors} compile error${a.errors > 1 ? "s" : ""}`, tone: "error" };
  if (c.writes === "off") return { text: "$(lock) rung · writes off" };
  if (c.writes === "manual") return { text: "$(lock) rung · manual sync" };
  if (a.lastInTia !== undefined) return { text: `$(check) rung · sent to TIA ${hhmm(a.lastInTia)}` };
  return { text: "$(check) rung · in sync" };
}
