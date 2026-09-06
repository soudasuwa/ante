// The recovery code: a transcribable backup of an identity's 32-byte secret
// seed. `ante-` + base58(seed ‖ blake3(seed)[:4]). The 4-byte checksum catches
// a typo or a truncated paste before it is imported as the wrong key.
//
// Whoever holds this code controls the identity — treat it like a password.

import { blake3 } from "@noble/hashes/blake3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

import { fingerprint } from "./ante-proof";
import { base58, base58decode, bytesEqual } from "./util";

const PREFIX = "ante-";
const SEED_LEN = 32;
const CHECK_LEN = 4;

/// Encode a 32-byte seed as a recovery code.
export function identityCodeFromSeed(seed: Uint8Array): string {
  if (seed.length !== SEED_LEN) throw new Error("identity seed must be 32 bytes");
  const body = new Uint8Array(SEED_LEN + CHECK_LEN);
  body.set(seed, 0);
  body.set(blake3(seed).slice(0, CHECK_LEN), SEED_LEN);
  return PREFIX + base58(body);
}

/// Decode a recovery code back to the seed. Throws with a specific message on a
/// bad prefix, bad characters, wrong length, or checksum mismatch.
export function identitySeedFromCode(code: string): Uint8Array {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) {
    throw new Error(`a recovery code starts with "${PREFIX}"`);
  }
  const body = base58decode(trimmed.slice(PREFIX.length));
  if (body.length !== SEED_LEN + CHECK_LEN) {
    throw new Error("recovery code is the wrong length — it looks incomplete");
  }
  const seed = body.slice(0, SEED_LEN);
  const check = body.slice(SEED_LEN);
  if (!bytesEqual(check, blake3(seed).slice(0, CHECK_LEN))) {
    throw new Error("recovery code checksum does not match — check for a typo");
  }
  return seed;
}

/// The identity fingerprint a recovery code resolves to, without importing it —
/// so a UI can show "this will restore identity X" before the user commits.
export function identityFingerprintFromCode(code: string): string {
  return fingerprint(ed25519.getPublicKey(identitySeedFromCode(code)));
}
