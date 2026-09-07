//! The canonical cross-implementation test vector.
//!
//! Both [`crate::proof`]'s `cbor_wire_format_is_pinned` test and
//! `client/test/ante-proof.test.ts` pin the exact bytes this produces. It is
//! the one place the Rust and TypeScript halves are held to the same wire
//! format.
//!
//! To regenerate after a **deliberate** format change:
//! `cargo run -p ante-core --features testvec --example print_vector`, then
//! paste the new `proof_cbor_hex` / `challenge_hex` into both pin sites. Any
//! such change is breaking for every proof already stored anywhere.
#![doc(hidden)]

use ed25519_dalek::SigningKey;

use crate::{pow, proof::AnteProof};

pub const SEED: [u8; 32] = [0x2a; 32];
pub const PURPOSE: &str = "ante:identity-level:v1";
pub const TS: u64 = 1_726_000_000_000;
pub const TARGET_BITS: u32 = 16;

pub fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&SEED)
}

pub fn verifying_key() -> [u8; 32] {
    signing_key().verifying_key().to_bytes()
}

/// The pinned proof: fixed seed, purpose, and timestamp; the smallest nonce
/// reaching [`TARGET_BITS`].
pub fn proof() -> AnteProof {
    let nonce = pow::grind(PURPOSE, &verifying_key(), TARGET_BITS).expect("16 bits is reachable");
    AnteProof::create(&signing_key(), PURPOSE.to_string(), nonce, TS)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
