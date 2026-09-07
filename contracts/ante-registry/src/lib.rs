//! The ante identity-level registry contract.
//!
//! A thin `#[contract]` shell over [`ante_core::registry`] — decode, delegate,
//! re-encode. All the CRDT and verification logic lives in `ante-core` so a
//! consuming app can link the same code (`RegistryState::level`) without
//! pulling `freenet-stdlib`.
//!
//! State: `identity_vk -> best AnteProof for the registry's purpose`.
//! Monotonic — an identity raises its level by publishing a better proof and
//! can never lower it. Every stored proof is re-verified on read, so a
//! corrupt state cannot inflate a level.

use ante_core::registry::{RegistryDelta, RegistryParameters, RegistryState, RegistrySummary};
use freenet_stdlib::prelude::*;

#[cfg(test)]
mod tests;

pub struct Contract;

fn cbor<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let mut out = Vec::new();
    ciborium::into_writer(value, &mut out).expect("CBOR serialization cannot fail");
    out
}

fn from_cbor<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    ciborium::from_reader(bytes).map_err(|e| format!("CBOR decode: {e}"))
}

fn decode_params(p: &Parameters<'_>) -> Result<RegistryParameters, ContractError> {
    from_cbor(p.as_ref()).map_err(ContractError::Deser)
}

/// Empty bytes are the genesis state.
fn decode_state(bytes: &[u8]) -> Result<RegistryState, String> {
    if bytes.is_empty() {
        Ok(RegistryState::default())
    } else {
        from_cbor(bytes)
    }
}

fn reject(reason: String) -> ContractError {
    ContractError::InvalidUpdateWithInfo { reason }
}

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
        Ok(match state.is_well_formed(&params) {
            Ok(()) => ValidateResult::Valid,
            Err(_) => ValidateResult::Invalid,
        })
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
                    // merge() silently skips anything inadmissible; that is the
                    // right behaviour for a full-state PUT (a peer's whole
                    // registry, some of which we may already beat).
                    current.merge(&params, &incoming);
                }
                // An empty delta means the peer is already converged; nothing
                // to decode. See get_state_delta.
                UpdateData::Delta(bytes) if bytes.as_ref().is_empty() => {}
                UpdateData::Delta(bytes) => {
                    let delta: RegistryDelta = from_cbor(bytes.as_ref()).map_err(reject)?;
                    // A delta is a deliberate submission — reject the whole
                    // update if any proof in it is not admissible, so a
                    // client learns its mistake loudly. An unimproved proof
                    // (`Ok(false)`) is a harmless no-op, not an error.
                    for proof in delta.proofs {
                        current
                            .admit(&params, proof)
                            .map_err(|e| reject(format!("{e:?}")))?;
                    }
                }
                UpdateData::StateAndDelta { state: s, delta: d } => {
                    let incoming = decode_state(s.as_ref()).map_err(reject)?;
                    current.merge(&params, &incoming);
                    let delta: RegistryDelta = from_cbor(d.as_ref()).map_err(reject)?;
                    for proof in delta.proofs {
                        current
                            .admit(&params, proof)
                            .map_err(|e| reject(format!("{e:?}")))?;
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
        Ok(StateSummary::from(cbor(&state.summarize())))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = decode_state(state.as_ref()).map_err(ContractError::Deser)?;
        let summary: RegistrySummary = if summary.as_ref().is_empty() {
            RegistrySummary::default()
        } else {
            from_cbor(summary.as_ref()).map_err(ContractError::Deser)?
        };
        let delta = state.delta_since(&summary);
        // Nothing to send: return literally nothing rather than CBOR framing
        // around an empty list. `fdev verify-merge` flags the latter as
        // `self_delta_empty`, and it would cost the network bytes on every
        // heartbeat between converged peers.
        if delta.proofs.is_empty() {
            return Ok(StateDelta::from(Vec::new()));
        }
        Ok(StateDelta::from(cbor(&delta)))
    }
}
