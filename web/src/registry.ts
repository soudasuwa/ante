// Client for the ante identity-level registry contract. Read a level with a
// plain contract GET; publish a proof with a delta update. The CRDT lives in
// `ante_core::registry`; this only reads and writes its CBOR.

import { decodeAnteProof, verifyAnteProof } from "./ante-proof";
import { asBytes, cborDecode, cborEncode, CborValue, mapGet } from "./cbor";
import { contractKeyFromId, FreenetClient } from "./freenet";
import { bytesEqual } from "./util";

declare const __ANTE_REGISTRY_CONTRACT_ID__: string;

/// The published registry instance id, or "" if none is configured yet.
export const ANTE_REGISTRY_CONTRACT_ID: string = __ANTE_REGISTRY_CONTRACT_ID__;

export function registryConfigured(): boolean {
  return ANTE_REGISTRY_CONTRACT_ID.length > 0;
}

export class RegistryClient {
  private readonly key = contractKeyFromId(ANTE_REGISTRY_CONTRACT_ID);

  constructor(private readonly client: FreenetClient) {}

  /// The bits an identity has on record, or `null`. Re-verifies the stored
  /// proof, so a corrupt entry reads as absent — never inflated.
  ///
  /// Fetches the whole registry state each call. Fine at Phase 2 scale; a
  /// real deployment would subscribe or shard.
  async readLevel(identityVk: Uint8Array): Promise<number | null> {
    const state = await this.client.getContractState(this.key);
    if (state.length === 0) return null;

    const levels = mapGet(cborDecode(state), "levels");
    if (!(levels instanceof Map)) return null;

    for (const [k, v] of levels) {
      if (bytesEqual(asBytes(k), identityVk)) {
        const proof = decodeAnteProof(cborEncode(v as CborValue));
        const result = verifyAnteProof(proof, 0);
        return result.ok ? result.bits : null;
      }
    }
    return null;
  }

  /// Publish a proof — one ground for `IDENTITY_LEVEL_PURPOSE`, straight from
  /// `AnteClient.commit`. Monotonic on the contract side: a weaker proof is a
  /// harmless no-op.
  async publishProof(proofCbor: Uint8Array): Promise<void> {
    const delta = cborEncode({ proofs: [cborDecode(proofCbor)] });
    await this.client.updateContractDelta(this.key, delta);
  }
}
