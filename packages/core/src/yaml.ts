// SPDX-License-Identifier: BUSL-1.1
// Minimal deterministic YAML emitter for rung's generated views (objects, arrays, strings, numbers, booleans).

const PLAIN = /^[A-Za-z_][A-Za-z0-9_ .\-/()%]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "" || RESERVED.test(s) || !PLAIN.test(s) || /^\d/.test(s) || /[:#]\s|\s$|^\s/.test(s)) return JSON.stringify(s);
  return s;
}

function key(k: string): string {
  return PLAIN.test(k) && !RESERVED.test(k) && !/^\d/.test(k) ? k : JSON.stringify(k);
}

function emit(v: unknown, indent: string, out: string[]): void {
  if (Array.isArray(v)) {
    if (!v.length) {
      out[out.length - 1] += " []";
      return;
    }
    for (const item of v) {
      if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
        const entries = Object.entries(item as Record<string, unknown>);
        entries.forEach(([k, val], i) => {
          const prefix = i === 0 ? `${indent}- ` : `${indent}  `;
          line(prefix, k, val, indent + "  ", out);
        });
      } else {
        out.push(`${indent}- ${item && typeof item === "object" ? (Array.isArray(item) ? "[]" : "{}") : scalar(item)}`);
      }
    }
    return;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) {
      out[out.length - 1] += " {}";
      return;
    }
    for (const [k, val] of entries) line(indent, k, val, indent, out);
    return;
  }
  out[out.length - 1] += " " + scalar(v);
}

function line(prefix: string, k: string, val: unknown, indent: string, out: string[]) {
  if (val && typeof val === "object") {
    out.push(`${prefix}${key(k)}:`);
    emit(val, indent + "  ", out);
  } else out.push(`${prefix}${key(k)}: ${scalar(val)}`);
}

/** Serializes to YAML; object keys keep insertion order, so callers sort where determinism matters. */
export function toYaml(value: unknown, header?: string): string {
  const out: string[] = [];
  if (header) for (const h of header.split("\n")) out.push(`# ${h}`);
  if (value && typeof value === "object" && !Array.isArray(value)) emit(value, "", out);
  else {
    out.push("value:");
    emit(value, "  ", out);
  }
  return out.join("\n") + "\n";
}
