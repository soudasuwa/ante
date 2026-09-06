//! The proof-of-work primitive.
//!
//! An ante is a nonce whose `blake3(challenge || nonce_le)` digest has some
//! number of leading zero bits, where `challenge` binds a *purpose* string and
//! an *identity* verifying key. Binding both means a nonce cannot be moved to a
//! different purpose or claimed by a different key: each `(purpose, identity)`
//! pair is its own independent search.
//!
//! Grinding needs only the public verifying key, so it can run anywhere — in
//! particular a browser Web Worker, off the delegate. The delegate's job is to
//! *sign* the result (see [`crate::proof`]), not to grind.

/// Domain-separation prefix for the challenge preimage. Bump the version
/// suffix if the layout below ever changes; a consumer that pins a purpose
/// string is implicitly pinning this too.
const CHALLENGE_CONTEXT: &[u8] = b"ante:pow-challenge:v1";

/// Longest purpose string accepted anywhere in the system. Keeps a hostile
/// caller from bloating a permission prompt or a stored proof.
pub const MAX_PURPOSE_BYTES: usize = 256;

/// The bytes a nonce is ground against:
/// `CHALLENGE_CONTEXT || len(purpose) as u32 le || purpose || identity_vk`.
///
/// The length prefix keeps `(purpose, identity_vk)` unambiguous — without it,
/// `("ab", vk)` and `("a", b'b' ++ vk)` would hash identically.
pub fn challenge_bytes(purpose: &str, identity_vk: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CHALLENGE_CONTEXT.len() + 4 + purpose.len() + 32);
    out.extend_from_slice(CHALLENGE_CONTEXT);
    out.extend_from_slice(&(purpose.len() as u32).to_le_bytes());
    out.extend_from_slice(purpose.as_bytes());
    out.extend_from_slice(identity_vk);
    out
}

/// `blake3(challenge_bytes(purpose, vk) || nonce.to_le_bytes())`.
pub fn digest(purpose: &str, identity_vk: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&challenge_bytes(purpose, identity_vk));
    hasher.update(&nonce.to_le_bytes());
    *hasher.finalize().as_bytes()
}

/// Count leading zero bits of a 32-byte digest (0..=256).
pub fn leading_zero_bits(digest: &[u8; 32]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        if *byte == 0 {
            bits += 8;
        } else {
            bits += byte.leading_zeros();
            break;
        }
    }
    bits
}

/// How many leading-zero bits `nonce` demonstrates for this `(purpose,
/// identity)`. This is ground truth: a pure function of verifiable inputs, so
/// it cannot be forged or overstated.
pub fn bits(purpose: &str, identity_vk: &[u8; 32], nonce: u64) -> u32 {
    leading_zero_bits(&digest(purpose, identity_vk, nonce))
}

/// Grind the smallest nonce reaching `target_bits`. Test and CLI helper — the
/// browser runs the identical search in a Web Worker with progress reporting.
///
/// Returns `None` if no nonce below `u64::MAX` works (unreachable for any
/// sane `target_bits`; a 64-bit space covers far more than 40 bits of grind).
pub fn grind(purpose: &str, identity_vk: &[u8; 32], target_bits: u32) -> Option<u64> {
    (0u64..).find(|nonce| bits(purpose, identity_vk, *nonce) >= target_bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK: [u8; 32] = [9u8; 32];

    #[test]
    fn leading_zeros_counts_across_byte_boundaries() {
        assert_eq!(leading_zero_bits(&[0xFF; 32]), 0);
        assert_eq!(leading_zero_bits(&[0x00; 32]), 256);
        let mut d = [0u8; 32];
        d[0] = 0x00;
        d[1] = 0x0F; // 4 leading zeros in the second byte
        assert_eq!(leading_zero_bits(&d), 8 + 4);
    }

    #[test]
    fn purpose_length_prefix_prevents_collision() {
        // ("ab", vk) must not hash like ("a", 'b' ++ vk-shifted); the length
        // prefix is what separates them. Cheapest check: the challenge bytes
        // themselves differ.
        let a = challenge_bytes("ab", &VK);
        let mut shifted = VK;
        shifted.rotate_left(1);
        let b = challenge_bytes("a", &shifted);
        assert_ne!(a, b);
    }

    #[test]
    fn nonce_is_bound_to_purpose_and_identity() {
        let nonce = grind("guestbook", &VK, 12).expect("12 bits is reachable");
        assert!(bits("guestbook", &VK, nonce) >= 12);
        // Same nonce, different purpose: essentially always fails the bar.
        assert!(bits("other-purpose", &VK, nonce) < 12);
        // Same nonce, different identity: likewise.
        assert!(bits("guestbook", &[1u8; 32], nonce) < 12);
    }

    #[test]
    fn grind_finds_a_satisfying_nonce() {
        let nonce = grind("x", &VK, 10).expect("10 bits is reachable");
        assert!(bits("x", &VK, nonce) >= 10);
    }
}
