//! "Always allow" grants.
//!
//! A grant is one attested calling origin the user has approved to spend their
//! ante identity on `Commit` without a prompt each time. The first `Commit`
//! from an app always prompts; choosing "Always allow" records the origin
//! here. Revocable from the managing UI.
//!
//! The origin is the runtime-attested [`origin_tag`](crate::identity::origin_tag)
//! — unspoofable, so a grant cannot be claimed by another app.

use serde::{Deserialize, Serialize};

use crate::env::DelegateEnv;

const GRANTS_KEY: &[u8] = b"ante:grants:v1";

#[derive(Default, Serialize, Deserialize)]
struct Grants {
    /// Origin tags allowed to commit without a prompt.
    origins: Vec<Vec<u8>>,
}

fn load(env: &impl DelegateEnv) -> Grants {
    match env.get_secret(GRANTS_KEY) {
        Some(bytes) => ante_core::from_cbor(&bytes).unwrap_or_default(),
        None => Grants::default(),
    }
}

fn save(env: &mut impl DelegateEnv, grants: &Grants) -> bool {
    env.set_secret(GRANTS_KEY, &ante_core::to_cbor(grants))
}

/// Is this origin allowed to commit without a prompt?
pub fn is_granted(env: &impl DelegateEnv, origin_tag: &[u8]) -> bool {
    load(env).origins.iter().any(|o| o == origin_tag)
}

/// Record an "always allow" grant for this origin. Idempotent.
pub fn grant(env: &mut impl DelegateEnv, origin_tag: &[u8]) -> Result<(), String> {
    let mut grants = load(env);
    if !grants.origins.iter().any(|o| o == origin_tag) {
        grants.origins.push(origin_tag.to_vec());
        if !save(env, &grants) {
            return Err("could not persist the grant".to_string());
        }
    }
    Ok(())
}

/// Remove one grant, or all when `origin_tag` is `None`.
pub fn revoke(env: &mut impl DelegateEnv, origin_tag: Option<&[u8]>) -> Result<(), String> {
    let mut grants = load(env);
    match origin_tag {
        Some(tag) => grants.origins.retain(|o| o != tag),
        None => grants.origins.clear(),
    }
    if !save(env, &grants) {
        return Err("could not persist the revocation".to_string());
    }
    Ok(())
}

/// Every currently-granted origin tag, for the managing UI to display.
pub fn list(env: &impl DelegateEnv) -> Vec<Vec<u8>> {
    load(env).origins
}
