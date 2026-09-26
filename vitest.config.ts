import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@rung/core": src("core"),
      "@rung/bridge-client": src("bridge-client"),
      "@rung/sync": src("sync"),
      "@rung/cli": src("cli"),
      "@rung/lsp": src("lsp"),
      "@rung/graph": src("graph"),
      "@rung/mcp": src("mcp"),
      "@rung/live": src("live"),
      "@rung/sim": src("sim"),
      "@rung/pro": fileURLToPath(new URL("./pro/packages/pro/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "pro/packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20000,
    // live e2e suites share one TIA Portal instance: run their files one after another
    fileParallelism: process.env.RUNG_E2E !== "1",
  },
});
