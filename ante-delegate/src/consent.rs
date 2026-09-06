//! The consent round-trip for [`AnteRequest::Commit`].
//!
//! `Commit` cannot be answered in one shot: the delegate emits a
//! `RequestUserInput`, the host shows it as an overlay in every open Freenet
//! tab, and the user's click comes back as a `UserResponse` on a later
//! `process()` call. The in-flight state is parked in the delegate scratch
//! context between the two.

use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::{
    DelegateError, MessageOrigin, NotificationMessage, OutboundDelegateMsg, UserInputRequest,
    UserInputResponse,
};
use serde::{Deserialize, Serialize};

use ante_core::{proof::AnteProof, to_cbor, AnteResponse};

use crate::env::DelegateEnv;
use crate::{identity, reply};

const ALLOW: &[u8] = b"Allow";
const DENY: &[u8] = b"Deny";

/// State parked in the scratch context while a commit prompt is on screen.
#[derive(Serialize, Deserialize)]
pub struct PendingCommit {
    request_id: u32,
    /// The calling app the prompt was raised for. An answer from a different
    /// app is not an answer to this question.
    origin_tag: Vec<u8>,
    purpose: String,
    nonce: u64,
    ts: u64,
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

/// Emit the consent prompt and park the pending state. The caller has already
/// confirmed the nonce reaches the requested bar.
pub fn emit_prompt(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    identity_vk: &[u8; 32],
    purpose: &str,
    nonce: u64,
    achieved_bits: u32,
    ts: u64,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    let request_id = next_request_id(env).map_err(DelegateError::Other)?;

    let fingerprint = ante_core::fingerprint(identity_vk);
    let caller = caller_label(origin);
    let text = format!(
        "{caller} wants to spend proof of work on your ante identity {fingerprint}.\n\n\
         Purpose: {purpose}\n\
         Work: about {achieved_bits} bits\n\n\
         Approving signs a single one-off proof. Your key is never revealed, and \
         nothing ongoing is granted.\n\n\
         Allow, or deny?"
    );

    let pending = PendingCommit {
        request_id,
        origin_tag: identity::origin_tag(origin),
        purpose: purpose.to_string(),
        nonce,
        ts,
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
            responses: vec![
                freenet_stdlib::prelude::ClientResponse::new(ALLOW.to_vec()),
                freenet_stdlib::prelude::ClientResponse::new(DENY.to_vec()),
            ],
        },
    )])
}

/// Handle the user's answer to a commit prompt.
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
    let pending: PendingCommit = ante_core::from_cbor(&parked)
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

    if resp.response.bytes() != ALLOW {
        return Ok(vec![reply(&AnteResponse::Denied)]);
    }

    let key: SigningKey = identity::load_existing(env)
        .ok_or_else(|| DelegateError::Other("identity vanished mid-prompt".to_string()))?;
    let proof = AnteProof::create(&key, pending.purpose, pending.nonce, pending.ts);
    Ok(vec![reply(&AnteResponse::Committed {
        proof: to_cbor(&proof),
    })])
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
