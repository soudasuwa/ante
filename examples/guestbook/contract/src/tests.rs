//! Native tests. The contract functions are pure over `(params, state, data)`,
//! so validate/update run directly with no host.

use ante_core::{pow, proof::AnteProof};
use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::*;

use crate::{
    cbor, from_cbor, Contract, Entry, GuestbookDelta, GuestbookParameters, GuestbookState,
    MAX_NAME_BYTES, MAX_TEXT_BYTES,
};

const PURPOSE: &str = "demo:guestbook:v1";
const MIN_BITS: u32 = 10;

fn params_bytes() -> Parameters<'static> {
    Parameters::from(cbor(&GuestbookParameters {
        purpose: PURPOSE.into(),
        min_bits: MIN_BITS,
    }))
}

fn author(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

/// An entry whose proof clears `bits` for `purpose`.
fn entry(key: &SigningKey, name: &str, text: &str, purpose: &str, bits: u32) -> Entry {
    let vk = key.verifying_key().to_bytes();
    let nonce = pow::grind(purpose, &vk, bits).expect("reachable");
    Entry {
        name: name.into(),
        text: text.into(),
        proof: AnteProof::create(key, purpose.into(), nonce, 1_700_000_000_000),
    }
}

fn apply(state: &[u8], entries: Vec<Entry>) -> Result<Vec<u8>, ContractError> {
    let data = vec![UpdateData::Delta(StateDelta::from(cbor(&GuestbookDelta {
        entries,
    })))];
    Contract::update_state(params_bytes(), State::from(state.to_vec()), data)
        .map(|m| m.new_state.expect("update returns a state").into_bytes())
}

fn merge(a: &[u8], b: &[u8]) -> Result<Vec<u8>, ContractError> {
    let data = vec![UpdateData::State(State::from(b.to_vec()))];
    Contract::update_state(params_bytes(), State::from(a.to_vec()), data)
        .map(|m| m.new_state.expect("merge returns a state").into_bytes())
}

fn validate(state: &[u8]) -> ValidateResult {
    Contract::validate_state(
        params_bytes(),
        State::from(state.to_vec()),
        RelatedContracts::default(),
    )
    .expect("validate ok")
}

fn entries(state: &[u8]) -> GuestbookState {
    from_cbor(state).expect("state decodes")
}

#[test]
fn a_valid_entry_is_accepted_and_survives_validation() {
    let state = apply(
        &[],
        vec![entry(&author(1), "alice", "first post", PURPOSE, MIN_BITS)],
    )
    .expect("accepted");
    assert!(matches!(validate(&state), ValidateResult::Valid));
    assert_eq!(entries(&state).entries.len(), 1);
}

#[test]
fn an_under_bar_proof_is_rejected() {
    // A proof with nonce 0 almost never clears 10 bits. Pick a seed where it
    // definitely does not, then confirm the contract refuses it.
    let bad = (0u8..40)
        .map(author)
        .map(|k| Entry {
            name: "bob".into(),
            text: "cheap".into(),
            proof: AnteProof::create(&k, PURPOSE.into(), 0, 1_700_000_000_000),
        })
        .find(|e| e.proof.verify(MIN_BITS).is_err())
        .expect("some seed yields an under-bar proof");

    assert!(apply(&[], vec![bad]).is_err());
}

#[test]
fn a_proof_for_another_purpose_is_rejected() {
    let e = entry(
        &author(4),
        "mallory",
        "wrong ns",
        "other:purpose:v1",
        MIN_BITS,
    );
    assert!(apply(&[], vec![e]).is_err());
}

#[test]
fn an_oversize_message_or_name_is_rejected() {
    let long_text = entry(
        &author(6),
        "x",
        &"z".repeat(MAX_TEXT_BYTES + 1),
        PURPOSE,
        MIN_BITS,
    );
    assert!(apply(&[], vec![long_text]).is_err());

    let long_name = entry(
        &author(7),
        &"z".repeat(MAX_NAME_BYTES + 1),
        "hi",
        PURPOSE,
        MIN_BITS,
    );
    assert!(apply(&[], vec![long_name]).is_err());
}

#[test]
fn replaying_one_signed_entry_collapses_to_a_single_key() {
    let e = entry(&author(8), "dave", "hello", PURPOSE, MIN_BITS);
    let once = apply(&[], vec![e.clone()]).unwrap();
    let again = apply(&once, vec![e.clone(), e.clone()]).unwrap();
    assert_eq!(entries(&again).entries.len(), 1);
}

#[test]
fn merge_of_two_states_is_the_union_and_order_independent() {
    let a = apply(&[], vec![entry(&author(9), "a", "one", PURPOSE, MIN_BITS)]).unwrap();
    let b = apply(&[], vec![entry(&author(10), "b", "two", PURPOSE, MIN_BITS)]).unwrap();
    let ab = merge(&a, &b).unwrap();
    let ba = merge(&b, &a).unwrap();
    assert_eq!(entries(&ab).entries.len(), 2);
    assert_eq!(ab, ba);
}

#[test]
fn a_full_state_put_with_a_forged_entry_fails_validation() {
    let mut e = entry(&author(11), "eve", "forged", PURPOSE, MIN_BITS);
    e.proof.nonce = e.proof.nonce.wrapping_add(1); // breaks the signature
    let mut state = GuestbookState::default();
    state.entries.insert(e.key(), e);
    assert!(matches!(validate(&cbor(&state)), ValidateResult::Invalid));
}

#[test]
fn an_entry_stored_under_a_mismatched_key_fails_validation() {
    let e = entry(&author(12), "frank", "hi", PURPOSE, MIN_BITS);
    let mut state = GuestbookState::default();
    state.entries.insert([0u8; 32], e); // wrong key
    assert!(matches!(validate(&cbor(&state)), ValidateResult::Invalid));
}

#[test]
fn get_state_delta_returns_only_entries_the_peer_lacks() {
    let s1 = apply(&[], vec![entry(&author(13), "a", "one", PURPOSE, MIN_BITS)]).unwrap();
    let s2 = apply(&s1, vec![entry(&author(14), "b", "two", PURPOSE, MIN_BITS)]).unwrap();

    let summary = Contract::summarize_state(params_bytes(), State::from(s1.clone()))
        .unwrap()
        .into_bytes();
    let delta =
        Contract::get_state_delta(params_bytes(), State::from(s2), StateSummary::from(summary))
            .unwrap()
            .into_bytes();

    let delta: GuestbookDelta = from_cbor(&delta).unwrap();
    assert_eq!(delta.entries.len(), 1, "only the entry s1 was missing");
    assert_eq!(delta.entries[0].name, "b");
}
