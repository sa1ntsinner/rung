#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Runs S7-PLCSIM V20 for the live download tests without a window on screen: PLCSIM starts on its own
// Windows desktop and one S7-1500 instance is created and powered on through the app's DevTools port.
//
//   node tools/fixtures/plcsim.mjs start     # prints the instance address when it is up
//   node tools/fixtures/plcsim.mjs stop
//
// TIA Portal lists the "PLCSIM" PG/PC interface only if it starts after PLCSIM, so start the fixture host after this.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXE = process.env.RUNG_PLCSIM_EXE ?? "C:\\Program Files\\Siemens\\Automation\\PLCSIM_V20\\S7PLCSIMV20.exe";
const PORT = Number(process.env.RUNG_PLCSIM_DEVTOOLS_PORT ?? 9333);
const PID_FILE = join(tmpdir(), "rung-plcsim.pid");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAUNCH = String.raw`
param([string]$Exe, [string]$Arguments)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RungDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SI { public int cb; public string r, desktop, title; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, i, o, e; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr p, t; public int pid, tid; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string n, IntPtr d, IntPtr m, int f, uint a, IntPtr s);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string a, string c, IntPtr pa, IntPtr ta, bool inh, uint f, IntPtr env, string cwd, ref SI si, out PI pi);
    public static int Start(string exe, string args) {
        if (CreateDesktop("rung-plcsim", IntPtr.Zero, IntPtr.Zero, 0, 0x10000000u, IntPtr.Zero) == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var si = new SI(); si.cb = Marshal.SizeOf(si); si.desktop = "rung-plcsim"; PI pi;
        if (!CreateProcess(null, "\"" + exe + "\" " + args, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, System.IO.Path.GetDirectoryName(exe), ref si, out pi)) throw new System.ComponentModel.Win32Exception();
        return pi.pid;
    }
}
'@
[RungDesktop]::Start($Exe, $Arguments)
`;

async function page() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = list.find((x) => x.type === "page");
  if (!p) throw new Error("PLCSIM has no page yet");
  return p.webSocketDebuggerUrl;
}

/** Evaluates JavaScript in the PLCSIM window and returns the value. */
async function evaluate(expression) {
  const ws = new WebSocket(await page());
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  try {
    const reply = new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true }));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    const r = await Promise.race([reply, sleep(15000).then(() => ({ error: "timeout" }))]);
    return r.result?.result?.value;
  } finally {
    ws.close();
  }
}

async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > end) throw new Error(`PLCSIM: timed out waiting for ${what}`);
    await sleep(1000);
  }
}

async function start() {
  if (!existsSync(EXE)) throw new Error(`S7-PLCSIM V20 not found at ${EXE}`);
  let running = false;
  try {
    await page();
    running = true;
  } catch {
    /* start it */
  }
  if (!running) {
    const script = join(mkdtempSync(join(tmpdir(), "rung-plcsim-")), "launch.ps1");
    writeFileSync(script, LAUNCH);
    // the first process on a freshly created desktop often exits during start-up; a second launch works
    for (let attempt = 1; ; attempt++) {
      const pid = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Exe", EXE, "-Arguments", `--remote-debugging-port=${PORT} --disable-gpu`], { encoding: "utf8" }).trim();
      writeFileSync(PID_FILE, pid);
      try {
        await until("the PLCSIM window", async () => (await evaluate("!!document.querySelector('#S7-1500-add-button')")) === true, 45000);
        break;
      } catch (e) {
        spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
        if (attempt === 3) throw e;
      }
    }
  }
  // the page shows its buttons before the app behind it listens, so a click can be lost: repeat it until it takes
  const instances = () => evaluate("document.querySelectorAll('[id^=instance-power-icon]').length");
  let added = 0;
  await until("the new instance", async () => {
    if ((await instances()) > 0) return true;
    if (added++ % 10 === 0) await evaluate("document.querySelector('#S7-1500-add-button').click()");
    return false;
  }, 90000);
  const led = () => evaluate("document.querySelector('[id^=run-stop-led]').className");
  const on = async () => /orange|green|yellow/.test((await led()) ?? "");
  let clicked = 0;
  await until("the instance to power on", async () => {
    if (await on()) return true;
    if (clicked++ % 10 === 0) await evaluate("document.querySelector('[id^=instance-power-icon]').click()");
    return false;
  }, 120000);
  const address = await evaluate("document.querySelector('[id^=x1-interface]').innerText");
  console.log(`PLCSIM READY ${address}`);
}

/** Ends only the PLCSIM this script started (its whole process tree), never one the person runs. */
function stop() {
  if (!existsSync(PID_FILE)) {
    console.log("no PLCSIM started by this script");
    return;
  }
  const pid = readFileSync(PID_FILE, "utf8").trim();
  spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  rmSync(PID_FILE, { force: true });
  console.log("PLCSIM stopped");
}

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "stop") stop();
else {
  console.error("usage: node tools/fixtures/plcsim.mjs start|stop");
  process.exit(1);
}
