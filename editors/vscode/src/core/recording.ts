// SPDX-License-Identifier: MIT
// Live Values' flight recorder (pure, for tests): every read of the pinned values kept for a while, with the
// person's bookmarks, written out as CSV; and the display formats TIA Portal offers for a number.

export type Format = "dec" | "hex" | "bin";

export interface Frame {
  at: number;
  values: Record<string, unknown>;
}

/** A value as TIA Portal shows it in that format: 16#00FF, 2#0000_0101; booleans, reals and texts as they are. */
export function formatted(v: unknown, f: Format = "dec"): string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return `'${v}'`;
  if (typeof v !== "number" || !Number.isInteger(v) || f === "dec") return v === undefined ? "…" : typeof v === "number" ? String(v) : JSON.stringify(v);
  // a negative integer as its two's complement, the width it needs (8, 16, 32 or 64 bits)
  const bits = [8, 16, 32, 64].find((b) => (v < 0 ? v >= -(2 ** (b - 1)) : v < 2 ** b)) ?? 64;
  const u = v < 0 ? BigInt(v) + (1n << BigInt(bits)) : BigInt(v);
  if (f === "hex") return `16#${u.toString(16).toUpperCase().padStart(bits / 4, "0")}`;
  return `2#${u.toString(2).padStart(bits, "0").replace(/\B(?=(\d{4})+$)/g, "_")}`;
}

/** A pinned value of the block under test: the member it is, written by the test (an input) or checked (an output). */
export interface Role {
  member: string;
  dir: "in" | "out";
}

const yamlKey = (k: string) => (/^[A-Za-z_][\w.]*$/.test(k) ? k : `'${k.replace(/'/g, "''")}'`);
const yamlValue = (v: unknown) => (typeof v === "boolean" || typeof v === "number" ? String(v) : JSON.stringify(v));
const yamlMap = (m: Record<string, unknown>) => `{ ${Object.entries(m).map(([k, v]) => `${yamlKey(k)}: ${yamlValue(v)}`).join(", ")} }`;

/**
 * A recorded window as a test case: a step at each change of the inputs, which sets what changed, runs to the last
 * read before the next change and expects the outputs as that read had them (settled, not at a cycle the PLC and the
 * simulator would count differently); then the rest of the time runs up to the next change. Throws when no output
 * was read in the window: a test without expectations would pass whatever the code does.
 */
export function recordingAsTest(frames: readonly Frame[], roles: Readonly<Record<string, Role>>, block: string, caseName: string, plc?: string): string {
  const ins = Object.entries(roles).filter(([, r]) => r.dir === "in");
  const outs = Object.entries(roles).filter(([, r]) => r.dir === "out");
  const inputsAt = (f: Frame) => Object.fromEntries(ins.filter(([n]) => n in f.values).map(([n, r]) => [r.member, f.values[n]]));
  const changes: number[] = [];
  let last: Record<string, unknown> | undefined;
  frames.forEach((f, i) => {
    const now = inputsAt(f);
    if (!last || Object.keys(now).some((k) => now[k] !== last![k])) changes.push(i);
    last = now;
  });
  const steps: string[] = [];
  let expected = false;
  changes.forEach((at, c) => {
    const f = frames[at]!;
    const now = inputsAt(f);
    const before = c ? inputsAt(frames[changes[c - 1]!]!) : {};
    const set = Object.fromEntries(Object.entries(now).filter(([k, v]) => !c || before[k] !== v));
    const end = changes[c + 1] !== undefined ? changes[c + 1]! - 1 : frames.length - 1;
    const settled = frames[end]!;
    const expect = Object.fromEntries(outs.filter(([n]) => n in settled.values).map(([n, r]) => [r.member, settled.values[n]]));
    if (Object.keys(expect).length) expected = true;
    const ms = Math.max(0, Math.round(settled.at - f.at));
    const parts = [Object.keys(set).length ? `set: ${yamlMap(set)}` : "", ms ? `advance: ${ms}ms` : "cycle: 1", Object.keys(expect).length ? `expect: ${yamlMap(expect)}` : ""].filter(Boolean);
    steps.push(`      - ${parts.join("\n        ")}`);
    const rest = changes[c + 1] !== undefined ? Math.round(frames[changes[c + 1]!]!.at - settled.at) : 0;
    if (rest > 0) steps.push(`      - advance: ${rest}ms`);
  });
  if (!expected) throw new Error(`no output of ${block} was read in this window: a test without expectations would pass whatever the code does`);
  const name = /^[A-Za-z_]\w*$/.test(block) ? block : JSON.stringify(block);
  return `# recorded on the PLC by rung's Live Values: the inputs as they changed, the outputs as they settled
block: ${name}
${plc ? `plc: ${/^[A-Za-z_][\w.-]*$/.test(plc) ? plc : JSON.stringify(plc)}\n` : ""}cases:
  - name: ${JSON.stringify(caseName)}
    steps:
${steps.join("\n")}
`;
}

/** The recorder: frames for `keepMs`, the newest last. */
export class Recorder {
  readonly frames: Frame[] = [];
  readonly bookmarks: { at: number; label: string }[] = [];
  constructor(private readonly keepMs = 10 * 60_000) {}

  add(frame: Frame): void {
    this.frames.push(frame);
    const from = frame.at - this.keepMs;
    while (this.frames.length && this.frames[0]!.at < from) this.frames.shift();
    while (this.bookmarks.length && this.bookmarks[0]!.at < from) this.bookmarks.shift();
  }

  mark(at: number, label: string): void {
    this.bookmarks.push({ at, label });
  }

  clear(): void {
    this.frames.length = 0;
    this.bookmarks.length = 0;
  }

  /** time (ISO, local offset kept out: UTC), ms since the first frame, one column per name, the bookmark at that read. */
  csv(names: readonly string[], formats: Record<string, Format> = {}): string {
    const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const t0 = this.frames[0]?.at ?? 0;
    const rows = [["time", "ms", ...names, "bookmark"].map(cell).join(",")];
    let b = 0;
    for (const f of this.frames) {
      const marks: string[] = [];
      while (b < this.bookmarks.length && this.bookmarks[b]!.at <= f.at) marks.push(this.bookmarks[b++]!.label);
      rows.push([new Date(f.at).toISOString(), String(f.at - t0), ...names.map((n) => (n in f.values ? formatted(f.values[n], formats[n]) : "")), marks.join("; ")].map(cell).join(","));
    }
    return rows.join("\n") + "\n";
  }
}
