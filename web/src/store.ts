// A record of proofs signed in this browser session.
//
// The gateway serves the webapp in an opaque-origin sandbox iframe, where
// `localStorage` is unavailable (a `SecurityError` on access). So the session
// list is held in memory — visible and copyable while the tab is open, gone on
// refresh. `localStorage` is still used opportunistically: outside the sandbox
// (`vite dev`, or a future non-iframe host) it persists across reloads.
//
// The durable record of an *identity-level* proof is the registry contract,
// not this. Per-action proofs are ephemeral by design — the app you commit for
// receives the proof and owns it from there.

import { bytesToHex, hexToBytes } from "./util";

export interface HeldProof {
  purpose: string;
  bits: number;
  ts: number;
  proofCborHex: string;
}

const KEY = "ante:held-proofs:v1";
const MAX = 50;

let session: HeldProof[] = hydrate();

function hydrate(): HeldProof[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as HeldProof[]) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Sandbox / private window — the in-memory list is still authoritative.
  }
}

export function loadHeldProofs(): HeldProof[] {
  return session;
}

export function saveHeldProof(entry: HeldProof): void {
  session = [entry, ...session.filter((p) => p.proofCborHex !== entry.proofCborHex)].slice(0, MAX);
  persist();
}

export function forgetHeldProof(proofCborHex: string): void {
  session = session.filter((p) => p.proofCborHex !== proofCborHex);
  persist();
}

/// True when the list will survive a page reload (i.e. `localStorage` works).
export function heldProofsPersist(): boolean {
  try {
    const probe = "ante:probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function proofCborToHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function proofCborFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}
