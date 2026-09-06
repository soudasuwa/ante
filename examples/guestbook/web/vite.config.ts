/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // Served from an iframe at a nested gateway path in production.
  base: "./",
  // @ante/client is consumed as TypeScript source; excluding it from
  // pre-bundling lets Vite transform its inlined grind worker.
  optimizeDeps: {
    exclude: ["@ante/client"],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
