// SPDX-License-Identifier: MIT
// The manifest's new contributions are wired: every command a walkthrough, menu or view uses exists, and every page
// a walkthrough step shows is there.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const commands = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));

describe("manifest", () => {
  it("the getting-started walkthrough runs existing commands and has its pages", () => {
    const w = pkg.contributes.walkthroughs.find((x: { id: string }) => x.id === "rung.getStarted");
    expect(w.steps.map((s: { id: string }) => s.id)).toEqual(["check", "project", "declarations", "usages", "test", "preview", "writes"]);
    for (const s of w.steps) {
      for (const m of String(s.description).matchAll(/command:([\w.]+)/g)) expect(commands.has(m[1]!)).toBe(true);
      expect(existsSync(join(root, s.media.markdown))).toBe(true);
      for (const e of s.completionEvents ?? []) if (e.startsWith("onCommand:")) expect(commands.has(e.slice(10))).toBe(true);
    }
  });

  it("declarations and usages contributions exist and are reachable", () => {
    for (const c of ["rung.declarations.open", "rung.usages.show", "rung.usages.refresh", "rung.usages.pick"]) expect(commands.has(c)).toBe(true);
    expect(pkg.contributes.views.rung.some((v: { id: string }) => v.id === "rung.usages")).toBe(true);
    expect(pkg.activationEvents).toContain("onWebviewPanel:rung.declarations");
    expect(pkg.contributes.menus["editor/title"].some((m: { command: string }) => m.command === "rung.declarations.open")).toBe(true);
  });

  it("no two keybindings share a key (Alt+Q D is download; declarations are Alt+Q A)", () => {
    const keys = pkg.contributes.keybindings.map((k: { key: string }) => k.key);
    expect(keys.filter((k: string, i: number) => keys.indexOf(k) !== i)).toEqual([]);
    expect(pkg.contributes.keybindings.find((k: { command: string }) => k.command === "rung.declarations.open").key).toBe("alt+q a");
  });

  it("every command in a menu is a contributed command", () => {
    for (const [, items] of Object.entries(pkg.contributes.menus as Record<string, { command?: string }[]>)) for (const i of items) if (i.command) expect(commands.has(i.command)).toBe(true);
  });
});
