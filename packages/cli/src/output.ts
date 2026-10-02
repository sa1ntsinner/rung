// SPDX-License-Identifier: BUSL-1.1
import type { Writable } from "node:stream";

/** A pager closing its input ends the command normally, including a running watch. */
export function quietBrokenPipe(stream: Writable, exit: (code: number) => void = (code) => process.exit(code)): void {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") exit(0);
    else throw e;
  });
}
