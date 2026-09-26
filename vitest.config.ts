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
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20000,
  },
});
