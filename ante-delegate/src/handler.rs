//! The non-prompting requests, as pure functions of the signing key.
//!
//! `Commit` is not here — it needs the consent round-trip and is routed in
//! `lib.rs`.

use ante_core::{pow, AnteRequest, AnteResponse};
use ed25519_dalek::SigningKey;

/// Serve `GetIdentity` or `Challenge`. `Commit` returns an error (it must not
/// reach this path).
pub fn handle_simple(key: &SigningKey, request: &AnteRequest) -> AnteResponse {
    let verifying_key = key.verifying_key().to_bytes();
    match request {
        AnteRequest::GetIdentity => AnteResponse::Identity { verifying_key },

        AnteRequest::Challenge { purpose } => {
            if let Err(message) = check_purpose(purpose) {
                return AnteResponse::Error { message };
            }
            AnteResponse::Challenge {
                bytes: pow::challenge_bytes(purpose, &verifying_key),
            }
        }

        AnteRequest::Commit { .. } => AnteResponse::Error {
            message: "Commit must go through the consent flow".to_string(),
        },
    }
}

/// A purpose string must be present and within the shared cap.
pub fn check_purpose(purpose: &str) -> Result<(), String> {
    if purpose.is_empty() || purpose.len() > pow::MAX_PURPOSE_BYTES {
        return Err(format!(
            "purpose must be 1..={} bytes",
            pow::MAX_PURPOSE_BYTES
        ));
    }
    Ok(())
}
