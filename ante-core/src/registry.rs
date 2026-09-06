//! The identity-level registry: a CRDT mapping each identity to the best
//! [`AnteProof`] it has published for the registry's purpose.
//!
//! This is the pure core — no `freenet-stdlib`. The contract in
//! `contracts/ante-registry/` is a thin shell over it, and a consuming app
//! links only `ante-core` and calls [`RegistryState::level`] after a plain
//! contract GET.
//!
//! ## What it is for
//!
//! Phase 1 hands an app an `AnteProof` per action, ground on demand. The
//! registry lets an identity publish its level *once* so an app can read it
//! without triggering a grind — "this identity is worth at least N bits" as a
//! lookup.
//!
//! ## Merge
//!
//! Per identity, keep the proof demonstrating the most bits; ties break on the
//! lexicographically greater signature. Both are pure functions of the set of
//! known proofs, so any arrival order converges. **Monotonic** — an identity
//! raises its level by publishing a better proof; it can never lower it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::proof::AnteProof;

/// Instance parameters, fixed at publish time.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct RegistryParameters {
    /// The single `purpose` every published proof must carry. Canonically
    /// `"ante:identity-level:v1"`.
    pub purpose: String,
    /// The floor the registry itself enforces. A proof below this is refused
    /// regardless of what a submitter claims; a consumer can still demand
    /// more on read.
    pub min_bits_floor: u32,
}

/// The registry state: identity verifying key → its best proof.
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct RegistryState {
    pub levels: BTreeMap<[u8; 32], AnteProof>,
}

/// A delta / update: proofs to fold in.
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct RegistryDelta {
    pub proofs: Vec<AnteProof>,
}

/// A summary for anti-entropy: identity → bits the peer already has.
///
/// **Known limit: this is linear in the number of registered identities.** A
/// summary ships to every interested peer on every anti-entropy heartbeat
/// (~5 min) whether or not anything changed, so its size is a standing
/// bandwidth cost, not a per-update one. Each entry costs ~42 CBOR bytes
/// (a 32-byte key encodes as a 34-byte array header + bytes, plus 1–5 for the
/// u32), so:
///
/// | identities | summary |
/// |---|---|
/// | 1 000 | ~42 KB |
/// | 10 000 | ~420 KB |
///
/// That is fine at the scale this is built for and untenable past roughly
/// 5 000 identities. The fix, when it is needed, is the standard one: replace
/// the flat map with K fixed buckets each holding a digest of that bucket's
/// contents, making the summary constant-size at the cost of `get_state_delta`
/// returning a superset of the true delta. That is sound here because
/// [`RegistryState::admit`] is idempotent — re-applying a proof already held is
/// a no-op. It is deferred only because changing this type re-keys the contract
/// and strands every published level, so it should be batched with any other
/// wire change rather than shipped alone.
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct RegistrySummary {
    pub bits: BTreeMap<[u8; 32], u32>,
}

/// Why a proof was refused entry to the registry.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdmitError {
    /// The proof's `identity_vk` does not match the key it was filed under.
    KeyMismatch,
    /// The proof carries a purpose other than the registry's.
    WrongPurpose,
    /// The proof does not clear [`RegistryParameters::min_bits_floor`], or is
    /// otherwise invalid.
    BelowFloor,
}

impl RegistryState {
    /// The bits an identity has on record, if any. The stored proof is
    /// re-verified so a corrupt state cannot inflate a level.
    pub fn level(&self, identity_vk: &[u8; 32]) -> Option<u32> {
        let proof = self.levels.get(identity_vk)?;
        proof.verify(0).ok()
    }

    /// Fold one proof in. Returns `Ok(true)` if it raised (or set) the
    /// identity's level, `Ok(false)` if an equal-or-better proof was already
    /// held, `Err` if the proof is not admissible.
    pub fn admit(
        &mut self,
        params: &RegistryParameters,
        proof: AnteProof,
    ) -> Result<bool, AdmitError> {
        if proof.purpose != params.purpose {
            return Err(AdmitError::WrongPurpose);
        }
        let bits = proof
            .verify(params.min_bits_floor)
            .map_err(|_| AdmitError::BelowFloor)?;
        let key = proof.identity_vk;

        match self.levels.get(&key) {
            Some(existing) if !supersedes(&proof, bits, existing) => Ok(false),
            _ => {
                self.levels.insert(key, proof);
                Ok(true)
            }
        }
    }

    /// Merge another state in (full-state PUT path). Every incoming proof is
    /// re-checked; anything inadmissible is skipped rather than poisoning the
    /// merge.
    pub fn merge(&mut self, params: &RegistryParameters, other: &RegistryState) {
        for proof in other.levels.values() {
            let _ = self.admit(params, proof.clone());
        }
    }

    pub fn summarize(&self) -> RegistrySummary {
        RegistrySummary {
            bits: self
                .levels
                .iter()
                .filter_map(|(k, p)| p.verify(0).ok().map(|b| (*k, b)))
                .collect(),
        }
    }

    /// Proofs this state holds that beat what `summary` says the peer has.
    pub fn delta_since(&self, summary: &RegistrySummary) -> RegistryDelta {
        RegistryDelta {
            proofs: self
                .levels
                .iter()
                .filter_map(|(k, proof)| {
                    let bits = proof.verify(0).ok()?;
                    match summary.bits.get(k) {
                        Some(&had) if had >= bits => None,
                        _ => Some(proof.clone()),
                    }
                })
                .collect(),
        }
    }

    /// Structural check for a state received as raw bytes: every proof filed
    /// under its own key, matching the purpose, clearing the floor.
    pub fn is_well_formed(&self, params: &RegistryParameters) -> Result<(), AdmitError> {
        for (key, proof) in &self.levels {
            if *key != proof.identity_vk {
                return Err(AdmitError::KeyMismatch);
            }
            if proof.purpose != params.purpose {
                return Err(AdmitError::WrongPurpose);
            }
            proof
                .verify(params.min_bits_floor)
                .map_err(|_| AdmitError::BelowFloor)?;
        }
        Ok(())
    }
}

/// Would `candidate` (already verified to `candidate_bits`) replace `existing`?
/// More bits wins; a tie breaks on the lexicographically greater signature so
/// every peer picks the same proof.
fn supersedes(candidate: &AnteProof, candidate_bits: u32, existing: &AnteProof) -> bool {
    let existing_bits = existing.verify(0).unwrap_or(0);
    match candidate_bits.cmp(&existing_bits) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => candidate.signature.to_bytes() > existing.signature.to_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pow;
    use ed25519_dalek::SigningKey;

    const PURPOSE: &str = "ante:identity-level:v1";

    fn params(floor: u32) -> RegistryParameters {
        RegistryParameters {
            purpose: PURPOSE.into(),
            min_bits_floor: floor,
        }
    }

    fn proof_for(seed: u8, purpose: &str, bits: u32) -> AnteProof {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let vk = key.verifying_key().to_bytes();
        let nonce = pow::grind(purpose, &vk, bits).expect("reachable");
        AnteProof::create(&key, purpose.into(), nonce, 1_700_000_000_000)
    }

    #[test]
    fn admit_records_then_reports_the_level() {
        let mut state = RegistryState::default();
        let p = proof_for(1, PURPOSE, 12);
        let vk = p.identity_vk;
        assert_eq!(state.admit(&params(8), p), Ok(true));
        assert!(state.level(&vk).unwrap() >= 12);
    }

    #[test]
    fn a_weaker_later_proof_does_not_lower_the_level() {
        let mut state = RegistryState::default();
        let strong = proof_for(2, PURPOSE, 16);
        let vk = strong.identity_vk;
        state.admit(&params(8), strong).unwrap();
        let before = state.level(&vk).unwrap();

        // Same identity, a proof ground only to 10 bits.
        let weak = proof_for(2, PURPOSE, 10);
        assert_eq!(state.admit(&params(8), weak), Ok(false));
        assert_eq!(state.level(&vk).unwrap(), before);
    }

    #[test]
    fn a_proof_below_the_floor_is_refused() {
        let mut state = RegistryState::default();
        let p = proof_for(3, PURPOSE, 6);
        assert_eq!(state.admit(&params(20), p), Err(AdmitError::BelowFloor));
    }

    #[test]
    fn a_proof_for_another_purpose_is_refused() {
        let mut state = RegistryState::default();
        let p = proof_for(4, "someone-elses:purpose", 12);
        assert_eq!(state.admit(&params(8), p), Err(AdmitError::WrongPurpose));
    }

    #[test]
    fn merge_is_order_independent_and_keeps_the_stronger_proof() {
        let weak = proof_for(5, PURPOSE, 10);
        let strong = proof_for(5, PURPOSE, 15);
        let vk = weak.identity_vk;

        let mut a = RegistryState::default();
        a.admit(&params(8), weak.clone()).unwrap();
        let mut b = RegistryState::default();
        b.admit(&params(8), strong.clone()).unwrap();

        let mut ab = a.clone();
        ab.merge(&params(8), &b);
        let mut ba = b.clone();
        ba.merge(&params(8), &a);

        assert_eq!(ab, ba);
        assert!(ab.level(&vk).unwrap() >= 15);
    }

    #[test]
    fn delta_since_carries_only_improvements() {
        let mut state = RegistryState::default();
        state.admit(&params(8), proof_for(6, PURPOSE, 12)).unwrap();
        state.admit(&params(8), proof_for(7, PURPOSE, 14)).unwrap();

        // A peer that already has seed-6 at its current level and nothing else.
        let mut summary = RegistrySummary::default();
        let vk6 = SigningKey::from_bytes(&[6u8; 32])
            .verifying_key()
            .to_bytes();
        summary.bits.insert(vk6, state.level(&vk6).unwrap());

        let delta = state.delta_since(&summary);
        assert_eq!(delta.proofs.len(), 1);
        assert_eq!(
            delta.proofs[0].identity_vk,
            SigningKey::from_bytes(&[7u8; 32])
                .verifying_key()
                .to_bytes()
        );
    }

    // --- merge laws -------------------------------------------------------
    //
    // Replicas converge only if merge is a join: idempotent, commutative, and
    // associative over the exact stored bytes. Freenet delivers at-least-once
    // and in any order, so all three are load-bearing — idempotence especially,
    // because a merge that changes state on re-application never settles.

    /// Same proof, different `ts` — identical bit count, different signature.
    /// The tie-break has to pick one of these deterministically.
    fn tied_pair(seed: u8, bits: u32) -> (AnteProof, AnteProof) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let vk = key.verifying_key().to_bytes();
        let nonce = pow::grind(PURPOSE, &vk, bits).expect("reachable");
        (
            AnteProof::create(&key, PURPOSE.into(), nonce, 1_700_000_000_000),
            AnteProof::create(&key, PURPOSE.into(), nonce, 1_700_000_000_001),
        )
    }

    fn state_of(proofs: &[AnteProof]) -> RegistryState {
        let mut s = RegistryState::default();
        for p in proofs {
            let _ = s.admit(&params(8), p.clone());
        }
        s
    }

    #[test]
    fn merge_is_idempotent() {
        let a = state_of(&[proof_for(20, PURPOSE, 12), proof_for(21, PURPOSE, 14)]);

        let mut once = a.clone();
        once.merge(&params(8), &a);
        assert_eq!(once, a, "merging a state with itself must not change it");

        let mut twice = once.clone();
        twice.merge(&params(8), &a);
        assert_eq!(twice, once, "and must stay put on redelivery");
    }

    #[test]
    fn admitting_the_same_proof_twice_is_a_no_op() {
        let p = proof_for(22, PURPOSE, 12);
        let mut state = RegistryState::default();
        assert_eq!(state.admit(&params(8), p.clone()), Ok(true));
        let after_first = state.clone();
        assert_eq!(state.admit(&params(8), p), Ok(false));
        assert_eq!(state, after_first);
    }

    #[test]
    fn merge_is_associative() {
        let a = state_of(&[proof_for(23, PURPOSE, 10)]);
        let b = state_of(&[proof_for(23, PURPOSE, 14), proof_for(24, PURPOSE, 12)]);
        let c = state_of(&[proof_for(24, PURPOSE, 16), proof_for(25, PURPOSE, 11)]);

        let mut left = a.clone(); // (a ∪ b) ∪ c
        left.merge(&params(8), &b);
        left.merge(&params(8), &c);

        let mut bc = b.clone(); // a ∪ (b ∪ c)
        bc.merge(&params(8), &c);
        let mut right = a.clone();
        right.merge(&params(8), &bc);

        assert_eq!(left, right);
    }

    #[test]
    fn a_tie_resolves_the_same_way_on_every_peer() {
        let (first, second) = tied_pair(26, 12);
        let vk = first.identity_vk;

        // Two peers see the tied proofs in opposite orders.
        let mut peer_a = state_of(&[first.clone(), second.clone()]);
        let peer_b = state_of(&[second, first]);
        assert_eq!(peer_a, peer_b, "the tie-break must not depend on order");

        // And merging the two settles immediately rather than flapping.
        let before = peer_a.clone();
        peer_a.merge(&params(8), &peer_b);
        assert_eq!(peer_a, before);
        assert!(peer_a.level(&vk).unwrap() >= 12);
    }

    #[test]
    fn a_converged_peer_gets_an_empty_delta() {
        // `get_state_delta` must not re-ship state a peer already holds — the
        // delta to an up-to-date peer carries no proofs at all.
        let state = state_of(&[proof_for(27, PURPOSE, 12), proof_for(28, PURPOSE, 13)]);
        let delta = state.delta_since(&state.summarize());
        assert!(delta.proofs.is_empty(), "converged peers exchange nothing");
    }

    #[test]
    fn a_delta_applied_twice_lands_in_the_same_place() {
        let source = state_of(&[proof_for(29, PURPOSE, 12)]);
        let delta = source.delta_since(&RegistrySummary::default());

        let mut peer = RegistryState::default();
        for p in &delta.proofs {
            let _ = peer.admit(&params(8), p.clone());
        }
        let after_first = peer.clone();
        for p in &delta.proofs {
            let _ = peer.admit(&params(8), p.clone());
        }
        assert_eq!(peer, after_first);
        assert_eq!(peer, source);
    }

    #[test]
    fn is_well_formed_rejects_a_mis_keyed_state() {
        let mut state = RegistryState::default();
        let p = proof_for(8, PURPOSE, 12);
        state.levels.insert([0u8; 32], p); // filed under the wrong key
        assert_eq!(
            state.is_well_formed(&params(8)),
            Err(AdmitError::KeyMismatch)
        );
    }

    #[test]
    fn level_re_verifies_so_a_corrupt_entry_reads_as_absent() {
        let mut state = RegistryState::default();
        let mut p = proof_for(9, PURPOSE, 12);
        let vk = p.identity_vk;
        p.ts += 1; // breaks the signature
        state.levels.insert(vk, p);
        assert_eq!(state.level(&vk), None);
    }
}
