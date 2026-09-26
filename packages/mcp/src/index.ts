// SPDX-License-Identifier: BUSL-1.1
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type McpContext } from "./server.js";

export { createMcpServer, SAFETY_RULES, type McpContext } from "./server.js";

/** Serves MCP over stdio until the client disconnects. */
export async function serveStdio(ctx: McpContext): Promise<void> {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}
