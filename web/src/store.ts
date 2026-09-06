// Phase 1 has no registry contract, so the proofs a user makes live in
// localStorage — a convenience, not a source of truth. Phase 2's registry
// replaces this.

import { bytesToHex, hexToBytes } from "./util";

export interface HeldProof {
  purpose: string;
  bits: number;
  ts: number;
  proofCborHex: string;
}

const KEY = "ante:held-proofs:v1";

export function loadHeldProofs(): HeldProof[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HeldProof[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHeldProof(entry: HeldProof): void {
  try {
    const all = loadHeldProofs().filter((p) => p.proofCborHex !== entry.proofCborHex);
    all.unshift(entry);
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, 50)));
  } catch {
    // A private window or blocked storage — the proof was still returned to
    // the caller; only the local history is lost.
  }
}

export function forgetHeldProof(proofCborHex: string): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(loadHeldProofs().filter((p) => p.proofCborHex !== proofCborHex)),
    );
  } catch {
    /* ignore */
  }
}

export function proofCborToHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function proofCborFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}
