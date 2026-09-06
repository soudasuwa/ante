//! The signed commitment an app receives and a consumer verifies.
//!
//! An [`AnteProof`] says: *the holder of `identity_vk` ground `nonce` against
//! `purpose`, and signed that fact at `ts`.* The number of bits it demonstrates
//! is not stored — it is recomputed from the nonce at verification time, so it
//! can never be overstated. A consumer supplies its own `min_bits` policy and
//! gets the achieved bit count back.
//!
//! What a proof means and does not mean:
//! - It proves the key **cost something** to use for this purpose — it is not a
//!   zero-cost sybil.
//! - It does **not** prove the key is unique, human-held, or not one of many an
//!   attacker made (each costs the same). Whales are explicitly out of scope;
//!   this is the floor between "no effort" and "needs a ghost key".

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::pow;

/// Domain-separation prefix for the proof signature preimage.
const SIGNING_CONTEXT: &[u8] = b"ante:proof-signature:v1";

/// A signed proof-of-work commitment bound to one identity and one purpose.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct AnteProof {
    /// Ed25519 verifying key of the committing identity.
    pub identity_vk: [u8; 32],
    /// What the work is for. A consumer decides which purpose string(s) it
    /// accepts; an unexpected purpose is a rejection, not a downgrade.
    pub purpose: String,
    /// The proof-of-work solution. Its achieved bit count is a pure function
    /// of `(purpose, identity_vk, nonce)` and is recomputed on verify.
    pub nonce: u64,
    /// Producer wall-clock, milliseconds since the Unix epoch. **Not trusted
    /// for freshness** (nothing enforces it) and **not calibrated** — a
    /// consumer that cares about hardware-era drift applies its own discount.
    pub ts: u64,
    /// Ed25519 signature by `identity_vk` over [`signing_bytes`].
    pub signature: Signature,
}

/// Canonical signed preimage:
/// `SIGNING_CONTEXT || identity_vk || len(purpose) le || purpose || nonce le || ts le`.
fn signing_bytes(identity_vk: &[u8; 32], purpose: &str, nonce: u64, ts: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIGNING_CONTEXT.len() + 32 + 4 + purpose.len() + 8 + 8);
    out.extend_from_slice(SIGNING_CONTEXT);
    out.extend_from_slice(identity_vk);
    out.extend_from_slice(&(purpose.len() as u32).to_le_bytes());
    out.extend_from_slice(purpose.as_bytes());
    out.extend_from_slice(&nonce.to_le_bytes());
    out.extend_from_slice(&ts.to_le_bytes());
    out
}

/// Why a proof failed verification.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerifyError {
    /// `identity_vk` is not a valid Ed25519 point.
    MalformedKey,
    /// `purpose` is empty or longer than [`pow::MAX_PURPOSE_BYTES`].
    BadPurpose,
    /// The nonce does not reach the consumer's `min_bits` threshold.
    InsufficientWork { have: u32, need: u32 },
    /// The signature is not valid for this identity over this proof.
    BadSignature,
}

impl core::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            VerifyError::MalformedKey => write!(f, "identity_vk is not a valid ed25519 key"),
            VerifyError::BadPurpose => write!(f, "purpose is empty or too long"),
            VerifyError::InsufficientWork { have, need } => {
                write!(f, "proof demonstrates {have} bits, need {need}")
            }
            VerifyError::BadSignature => write!(f, "signature does not verify for this identity"),
        }
    }
}

impl std::error::Error for VerifyError {}

impl AnteProof {
    /// Build and sign a proof. Delegate-side only — the caller must already
    /// hold the [`SigningKey`]. `nonce` is taken on trust here (the delegate
    /// checks it against the requested bar before calling); verification is
    /// what makes it sound end to end.
    pub fn create(key: &SigningKey, purpose: String, nonce: u64, ts: u64) -> Self {
        let identity_vk = key.verifying_key().to_bytes();
        let signature = key.sign(&signing_bytes(&identity_vk, &purpose, nonce, ts));
        AnteProof {
            identity_vk,
            purpose,
            nonce,
            ts,
            signature,
        }
    }

    /// Verify the proof and return the leading-zero bits it demonstrates.
    ///
    /// `min_bits` is the consumer's policy: how much work this action is worth
    /// requiring. Set it so one identity's grind exceeds the value at risk per
    /// action, and treat multiple identities independently.
    ///
    /// The check order is cheapest-first: key shape, purpose bounds, then the
    /// one blake3 hash for the work count, then the Ed25519 verification last.
    pub fn verify(&self, min_bits: u32) -> Result<u32, VerifyError> {
        let vk =
            VerifyingKey::from_bytes(&self.identity_vk).map_err(|_| VerifyError::MalformedKey)?;

        if self.purpose.is_empty() || self.purpose.len() > pow::MAX_PURPOSE_BYTES {
            return Err(VerifyError::BadPurpose);
        }

        let achieved = pow::bits(&self.purpose, &self.identity_vk, self.nonce);
        if achieved < min_bits {
            return Err(VerifyError::InsufficientWork {
                have: achieved,
                need: min_bits,
            });
        }

        vk.verify_strict(
            &signing_bytes(&self.identity_vk, &self.purpose, self.nonce, self.ts),
            &self.signature,
        )
        .map_err(|_| VerifyError::BadSignature)?;

        Ok(achieved)
    }

    /// bs58 of the first 8 bytes of the verifying key — a short, stable handle
    /// for display in permission prompts and UIs. Not a security boundary.
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.identity_vk)
    }
}

/// bs58 of the first 8 bytes of a verifying key. See [`AnteProof::fingerprint`].
pub fn fingerprint(identity_vk: &[u8; 32]) -> String {
    bs58::encode(&identity_vk[..8]).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pow;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn signed_proof(k: &SigningKey, purpose: &str, target_bits: u32) -> AnteProof {
        let vk = k.verifying_key().to_bytes();
        let nonce = pow::grind(purpose, &vk, target_bits).expect("reachable");
        AnteProof::create(k, purpose.to_string(), nonce, 1_700_000_000_000)
    }

    #[test]
    fn round_trip_verifies_and_reports_bits() {
        let k = key(1);
        let proof = signed_proof(&k, "ante:identity-level:v1", 12);
        let bits = proof.verify(12).expect("verifies");
        assert!(bits >= 12);
        assert_eq!(proof.verify(8), Ok(bits));
    }

    /// The wire format every stored proof and every third-party verifier
    /// depends on. If this fails after a deliberate serde/layout change:
    /// `cargo run -p ante-core --example print_vector`, paste the new hex
    /// here AND into `web/test/ante-proof.test.ts`, and treat it as a
    /// breaking change for every proof already in the wild.
    #[test]
    fn cbor_wire_format_is_pinned() {
        let proof = crate::testvec::proof();
        assert_eq!(
            crate::testvec::hex(&crate::to_cbor(&proof)),
            "a56b6964656e746974795f766b98201819187f186b182318e1186c1885183218c618ab18c8183818fa\
             18cd185e18a7188918be0c187618b2189203183403189b18fa188b183d1836188d18616770757270\
             6f736576616e74653a6964656e746974792d6c6576656c3a7631656e6f6e6365198b196274731b00\
             000191dd9dec00697369676e6174757265984018f6188b07189c18d5182b184518e8187f185e1871\
             18a418e618cc189e18ff1897185f189e1838188018ef186d1860188f18c50f18de18e618f118de18\
             6e189d186518510f1834182f189a1869189e0d18d0185a18cc189a188418ad14184b187e184a18bc\
             186e1858121872189718ea18ad182718e418970a"
        );
    }

    /// The challenge layout the grinder (JS or Rust) hashes against.
    #[test]
    fn challenge_bytes_are_pinned() {
        let vk = crate::testvec::verifying_key();
        assert_eq!(
            crate::testvec::hex(&pow::challenge_bytes(crate::testvec::PURPOSE, &vk)),
            "616e74653a706f772d6368616c6c656e67653a763116000000616e74653a6964656e746974792d6c65\
             76656c3a7631197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61"
        );
    }

    #[test]
    fn insufficient_work_is_rejected_without_touching_the_signature() {
        let k = key(2);
        let proof = signed_proof(&k, "guestbook", 10);
        match proof.verify(24) {
            Err(VerifyError::InsufficientWork { need: 24, .. }) => {}
            other => panic!("expected InsufficientWork, got {other:?}"),
        }
    }

    #[test]
    fn tampering_with_the_nonce_breaks_the_signature() {
        let k = key(3);
        let mut proof = signed_proof(&k, "guestbook", 12);
        // Find another nonce that still clears 12 bits, so the work check
        // passes and only the signature can catch the swap.
        let vk = proof.identity_vk;
        let mut alt = proof.nonce + 1;
        while pow::bits("guestbook", &vk, alt) < 12 {
            alt += 1;
        }
        proof.nonce = alt;
        assert_eq!(proof.verify(12), Err(VerifyError::BadSignature));
    }

    #[test]
    fn tampering_with_the_timestamp_breaks_the_signature() {
        let k = key(4);
        let mut proof = signed_proof(&k, "guestbook", 10);
        proof.ts += 1;
        assert_eq!(proof.verify(8), Err(VerifyError::BadSignature));
    }

    #[test]
    fn a_proof_for_one_purpose_does_not_verify_as_another() {
        let k = key(5);
        let mut proof = signed_proof(&k, "app-a:action", 12);
        proof.purpose = "app-b:action".to_string();
        // Both the work (bound to purpose) and the signature (covers purpose)
        // fail; work is checked first.
        match proof.verify(12) {
            Err(VerifyError::InsufficientWork { .. }) | Err(VerifyError::BadSignature) => {}
            other => panic!("expected rejection, got {other:?}"),
        }
    }

    #[test]
    fn another_identity_cannot_present_someone_elses_work() {
        let victim = key(6);
        let attacker = key(7);
        let mut proof = signed_proof(&victim, "guestbook", 12);
        // Attacker swaps in their own key but keeps the victim's nonce.
        proof.identity_vk = attacker.verifying_key().to_bytes();
        assert!(proof.verify(12).is_err());
    }

    #[test]
    fn cbor_round_trips() {
        let k = key(8);
        let proof = signed_proof(&k, "guestbook", 10);
        let bytes = crate::to_cbor(&proof);
        let back: AnteProof = crate::from_cbor(&bytes).expect("decodes");
        assert_eq!(proof, back);
        assert!(back.verify(8).is_ok());
    }

    #[test]
    fn empty_purpose_is_rejected() {
        let k = key(9);
        let nonce = pow::grind("", &k.verifying_key().to_bytes(), 4).unwrap();
        let proof = AnteProof::create(&k, String::new(), nonce, 1);
        assert_eq!(proof.verify(0), Err(VerifyError::BadPurpose));
    }
}
