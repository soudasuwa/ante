//! A reference guestbook contract: `username + text`, one entry gated by an
//! [`AnteProof`](ante_core::AnteProof).
//!
//! This is the whole point of ante at contract scope. Each entry carries a
//! signed proof that its author burned `min_bits` of work against this
//! guestbook's `purpose` string; `validate_state` and `update_state` reject
//! anything that does not verify. A drive-by spam script that ignores ante
//! simply cannot produce a valid entry, and one that implements it pays a
//! per-post CPU tax.
//!
//! The state is a grow-only set of entries keyed by
//! `blake3(author_vk || nonce || text)`, so replaying one signed entry many
//! times collapses to a single key. Merge is the set union — any arrival
//! order converges.
//!
//! Not shown, because ante does not solve it: rate-limiting a determined
//! author, or stopping someone with a lot of CPU. That is the app's call
//! (raise `min_bits`, add a per-author cap, require a ghost key for more).

use std::collections::BTreeMap;

use ante_core::AnteProof;
use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

/// Longest guestbook message, in bytes.
pub const MAX_TEXT_BYTES: usize = 500;
/// Longest display name, in bytes.
pub const MAX_NAME_BYTES: usize = 40;

/// Instance parameters — the app's anti-spam policy, fixed at publish time.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct GuestbookParameters {
    /// The `purpose` string every entry's proof must carry. Make it specific
    /// to this guestbook (e.g. `"myapp:guestbook:v1"`) so a proof minted for
    /// somewhere else cannot be replayed here.
    pub purpose: String,
    /// Minimum leading-zero bits an entry's proof must demonstrate.
    pub min_bits: u32,
}

/// One signed guestbook entry.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub text: String,
    /// The commitment. `proof.identity_vk` is the author; `proof.purpose` must
    /// equal the guestbook's; `proof.verify(min_bits)` must pass.
    pub proof: AnteProof,
}

/// The `purpose` a proof must carry to count for this exact message.
///
/// This is the whole defence against one grind buying unlimited posts. An
/// [`AnteProof`] commits to `(identity, purpose, nonce)` and **nothing else**,
/// so with a fixed purpose the same nonce validates any text you like — and
/// because the challenge is `blake3(purpose ‖ vk)` and grinding starts at nonce
/// 0, an author replays the identical search every time and re-finds the same
/// lucky nonce for free. Folding the message into the purpose gives every
/// distinct post its own challenge, and therefore its own genuine search.
///
/// Both lengths are prefixed so `(name, text)` cannot be re-split: without it
/// `("ab", "c")` and `("a", "bc")` would hash alike.
pub fn content_purpose(prefix: &str, name: &str, text: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&(name.len() as u32).to_le_bytes());
    h.update(name.as_bytes());
    h.update(&(text.len() as u32).to_le_bytes());
    h.update(text.as_bytes());
    let tag = h.finalize();
    let mut out = String::with_capacity(prefix.len() + 17);
    out.push_str(prefix);
    out.push(':');
    for byte in &tag.as_bytes()[..8] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

impl Entry {
    /// Stable key: dedupes an entry replayed verbatim.
    pub fn key(&self) -> [u8; 32] {
        let mut h = blake3::Hasher::new();
        h.update(&self.proof.identity_vk);
        h.update(&self.proof.nonce.to_le_bytes());
        h.update(self.text.as_bytes());
        *h.finalize().as_bytes()
    }

    fn check(&self, params: &GuestbookParameters) -> Result<(), String> {
        if self.name.is_empty() || self.name.len() > MAX_NAME_BYTES {
            return Err("name out of bounds".into());
        }
        if self.text.is_empty() || self.text.len() > MAX_TEXT_BYTES {
            return Err("text out of bounds".into());
        }
        // The proof must be bound to THIS message, not merely to the
        // guestbook. See `content_purpose`.
        if self.proof.purpose != content_purpose(&params.purpose, &self.name, &self.text) {
            return Err("proof is not bound to this message".into());
        }
        // verify() recomputes the achieved bits from the nonce, so the author
        // cannot overstate them, and checks the signature over
        // (vk, purpose, nonce, ts) — binding the proof to this exact author.
        self.proof
            .verify(params.min_bits)
            .map(|_bits| ())
            .map_err(|e| format!("proof rejected: {e}"))
    }
}

#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct GuestbookState {
    pub entries: BTreeMap<[u8; 32], Entry>,
}

impl GuestbookState {
    fn merge(&mut self, other: GuestbookState) {
        for (key, entry) in other.entries {
            self.entries.entry(key).or_insert(entry);
        }
    }
}

#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct GuestbookDelta {
    pub entries: Vec<Entry>,
}

/// Summary for anti-entropy: the sorted set of entry keys a peer already has.
#[derive(Clone, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct GuestbookSummary {
    pub keys: Vec<[u8; 32]>,
}

fn cbor<T: Serialize>(value: &T) -> Vec<u8> {
    let mut out = Vec::new();
    ciborium::into_writer(value, &mut out).expect("CBOR serialization cannot fail");
    out
}

fn from_cbor<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    ciborium::from_reader(bytes).map_err(|e| format!("CBOR decode: {e}"))
}

fn decode_params(p: &Parameters<'_>) -> Result<GuestbookParameters, ContractError> {
    from_cbor(p.as_ref()).map_err(ContractError::Deser)
}

fn decode_state(bytes: &[u8]) -> Result<GuestbookState, String> {
    if bytes.is_empty() {
        Ok(GuestbookState::default())
    } else {
        from_cbor(bytes)
    }
}

fn reject(reason: String) -> ContractError {
    ContractError::InvalidUpdateWithInfo { reason }
}

pub struct Contract;

#[contract]
impl ContractInterface for Contract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let params = decode_params(&parameters)?;
        let Ok(state) = decode_state(state.as_ref()) else {
            return Ok(ValidateResult::Invalid);
        };
        for (key, entry) in &state.entries {
            if *key != entry.key() {
                return Ok(ValidateResult::Invalid);
            }
            if entry.check(&params).is_err() {
                return Ok(ValidateResult::Invalid);
            }
        }
        Ok(ValidateResult::Valid)
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let params = decode_params(&parameters)?;
        let mut current = decode_state(state.as_ref()).map_err(ContractError::Deser)?;

        for update in data {
            match update {
                UpdateData::State(bytes) => {
                    let incoming = decode_state(bytes.as_ref()).map_err(reject)?;
                    for entry in incoming.entries.values() {
                        entry.check(&params).map_err(reject)?;
                    }
                    current.merge(incoming);
                }
                UpdateData::Delta(bytes) => {
                    let delta: GuestbookDelta = from_cbor(bytes.as_ref()).map_err(reject)?;
                    for entry in delta.entries {
                        entry.check(&params).map_err(reject)?;
                        current.entries.entry(entry.key()).or_insert(entry);
                    }
                }
                UpdateData::StateAndDelta { state: s, delta: d } => {
                    let incoming = decode_state(s.as_ref()).map_err(reject)?;
                    for entry in incoming.entries.values() {
                        entry.check(&params).map_err(reject)?;
                    }
                    current.merge(incoming);
                    let delta: GuestbookDelta = from_cbor(d.as_ref()).map_err(reject)?;
                    for entry in delta.entries {
                        entry.check(&params).map_err(reject)?;
                        current.entries.entry(entry.key()).or_insert(entry);
                    }
                }
                _ => {}
            }
        }

        Ok(UpdateModification::valid(State::from(cbor(&current))))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let state = decode_state(state.as_ref()).map_err(ContractError::Deser)?;
        let summary = GuestbookSummary {
            keys: state.entries.keys().copied().collect(),
        };
        Ok(StateSummary::from(cbor(&summary)))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = decode_state(state.as_ref()).map_err(ContractError::Deser)?;
        let have: GuestbookSummary = if summary.as_ref().is_empty() {
            GuestbookSummary::default()
        } else {
            from_cbor(summary.as_ref()).map_err(ContractError::Deser)?
        };
        let have: std::collections::BTreeSet<[u8; 32]> = have.keys.into_iter().collect();
        let delta = GuestbookDelta {
            entries: state
                .entries
                .into_iter()
                .filter(|(k, _)| !have.contains(k))
                .map(|(_, entry)| entry)
                .collect(),
        };
        Ok(StateDelta::from(cbor(&delta)))
    }
}
