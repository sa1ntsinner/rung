// SPDX-License-Identifier: MIT
/** Keep every choice; a stale remembered PLC has no effect. */
export function deviceChoices(devices: readonly string[], remembered?: string): string[] {
  return remembered && devices.includes(remembered) ? [remembered, ...devices.filter((d) => d !== remembered)] : [...devices];
}
