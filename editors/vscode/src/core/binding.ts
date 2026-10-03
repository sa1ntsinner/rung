// SPDX-License-Identifier: MIT
// Which file the declarations panel shows: it follows SCL editors unless pinned, and focusing anything else (the
// panel itself, a terminal, a Markdown file) keeps the current one.

export interface Binding {
  pinned: boolean;
  uri?: string;
}

export function retarget(b: Binding, active: { uri: string; languageId: string } | undefined): Binding {
  if (b.pinned || !active || active.languageId !== "scl") return b;
  return { ...b, uri: active.uri };
}
