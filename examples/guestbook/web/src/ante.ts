// ─────────────────────────────────────────────────────────────────────────
//  The entire ante integration. Everything ante-specific in this app is here.
//
//  Producing side  — one call: grind proof of work for GUESTBOOK_PURPOSE and,
//                    with the user's consent, get a signed proof back.
//  Verifying side  — one call: re-check every proof the app displays, so a
//                    forged entry that somehow reached state is not shown as
//                    valid. (The contract already rejects them on write; this
//                    is defence in depth and lets the UI label each entry.)
// ─────────────────────────────────────────────────────────────────────────

import {
  AnteClient,
  verifyAnteProof,
  type AnteProof,
  type FreenetClient,
} from "@ante/client";

import { GUESTBOOK_MIN_BITS, GUESTBOOK_PURPOSE } from "./guestbook";

export interface GrindProgress {
  (tried: number, hashesPerSecond: number): void;
}

/// Attach the ante delegate to the node. The delegate WASM ships inside
/// @ante/client — nothing to deploy.
export function attachAnte(fn: FreenetClient): Promise<AnteClient> {
  return AnteClient.attach(fn);
}

/// Grind a proof for one post. Resolves to the proof, or null if the user
/// declined the consent prompt. `onProgress` drives the grind indicator;
/// `onPrompt` fires when the request reaches the node.
export async function proofForPost(
  ante: AnteClient,
  opts: { onProgress?: GrindProgress; onPrompt?: () => void },
): Promise<AnteProof | null> {
  const outcome = await ante.commit(GUESTBOOK_PURPOSE, {
    minBits: GUESTBOOK_MIN_BITS,
    onProgress: opts.onProgress,
    onPrompt: opts.onPrompt,
  });
  return outcome.kind === "committed" ? outcome.proof : null;
}

/// Re-verify a displayed entry's proof. Returns the bits it demonstrates, or
/// null if it does not clear the guestbook's bar / the signature is bad.
export function checkProof(proof: AnteProof): number | null {
  const result = verifyAnteProof(proof, GUESTBOOK_MIN_BITS);
  return result.ok ? result.bits : null;
}
