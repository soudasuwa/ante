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

import { GUESTBOOK_MIN_BITS, GUESTBOOK_PURPOSE } from "./guestbook";

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
  onProgress: (progress: GrindProgress) => void,
): Promise<GrindSession> {
  return ante.grind(GUESTBOOK_PURPOSE, { minBits: GUESTBOOK_MIN_BITS, onProgress });
}

/// Re-verify a displayed entry's proof. Returns the bits it demonstrates, or
/// null if it does not clear the guestbook's bar / the signature is bad.
export function checkProof(proof: AnteProof): number | null {
  const result = verifyAnteProof(proof, GUESTBOOK_MIN_BITS);
  return result.ok ? result.bits : null;
}
