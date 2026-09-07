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
//!
//! Backup / recovery: [`AnteRequest::ExportIdentity`] reveals the identity's
//! 32-byte secret seed (behind a prompt — the one request that exposes the
//! private key), and [`AnteRequest::ImportIdentity`] restores it on another
//! device, or after the node's secret store is lost. Both always prompt.

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
    ///
    /// The first `Commit` from an app prompts (Allow / Always allow / Deny).
    /// After "Always allow", `Commit`s from that app sign without a prompt.
    Commit {
        purpose: String,
        nonce: u64,
        min_bits: u32,
        ts: u64,
    },

    /// List the calling origins that hold an "always allow" grant, for a
    /// managing UI. No prompt.
    ListGrants,

    /// Remove one "always allow" grant, or all of them when `origin` is
    /// `None`. Revoking a permission is safe, so no prompt.
    RevokeGrant { origin: Option<Vec<u8>> },

    /// Reveal the identity's 32-byte secret seed so the user can back it up.
    /// **Always prompts** — this is the only request that exposes the private
    /// key. The delegate creates an identity first if none exists.
    ExportIdentity,

    /// Set this device's identity to `seed` (32 bytes) — restoring a backup on
    /// a new device or after the node's secret store was wiped. **Always
    /// prompts**; if an identity already exists the prompt says it will be
    /// replaced (and its "always allow" grants are cleared). Re-importing the
    /// current seed is a no-op.
    ImportIdentity { seed: Vec<u8> },

    /// Ask the user, BEFORE any work is done, to authorize grinding
    /// `min_bits` for `purpose`. **Prompts**, unless this app already holds an
    /// "always allow" grant.
    ///
    /// On approval the delegate parks a single-use authorization and returns
    /// the challenge bytes, so the caller can grind and then `Commit` without
    /// a second prompt. On refusal, `Denied` — and no work has been spent.
    ///
    /// This exists because consent should precede a cost, not follow it. The
    /// old order asked "the work is already done: 25 bits, allow?", which puts
    /// the user's only decision after the only expensive part, and makes a
    /// refusal cost them the grind they just paid for.
    ///
    /// Optional. `Commit` still prompts on its own for a caller that never
    /// asked, so this is an improvement a consumer opts into rather than a
    /// break.
    RequestGrind { purpose: String, min_bits: u32 },

    /// Report whether this delegate generation holds an identity, WITHOUT
    /// creating one. No prompt.
    ///
    /// Exists because [`AnteRequest::GetIdentity`] creates on miss, which makes
    /// it unusable for probing: asking an older generation "do you have an
    /// identity?" with `GetIdentity` mints one there as a side effect, and the
    /// caller then sees a key that differs from the current one and reports it
    /// as a stranded identity it just fabricated. A search must not write.
    ///
    /// Generations published before this variant existed will reject it as a
    /// malformed request, so a prober has to fall back to `GetIdentity` for
    /// them — accepting create-on-probe only where the WASM can no longer be
    /// changed.
    HasIdentity,
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

    /// The user declined a consent prompt ([`AnteRequest::Commit`],
    /// [`AnteRequest::ExportIdentity`], or [`AnteRequest::ImportIdentity`]).
    Denied,

    /// The calling origins that currently hold an "always allow" grant.
    Grants { origins: Vec<Vec<u8>> },

    /// A [`AnteRequest::RevokeGrant`] was applied.
    Revoked,

    /// The identity's 32-byte secret seed, in response to
    /// [`AnteRequest::ExportIdentity`]. Whoever holds this controls the
    /// identity — the client shows it once, for the user to store safely.
    IdentitySeed { seed: [u8; 32] },

    /// [`AnteRequest::ImportIdentity`] succeeded; `verifying_key` is the
    /// now-active identity.
    Imported { verifying_key: [u8; 32] },

    /// The request could not be served (malformed payload, nonce below
    /// `min_bits`, purpose too long, entropy failure, ...).
    Error { message: String },

    /// Grinding was authorized: `bytes` is the challenge preimage, exactly as
    /// [`AnteResponse::Challenge`] returns it. Distinct from `Challenge`
    /// because it also means "a single-use authorization is parked, and the
    /// matching `Commit` will not prompt again".
    GrindAuthorized { bytes: Vec<u8> },

    /// This delegate generation holds no identity, in answer to
    /// [`AnteRequest::HasIdentity`]. Distinct from `Error` because "there is
    /// nothing here" is an answer, not a failure — and the difference decides
    /// whether a caller should keep looking.
    NoIdentity,
}
