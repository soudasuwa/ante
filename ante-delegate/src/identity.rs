//! Per-origin identity key custody.
//!
//! Every calling origin (a web app's container contract, or another delegate)
//! gets its own isolated Ed25519 identity. The key lives in the node's
//! encrypted secret store, namespaced by the runtime-attested origin, and
//! never leaves the delegate.

use ed25519_dalek::SigningKey;
use freenet_stdlib::prelude::MessageOrigin;

use crate::env::DelegateEnv;

/// Storage-format version. Bumping this stranding every existing key, so it
/// only moves on a deliberate migration.
const NS_PREFIX: &[u8] = b"ante:identity:v1:";

/// Secret-store key for an origin's identity signing seed.
///
/// The layout is part of the delegate's on-disk format: changing it strands
/// existing keys exactly like a WASM re-key would.
pub fn secret_key_for(origin: Option<&MessageOrigin>) -> Vec<u8> {
    let mut key = NS_PREFIX.to_vec();
    match origin {
        Some(MessageOrigin::WebApp(id)) => {
            key.extend_from_slice(b"webapp:");
            key.extend_from_slice(id.as_bytes());
        }
        Some(MessageOrigin::Delegate(dk)) => {
            key.extend_from_slice(b"delegate:");
            key.extend_from_slice(dk.bytes());
        }
        None => key.extend_from_slice(b"unattested"),
        // MessageOrigin is #[non_exhaustive]: a future variant gets a stable
        // bucket rather than a compile break.
        Some(_) => key.extend_from_slice(b"unknown-origin"),
    }
    key
}

/// Load the origin's signing key, generating and persisting one from host
/// entropy on first use.
pub fn load_or_create(
    env: &mut impl DelegateEnv,
    origin: Option<&MessageOrigin>,
) -> Result<SigningKey, String> {
    let store_key = secret_key_for(origin);

    if let Some(stored) = env.get_secret(&store_key) {
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
    if !env.set_secret(&store_key, &seed) {
        return Err("failed to persist the identity key".to_string());
    }
    Ok(key)
}

/// Load an origin's key **without** creating one. Returns `None` if this origin
/// has no identity yet.
pub fn load_existing(env: &impl DelegateEnv, origin: Option<&MessageOrigin>) -> Option<SigningKey> {
    let seed: [u8; 32] = env.get_secret(&secret_key_for(origin))?.try_into().ok()?;
    Some(SigningKey::from_bytes(&seed))
}
