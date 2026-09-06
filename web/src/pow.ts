// The grind, matching `ante_core::pow`:
//   digest = blake3(challenge_bytes || nonce.to_le_bytes())
//   bits   = leading zero bits of the digest
// `challenge_bytes` is produced by the delegate (AnteResponse::Challenge) so
// the domain-separation layout lives in exactly one place — Rust.

import { blake3 } from "@noble/hashes/blake3.js";

export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
    } else {
      // Math.clz32 counts 32-bit leading zeros; a single byte contributes
      // clz32(byte) - 24.
      bits += Math.clz32(byte) - 24;
      break;
    }
  }
  return bits;
}

export function powDigest(challenge: Uint8Array, nonce: number): Uint8Array {
  const input = new Uint8Array(challenge.length + 8);
  input.set(challenge);
  // u64 little-endian. The grind never approaches 2^53, let alone 2^64.
  new DataView(input.buffer).setBigUint64(challenge.length, BigInt(nonce), true);
  return blake3(input);
}

export function powBits(challenge: Uint8Array, nonce: number): number {
  return leadingZeroBits(powDigest(challenge, nonce));
}

/// Synchronous grind — used in tests and as the worker's inner loop.
export function grind(challenge: Uint8Array, targetBits: number): number {
  for (let nonce = 0; ; nonce++) {
    if (powBits(challenge, nonce) >= targetBits) return nonce;
  }
}
