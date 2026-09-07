//! Emit real contract states for `fdev verify-merge`.
//!
//!   cargo run --example dump_states -- <dir>
//!
//! Writes states plus the transitions between them, so the verifier can check
//! transition_path_agreement rather than only the order-independence laws.
//! `scripts/verify-merge.sh` drives this.

use std::path::{Path, PathBuf};

use ante_core::{pow, proof::AnteProof};
use ante_guestbook_contract::{content_purpose, Entry, GuestbookState};
use ed25519_dalek::SigningKey;

const PURPOSE: &str = "ante-guestbook:post:v1";
const MIN_BITS: u32 = 16;

fn entry(seed: u8, name: &str, text: &str) -> Entry {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let vk = key.verifying_key().to_bytes();
    let purpose = content_purpose(PURPOSE, name, text);
    let nonce = pow::grind(&purpose, &vk, MIN_BITS).expect("reachable");
    Entry {
        name: name.into(),
        text: text.into(),
        proof: AnteProof::create(&key, purpose, nonce, 1_726_000_000_000),
    }
}

fn write(dir: &Path, name: &str, state: &GuestbookState) {
    let mut bytes = Vec::new();
    ciborium::into_writer(state, &mut bytes).expect("serialize");
    std::fs::write(dir.join(name), bytes).expect("write");
    println!("{name}  ({} entries)", state.entries.len());
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("usage: dump_states <dir>"));
    std::fs::create_dir_all(&dir).expect("mkdir");

    let a = entry(11, "alice", "first");
    let b = entry(12, "bob", "second");
    let c = entry(13, "carol", "third");

    let empty = GuestbookState::default();

    let mut one = empty.clone();
    one.entries.insert(a.key(), a.clone());

    let mut two = one.clone();
    two.entries.insert(b.key(), b.clone());

    let mut three = two.clone();
    three.entries.insert(c.key(), c.clone());

    // A divergent branch: the same base grew a different entry.
    let mut other_two = one.clone();
    other_two.entries.insert(c.key(), c);

    write(&dir, "empty.bin", &empty);
    write(&dir, "one.bin", &one);
    write(&dir, "two.bin", &two);
    write(&dir, "three.bin", &three);
    write(&dir, "other_two.bin", &other_two);
}
