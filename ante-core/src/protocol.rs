//! Wire protocol between an app (or the bundled UI) and the ante delegate.
//!
//! Requests and responses are CBOR-encoded and carried in the payload of a
//! Freenet `ApplicationMessage`. The delegate custodies **one** Ed25519
//! identity key per user, shared across every calling app; an app never sees
//! the private key, only the verifying key and finished [`AnteProof`]s.
//!
//! Flow:
//! 1. [`AnteRequest::GetIdentity`] — learn (and, first time, create) the
//!    user's identity. No prompt.
//! 2. [`AnteRequest::Challenge`] — get the exact bytes to grind, so the client
//!    never has to reproduce the domain-separation layout. No prompt.
//! 3. grind a nonce off-thread (see the `pow` module / the JS worker).
//! 4. [`AnteRequest::Commit`] — the delegate shows a consent prompt; on
//!    approval it signs an [`AnteProof`] over the work and returns it.

use serde::{Deserialize, Serialize};

/// Requests an app sends to the ante delegate.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum AnteRequest {
    /// Return the user's identity verifying key, creating and persisting a
    /// keypair first if none exists yet. Never prompts — it only exposes a
    /// public key.
    GetIdentity,

    /// Return the challenge bytes for `purpose` bound to the user's
    /// identity. The client feeds these to the grinder as
    /// `blake3(bytes || nonce_le)` and counts leading zero bits. Never
    /// prompts.
    Challenge { purpose: String },

    /// Ask the user to authorize spending this identity on `purpose`, and on
    /// approval sign an [`AnteProof`] over `nonce`.
    ///
    /// `min_bits` is what the app requires; the delegate rejects a nonce below
    /// it *before* prompting, so the user is never asked to approve a dud.
    /// `ts` is the producer timestamp to embed (milliseconds since the Unix
    /// epoch); the client supplies it because the delegate has no clock.
    Commit {
        purpose: String,
        nonce: u64,
        min_bits: u32,
        ts: u64,
    },
}

/// Responses the ante delegate sends back.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum AnteResponse {
    /// The identity's Ed25519 verifying key bytes.
    Identity { verifying_key: [u8; 32] },

    /// Challenge preimage for the requested purpose. Grind
    /// `blake3(bytes || nonce.to_le_bytes())`.
    Challenge { bytes: Vec<u8> },

    /// CBOR of an [`crate::proof::AnteProof`], ready to attach to a contract
    /// write or hand to a verifier.
    Committed { proof: Vec<u8> },

    /// The user declined the [`AnteRequest::Commit`] prompt.
    Denied,

    /// The request could not be served (malformed payload, nonce below
    /// `min_bits`, purpose too long, entropy failure, ...).
    Error { message: String },
}
