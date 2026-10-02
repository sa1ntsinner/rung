// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { quietBrokenPipe } from "../src/output.js";

describe("CLI output pipes", () => {
  it("a reader closing the pipe exits quietly with code 0", async () => {
    const stream = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error("broken pipe"), { code: "EPIPE" })); } });
    const exits: number[] = [];
    quietBrokenPipe(stream, (code) => exits.push(code));
    stream.write("FAIL tests/valve.test.yaml:3 Valve: opens\n");
    await new Promise<void>((resolve) => stream.once("close", resolve));
    expect(exits).toEqual([0]);
  });

  it("preserves other output errors", () => {
    const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });
    quietBrokenPipe(stream, () => { throw new Error("must not exit quietly"); });
    const error = Object.assign(new Error("disk error"), { code: "EIO" });
    expect(() => stream.emit("error", error)).toThrow(error);
  });
});
