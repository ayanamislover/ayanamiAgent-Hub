import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  resolve: {
    alias: [
      {
        find: "@crossagent/protocol/terminal",
        replacement: fileURLToPath(
          new URL("../../packages/protocol/src/terminal.ts", import.meta.url),
        ),
      },
      {
        find: "@crossagent/client",
        replacement: fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
      },
      {
        find: "@crossagent/protocol",
        replacement: fileURLToPath(
          new URL("../../packages/protocol/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4387",
      "/mcp": "http://127.0.0.1:4387",
      "/ws": {
        target: "ws://127.0.0.1:4387",
        ws: true,
      },
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
  },
});
