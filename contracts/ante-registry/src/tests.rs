//! Native tests for the contract shell. The CRDT itself is tested in
//! `ante_core::registry`; these check the decode / dispatch / re-encode layer
//! and the delta-vs-state update policy.

use ante_core::pow;
use ante_core::proof::AnteProof;
use ante_core::registry::{RegistryDelta, RegistryParameters, RegistryState};
use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::*;

use crate::{cbor, from_cbor, Contract};

const PURPOSE: &str = "ante:identity-level:v1";
const FLOOR: u32 = 10;

fn params_bytes() -> Parameters<'static> {
    Parameters::from(cbor(&RegistryParameters {
        purpose: PURPOSE.into(),
        min_bits_floor: FLOOR,
    }))
}

fn proof(seed: u8, purpose: &str, bits: u32) -> AnteProof {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let vk = key.verifying_key().to_bytes();
    let nonce = pow::grind(purpose, &vk, bits).expect("reachable");
    AnteProof::create(&key, purpose.into(), nonce, 1_700_000_000_000)
}

fn vk(seed: u8) -> [u8; 32] {
    SigningKey::from_bytes(&[seed; 32])
        .verifying_key()
        .to_bytes()
}

fn submit(state: &[u8], proofs: Vec<AnteProof>) -> Result<Vec<u8>, ContractError> {
    let data = vec![UpdateData::Delta(StateDelta::from(cbor(&RegistryDelta {
        proofs,
    })))];
    Contract::update_state(params_bytes(), State::from(state.to_vec()), data)
        .map(|m| m.new_state.expect("state").into_bytes())
}

fn state_of(bytes: &[u8]) -> RegistryState {
    from_cbor(bytes).expect("decodes")
}

fn validate(bytes: &[u8]) -> ValidateResult {
    Contract::validate_state(
        params_bytes(),
        State::from(bytes.to_vec()),
        RelatedContracts::default(),
    )
    .expect("validate ok")
}

#[test]
fn a_submitted_proof_becomes_a_readable_level() {
    let s = submit(&[], vec![proof(1, PURPOSE, 14)]).expect("accepted");
    assert!(matches!(validate(&s), ValidateResult::Valid));
    assert!(state_of(&s).level(&vk(1)).unwrap() >= 14);
}

#[test]
fn a_delta_with_a_below_floor_proof_is_rejected_whole() {
    let ok = proof(2, PURPOSE, 12);
    let bad = proof(3, PURPOSE, 4); // may fluke the floor; retry seeds if so
    let bad = if bad.verify(FLOOR).is_ok() {
        proof(4, PURPOSE, 2)
    } else {
        bad
    };
    let err = submit(&[], vec![ok, bad]);
    assert!(err.is_err(), "one bad proof rejects the whole delta");
}

#[test]
fn a_delta_with_a_wrong_purpose_proof_is_rejected() {
    let bad = proof(5, "some-app:action:v1", 12);
    assert!(submit(&[], vec![bad]).is_err());
}

#[test]
fn resubmitting_a_weaker_proof_is_a_harmless_noop() {
    let strong = submit(&[], vec![proof(6, PURPOSE, 16)]).unwrap();
    let before = state_of(&strong).level(&vk(6)).unwrap();
    // Not an improvement — Ok(false) inside admit, not an error.
    let after = submit(&strong, vec![proof(6, PURPOSE, 11)]).expect("no-op, not an error");
    assert_eq!(state_of(&after).level(&vk(6)).unwrap(), before);
}

#[test]
fn a_full_state_merge_keeps_the_stronger_side_either_way() {
    let a = submit(&[], vec![proof(7, PURPOSE, 11)]).unwrap();
    let b = submit(&[], vec![proof(7, PURPOSE, 15)]).unwrap();

    let merge = |x: Vec<u8>, y: Vec<u8>| {
        Contract::update_state(
            params_bytes(),
            State::from(x),
            vec![UpdateData::State(State::from(y))],
        )
        .unwrap()
        .new_state
        .unwrap()
        .into_bytes()
    };
    let ab = merge(a.clone(), b.clone());
    let ba = merge(b, a);
    assert_eq!(ab, ba);
    assert!(state_of(&ab).level(&vk(7)).unwrap() >= 15);
}

#[test]
fn validate_rejects_a_state_carrying_a_forged_proof() {
    let mut p = proof(8, PURPOSE, 12);
    p.ts += 1; // breaks the signature
    let mut state = RegistryState::default();
    state.levels.insert(p.identity_vk, p);
    assert!(matches!(validate(&cbor(&state)), ValidateResult::Invalid));
}

#[test]
fn summary_and_delta_round_trip_through_the_contract() {
    let s1 = submit(&[], vec![proof(9, PURPOSE, 12)]).unwrap();
    let s2 = submit(&s1, vec![proof(10, PURPOSE, 13)]).unwrap();

    let summary = Contract::summarize_state(params_bytes(), State::from(s1.clone()))
        .unwrap()
        .into_bytes();
    let delta =
        Contract::get_state_delta(params_bytes(), State::from(s2), StateSummary::from(summary))
            .unwrap()
            .into_bytes();

    let delta: RegistryDelta = from_cbor(&delta).unwrap();
    // s1 already had seed-9; only seed-10 is new.
    assert_eq!(delta.proofs.len(), 1);
    assert_eq!(delta.proofs[0].identity_vk, vk(10));

    // And the delta the contract emitted folds cleanly into a fresh core state.
    let mut fresh = RegistryState::default();
    let params = RegistryParameters {
        purpose: PURPOSE.into(),
        min_bits_floor: FLOOR,
    };
    for p in delta.proofs {
        fresh.admit(&params, p).unwrap();
    }
    assert!(fresh.level(&vk(10)).is_some());
}
