// SPDX-License-Identifier: MIT
// The HTML shell of every rung webview: local, nonce-only scripts and styles, nothing from the network.
import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function nonce(): string {
  return [...randomBytes(32)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function webviewHtml(o: { cspSource: string; nonce: string; script: string; styles: string[]; title: string }): string {
  const csp = [`default-src 'none'`, `style-src ${o.cspSource}`, `font-src ${o.cspSource}`, `img-src ${o.cspSource} data:`, `script-src 'nonce-${o.nonce}'`].join("; ");
  const links = o.styles.map((s) => `<link rel="stylesheet" href="${s}">`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0">${links}<title>${escapeHtml(o.title)}</title></head><body><script nonce="${o.nonce}" src="${o.script}"></script></body></html>`;
}
