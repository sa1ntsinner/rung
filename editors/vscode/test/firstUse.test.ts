// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { Args, type CheckItem } from "../src/core/args";
import { mirrorFolderFor, preflight, tiaReadiness, tiaVersionOf, validateRemoteProject } from "../src/core/firstUse";

const item = (id: string, status: CheckItem["status"], detail?: string, fix?: string): CheckItem => ({ id, group: "plc", name: id, status, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });
const good = [item("tia", "ok", "V20, V21"), item("openness", "ok", "V20, V21"), item("openness-group", "ok"), item("whitelist", "ok")];

it("completes TIA readiness only after every required check succeeds", () => {
  expect(tiaReadiness(good)).toEqual({ ok: true, message: "TIA sync ready" });
  expect(tiaReadiness([...good, item("codesys", "missing")]).ok).toBe(true);
  expect(tiaReadiness(good.filter(i => i.id !== "whitelist"))).toMatchObject({ ok: false });
  expect(tiaReadiness(good.map(i => i.id === "whitelist" ? { ...i, status: "warn" } : i))).toMatchObject({ ok: false, message: expect.stringContaining("whitelist") });
  expect(tiaReadiness(undefined).ok).toBe(false);
});

describe("first use: Open TIA Project", () => {
  it("accepts literal Windows project paths with spaces and non-ASCII characters, only for supported versions", () => {
    for (const path of ["C:\\Projects\\Líne 3\\Líne 3.ap19", "D:\\Work\\Line.AP20", "\\\\server\\projects\\Line.ap21"])
      expect(validateRemoteProject(path)).toBeUndefined();
    for (const path of ["", "C:\\Line.zap20", "C:\\Line.ap22", "C:\\Line.ap20.bak"])
      expect(validateRemoteProject(path)).toMatch(/\.ap19.*\.ap20.*\.ap21/);
  });
  it("reads the TIA Portal version from the project's extension", () => {
    expect(tiaVersionOf("C:\\P\\Line\\Line.ap19")).toBe("V19");
    expect(tiaVersionOf("C:\\P\\Line\\Line.AP21")).toBe("V21");
    // an archive: its own version, an older one retrieved with upgrade by V20
    expect(tiaVersionOf("C:\\P\\Line.zap20")).toBe("V20");
    expect(tiaVersionOf("C:\\P\\Line.zap17")).toBe("V20");
    expect(tiaVersionOf("C:\\P\\Line\\Line.ap20.bak")).toBeUndefined();
  });

  it("goes on when TIA Portal, Openness and the group are there", () => {
    expect(preflight(good, "V20")).toEqual({ ok: true });
  });

  it("stops before anything starts when the project's TIA Portal version is not installed", () => {
    expect(preflight(good, "V19")).toMatchObject({ ok: false, message: expect.stringMatching(/TIA Portal V19 is not installed.*V20, V21/) });
  });

  it("stops when the Windows user is not in the Openness group: that needs an administrator and a new sign-in", () => {
    const r = preflight([...good.filter((i) => i.id !== "openness-group"), item("openness-group", "missing", undefined, "an administrator adds you")], "V20");
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Siemens TIA Openness.*sign out and in/) });
  });

  it("offers the whitelist fix but does not stop for it", () => {
    const r = preflight([...good.filter((i) => i.id !== "whitelist"), item("whitelist", "warn")], "V20");
    expect(r).toEqual({ ok: true, whitelist: true });
  });

  it("an answer it cannot read does not block: rung init says what is wrong itself", () => {
    expect(preflight(undefined, "V20")).toEqual({ ok: true });
  });

  it("puts the mirror next to the project, never inside TIA Portal's folder", () => {
    expect(mirrorFolderFor("C:\\Work\\Line\\Line.ap20")).toBe("C:\\Work\\Line-rung");
    expect(mirrorFolderFor("C:\\Downloads\\Line.zap20")).toBe("C:\\Downloads\\Line-rung");
  });

  it("init and pull name the folder when it is not the open one", () => {
    expect(Args.init("C:\\P\\L.ap20")).toEqual(["init", "--project", "C:\\P\\L.ap20"]);
    expect(Args.init("C:\\P\\L.ap20", "C:\\W")).toEqual(["init", "C:\\W", "--project", "C:\\P\\L.ap20"]);
  });
});
