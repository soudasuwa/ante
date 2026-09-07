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

/// An entry whose proof clears `bits`, bound to its own content under
/// `prefix`. Pass a different `prefix` to simulate a proof minted elsewhere.
fn entry(key: &SigningKey, name: &str, text: &str, prefix: &str, bits: u32) -> Entry {
    let vk = key.verifying_key().to_bytes();
    let purpose = crate::content_purpose(prefix, name, text);
    let nonce = pow::grind(&purpose, &vk, bits).expect("reachable");
    Entry {
        name: name.into(),
        text: text.into(),
        proof: AnteProof::create(key, purpose, nonce, 1_700_000_000_000),
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The exact CBOR a single-entry `GuestbookDelta` serializes to. The web
/// client (`examples/guestbook/web/src/guestbook.ts`, via `@ante/client`'s
/// `cborEncode`) builds this same blob and posts it as a delta UPDATE; a
/// matching pin lives in that package's test suite. If this hex moves, the two
/// sides have drifted and posts from the web app will stop validating.
#[test]
fn delta_cbor_wire_format_is_pinned() {
    assert_eq!(hex(&cbor(&pinned_delta())), PINNED_DELTA_HEX);
}

/// Same blob, fed through `update_state` — proves the wire the web app emits is
/// actually accepted, not just byte-stable.
#[test]
fn the_pinned_delta_is_accepted_by_update_state() {
    let params = Parameters::from(cbor(&GuestbookParameters {
        purpose: "ante-guestbook:post:v2".into(),
        min_bits: 16,
    }));
    let data = vec![UpdateData::Delta(StateDelta::from(cbor(&pinned_delta())))];
    let new_state = Contract::update_state(params, State::from(Vec::new()), data)
        .expect("accepted")
        .new_state
        .expect("state");
    let decoded: GuestbookState = from_cbor(&new_state).unwrap();
    assert_eq!(decoded.entries.len(), 1);
}

const PINNED_DELTA_HEX: &str = "a167656e747269657381a3646e616d6565616c69636564746578746568656c6c6f6570726f6f66a56b6964656e746974795f766b982018ea184a186c186318e2189c18520a18be18f51850187b13182e18c518f918951847187618ae18be18be187b18921842181e18ea186914184618d2182c67707572706f73657827616e74652d6775657374626f6f6b3a706f73743a76323a34333731306633666431373037343835656e6f6e636519fb8c6274731b00000191dd9dec00697369676e6174757265984018cd186e187a0b18e71518941118f018ba18c418240b0e0c18cc18fb186818c5183e18d5184218dd18aa181c187818da18bf185218351854188a18971829184818a5183f18f00e187b1318fb1821185b1876186918bb182918b218721833188718ad182e18c2181d1891184818dc1867189e18e318fa03";

fn pinned_delta() -> GuestbookDelta {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let vk = key.verifying_key().to_bytes();
    let purpose = crate::content_purpose("ante-guestbook:post:v2", "alice", "hello");
    let nonce = pow::grind(&purpose, &vk, 16).expect("reachable");
    GuestbookDelta {
        entries: vec![Entry {
            name: "alice".into(),
            text: "hello".into(),
            proof: AnteProof::create(&key, purpose, nonce, 1_726_000_000_000),
        }],
    }
}

/// `fdev verify-merge` flags a non-empty delta to a converged peer
/// (`self_delta_empty`): it would ship CBOR framing on every anti-entropy
/// heartbeat forever. And the apply side must accept the empty bytes it emits.
#[test]
fn a_converged_peer_gets_literally_nothing_and_can_apply_it() {
    let state = apply(&[], vec![entry(&author(40), "z", "hi", PURPOSE, MIN_BITS)]).unwrap();
    let summary = Contract::summarize_state(params_bytes(), State::from(state.clone()))
        .unwrap()
        .into_bytes();
    let delta = Contract::get_state_delta(
        params_bytes(),
        State::from(state.clone()),
        StateSummary::from(summary),
    )
    .unwrap()
    .into_bytes();
    assert!(
        delta.is_empty(),
        "converged peers exchange no bytes, got {delta:?}"
    );

    // Applying it must be a no-op, not a decode error.
    let after = Contract::update_state(
        params_bytes(),
        State::from(state.clone()),
        vec![UpdateData::Delta(StateDelta::from(delta))],
    )
    .expect("an empty delta applies cleanly")
    .new_state
    .expect("state");
    assert_eq!(entries(&after).entries.len(), entries(&state).entries.len());
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

/// The reason `content_purpose` exists. Before it, an `AnteProof` committed to
/// (identity, purpose, nonce) and nothing else — so one grind, however
/// expensive, validated an unlimited number of *different* messages. Worse, the
/// challenge is fixed per (purpose, identity) and grinding starts at nonce 0,
/// so an author re-found the same nonce for free on every post. That is not
/// per-post proof of work; it is a one-time toll.
#[test]
fn a_proof_cannot_be_moved_to_a_different_message() {
    let author = author(30);
    let original = entry(
        &author,
        "mallory",
        "the message I paid for",
        PURPOSE,
        MIN_BITS,
    );
    assert!(
        apply(&[], vec![original.clone()]).is_ok(),
        "the real post is fine"
    );

    // Same author, same (expensive) proof, different text.
    let reused = Entry {
        name: original.name.clone(),
        text: "a completely different message, for free".into(),
        proof: original.proof.clone(),
    };
    assert!(
        apply(&[], vec![reused]).is_err(),
        "a proof must not carry over to another message"
    );

    // And the name is bound too, not just the body.
    let renamed = Entry {
        name: "someone else".into(),
        text: original.text.clone(),
        proof: original.proof,
    };
    assert!(
        apply(&[], vec![renamed]).is_err(),
        "the name is bound as well"
    );
}

/// Each distinct message gets its own challenge, so each needs its own search.
#[test]
fn different_messages_get_different_purposes() {
    let a = crate::content_purpose(PURPOSE, "alice", "hello");
    let b = crate::content_purpose(PURPOSE, "alice", "hello!");
    let c = crate::content_purpose(PURPOSE, "alicia", "hello");
    assert_ne!(a, b);
    assert_ne!(a, c);
    assert!(a.starts_with(PURPOSE), "the app prefix stays readable: {a}");
    assert!(a.len() <= ante_core::pow::MAX_PURPOSE_BYTES);

    // Length-prefixing: ("ab","c") and ("a","bc") must not collide.
    assert_ne!(
        crate::content_purpose(PURPOSE, "ab", "c"),
        crate::content_purpose(PURPOSE, "a", "bc")
    );
}
