//! # ante-core
//!
//! The shared primitive behind **ante**: a small, mandatory proof-of-work cost
//! attached to a Freenet identity. It fills the gap between *no effort at all
//! to sybil* and *needs a [ghost key](https://freenet.org/ghostkey)* — the
//! stepping stone for low-stakes contracts (a guestbook, a comment box) that
//! want a measurable commitment without a gatekeeper.
//!
//! An **ante** is a signed [`AnteProof`]: a nonce ground against a purpose
//! string and an identity key, plus that identity's signature over the fact.
//! A consumer calls [`AnteProof::verify`] with its own `min_bits` policy and
//! gets back the leading-zero bits the proof demonstrates.
//!
//! This crate has **no `freenet-stdlib` dependency** — a contract or app that
//! only needs to *verify* proofs links just this. The delegate that *produces*
//! proofs (key custody, the consent prompt) is a separate crate.
//!
//! ## Scope
//!
//! A proof establishes that a key **cost something** for this purpose. It does
//! not establish uniqueness, personhood, or that the key is not one of many an
//! attacker ground (each costs the same). Resisting a resourced adversary is
//! explicitly *not* this project's job — that is what ghost keys and
//! reputation systems above it are for.
//!
//! ```
//! use ante_core::{pow, proof::AnteProof};
//! use ed25519_dalek::SigningKey;
//!
//! let key = SigningKey::from_bytes(&[42u8; 32]);
//! let vk = key.verifying_key().to_bytes();
//!
//! // Producer: grind, then sign (the delegate does the signing behind a prompt).
//! let nonce = pow::grind("demo:purpose", &vk, 10).unwrap();
//! let proof = AnteProof::create(&key, "demo:purpose".into(), nonce, 1_700_000_000_000);
//!
//! // Consumer: apply a policy threshold, get the achieved bits.
//! let bits = proof.verify(8).unwrap();
//! assert!(bits >= 10);
//! ```

pub mod pow;
pub mod proof;
#[cfg(feature = "protocol")]
pub mod protocol;
pub mod registry;

/// The pinned cross-implementation vector. Behind a feature so it is not part
/// of a consumer's public API — see `Cargo.toml`.
#[cfg(any(test, feature = "testvec"))]
#[doc(hidden)]
pub mod testvec;

pub use proof::{fingerprint, AnteProof, VerifyError};
#[cfg(feature = "protocol")]
pub use protocol::{AnteRequest, AnteResponse};

use serde::{de::DeserializeOwned, Serialize};

/// CBOR-encode a value. All wire payloads in this system are CBOR; only the
/// signature and PoW preimages use a hand-rolled canonical byte layout.
pub fn to_cbor<T: Serialize>(value: &T) -> Vec<u8> {
    let mut bytes = Vec::new();
    ciborium::into_writer(value, &mut bytes).expect("CBOR serialization cannot fail");
    bytes
}

/// Decode a CBOR-encoded value.
pub fn from_cbor<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    ciborium::from_reader(bytes).map_err(|e| format!("CBOR decode failed: {e}"))
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn requests_and_responses_cbor_round_trip() {
        let reqs = [
            AnteRequest::GetIdentity,
            AnteRequest::Challenge {
                purpose: "guestbook".into(),
            },
            AnteRequest::Commit {
                purpose: "guestbook".into(),
                nonce: 12345,
                min_bits: 20,
                ts: 1_700_000_000_000,
            },
            AnteRequest::ListGrants,
            AnteRequest::RevokeGrant { origin: None },
            AnteRequest::RevokeGrant {
                origin: Some(vec![9, 9, 9]),
            },
            AnteRequest::ExportIdentity,
            AnteRequest::ImportIdentity {
                seed: vec![0x2a; 32],
            },
        ];
        for req in reqs {
            assert_eq!(from_cbor::<AnteRequest>(&to_cbor(&req)).unwrap(), req);
        }

        let resps = [
            AnteResponse::Identity {
                verifying_key: [7u8; 32],
            },
            AnteResponse::Challenge {
                bytes: vec![1, 2, 3],
            },
            AnteResponse::Committed {
                proof: vec![4, 5, 6],
            },
            AnteResponse::Denied,
            AnteResponse::Grants {
                origins: vec![vec![1, 2], vec![3, 4]],
            },
            AnteResponse::Revoked,
            AnteResponse::IdentitySeed { seed: [0x2a; 32] },
            AnteResponse::Imported {
                verifying_key: [8u8; 32],
            },
            AnteResponse::Error {
                message: "nope".into(),
            },
        ];
        for resp in resps {
            assert_eq!(from_cbor::<AnteResponse>(&to_cbor(&resp)).unwrap(), resp);
        }
    }
}
