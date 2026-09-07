import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Served from an iframe at a nested gateway path.
  base: "./",
  build: {
    rollupOptions: {
      // whitepaper.html is generated from the repo's WHITEPAPER.md by
      // scripts/render-whitepaper.mjs, so the page can never drift from the
      // document it renders.
      input: {
        main: resolve(__dirname, "index.html"),
        whitepaper: resolve(__dirname, "whitepaper.html"),
      },
    },
  },
});
