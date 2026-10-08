// SPDX-License-Identifier: BUSL-1.1
// rung debug: a Debug Adapter Protocol server on stdin/stdout that debugs one test case on the offline
// simulator (VS Code, nvim-dap, Zed). The case replays from its start for every stop (DebugSession), so
// stepping back is as cheap as stepping on.
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { WorkspaceIndex } from "@rung/lsp";
import { breakpointLine, DebugSession, testPositions, type DebugState, type DebugVariable } from "@rung/sim";
import { findWorkspace, type Io } from "./common.js";

interface Request {
  seq: number;
  type: "request";
  command: string;
  arguments?: Record<string, unknown>;
}

export interface LaunchArgs {
  /** The test file, absolute or from the workspace (tests/motor.test.yaml). */
  test: string;
  /** The case, numbered from 0. */
  case?: number;
  stopOnEntry?: boolean;
}

/** Serves one debug session; resolves when the editor disconnects. */
export function startDebugAdapter(io: Io, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  let seq = 1;
  const send = (m: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ seq: seq++, ...m }), "utf8");
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };
  const event = (name: string, body?: unknown) => send({ type: "event", event: name, ...(body ? { body } : {}) });

  let session: DebugSession | undefined;
  let caseName = "";
  let launched: LaunchArgs | undefined;
  let configured = false;
  // by file: as the editor set them (id, line asked for) and where they stop (line), when the workspace is loaded
  const breakpoints = new Map<string, { id: number; asked: number; line: number; verified: boolean; condition?: string }[]>();
  let nextBreakpoint = 1;
  let index: WorkspaceIndex | undefined;
  /** A breakpoint moved to the statement it stops at, or unverified where nothing runs. */
  const place = (uri: string, b: { id: number; asked: number; condition?: string }) => {
    if (!index) return { ...b, line: b.asked, verified: true };
    const line = breakpointLine(index, uri, b.asked);
    return { ...b, line: line ?? b.asked, verified: line !== undefined };
  };
  const shownBreakpoint = (b: { id: number; line: number; verified: boolean }) => ({ id: b.id, verified: b.verified, line: b.line, ...(b.verified ? {} : { message: "No SCL statement the simulator runs here (a declaration, END_IF, a DB, LAD/FBD)" }) });
  // variable handles live until the next run: 1 and 2 are a frame's scopes, the rest children
  let handles = new Map<number, { frame: number; list: () => DebugVariable[] }>();
  let nextHandle = 1;
  const handle = (frame: number, list: () => DebugVariable[]) => {
    handles.set(nextHandle, { frame, list });
    return nextHandle++;
  };

  // what follows an answer (the initialized event, a run and its stopped event) goes out after it, in order
  const pending: (() => unknown)[] = [];
  const later = (fn: () => unknown) => void pending.push(fn);

  const report = (s: DebugState) => {
    handles = new Map();
    nextHandle = 1;
    if (s.kind === "stopped") {
      event("stopped", { reason: s.reason, threadId: 1, allThreadsStopped: true, description: s.text ?? `t = ${s.time} ms`, ...(s.text ? { text: s.text } : {}) });
      return;
    }
    const r = s.result;
    const lines: string[] = [];
    if (s.error) lines.push(`${s.error}`);
    if (r) {
      lines.push(`${r.passed ? "passed" : "FAILED"}: ${caseName || r.name}${r.error ? ` — ${r.errorStep ? `step ${r.errorStep}: ` : ""}${r.error}` : ""}`);
      for (const f of r.failures) lines.push(`  step ${f.step}: ${f.name} expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`);
    }
    if (s.note) lines.push(s.note);
    if (!lines.length) lines.push("The case did not run.");
    event("output", { category: r?.passed ? "console" : "stderr", output: lines.join("\n") + "\n" });
    event("terminated");
  };

  const syncBreakpoints = () => {
    if (session) session.breakpoints = [...breakpoints].flatMap(([uri, list]) => list.filter((b) => b.verified).map((b) => ({ uri, line: b.line, ...(b.condition ? { condition: b.condition } : {}) })));
  };

  const begin = async () => {
    if (!session || !launched || !configured) return;
    syncBreakpoints();
    report(await session.start(!!launched.stopOnEntry));
  };

  const prepare = async (a: LaunchArgs) => {
    if (!a?.test) throw new Error("launch needs `test`: the test file to debug (tests/motor.test.yaml)");
    const path = isAbsolute(a.test) ? a.test : resolve(io.cwd, a.test);
    const ws = await findWorkspace(dirname(path)).catch(() => io.cwd);
    const text = await readFile(path, "utf8").catch(() => {
      throw new Error(`no test file at ${path}`);
    });
    const loaded = new WorkspaceIndex();
    await loaded.load(ws);
    const rel = relative(ws, path).split("\\").join("/");
    const n = a.case ?? 0;
    const count = testPositions(text).length;
    if (!Number.isInteger(n) || n < 0 || n >= count) throw new Error(`${rel} has ${count} case${count === 1 ? "" : "s"}, numbered from 0: there is no case ${n}`);
    index = loaded;
    // breakpoints set before the launch move to their statements now
    for (const [uri, list] of breakpoints) {
      const placed = list.map((b) => place(uri, b));
      breakpoints.set(uri, placed);
      for (const b of placed) later(() => event("breakpoint", { reason: "changed", breakpoint: shownBreakpoint(b) }));
    }
    caseName = [...text.matchAll(/^\s*-\s*name:\s*(.+?)\s*$/gm)][n]?.[1]?.replace(/^["']|["']$/g, "") ?? `case ${n + 1}`;
    session = new DebugSession(loaded, rel, text, n);
    launched = a;
  };

  const step = async (run: (d: DebugSession) => Promise<DebugState>) => {
    if (session) report(await run(session));
  };

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<unknown> | unknown> = {
    initialize: () => {
      later(() => event("initialized"));
      return {
        supportsConfigurationDoneRequest: true,
        supportsConditionalBreakpoints: true,
        supportsStepBack: true,
        supportsSetVariable: true,
        supportsEvaluateForHovers: true,
        supportsTerminateRequest: true,
      };
    },
    launch: async (a) => {
      await prepare(a as unknown as LaunchArgs);
      later(() => begin());
    },
    configurationDone: () => {
      configured = true;
      later(() => begin());
    },
    setBreakpoints: (a) => {
      const source = a.source as { path?: string };
      const uri = source.path ? pathToFileURL(source.path).href : "";
      const list = ((a.breakpoints as { line: number; condition?: string }[] | undefined) ?? []).map((b) => place(uri, { id: nextBreakpoint++, asked: b.line, ...(b.condition ? { condition: b.condition } : {}) }));
      if (uri) breakpoints.set(uri, list);
      syncBreakpoints();
      return { breakpoints: list.map(shownBreakpoint) };
    },
    threads: () => ({ threads: [{ id: 1, name: caseName || "test case" }] }),
    stackTrace: () => {
      const frames = session?.frames() ?? [];
      return {
        stackFrames: frames.map((f, i) => ({ id: i, name: f.name, line: f.line, column: f.column, ...(f.uri ? { source: { name: basename(fileURLToPath(f.uri)), path: fileURLToPath(f.uri) } } : {}) })),
        totalFrames: frames.length,
      };
    },
    scopes: (a) => {
      const frame = Number(a.frameId ?? 0);
      const s = session!;
      return {
        scopes: [
          { name: "Locals", presentationHint: "locals", variablesReference: handle(frame, () => s.locals(frame)), expensive: false },
          { name: "Data blocks", variablesReference: handle(frame, () => s.globals()), expensive: false },
        ],
      };
    },
    variables: (a) => {
      const h = handles.get(Number(a.variablesReference));
      return {
        variables: (h?.list() ?? []).map((v) => ({
          name: v.name,
          value: v.value,
          ...(v.type ? { type: v.type } : {}),
          ...(v.evaluateName ? { evaluateName: v.evaluateName } : {}),
          variablesReference: v.children ? handle(h!.frame, v.children) : 0,
        })),
      };
    },
    setVariable: async (a) => {
      const h = handles.get(Number(a.variablesReference));
      const v = h?.list().find((x) => x.name === a.name);
      if (!h || !v?.evaluateName) throw new Error(`${String(a.name)} cannot be set`);
      const r = await session!.setVariable(v.evaluateName, String(a.value), h.frame);
      return { value: r.value };
    },
    evaluate: (a) => {
      const v = session!.evaluate(String(a.expression), Number(a.frameId ?? 0));
      return { result: v.value, ...(v.type ? { type: v.type } : {}), variablesReference: v.children ? handle(Number(a.frameId ?? 0), v.children) : 0 };
    },
    continue: () => {
      later(() => step((d) => d.continue()));
      return { allThreadsContinued: true };
    },
    next: () => void later(() => step((d) => d.next())),
    stepIn: () => void later(() => step((d) => d.stepIn())),
    stepOut: () => void later(() => step((d) => d.stepOut())),
    stepBack: () => void later(() => step((d) => d.stepBack())),
    reverseContinue: () => void later(() => step((d) => d.reverseContinue())),
    // a run takes milliseconds: there is nothing running to pause
    pause: () => undefined,
    terminate: () => void later(() => event("terminated")),
    disconnect: () => undefined,
  };

  return new Promise<void>((done) => {
    let buf = Buffer.alloc(0);
    let queue = Promise.resolve();
    const dispatch = async (req: Request) => {
      const h = handlers[req.command];
      const reply = (m: Record<string, unknown>) => send({ type: "response", request_seq: req.seq, command: req.command, ...m });
      if (!h) return reply({ success: false, message: `rung debug does not support ${req.command}` });
      try {
        const body = await h(req.arguments ?? {});
        reply({ success: true, ...(body ? { body } : {}) });
      } catch (e) {
        pending.length = 0;
        reply({ success: false, message: (e as Error).message, body: { error: { id: 1, format: (e as Error).message, showUser: req.command === "launch" } } });
      }
      for (const fn of pending.splice(0)) {
        try {
          await fn();
        } catch (e) {
          event("output", { category: "stderr", output: `rung debug: ${(e as Error).message}\n` });
        }
      }
      if (req.command === "disconnect") done();
    };
    input.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, end).toString("ascii"))?.[1]);
        if (!Number.isFinite(len) || buf.length < end + 4 + len) return;
        const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString("utf8")) as Request;
        buf = buf.subarray(end + 4 + len);
        // one request at a time, in order: a step finishes before the stack trace after it is answered
        queue = queue.then(() => dispatch(msg));
      }
    });
    input.on("end", () => done());
  });
}
