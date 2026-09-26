// SPDX-License-Identifier: MIT
// Turns the rung.command setting plus arguments into something child_process / a terminal can start.
// Windows npm shims (rung.cmd) need cmd.exe; everything else is spawned directly. No vscode import.
import { posix, win32 } from "node:path";

export interface Invocation {
  /** Executable to start (cmd.exe when `shell`). */
  file: string;
  args: string[];
  /** Command line for display in terminals and logs. */
  display: string;
  /** true: `file` is cmd.exe and args[3] is the complete quoted command line. */
  shell: boolean;
}

/** Quotes one argument for cmd.exe /s /c "…" (CreateProcess rules plus doubled quotes). */
export function quoteWindows(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  // backslashes before a quote are doubled, the quote is escaped
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** Display quoting for POSIX shells. */
export function quotePosix(arg: string): string {
  return arg !== "" && /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function displayCommand(parts: readonly string[], platform: NodeJS.Platform): string {
  return parts.map(platform === "win32" ? quoteWindows : quotePosix).join(" ");
}

export interface ResolveEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isFile: (p: string) => boolean;
  cwd?: string;
}

function envGet(env: Record<string, string | undefined>, key: string): string | undefined {
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? env[k] : undefined;
}

/** Finds `name` on PATH (with PATHEXT on Windows). Paths are returned unchanged if they exist. */
export function findExecutable(name: string, r: ResolveEnv): string | undefined {
  const win = r.platform === "win32";
  const path = win ? win32 : posix;
  const exts = win && !path.extname(name) ? (envGet(r.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasDir = win ? /[\\/]/.test(name) : name.includes("/");
  const dirs = hasDir ? [r.cwd && !path.isAbsolute(name) ? r.cwd : ""] : (envGet(r.env, "PATH") ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, name + ext) : name + ext;
      if (r.isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * command: the rung.command setting, e.g. ["rung"] or ["node", "C:/rung/packages/cli/dist/index.js"].
 * Unresolvable commands are passed through unchanged so the spawn error names them.
 */
export function buildInvocation(command: readonly string[], args: readonly string[], r: ResolveEnv): Invocation {
  const [head = "rung", ...prefix] = command.length ? command : ["rung"];
  const resolved = findExecutable(head, r) ?? head;
  const all = [...prefix, ...args];
  const display = displayCommand([head, ...all], r.platform);
  if (r.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...all].map(quoteWindows).join(" ");
    const comspec = envGet(r.env, "ComSpec") ?? "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], display, shell: true };
  }
  return { file: resolved, args: all, display, shell: false };
}
