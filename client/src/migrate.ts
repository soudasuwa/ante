// Carrying state forward across a contract re-key.
//
// A contract's address is its bytes, so any rebuild strands the old instance's
// state. The fix is to probe the predecessors recorded in the lineage and bring
// what they hold into the current generation.
//
// The decision rules here are taken from `freenet-migrate`, which packages what
// River and Delta each learned the hard way. Two of them matter more than they
// look:
//
//   * **Silence is not absence.** A predecessor that times out is UNRESOLVED,
//     not empty. Recording the migration as finished on a timeout writes off
//     data that was merely slow.
//   * **`NotFound` is not proof either** — on this network it is wrong more
//     often than it is right — so it is treated the same way.
//
// A sweep that leaves anything unresolved reports `complete: false`, and the
// caller is expected to run it again on a later load.
//
// What ante does NOT need is the crate's merge-then-verify fold. Its state
// decomposes into independently valid `AnteProof`s, so migration is simply
// resubmitting them through the normal delta path, where the contract's own
// `admit` re-validates every one. Nothing unverified can enter, which makes the
// sweep permissionless: anyone may run it, for anyone's proofs.

import { verifyAnteProof, type AnteProof } from "./ante-proof";
import { asBytes, cborDecode, mapGet } from "./cbor";
import type { FreenetClient } from "./freenet";
import { contractKeyFromId } from "./freenet";
import { decodeAnteProofValue } from "./ante-proof";

/// How long to wait for one predecessor before calling it unresolved. A GET for
/// a contract nobody hosts any more does not fail fast, so without this the
/// sweep would hang rather than report a gap.
const PROBE_TIMEOUT_MS = 12_000;

export interface MigrationReport {
  /// Predecessor ids that answered with state.
  hits: string[];
  /// Answered, but held nothing.
  empty: string[];
  /// Never answered — timed out or errored. NOT evidence of absence.
  unresolved: string[];
  /// Proofs carried into the current generation.
  carried: number;
  /// True only when every predecessor answered. While false the sweep should
  /// be run again on a later load: something may still be out there.
  complete: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/// Every proof a registry state holds, ignoring any that no longer verify.
function proofsIn(stateBytes: Uint8Array, minBits: number): AnteProof[] {
  if (stateBytes.length === 0) return [];
  const levels = mapGet(cborDecode(stateBytes), "levels");
  if (!(levels instanceof Map)) return [];

  const out: AnteProof[] = [];
  for (const [key, value] of levels) {
    let proof: AnteProof;
    try {
      proof = decodeAnteProofValue(value);
    } catch {
      continue; // a corrupt entry is skipped, never carried
    }
    // Filed under its own key, and still clearing the floor the CURRENT
    // generation enforces — the contract rejects a whole delta if any proof in
    // it is inadmissible, so an unusable proof must not travel with the rest.
    try {
      if (!bytesMatch(asBytes(key), proof.identityVk)) continue;
    } catch {
      continue;
    }
    if (verifyAnteProof(proof, minBits).ok) out.push(proof);
  }
  return out;
}

function bytesMatch(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/// Probe every predecessor and carry what they hold into the current registry.
///
/// Sweeps all generations rather than stopping at the newest that answers: the
/// registry is a monotonic union, so more proofs is strictly better and cannot
/// undo anything. (That is `freenet-migrate`'s `FoldAll`. Its warning about
/// resurrecting delete-by-absence data does not apply here — nothing is ever
/// deleted from this state.)
export async function migrateRegistry(
  client: FreenetClient,
  current: string,
  predecessors: readonly string[],
  minBits: number,
  submit: (proofs: AnteProof[]) => Promise<void>,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    hits: [],
    empty: [],
    unresolved: [],
    carried: 0,
    complete: true,
  };
  const collected: AnteProof[] = [];

  for (const id of predecessors) {
    if (id === current) continue;
    let bytes: Uint8Array | null;
    try {
      bytes = await withTimeout(client.getContractState(contractKeyFromId(id)), PROBE_TIMEOUT_MS);
    } catch {
      bytes = null;
    }

    if (bytes === null) {
      // Timed out, errored, or answered NotFound. None of those prove the
      // generation is empty, so the sweep stays incomplete and runs again.
      report.unresolved.push(id);
      report.complete = false;
      continue;
    }

    const proofs = proofsIn(bytes, minBits);
    if (proofs.length === 0) report.empty.push(id);
    else {
      report.hits.push(id);
      collected.push(...proofs);
    }
  }

  if (collected.length > 0) {
    // One delta. Duplicates and already-known proofs are harmless: `admit` keeps
    // the better of the two and reports the rest as no-ops.
    await submit(collected);
    report.carried = collected.length;
  }
  return report;
}
