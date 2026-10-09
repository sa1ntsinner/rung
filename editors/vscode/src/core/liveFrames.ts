// SPDX-License-Identifier: MIT
import type { Frame } from "./recording";

export interface LiveFrame extends Frame {
  errors?: Record<string, string>;
  display?: Record<string, string>;
  observedAt?: Record<string, number>;
  state?: "live" | "stale" | "disconnected";
  scope?: { device: string; address: string; transport: string; epoch: number };
}
export interface Seen { value?: unknown; display?: string; error?: string; at: number; history: unknown[]; state?: LiveFrame["state"] }
export function takeLiveFrame(seen: Map<string, Seen>, names: readonly string[], frame: LiveFrame): Frame | undefined {
  const values: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const s = seen.get(name) ?? { at: 0, history: [] };
    if (frame.state) s.state = frame.state;
    const error = frame.errors?.[name] ?? (frame.state && frame.state !== "live" ? `PLC ${frame.state}` : undefined);
    if (error) s.error = error;
    if (!error && Object.hasOwn(frame.values, name)) {
      const at = frame.observedAt ? frame.observedAt[name] : frame.at;
      if (at !== undefined && at >= s.at) {
        s.state = frame.state ?? "live"; s.error = undefined;
        if (at > s.at) { s.history.push(frame.values[name]); values[name] = frame.values[name]; }
        if (s.history.length > 32) s.history.shift();
        s.value = frame.values[name]; s.display = frame.display?.[name]; s.at = at;
      }
    }
    seen.set(name, s);
  }
  return Object.keys(values).length ? { at: frame.at, values } : undefined;
}
