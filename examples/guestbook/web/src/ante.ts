// ─────────────────────────────────────────────────────────────────────────
//  The entire ante integration. Everything ante-specific in this app is here.
//
//  Producing side  — start an open-ended grind, let the reader decide how much
//                    work to commit, then sign the best result they waited for.
//  Verifying side  — re-check every proof the app displays, so a forged entry
//                    that somehow reached state is not shown as valid. (The
//                    contract already rejects them on write; this is defence in
//                    depth and lets the UI label each entry.)
// ─────────────────────────────────────────────────────────────────────────

import {
  AnteClient,
  verifyAnteProof,
  type AnteProof,
  type FreenetClient,
  type GrindProgress,
  type GrindSession,
} from "@ante/client";

import { contentPurpose, GUESTBOOK_MIN_BITS } from "./guestbook";

export type { GrindProgress, GrindSession };

/// Attach the ante delegate to the node. The delegate WASM ships inside
/// @ante/client — nothing to deploy.
export function attachAnte(fn: FreenetClient): Promise<AnteClient> {
  return AnteClient.attach(fn);
}

/// Begin grinding for a post. Returns a handle: it keeps improving the proof
/// until `commit()` (sign the best so far, behind the consent prompt) or
/// `stop()`. `GUESTBOOK_MIN_BITS` is the contract's floor, so `session.ready`
/// only turns true once the proof would actually be accepted.
export function startPostGrind(
  ante: AnteClient,
  name: string,
  text: string,
  onProgress: (progress: GrindProgress) => void,
  onPrompt?: () => void,
): Promise<GrindSession> {
  // Bound to this exact message, so the work cannot be reused for another.
  //
  // grind() asks the node for permission BEFORE spending anything, so the
  // prompt names this message and this bar while refusing is still free. The
  // work starts only once the user has agreed to it.
  return ante.grind(contentPurpose(name, text), {
    minBits: GUESTBOOK_MIN_BITS,
    onProgress,
    onPrompt,
  });
}

/// Split a predecessor generation's entries into those still valid under the
/// CURRENT rules and a count of those that are not.
///
/// The drops are not corruption. Entries written before proofs were bound to
/// the message they pay for carry a bare purpose, and the contract now demands
/// a content-bound one — so a security fix legitimately strands the data it was
/// protecting against. Carrying them would reopen "one grind buys unlimited
/// posts".
export function carryableEntries(entries: { name: string; text: string; proof: AnteProof }[]): {
  carryable: typeof entries;
  dropped: number;
} {
  const carryable = entries.filter((e) => checkProof(e) !== null);
  return { carryable, dropped: entries.length - carryable.length };
}

/// Re-verify a displayed entry's proof. Returns the bits it demonstrates, or
/// null if it does not clear the guestbook's bar / the signature is bad.
export function checkProof(entry: { name: string; text: string; proof: AnteProof }): number | null {
  // Both halves matter: the proof must verify AND be bound to this message.
  if (entry.proof.purpose !== contentPurpose(entry.name, entry.text)) return null;
  const result = verifyAnteProof(entry.proof, GUESTBOOK_MIN_BITS);
  return result.ok ? result.bits : null;
}
