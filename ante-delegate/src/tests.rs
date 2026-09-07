//! Native tests for the delegate logic, driven through the in-memory
//! [`TestEnv`]. `DelegateCtx`'s host functions are WASM-only, so these run the
//! real `dispatch` / consent code against a stand-in store; the WASM FFI seam
//! itself is covered by the browser smoke against a live node.

use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::{
    ClientResponse, ContractInstanceId, DelegateContext, MessageOrigin, OutboundDelegateMsg,
    UserInputResponse,
};

use ante_core::{pow, proof::AnteProof, AnteRequest, AnteResponse};

use crate::env::{DelegateEnv, TestEnv};
use crate::{consent, dispatch, identity};

const ENTROPY: [u8; 32] = [0x11; 32];

fn origin_a() -> MessageOrigin {
    MessageOrigin::WebApp(ContractInstanceId::new([0xAA; 32]))
}

fn origin_b() -> MessageOrigin {
    MessageOrigin::WebApp(ContractInstanceId::new([0xBB; 32]))
}

/// The identity key `TestEnv` will deterministically produce for an origin.
fn expected_key() -> SigningKey {
    SigningKey::from_bytes(&ENTROPY)
}

fn env() -> TestEnv {
    TestEnv::new().with_entropy(ENTROPY.to_vec())
}

fn decode_reply(out: &[OutboundDelegateMsg]) -> AnteResponse {
    let [OutboundDelegateMsg::ApplicationMessage(app)] = out else {
        panic!("expected exactly one ApplicationMessage, got {out:?}");
    };
    assert!(app.processed, "reply must be marked processed");
    ante_core::from_cbor(&app.payload).expect("reply decodes")
}

fn run(env: &mut TestEnv, origin: &MessageOrigin, req: AnteRequest) -> Vec<OutboundDelegateMsg> {
    dispatch(env, Some(origin), req).expect("dispatch ok")
}

// ---------------------------------------------------------------------------
// HasIdentity — the probe that must not write
// ---------------------------------------------------------------------------

#[test]
fn has_identity_reports_absence_without_creating_one() {
    let mut env = env();
    let probe = decode_reply(&run(&mut env, &origin_a(), AnteRequest::HasIdentity));
    assert_eq!(probe, AnteResponse::NoIdentity);

    // The whole point: probing must leave the store untouched. If HasIdentity
    // created a key the way GetIdentity does, a search across older generations
    // would mint identities and then report them as stranded ones it "found" —
    // fabricating the thing it claims to have discovered.
    assert!(
        env.get_secret(b"ante:identity:v1:primary").is_none(),
        "HasIdentity must not persist an identity"
    );

    // And it must still answer NoIdentity the second time, not drift.
    let again = decode_reply(&run(&mut env, &origin_a(), AnteRequest::HasIdentity));
    assert_eq!(again, AnteResponse::NoIdentity);
}

#[test]
fn has_identity_reports_the_key_once_one_exists() {
    let mut env = env();
    let created = decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity));
    let probed = decode_reply(&run(&mut env, &origin_a(), AnteRequest::HasIdentity));
    assert_eq!(created, probed);
}

#[test]
fn has_identity_does_not_prompt() {
    let mut env = env();
    let out = run(&mut env, &origin_a(), AnteRequest::HasIdentity);
    assert_eq!(
        out.len(),
        1,
        "a probe must answer in one message, not prompt"
    );
    assert!(
        env.context_is_empty(),
        "a probe must not park a pending prompt"
    );
}

// ---------------------------------------------------------------------------
// GetIdentity
// ---------------------------------------------------------------------------

#[test]
fn get_identity_creates_then_reuses_one_key() {
    let mut env = env();
    let first = decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity));
    let second = decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity));
    assert_eq!(first, second);
    assert_eq!(
        first,
        AnteResponse::Identity {
            verifying_key: expected_key().verifying_key().to_bytes()
        }
    );
}

#[test]
fn every_app_sees_the_same_identity() {
    // The identity is one shared key — that is what makes a registry level
    // portable. Two different calling apps must get the same verifying key,
    // and the second call must not mint a second key.
    let mut env = env();
    let a = decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity));
    env.fail_next_set_secret(); // a second mint would try to persist and fail
    let b = decode_reply(&run(&mut env, &origin_b(), AnteRequest::GetIdentity));
    assert_eq!(a, b);
    assert!(matches!(a, AnteResponse::Identity { .. }));
    // The prompt-origin check still distinguishes apps.
    assert_ne!(
        identity::origin_tag(Some(&origin_a())),
        identity::origin_tag(Some(&origin_b()))
    );
}

#[test]
fn zero_entropy_is_refused() {
    let mut env = TestEnv::new().with_entropy(vec![0u8; 32]);
    let resp = decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity));
    match resp {
        AnteResponse::Error { message } => assert!(message.contains("entropy")),
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn persist_failure_is_surfaced() {
    let mut env = env();
    env.fail_next_set_secret();
    let resp = decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity));
    assert!(matches!(resp, AnteResponse::Error { .. }));
}

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

#[test]
fn challenge_returns_canonical_bytes() {
    let mut env = env();
    let vk = expected_key().verifying_key().to_bytes();
    let resp = decode_reply(&run(
        &mut env,
        &origin_a(),
        AnteRequest::Challenge {
            purpose: "guestbook".into(),
        },
    ));
    assert_eq!(
        resp,
        AnteResponse::Challenge {
            bytes: pow::challenge_bytes("guestbook", &vk)
        }
    );
}

#[test]
fn challenge_rejects_empty_purpose() {
    let mut env = env();
    let resp = decode_reply(&run(
        &mut env,
        &origin_a(),
        AnteRequest::Challenge {
            purpose: String::new(),
        },
    ));
    assert!(matches!(resp, AnteResponse::Error { .. }));
}

#[test]
fn challenge_rejects_oversize_purpose() {
    let mut env = env();
    let resp = decode_reply(&run(
        &mut env,
        &origin_a(),
        AnteRequest::Challenge {
            purpose: "x".repeat(pow::MAX_PURPOSE_BYTES + 1),
        },
    ));
    assert!(matches!(resp, AnteResponse::Error { .. }));
}

// ---------------------------------------------------------------------------
// Commit — the consent round-trip
// ---------------------------------------------------------------------------

const PURPOSE: &str = "ante:identity-level:v1";
const BITS: u32 = 12;

fn good_nonce() -> u64 {
    let vk = expected_key().verifying_key().to_bytes();
    pow::grind(PURPOSE, &vk, BITS).expect("reachable")
}

fn commit_req(nonce: u64, min_bits: u32) -> AnteRequest {
    AnteRequest::Commit {
        purpose: PURPOSE.into(),
        nonce,
        min_bits,
        ts: 1_700_000_000_000,
    }
}

fn prompt_request_id(out: &[OutboundDelegateMsg]) -> u32 {
    let [OutboundDelegateMsg::RequestUserInput(req)] = out else {
        panic!("expected one RequestUserInput, got {out:?}");
    };
    assert_eq!(req.responses.len(), 3, "Allow / Always allow / Deny");
    req.request_id
}

fn answer(request_id: u32, button: &[u8]) -> UserInputResponse<'static> {
    UserInputResponse {
        request_id,
        response: ClientResponse::new(button.to_vec()),
        context: DelegateContext::default(),
    }
}

#[test]
fn commit_with_a_dud_nonce_errors_and_parks_nothing() {
    let mut env = env();
    // nonce 0 almost certainly fails a 12-bit bar
    let resp = decode_reply(&run(&mut env, &origin_a(), commit_req(0, BITS)));
    assert!(matches!(resp, AnteResponse::Error { .. }));
    assert!(env.context_is_empty(), "no prompt should be parked");
}

#[test]
fn commit_raises_a_prompt_and_parks_pending_state() {
    let mut env = env();
    let out = run(&mut env, &origin_a(), commit_req(good_nonce(), BITS));
    prompt_request_id(&out);
    assert!(!env.context_is_empty(), "pending prompt must be parked");
}

#[test]
fn allow_signs_a_verifiable_proof_and_clears_context() {
    let mut env = env();
    let nonce = good_nonce();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(nonce, BITS)));

    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Allow"))
        .expect("handled");
    let AnteResponse::Committed { proof } = decode_reply(&out) else {
        panic!("expected Committed");
    };
    let proof: AnteProof = ante_core::from_cbor(&proof).expect("proof decodes");

    let bits = proof
        .verify(BITS)
        .expect("proof verifies at the committed bar");
    assert!(bits >= BITS);
    assert_eq!(proof.purpose, PURPOSE);
    assert_eq!(proof.nonce, nonce);
    assert_eq!(proof.identity_vk, expected_key().verifying_key().to_bytes());
    assert!(env.context_is_empty(), "context cleared after answering");
}

#[test]
fn deny_returns_denied_and_clears_context() {
    let mut env = env();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Deny"))
        .expect("handled");
    assert_eq!(decode_reply(&out), AnteResponse::Denied);
    assert!(env.context_is_empty());
}

#[test]
fn a_response_with_the_wrong_id_leaves_the_prompt_standing() {
    let mut env = env();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    let err = consent::handle_response(
        &mut env,
        Some(&origin_a()),
        &answer(id.wrapping_add(1), b"Allow"),
    );
    assert!(err.is_err());
    assert!(!env.context_is_empty(), "the real prompt must survive");
}

#[test]
fn a_response_from_a_different_origin_is_refused() {
    let mut env = env();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    let err = consent::handle_response(&mut env, Some(&origin_b()), &answer(id, b"Allow"));
    assert!(err.is_err());
    assert!(!env.context_is_empty());
}

#[test]
fn a_response_with_no_pending_prompt_is_refused() {
    let mut env = env();
    let err = consent::handle_response(&mut env, Some(&origin_a()), &answer(1, b"Allow"));
    assert!(err.is_err());
}

#[test]
fn a_dropped_context_write_fails_the_commit_loudly() {
    let mut env = env();
    // Let GetIdentity mint the key first, so the failing write is the one
    // that parks the pending prompt, not the key persist.
    run(&mut env, &origin_a(), AnteRequest::GetIdentity);
    env.fail_next_context_write();
    let err = dispatch(&mut env, Some(&origin_a()), commit_req(good_nonce(), BITS));
    assert!(
        err.is_err(),
        "a dropped park must not silently lose the prompt"
    );
}

#[test]
fn a_higher_bar_than_committed_still_verifies_when_the_grind_cleared_it() {
    // The proof records the nonce, not a bit claim: a consumer asking for
    // fewer bits than were ground always passes.
    let mut env = env();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Allow")).unwrap();
    let AnteResponse::Committed { proof } = decode_reply(&out) else {
        panic!()
    };
    let proof: AnteProof = ante_core::from_cbor(&proof).unwrap();
    assert!(proof.verify(BITS - 4).is_ok());
}

// ---------------------------------------------------------------------------
// "Always allow" grants
// ---------------------------------------------------------------------------

#[test]
fn always_allow_then_the_next_commit_signs_with_no_prompt() {
    let mut env = env();

    // First commit → prompt → "Always allow" → signs + records the grant.
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Always allow"))
        .expect("handled");
    assert!(matches!(decode_reply(&out), AnteResponse::Committed { .. }));

    // Second commit from the same app → no RequestUserInput, straight Committed.
    let out = run(&mut env, &origin_a(), commit_req(good_nonce(), BITS));
    assert!(matches!(decode_reply(&out), AnteResponse::Committed { .. }));

    // A different app still prompts.
    let out = dispatch(&mut env, Some(&origin_b()), commit_req(good_nonce(), BITS)).unwrap();
    assert!(matches!(
        out.as_slice(),
        [OutboundDelegateMsg::RequestUserInput(_)]
    ));
}

#[test]
fn list_and_revoke_grants() {
    let mut env = env();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Always allow")).unwrap();

    let AnteResponse::Grants { origins } =
        decode_reply(&dispatch(&mut env, Some(&origin_a()), AnteRequest::ListGrants).unwrap())
    else {
        panic!("expected Grants");
    };
    assert_eq!(origins.len(), 1);

    let revoked = dispatch(
        &mut env,
        Some(&origin_a()),
        AnteRequest::RevokeGrant {
            origin: Some(origins[0].clone()),
        },
    )
    .unwrap();
    assert_eq!(decode_reply(&revoked), AnteResponse::Revoked);

    // Back to prompting.
    let out = dispatch(&mut env, Some(&origin_a()), commit_req(good_nonce(), BITS)).unwrap();
    assert!(matches!(
        out.as_slice(),
        [OutboundDelegateMsg::RequestUserInput(_)]
    ));
}

#[test]
fn plain_allow_does_not_create_a_grant() {
    let mut env = env();
    let id = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Allow")).unwrap();

    // Next commit still prompts.
    let out = dispatch(&mut env, Some(&origin_a()), commit_req(good_nonce(), BITS)).unwrap();
    assert!(matches!(
        out.as_slice(),
        [OutboundDelegateMsg::RequestUserInput(_)]
    ));
}

// ---------------------------------------------------------------------------
// ExportIdentity / ImportIdentity — backup & recovery
// ---------------------------------------------------------------------------

/// request_id of a two-button (backup / recovery) prompt.
fn recovery_prompt_id(out: &[OutboundDelegateMsg]) -> u32 {
    let [OutboundDelegateMsg::RequestUserInput(req)] = out else {
        panic!("expected one RequestUserInput, got {out:?}");
    };
    assert_eq!(req.responses.len(), 2, "action / cancel");
    req.request_id
}

#[test]
fn export_prompts_then_reveals_the_seed() {
    let mut env = env();
    let id = recovery_prompt_id(&run(&mut env, &origin_a(), AnteRequest::ExportIdentity));

    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Reveal"))
        .expect("handled");
    assert_eq!(
        decode_reply(&out),
        AnteResponse::IdentitySeed { seed: ENTROPY }
    );
    assert!(env.context_is_empty());
}

#[test]
fn export_cancelled_reveals_nothing() {
    let mut env = env();
    let id = recovery_prompt_id(&run(&mut env, &origin_a(), AnteRequest::ExportIdentity));
    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Cancel"))
        .expect("handled");
    assert_eq!(decode_reply(&out), AnteResponse::Denied);

    // The seed must not appear anywhere in the outbound bytes.
    let OutboundDelegateMsg::ApplicationMessage(app) = &out[0] else {
        panic!()
    };
    assert!(!app.payload.windows(ENTROPY.len()).any(|w| w == ENTROPY));
}

#[test]
fn export_ignores_a_commit_button() {
    let mut env = env();
    let id = recovery_prompt_id(&run(&mut env, &origin_a(), AnteRequest::ExportIdentity));
    // "Allow" is the commit vocabulary — not an approval for an export.
    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Allow"))
        .expect("handled");
    assert_eq!(decode_reply(&out), AnteResponse::Denied);
}

const IMPORT_SEED: [u8; 32] = [0x55; 32];

fn import_req(seed: &[u8]) -> AnteRequest {
    AnteRequest::ImportIdentity {
        seed: seed.to_vec(),
    }
}

#[test]
fn import_into_a_fresh_delegate_sets_the_identity() {
    let mut env = TestEnv::new(); // no identity yet
    let id = recovery_prompt_id(&run(&mut env, &origin_a(), import_req(&IMPORT_SEED)));
    let out = consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Import"))
        .expect("handled");

    let imported_vk = SigningKey::from_bytes(&IMPORT_SEED)
        .verifying_key()
        .to_bytes();
    assert_eq!(
        decode_reply(&out),
        AnteResponse::Imported {
            verifying_key: imported_vk
        }
    );
    // GetIdentity now reports the imported key.
    assert_eq!(
        decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity)),
        AnteResponse::Identity {
            verifying_key: imported_vk
        }
    );
}

#[test]
fn import_over_an_existing_identity_replaces_it_and_clears_grants() {
    let mut env = env();
    // Establish identity A and an "always allow" grant for origin_a.
    let gid = prompt_request_id(&run(&mut env, &origin_a(), commit_req(good_nonce(), BITS)));
    consent::handle_response(&mut env, Some(&origin_a()), &answer(gid, b"Always allow")).unwrap();

    let id = recovery_prompt_id(&run(&mut env, &origin_a(), import_req(&IMPORT_SEED)));
    consent::handle_response(&mut env, Some(&origin_a()), &answer(id, b"Import")).unwrap();

    let imported_vk = SigningKey::from_bytes(&IMPORT_SEED)
        .verifying_key()
        .to_bytes();
    assert_eq!(
        decode_reply(&run(&mut env, &origin_a(), AnteRequest::GetIdentity)),
        AnteResponse::Identity {
            verifying_key: imported_vk
        }
    );
    // The old identity's grant is gone — a commit prompts again. (The nonce
    // has to clear the bar for the *new* identity.)
    let nonce = pow::grind(PURPOSE, &imported_vk, BITS).expect("reachable");
    let out = dispatch(&mut env, Some(&origin_a()), commit_req(nonce, BITS)).unwrap();
    assert!(matches!(
        out.as_slice(),
        [OutboundDelegateMsg::RequestUserInput(_)]
    ));
}

#[test]
fn re_importing_the_current_identity_is_a_silent_noop() {
    let mut env = env(); // identity is SigningKey::from_bytes(ENTROPY)
    run(&mut env, &origin_a(), AnteRequest::GetIdentity); // materialise it
    let out = run(&mut env, &origin_a(), import_req(&ENTROPY));
    assert_eq!(
        decode_reply(&out),
        AnteResponse::Imported {
            verifying_key: expected_key().verifying_key().to_bytes()
        }
    );
    assert!(
        !matches!(out.as_slice(), [OutboundDelegateMsg::RequestUserInput(_)]),
        "no prompt for a no-op re-import"
    );
}

#[test]
fn import_rejects_a_wrong_length_seed() {
    let mut env = env();
    let out = run(&mut env, &origin_a(), import_req(&[1u8; 31]));
    assert!(matches!(decode_reply(&out), AnteResponse::Error { .. }));
    assert!(env.context_is_empty(), "a bad seed parks nothing");
}

#[test]
fn an_exported_seed_round_trips_into_another_delegate() {
    // Export from one delegate...
    let mut source = env();
    let id = recovery_prompt_id(&run(&mut source, &origin_a(), AnteRequest::ExportIdentity));
    let AnteResponse::IdentitySeed { seed } = decode_reply(
        &consent::handle_response(&mut source, Some(&origin_a()), &answer(id, b"Reveal")).unwrap(),
    ) else {
        panic!("expected IdentitySeed");
    };

    // ...import it into a fresh one.
    let mut dest = TestEnv::new();
    let id = recovery_prompt_id(&run(&mut dest, &origin_a(), import_req(&seed)));
    consent::handle_response(&mut dest, Some(&origin_a()), &answer(id, b"Import")).unwrap();

    assert_eq!(
        decode_reply(&run(&mut dest, &origin_a(), AnteRequest::GetIdentity)),
        decode_reply(&run(&mut source, &origin_a(), AnteRequest::GetIdentity)),
    );
}

#[test]
fn an_import_answer_from_another_app_is_refused() {
    let mut env = env();
    let id = recovery_prompt_id(&run(&mut env, &origin_a(), import_req(&IMPORT_SEED)));
    let err = consent::handle_response(&mut env, Some(&origin_b()), &answer(id, b"Import"));
    assert!(err.is_err());
    assert!(!env.context_is_empty(), "the real prompt must survive");
}
