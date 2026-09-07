//! Emit real contract states for `fdev verify-merge`.
//!
//!   cargo run --example dump_states -- <dir>
//!
//! See `scripts/verify-merge.sh`.

use std::path::{Path, PathBuf};

use ante_core::{
    pow,
    proof::AnteProof,
    registry::{RegistryParameters, RegistryState},
};
use ed25519_dalek::SigningKey;

const PURPOSE: &str = "ante:identity-level:v2";

fn params() -> RegistryParameters {
    RegistryParameters {
        purpose: PURPOSE.into(),
        min_bits_floor: 12,
    }
}

fn proof(seed: u8, bits: u32) -> AnteProof {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let vk = key.verifying_key().to_bytes();
    let nonce = pow::grind(PURPOSE, &vk, bits).expect("reachable");
    AnteProof::create(&key, PURPOSE.into(), nonce, 1_726_000_000_000)
}

fn write(dir: &Path, name: &str, state: &RegistryState) {
    let mut bytes = Vec::new();
    ciborium::into_writer(state, &mut bytes).expect("serialize");
    std::fs::write(dir.join(name), bytes).expect("write");
    println!("{name}  ({} identities)", state.levels.len());
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("usage: dump_states <dir>"));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let p = params();

    let empty = RegistryState::default();

    let mut one = empty.clone();
    one.admit(&p, proof(21, 13)).expect("admitted");

    let mut two = one.clone();
    two.admit(&p, proof(22, 14)).expect("admitted");

    // The same identity, improved — exercises the monotonic path.
    let mut improved = two.clone();
    improved.admit(&p, proof(21, 16)).expect("admitted");

    // A divergent branch from `one`.
    let mut other_two = one.clone();
    other_two.admit(&p, proof(23, 13)).expect("admitted");

    write(&dir, "empty.bin", &empty);
    write(&dir, "one.bin", &one);
    write(&dir, "two.bin", &two);
    write(&dir, "improved.bin", &improved);
    write(&dir, "other_two.bin", &other_two);
}
