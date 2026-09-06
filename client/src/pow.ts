// The grind, matching `ante_core::pow`:
//   digest = blake3(challenge_bytes || nonce.to_le_bytes())
//   bits   = leading zero bits of the digest
// `challenge_bytes` comes from the delegate (AnteResponse::Challenge) so the
// domain-separation layout lives in exactly one place — Rust.
//
// `@noble/hashes` blake3 is pure JS (~100s of K hashes/s, not the GB/s of a
// native build), so the inner loop is written to avoid per-iteration
// allocation: one input buffer, rewrite only the 8 nonce bytes each try.

import { blake3 } from "@noble/hashes/blake3.js";

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
    } else {
      bits += Math.clz32(byte) - 24;
      break;
    }
  }
  return bits;
}

export function powDigest(challenge: Uint8Array, nonce: number): Uint8Array {
  const input = new Uint8Array(challenge.length + 8);
  input.set(challenge);
  new DataView(input.buffer).setBigUint64(challenge.length, BigInt(nonce), true);
  return blake3(input);
}

export function powBits(challenge: Uint8Array, nonce: number): number {
  return leadingZeroBits(powDigest(challenge, nonce));
}

/// A reusable grinder over one challenge. `next(count)` tries the next `count`
/// nonces and returns the first satisfying one, or `null` if none in that
/// batch — so the caller can report progress between batches.
export class Grinder {
  private readonly input: Uint8Array;
  private readonly nonceView: DataView;
  private nonce = 0;
  tried = 0;

  constructor(
    challenge: Uint8Array,
    private readonly targetBits: number,
  ) {
    this.input = new Uint8Array(challenge.length + 8);
    this.input.set(challenge);
    this.nonceView = new DataView(this.input.buffer, challenge.length, 8);
  }

  next(batch: number): number | null {
    for (let i = 0; i < batch; i++) {
      this.nonceView.setBigUint64(0, BigInt(this.nonce), true);
      const digest = blake3(this.input);
      this.tried++;
      if (leadingZeroBits(digest) >= this.targetBits) return this.nonce;
      this.nonce++;
    }
    return null;
  }
}

/// Expected tries to clear `bits` is 2^bits, so a target much past ~32 is not a
/// grind, it is a hang. Cap the synchronous helper at a budget a caller can
/// reason about rather than spinning forever on a typo'd target.
const DEFAULT_MAX_TRIES = 1 << 30;

/// Synchronous grind — tests, and any caller happy to block. Throws once
/// `maxTries` nonces have been tried without reaching `targetBits`; the worker
/// (`pow-worker.ts`) is the non-blocking path and reports progress instead.
export function grind(
  challenge: Uint8Array,
  targetBits: number,
  maxTries = DEFAULT_MAX_TRIES,
): number {
  const g = new Grinder(challenge, targetBits);
  while (g.tried < maxTries) {
    const hit = g.next(1 << 16);
    if (hit !== null) return hit;
  }
  throw new Error(`no nonce reached ${targetBits} bits in ${maxTries.toLocaleString()} tries`);
}
