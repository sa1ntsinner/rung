// SPDX-License-Identifier: MIT
// VS Code's Undo and Redo in a focused webview run the page's own document.execCommand("undo"/"redo"). The browser's
// undo stack belongs to the document, not to a field: with the table focused, it rewound the filter field's typing
// (and refiltered the table). Native undo and redo are kept for a text field that has the focus; anywhere else the
// table's own undo (its Ctrl+Z handler) is the only one.

const GUARDED = Symbol("rung.nativeUndo");

const isTextField = (el: Element | null): boolean =>
  !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable === true);

export function guardNativeUndo(doc: Document): void {
  const d = doc as Document & { [GUARDED]?: true };
  if (d[GUARDED] || typeof doc.execCommand !== "function") return;
  const native = doc.execCommand.bind(doc);
  d.execCommand = (command: string, showUI?: boolean, value?: string): boolean => {
    if (/^(undo|redo)$/i.test(command) && !isTextField(doc.activeElement)) return false;
    return showUI === undefined && value === undefined ? native(command) : native(command, showUI, value);
  };
  d[GUARDED] = true;
}
