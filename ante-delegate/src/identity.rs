//! Identity key custody.
//!
//! There is **one** ante identity per user, shared across every app that talks
//! to this delegate — that is what makes a level portable (grind once, every
//! app reads it from the registry). The key lives in the node's encrypted
//! secret store and never leaves the delegate. The consent prompt, which shows
//! the runtime-attested calling app, is the safeguard against a rogue app
//! spending the identity without the user knowing.
//!
//! Privacy note for callers: apps the user commits with can tell it is the
//! same key. Unlinkable per-action commitment is a different mechanism (raw
//! per-post proof-of-work), not this.

use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::MessageOrigin;

use crate::env::DelegateEnv;

/// Secret-store key for the identity signing seed. One fixed slot — changing
/// it strands the existing key exactly like a WASM re-key would.
const IDENTITY_SEED_KEY: &[u8] = b"ante:identity:v1:primary";

/// A short, stable tag for a calling origin — used to check that a
/// `UserResponse` came back from the same app that raised the prompt. Not a
/// storage namespace (the identity is shared); just an equality token.
pub fn origin_tag(origin: Option<&MessageOrigin>) -> Vec<u8> {
    match origin {
        Some(MessageOrigin::WebApp(id)) => {
            let mut t = b"webapp:".to_vec();
            t.extend_from_slice(id.as_bytes());
            t
        }
        Some(MessageOrigin::Delegate(dk)) => {
            let mut t = b"delegate:".to_vec();
            t.extend_from_slice(dk.bytes());
            t
        }
        None => b"unattested".to_vec(),
        // MessageOrigin is #[non_exhaustive].
        Some(_) => b"unknown-origin".to_vec(),
    }
}

/// Load the identity key, generating and persisting one from host entropy on
/// first use.
pub fn load_or_create(env: &mut impl DelegateEnv) -> Result<SigningKey, String> {
    if let Some(stored) = env.get_secret(IDENTITY_SEED_KEY) {
        let seed: [u8; 32] = stored
            .try_into()
            .map_err(|_| "stored identity seed has the wrong length".to_string())?;
        return Ok(SigningKey::from_bytes(&seed));
    }

    let seed: [u8; 32] = env
        .rand_bytes(32)
        .try_into()
        .map_err(|_| "host returned the wrong number of random bytes".to_string())?;
    // The native entropy stub returns zeroes; an all-zero seed here means the
    // host CSPRNG failed, and a predictable identity key must never ship.
    if seed == [0u8; 32] {
        return Err("host entropy source returned zeroes".to_string());
    }

    let key = SigningKey::from_bytes(&seed);
    if !env.set_secret(IDENTITY_SEED_KEY, &seed) {
        return Err("failed to persist the identity key".to_string());
    }
    Ok(key)
}

/// Load the identity key **without** creating one. `None` if none exists yet.
pub fn load_existing(env: &impl DelegateEnv) -> Option<SigningKey> {
    Some(SigningKey::from_bytes(&export_seed(env)?))
}

/// The raw 32-byte identity seed, for the user to back up. `None` if none
/// exists yet. Only ever reached through the `ExportIdentity` consent prompt.
pub fn export_seed(env: &impl DelegateEnv) -> Option<[u8; 32]> {
    env.get_secret(IDENTITY_SEED_KEY)?.try_into().ok()
}

/// Replace the stored identity seed with `seed` (restoring a backup). Only
/// reached through the `ImportIdentity` consent prompt.
pub fn import_seed(env: &mut impl DelegateEnv, seed: &[u8; 32]) -> Result<(), String> {
    if env.set_secret(IDENTITY_SEED_KEY, seed) {
        Ok(())
    } else {
        Err("failed to persist the imported identity".to_string())
    }
}

/// The verifying key a seed produces — for showing which identity an import
/// would switch to, before it happens.
pub fn vk_for_seed(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}
