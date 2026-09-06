//! Prints the canonical cross-implementation test vector.
//!
//!   cargo run -p ante-core --example print_vector
//!
//! Run this after a deliberate wire-format change and paste the output into the
//! two pin sites: `ante-core/src/proof.rs` (`cbor_wire_format_is_pinned`) and
//! `client/test/ante-proof.test.ts` (`VECTOR`).

use ante_core::{pow, testvec, to_cbor};

fn main() {
    let vk = testvec::verifying_key();
    let proof = testvec::proof();

    println!("seed_hex        {}", testvec::hex(&testvec::SEED));
    println!("vk_hex          {}", testvec::hex(&vk));
    println!("purpose         {}", testvec::PURPOSE);
    println!("ts              {}", testvec::TS);
    println!("nonce           {}", proof.nonce);
    println!(
        "achieved_bits   {}",
        pow::bits(testvec::PURPOSE, &vk, proof.nonce)
    );
    println!(
        "challenge_hex   {}",
        testvec::hex(&pow::challenge_bytes(testvec::PURPOSE, &vk))
    );
    println!("proof_cbor_hex  {}", testvec::hex(&to_cbor(&proof)));
}
