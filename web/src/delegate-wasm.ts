// Build-injected by vite.config.ts from web/.gen/ (written by
// scripts/sync-delegate.sh). Empty until the delegate is built — the UI
// detects that and tells you to run the build.

declare const __ANTE_DELEGATE_WASM_B64__: string;
declare const __ANTE_DELEGATE_KEY_BYTES__: number[];
declare const __ANTE_DELEGATE_CODE_HASH_BYTES__: number[];

export const ANTE_DELEGATE_WASM_B64: string = __ANTE_DELEGATE_WASM_B64__;
export const ANTE_DELEGATE_KEY_BYTES: number[] = __ANTE_DELEGATE_KEY_BYTES__;
export const ANTE_DELEGATE_CODE_HASH_BYTES: number[] = __ANTE_DELEGATE_CODE_HASH_BYTES__;

export function delegateIsBuilt(): boolean {
  return (
    ANTE_DELEGATE_WASM_B64.length > 0 &&
    ANTE_DELEGATE_KEY_BYTES.length === 32 &&
    ANTE_DELEGATE_CODE_HASH_BYTES.length === 32
  );
}
