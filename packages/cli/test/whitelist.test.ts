// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { entryStatus } from "../src/setup.js";

const entry = (path: string, hash = "B9R84T8U=") =>
  `HKEY_LOCAL_MACHINE\\SOFTWARE\\Siemens\\Automation\\Openness\\20.0\\Whitelist\\rung-bridge-v20.exe\\Entry\r\n    Path    REG_SZ    ${path}\r\n    DateModified    REG_SZ    2026/10/04 13:10:54.000\r\n    FileHash    REG_SZ    ${hash}\r\n`;
const EXT = "C:\\Users\\me\\.vscode\\extensions\\sa1ntsinner.rung-scl-0.2.0\\rung\\bridge\\rung-bridge-v20.exe";
const COPY = "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\sa1ntsinner.rung-scl\\rung-0.2.0+abc\\bridge\\rung-bridge-v20.exe";

describe("the Openness whitelist entry, as TIA Portal reads it", () => {
  it("is ok only for the same file at the same path", () => {
    expect(entryStatus(entry(EXT), EXT, "B9R84T8U=")).toBe("ok");
    expect(entryStatus(entry(EXT.toUpperCase()), EXT, "B9R84T8U=")).toBe("ok");
    // the same bridge copied elsewhere (the extension's storage folder): TIA Portal still asks
    expect(entryStatus(entry(EXT), COPY, "B9R84T8U=")).toBe("stale");
    // another build at the same path
    expect(entryStatus(entry(EXT, "OTHER="), EXT, "B9R84T8U=")).toBe("stale");
    expect(entryStatus("", EXT, "B9R84T8U=")).toBe("missing");
  });

  it("reads reg export's format too (UTF-16 on disk, so a user folder outside ASCII stays intact)", () => {
    const jorg = "C:\\Users\\Jörg\\AppData\\Roaming\\Code\\User\\globalStorage\\sa1ntsinner.rung-scl\\rung-0.2.0+abc\\bridge\\rung-bridge-v20.exe";
    const exported = `Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Siemens\\Automation\\Openness\\20.0\\Whitelist\\rung-bridge-v20.exe\\Entry]\r\n"Path"="${jorg.split("\\").join("\\\\")}"\r\n"DateModified"="2026/10/04 13:10:54.000"\r\n"FileHash"="B9R84T8U="\r\n`;
    expect(entryStatus(exported, jorg, "B9R84T8U=")).toBe("ok");
    expect(entryStatus(exported, EXT, "B9R84T8U=")).toBe("stale");
  });
});
