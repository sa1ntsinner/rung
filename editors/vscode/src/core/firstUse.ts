// SPDX-License-Identifier: MIT
// "Open TIA Project…": what to check before rung starts a TIA Portal, and where the mirror goes.
import { posix, win32 } from "node:path";
import type { CheckItem } from "./args";

/** The TIA Portal a project (or archive) needs: an archive older than V18 is retrieved by V20, with upgrade. */
export function tiaVersionOf(project: string): string | undefined {
  const m = /\.(z?)ap(\d\d)$/i.exec(project);
  if (!m) return undefined;
  return m[1] && Number(m[2]) < 18 ? "V20" : `V${m[2]}`;
}

export function validateRemoteProject(project: string): string | undefined {
  return /\.ap(18|19|20|21)$/i.test(project) ? undefined : "Enter the Windows project path ending in .ap18, .ap19, .ap20 or .ap21.";
}

export type Preflight = { ok: true; whitelist?: true } | { ok: false; message: string };

/** What TIA sync cannot do without (the rest of rung check is optional: other PLCs, editors, agents). */
const TIA_NEEDS = ["tia", "openness", "openness-group", "whitelist"];

/** A row of the Environment view: a must-have for TIA Portal that is missing looks unlike an optional tool. */
export function envLook(i: CheckItem): { icon: "pass" | "warning" | "error" | "circle-large-outline"; description: string } {
  if (i.status === "ok") return { icon: "pass", description: i.detail ?? "" };
  // TIA Portal on Linux or macOS: not a fault here, it is reached over ssh
  if (i.status === "na") return { icon: "circle-large-outline", description: i.detail ?? "not available here" };
  if (TIA_NEEDS.includes(i.id)) return { icon: "error", description: "needed for TIA Portal" };
  if (i.status === "warn") return { icon: "warning", description: i.detail ?? "needs attention" };
  return { icon: "circle-large-outline", description: "not installed" };
}

export function tiaReadiness(items: CheckItem[] | undefined): { ok: boolean; message: string } {
  const missing = TIA_NEEDS.filter(id => items?.find(i => i.id === id)?.status !== "ok");
  return missing.length ? { ok: false, message: `TIA sync needs: ${missing.map(id => items?.find(i => i.id === id)?.name ?? id).join(", ")}` } : { ok: true, message: "TIA sync ready" };
}

/**
 * Stops only for what no click in rung can fix (a missing TIA Portal version, the Openness group, which needs an
 * administrator and a new sign-in), before a TIA Portal starts and waits for minutes. No readable answer: go on.
 */
export function preflight(items: CheckItem[] | undefined, tia: string | undefined): Preflight {
  if (!items) return { ok: true };
  const of = (id: string) => items.find((i) => i.id === id);
  const installed = (of("tia")?.detail ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (tia && of("tia") && !installed.includes(tia))
    return { ok: false, message: `TIA Portal ${tia} is not installed on this PC${installed.length ? ` (found: ${installed.join(", ")})` : ""}. rung opens a project with its own TIA Portal version.` };
  const group = of("openness-group");
  if (group && group.status !== "ok")
    return { ok: false, message: `Your Windows user is not in the group "Siemens TIA Openness". An administrator has to add you; then sign out and in once.${group.fix ? ` (${group.fix})` : ""}` };
  return of("whitelist")?.status === "ok" || !of("whitelist") ? { ok: true } : { ok: true, whitelist: true };
}

/** Next to the project's folder: C:\Work\Line\Line.ap20 → C:\Work\Line-rung (TIA Portal's own folder stays its own). */
export function mirrorFolderFor(project: string): string {
  const p = /^[A-Za-z]:|^\\\\/.test(project) ? win32 : posix;
  // an archive sits among other files: C:\Downloads\Line.zap20 → C:\Downloads\Line-rung
  if (/\.zap\d+$/i.test(project)) return p.join(p.dirname(project), `${p.basename(project).replace(/\.zap\d+$/i, "")}-rung`);
  const folder = p.dirname(project);
  return p.join(p.dirname(folder), `${p.basename(folder)}-rung`);
}
