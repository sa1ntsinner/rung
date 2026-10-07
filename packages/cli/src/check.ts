// SPDX-License-Identifier: BUSL-1.1
import { formatChecks, realProbes, runChecks } from "@rung/core";
import type { Io } from "./common.js";

export async function cmdCheck(v: Record<string, unknown>, io: Io): Promise<number> {
  const { whitelistHere } = await import("./setup.js");
  const { bridgeExecutable } = await import("./paths.js");
  const items = await runChecks(realProbes(io.env, () => whitelistHere(io.env)));
  if (v.json) io.stdout(JSON.stringify(items, null, 2) + "\n");
  else {
    io.stdout(formatChecks(items, !!process.stdout.isTTY && !io.env.NO_COLOR));
    io.stdout("rung setup wires rung into your editors and AI agents.\n");
  }
  return 0;
}
