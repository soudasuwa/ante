import { defineConfig } from "vite";

export default defineConfig({
  // Served from an iframe at a nested gateway path in production; relative
  // asset URLs are required.
  base: "./",
  // @ante/client is consumed as TypeScript source (its `exports` points at
  // src/index.ts). Excluding it from pre-bundling lets Vite transform its
  // source directly — needed for the inlined `?worker&inline` grind worker.
  optimizeDeps: {
    exclude: ["@ante/client"],
  },
});
