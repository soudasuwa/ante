//! # ante-delegate
//!
//! The Freenet delegate behind **ante**. It custodies **one** Ed25519 identity
//! key per user in the node's encrypted secret store — shared across every app
//! that talks to the delegate, so a level published to the registry is
//! portable. Behind a user consent prompt it signs
//! [`AnteProof`](ante_core::AnteProof)s over proof-of-work the caller supplies.
//!
//! The private key never leaves the delegate. An app only ever sees the
//! verifying key and finished proofs.
//!
//! ## Request flow
//!
//! | Request | Prompts? | Returns |
//! |---|---|---|
//! | `GetIdentity` | no | the identity verifying key (created on first use) |
//! | `Challenge { purpose }` | no | the exact bytes to grind |
//! | `Commit { purpose, nonce, min_bits, ts }` | **yes** | a signed `AnteProof`, or `Denied` |
//!
//! `Commit` first checks the nonce against `min_bits` (so the user is never
//! asked to approve a dud), then raises the prompt. On approval it signs; the
//! answer arrives on a later `process()` call as a `UserResponse`.

mod consent;
mod env;
mod grants;
mod handler;
mod identity;

#[cfg(test)]
mod tests;

use freenet_stdlib::prelude::*;

use ante_core::{pow, to_cbor, AnteRequest, AnteResponse};

use crate::env::DelegateEnv;

pub struct AnteDelegate;

#[delegate]
impl DelegateInterface for AnteDelegate {
    fn process(
        ctx: &mut DelegateCtx,
        _parameters: Parameters<'static>,
        origin: Option<MessageOrigin>,
        message: InboundDelegateMsg,
    ) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
        match message {
            InboundDelegateMsg::ApplicationMessage(app) => {
                if app.processed {
                    return Err(DelegateError::Other(
                        "cannot process an already-processed message".to_string(),
                    ));
                }
                let request: AnteRequest = match ante_core::from_cbor(&app.payload) {
                    Ok(r) => r,
                    Err(e) => {
                        return Ok(vec![reply(&AnteResponse::Error {
                            message: format!("malformed request: {e}"),
                        })]);
                    }
                };
                dispatch(ctx, origin.as_ref(), request)
            }

            InboundDelegateMsg::UserResponse(resp) => {
                consent::handle_response(ctx, origin.as_ref(), &resp)
            }

            // InboundDelegateMsg is #[non_exhaustive]; this delegate is purely
            // request/response and ignores contract-callback variants.
            _ => Ok(vec![]),
        }
    }
}

fn dispatch(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
    request: AnteRequest,
) -> Result<Vec<OutboundDelegateMsg>, DelegateError> {
    match request {
        AnteRequest::GetIdentity | AnteRequest::Challenge { .. } => {
            match identity::load_or_create(env) {
                Ok(key) => Ok(vec![reply(&handler::handle_simple(&key, &request))]),
                Err(message) => Ok(vec![reply(&AnteResponse::Error { message })]),
            }
        }

        AnteRequest::ListGrants => Ok(vec![reply(&AnteResponse::Grants {
            origins: grants::list(env),
        })]),

        AnteRequest::RevokeGrant { origin: tag } => {
            Ok(vec![reply(&match grants::revoke(env, tag.as_deref()) {
                Ok(()) => AnteResponse::Revoked,
                Err(message) => AnteResponse::Error { message },
            })])
        }

        AnteRequest::Commit {
            purpose,
            nonce,
            min_bits,
            ts,
        } => {
            if let Err(message) = handler::check_purpose(&purpose) {
                return Ok(vec![reply(&AnteResponse::Error { message })]);
            }
            let key = match identity::load_or_create(env) {
                Ok(k) => k,
                Err(message) => return Ok(vec![reply(&AnteResponse::Error { message })]),
            };
            let vk = key.verifying_key().to_bytes();
            let achieved = pow::bits(&purpose, &vk, nonce);
            if achieved < min_bits {
                return Ok(vec![reply(&AnteResponse::Error {
                    message: format!("nonce demonstrates {achieved} bits, need {min_bits}"),
                })]);
            }

            // A prior "Always allow" from this app signs without a prompt.
            if grants::is_granted(env, &identity::origin_tag(origin)) {
                return Ok(vec![reply(&consent::signed_commit(
                    &key, purpose, nonce, ts,
                ))]);
            }
            consent::emit_prompt(env, origin, &vk, &purpose, nonce, achieved, ts)
        }
    }
}

/// Wrap an [`AnteResponse`] as a processed outbound `ApplicationMessage`.
pub(crate) fn reply(resp: &AnteResponse) -> OutboundDelegateMsg {
    OutboundDelegateMsg::ApplicationMessage(ApplicationMessage::new(to_cbor(resp)).processed(true))
}
