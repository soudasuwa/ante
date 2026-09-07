//! The consent round-trip for the prompting requests: `Commit`,
//! `ExportIdentity`, `ImportIdentity`.
//!
//! None can be answered in one shot: the delegate emits a `RequestUserInput`,
//! the host shows it as an overlay in every open Freenet tab, and the user's
//! click comes back as a `UserResponse` on a later `process()` call. The
//! in-flight state is parked in the delegate scratch context between the two.

use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::{
    ClientResponse, DelegateError, MessageOrigin, NotificationMessage, OutboundDelegateMsg,
    UserInputRequest, UserInputResponse,
};
use serde::{Deserialize, Serialize};

use ante_core::{proof::AnteProof, to_cbor, AnteResponse};

use crate::env::DelegateEnv;
use crate::{grants, identity, reply};

// Commit buttons.
const ALLOW: &[u8] = b"Allow";
const ALWAYS: &[u8] = b"Always allow";
const DENY: &[u8] = b"Deny";
// Backup / recovery buttons — distinct verbs so a click is unambiguous.
const REVEAL: &[u8] = b"Reveal";
const IMPORT: &[u8] = b"Import";
const CANCEL: &[u8] = b"Cancel";

/// Build a signed `Committed` response. Shared by the prompt path and the
/// "already granted" fast path in `lib.rs`.
pub fn signed_commit(key: &SigningKey, purpose: String, nonce: u64, ts: u64) -> AnteResponse {
    AnteResponse::Committed {
        proof: to_cbor(&AnteProof::create(key, purpose, nonce, ts)),
    }
}

/// State parked in the scratch context while a prompt is on screen.
#[derive(Serialize, Deserialize)]
pub struct Pending {
    request_id: u32,
    /// The calling app the prompt was raised for. An answer from a different
    /// app is not an answer to this question.
    origin_tag: Vec<u8>,
    action: PendingAction,
}

#[derive(Serialize, Deserialize)]
enum PendingAction {
    Commit {
        purpose: String,
        nonce: u64,
        ts: u64,
    },
    Export,
    Import {
        seed: [u8; 32],
        /// The identity this import would replace, if any — for a "gone after
        /// this" line in the prompt and to clear its grants on approval.
        replacing: Option<[u8; 32]>,
    },
}

/// Monotonic prompt-id counter in the secret store. It only has to avoid
/// collisions between concurrently-open prompts — the origin check in
/// [`handle_response`] is what actually authorizes an answer.
fn next_request_id(env: &mut impl DelegateEnv) -> Result<u32, String> {
    const KEY: &[u8] = b"ante:prompt-seq:v1";
    let current = env
        .get_secret(KEY)
        .and_then(|b| <[u8; 4]>::try_from(b.as_slice()).ok())
        .map(u32::from_le_bytes)
        .unwrap_or(0);
    let next = match current.wrapping_add(1) {
        0 => 1,
        n => n,
    };
    if !env.set_secret(KEY, &next.to_le_bytes()) {
        return Err("could not record the prompt id".to_string());
    }
    Ok(next)
}

/// Allocate a prompt id, park the pending action, and build the
/// `RequestUserInput` with the given text and buttons.
fn raise(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    action: PendingAction,
    text: String,
    buttons: &[&[u8]],
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    let request_id = next_request_id(env).map_err(DelegateError::Other)?;
    let pending = Pending {
        request_id,
        origin_tag: identity::origin_tag(origin),
        action,
    };
    if !env.context_write(&to_cbor(&pending)) {
        return Err(DelegateError::Other(
            "could not park the pending prompt".to_string(),
        ));
    }
    Ok(vec![OutboundDelegateMsg::RequestUserInput(
        UserInputRequest {
            request_id,
            message: {
                let json = serde_json::json!(text);
                NotificationMessage::try_from(&json)
                    .expect("a string is a valid NotificationMessage")
            },
            responses: buttons
                .iter()
                .map(|b| ClientResponse::new(b.to_vec()))
                .collect(),
        },
    )])
}

/// Emit the commit consent prompt. The caller has already confirmed the nonce
/// reaches the requested bar.
pub fn emit_commit_prompt(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    identity_vk: &[u8; 32],
    purpose: &str,
    nonce: u64,
    achieved_bits: u32,
    ts: u64,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    let fingerprint = ante_core::fingerprint(identity_vk);
    let caller = caller_label(origin);
    // Tense matters here. By the time this is on screen the grinding is
    // finished; what is being asked for is the signature. "wants to spend
    // proof of work" read as though the work were about to start, which made
    // the prompt describe a different action than the one it authorises.
    let text = format!(
        "{caller} wants to sign with your ante identity {fingerprint}.\n\n\
         The work is already done: {achieved_bits} bits.\n\
         For: {purpose}\n\n\
         Allow signs this once. Always allow stops asking for this app until \
         you revoke it. Your key itself is never revealed."
    );
    raise(
        env,
        origin,
        PendingAction::Commit {
            purpose: purpose.to_string(),
            nonce,
            ts,
        },
        text,
        &[ALLOW, ALWAYS, DENY],
    )
}

/// Emit the "reveal your secret key" prompt.
pub fn emit_export_prompt(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    identity_vk: &[u8; 32],
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    let fingerprint = ante_core::fingerprint(identity_vk);
    let caller = caller_label(origin);
    let text = format!(
        "{caller} wants to reveal the SECRET KEY of your ante identity {fingerprint}.\n\n\
         Anyone who has this key can act as you on every app that uses ante. Only \
         reveal it to save a backup somewhere safe, and never paste it into a site \
         you do not trust.\n\n\
         Reveal shows the key once. Cancel does nothing."
    );
    raise(env, origin, PendingAction::Export, text, &[REVEAL, CANCEL])
}

/// Emit the "replace this device's identity" prompt.
pub fn emit_import_prompt(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    new_vk: &[u8; 32],
    replacing: Option<[u8; 32]>,
    seed: [u8; 32],
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    let caller = caller_label(origin);
    let new_fp = ante_core::fingerprint(new_vk);
    let text = match replacing {
        Some(old) => format!(
            "{caller} wants to REPLACE this device's ante identity.\n\n\
             New identity: {new_fp}\n\
             Current identity {old_fp} will be forgotten on this device — anything \
             it committed stays under that key. Its \"always allow\" grants are \
             cleared.\n\n\
             Import switches identities. Cancel does nothing.",
            old_fp = ante_core::fingerprint(&old),
        ),
        None => format!(
            "{caller} wants to set this device's ante identity to {new_fp} \
             (restoring a backup).\n\n\
             Import sets it. Cancel does nothing."
        ),
    };
    raise(
        env,
        origin,
        PendingAction::Import { seed, replacing },
        text,
        &[IMPORT, CANCEL],
    )
}

/// Handle the user's answer to a prompt.
pub fn handle_response(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    resp: &UserInputResponse<'_>,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    let parked = env.context_read();
    if parked.is_empty() {
        return Err(DelegateError::Other(
            "user response with no pending prompt".to_string(),
        ));
    }
    let pending: Pending = ante_core::from_cbor(&parked)
        .map_err(|e| DelegateError::Other(format!("corrupt pending prompt: {e}")))?;

    // WHICH question. Not cleared on mismatch — a stray or guessed id must
    // leave the real prompt standing.
    if resp.request_id != pending.request_id {
        return Err(DelegateError::Other(
            "user response does not match the pending prompt".to_string(),
        ));
    }
    // WHOSE. A genuine answer is fed back through the same invocation chain
    // that raised the prompt, so it always arrives under the same attested
    // origin. Anything else is someone answering a dialog that was not theirs.
    if identity::origin_tag(origin) != pending.origin_tag {
        return Err(DelegateError::Other(
            "user response came from a different app than the prompt".to_string(),
        ));
    }

    // Right question, right caller: consume it.
    env.context_clear();
    let answer = resp.response.bytes();

    match pending.action {
        PendingAction::Commit { purpose, nonce, ts } => {
            if answer != ALLOW && answer != ALWAYS {
                return Ok(vec![reply(&AnteResponse::Denied)]);
            }
            if answer == ALWAYS {
                grants::grant(env, &pending.origin_tag).map_err(DelegateError::Other)?;
            }
            let key = identity::load_existing(env)
                .ok_or_else(|| DelegateError::Other("identity vanished mid-prompt".to_string()))?;
            Ok(vec![reply(&signed_commit(&key, purpose, nonce, ts))])
        }

        PendingAction::Export => {
            if answer != REVEAL {
                return Ok(vec![reply(&AnteResponse::Denied)]);
            }
            let seed = identity::export_seed(env)
                .ok_or_else(|| DelegateError::Other("identity vanished mid-prompt".to_string()))?;
            Ok(vec![reply(&AnteResponse::IdentitySeed { seed })])
        }

        PendingAction::Import { seed, replacing } => {
            if answer != IMPORT {
                return Ok(vec![reply(&AnteResponse::Denied)]);
            }
            identity::import_seed(env, &seed).map_err(DelegateError::Other)?;
            // A different identity's "always allow" decisions do not carry over.
            if replacing.is_some() {
                grants::revoke(env, None).map_err(DelegateError::Other)?;
            }
            Ok(vec![reply(&AnteResponse::Imported {
                verifying_key: identity::vk_for_seed(&seed),
            })])
        }
    }
}

/// A short label for the calling origin, for the prompt body. The
/// *trustworthy* caller identity is surfaced by the runtime's own prompt
/// chrome; this is only a hint.
fn caller_label(origin: Option<&MessageOrigin>) -> String {
    match origin {
        Some(MessageOrigin::WebApp(id)) => format!("The web app {}", short_hex(id.as_bytes())),
        Some(MessageOrigin::Delegate(dk)) => format!("The delegate {}", short_hex(dk.bytes())),
        None => "An unattested caller".to_string(),
        Some(_) => "A caller".to_string(),
    }
}

fn short_hex(bytes: &[u8]) -> String {
    bytes.iter().take(4).map(|b| format!("{b:02x}")).collect()
}
