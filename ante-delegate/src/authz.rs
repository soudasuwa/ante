//! Single-use grind authorizations.
//!
//! A user who approved "grind 18 bits to post as alice: hello" has already made
//! the decision that `Commit` would otherwise ask for. Parking that approval
//! here lets the matching `Commit` sign without a second prompt, which is the
//! whole point of asking first: one decision, taken before the cost, not after.
//!
//! **Single-use, not time-limited, and that is forced rather than chosen.** The
//! delegate has no clock — `ts` arrives from the caller and is unauthenticated
//! (see the whitepaper on freshness), so an expiry would be a number the caller
//! could set to anything. Consumption on use is the only bound that cannot be
//! lied about.
//!
//! An authorization is matched on `(origin_tag, purpose, min_bits)`. The origin
//! is runtime-attested, so one app cannot spend another's. `purpose` is exact:
//! for a content-bound caller it already contains the message digest, so an
//! approval for one post cannot sign a different one — the same property that
//! makes the proof itself non-transferable.

use serde::{Deserialize, Serialize};

use crate::env::DelegateEnv;

const AUTHZ_KEY: &[u8] = b"ante:grind-authz:v1";

/// How many approvals may sit unspent at once.
///
/// They are consumed by the `Commit` that follows, so the steady state is zero
/// or one. A cap exists because nothing else bounds the list: a caller can
/// request an authorization and simply never commit — a user clicking Allow on
/// prompts they then abandon would otherwise grow this without limit, in a
/// secret store, forever. Eight is far above any honest interleaving and small
/// enough that the eviction below can never lose an approval that mattered.
const MAX_PENDING: usize = 8;

#[derive(Default, Serialize, Deserialize)]
struct Authorizations {
    entries: Vec<Authorization>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Authorization {
    origin_tag: Vec<u8>,
    purpose: String,
    min_bits: u32,
}

fn load(env: &impl DelegateEnv) -> Authorizations {
    match env.get_secret(AUTHZ_KEY) {
        Some(bytes) => ante_core::from_cbor(&bytes).unwrap_or_default(),
        None => Authorizations::default(),
    }
}

fn save(env: &mut impl DelegateEnv, a: &Authorizations) -> bool {
    env.set_secret(AUTHZ_KEY, &ante_core::to_cbor(a))
}

/// Record an approval for this caller to grind `purpose` at `min_bits`.
///
/// Idempotent: approving the same thing twice leaves one entry, so a user who
/// clicks Allow, abandons the grind and starts again does not stack approvals.
pub fn authorize(
    env: &mut impl DelegateEnv,
    origin_tag: &[u8],
    purpose: &str,
    min_bits: u32,
) -> Result<(), String> {
    let mut a = load(env);
    let candidate = Authorization {
        origin_tag: origin_tag.to_vec(),
        purpose: purpose.to_string(),
        min_bits,
    };
    if a.entries.contains(&candidate) {
        return Ok(());
    }
    a.entries.push(candidate);
    // Oldest first, so the eviction drops the approval least likely to still be
    // waiting on a grind.
    while a.entries.len() > MAX_PENDING {
        a.entries.remove(0);
    }
    if !save(env, &a) {
        return Err("could not record the grind authorization".to_string());
    }
    Ok(())
}

/// Consume an approval matching this caller, purpose and bar. Returns whether
/// one was found — a `Commit` that finds none falls back to prompting.
///
/// `min_bits` must match what was approved: the user agreed to a specific bar,
/// and an app that asked for 16 must not silently spend that approval on a
/// commit claiming 24, or the number in the prompt meant nothing.
pub fn consume(
    env: &mut impl DelegateEnv,
    origin_tag: &[u8],
    purpose: &str,
    min_bits: u32,
) -> bool {
    let mut a = load(env);
    let Some(i) = a
        .entries
        .iter()
        .position(|e| e.origin_tag == origin_tag && e.purpose == purpose && e.min_bits == min_bits)
    else {
        return false;
    };
    a.entries.remove(i);
    // A failed save must not authorize the commit: better to prompt again than
    // to leave a spent approval on disk that could be spent a second time.
    save(env, &a)
}

/// Drop every parked approval. Used when the identity is replaced — approvals
/// were given for the old key and must not carry to a new one.
pub fn clear(env: &mut impl DelegateEnv) -> bool {
    save(env, &Authorizations::default())
}
