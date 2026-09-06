// Fallback for the generated, gitignored `embedded.ts`. The `prepare` script
// copies this into place on a fresh install so `tsc` / `vitest` resolve
// without a delegate build; `scripts/sync-delegate.sh` writes the real thing
// (base64 delegate WASM + key + registry id).
export const ANTE_DELEGATE_WASM_B64 = "";
export const ANTE_DELEGATE_KEY_BYTES: number[] = [];
export const ANTE_DELEGATE_CODE_HASH_BYTES: number[] = [];
export const ANTE_REGISTRY_CONTRACT_ID = "";
export function delegateEmbedded(): boolean {
  return (
    ANTE_DELEGATE_WASM_B64.length > 0 &&
    ANTE_DELEGATE_KEY_BYTES.length === 32 &&
    ANTE_DELEGATE_CODE_HASH_BYTES.length === 32
  );
}
