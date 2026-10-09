// SPDX-License-Identifier: MIT
import { createInterface } from "node:readline";
let bootstrap;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (!bootstrap) { bootstrap = request; return; }
  const result = request.method === "bridge.hello" ? { protocol: 1, tiaVersion: "", bridgeVersion: "test", capabilities: [] } : bootstrap;
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
});
