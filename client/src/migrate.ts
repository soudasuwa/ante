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

/// What an app must supply to carry its own state forward. The probe owns the
/// decisions (order, hit criteria, when to stop, what counts as an answer);
/// this is the part only the app can know.
export interface GenerationProbe<T> {
  /// Items in a predecessor's state that are still valid under the CURRENT
  /// rules, plus a count of those that are not.
  ///
  /// Dropping happens here, deliberately, rather than being left to the
  /// contract: a delta is rejected as a whole if any single item in it is
  /// inadmissible, so one stale item would block every good one travelling
  /// with it. It is also the honest place for it — a rule that tightened (a
  /// security fix, say) legitimately strands what it was protecting against,
  /// and that is a drop, not an absence.
  decode(stateBytes: Uint8Array): { carryable: T[]; dropped: number };
  /// Submit one batch through the app's normal write path, so the contract's
  /// own validator sees every item.
  submit(items: T[]): Promise<void>;
  /// Items per delta. State that grows without bound needs this; the default
  /// suits collections that do not.
  chunkSize?: number;
}

export interface MigrationReport {
  /// Predecessor ids that answered with state.
  hits: string[];
  /// Answered, but held nothing.
  empty: string[];
  /// Never answered — timed out or errored. NOT evidence of absence.
  unresolved: string[];
  /// Items carried into the current generation.
  carried: number;
  /// Items found but not carried: no longer valid under the current rules.
  dropped: number;
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

function bytesMatch(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/// Probe every predecessor and carry what they hold into the current generation.
///
/// Sweeps all generations rather than stopping at the newest that answers. That
/// is `freenet-migrate`'s `FoldAll`, and its warning about resurrecting
/// delete-by-absence data applies only to state that deletes; ante's
/// collections are grow-only, so more is strictly better and cannot undo
/// anything.
export async function probeGenerations<T>(
  client: FreenetClient,
  current: string,
  predecessors: readonly string[],
  probe: GenerationProbe<T>,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    hits: [],
    empty: [],
    unresolved: [],
    carried: 0,
    dropped: 0,
    complete: true,
  };
  const collected: T[] = [];

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

    let carryable: T[] = [];
    let dropped = 0;
    try {
      ({ carryable, dropped } = probe.decode(bytes));
    } catch {
      // Undecodable state is an answer: this generation holds nothing usable.
    }
    report.dropped += dropped;
    if (carryable.length === 0) report.empty.push(id);
    else {
      report.hits.push(id);
      collected.push(...carryable);
    }
  }

  // Duplicates and already-known items are harmless — every one of ante's
  // collections is a monotonic union, so re-submitting is a no-op.
  const chunk = probe.chunkSize ?? 64;
  for (let i = 0; i < collected.length; i += chunk) {
    await probe.submit(collected.slice(i, i + chunk));
  }
  report.carried = collected.length;
  return report;
}

/// The registry's carry-forward: identity levels.
///
/// `self` is the identity held on THIS device, if any. The sweep carries every
/// proof it finds, for every identity — that is the point of it, and it is safe
/// because the contract re-validates each one on the way in. But that makes
/// `carried` a fact about the network, not about the person looking at the
/// screen, and a UI that reports it as "recovered N levels" tells them their
/// levels came back when nothing of theirs was involved. `carriedSelf` is the
/// only part of the report that is about them.
export async function migrateRegistry(
  client: FreenetClient,
  current: string,
  predecessors: readonly string[],
  minBits: number,
  submit: (proofs: AnteProof[]) => Promise<void>,
  self?: Uint8Array,
): Promise<RegistryMigrationReport> {
  let carriedSelf = false;
  const report = await probeGenerations<AnteProof>(client, current, predecessors, {
    decode: (bytes) => {
      const all = allProofsIn(bytes);
      const carryable = all.filter((p) => verifyAnteProof(p, minBits).ok);
      if (self && carryable.some((p) => bytesMatch(p.identityVk, self))) carriedSelf = true;
      return { carryable, dropped: all.length - carryable.length };
    },
    submit,
  });
  return { ...report, carriedSelf };
}

export interface RegistryMigrationReport extends MigrationReport {
  /// Whether one of the carried proofs belongs to this device's identity.
  /// False when the sweep only moved other people's records forward.
  carriedSelf: boolean;
}

/// Every proof a registry state holds, filed under its own key. Validity
/// against the current floor is the caller's business.
function allProofsIn(stateBytes: Uint8Array): AnteProof[] {
  if (stateBytes.length === 0) return [];
  const levels = mapGet(cborDecode(stateBytes), "levels");
  if (!(levels instanceof Map)) return [];

  const out: AnteProof[] = [];
  for (const [key, value] of levels) {
    try {
      const proof = decodeAnteProofValue(value);
      if (bytesMatch(asBytes(key), proof.identityVk)) out.push(proof);
    } catch {
      // a corrupt entry is skipped, never carried
    }
  }
  return out;
}
