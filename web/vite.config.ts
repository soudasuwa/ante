/// <reference types="node" />
import { defineConfig } from "vitest/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The delegate WASM and its address are written to web/.gen/ by
// scripts/sync-delegate.sh (which runs the canonical build and computes the
// key). Defaults keep `vite dev` and `vitest` working before anything is
// built — the UI just shows "delegate not built" until then.
function genText(filename: string, fallback: string): string {
  const p = resolve(__dirname, ".gen", filename);
  return existsSync(p) ? readFileSync(p, "utf-8").trim() : fallback;
}

function genBase64(filename: string): string {
  const p = resolve(__dirname, ".gen", filename);
  return existsSync(p) ? readFileSync(p).toString("base64") : "";
}

export default defineConfig({
  // Served from an iframe at a nested gateway path in production; relative
  // asset URLs are required.
  base: "./",
  define: {
    // Raw delegate WASM, base64. Inlined rather than fetched: the gateway
    // iframe's opaque origin makes a runtime asset fetch unreliable.
    __ANTE_DELEGATE_WASM_B64__: JSON.stringify(genBase64("ante_delegate.wasm")),
    // blake3(code_hash || params) — the node's delegate lookup key.
    __ANTE_DELEGATE_KEY_BYTES__: genText("ante_delegate_key_bytes.json", "[]"),
    // blake3(raw wasm) — a different hash; both are needed to register.
    __ANTE_DELEGATE_CODE_HASH_BYTES__: genText("ante_delegate_code_hash_bytes.json", "[]"),
    // The published ante-registry instance id (base58), from
    // scripts/publish-registry.sh. Empty until the contract is published —
    // the UI then shows only the local best level.
    __ANTE_REGISTRY_CONTRACT_ID__: JSON.stringify(genText("registry_contract_id.txt", "")),
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
