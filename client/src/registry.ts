// Client for the ante identity-level registry contract. Read a level with a
// plain contract GET; publish a proof with a delta update. The CRDT lives in
// `ante_core::registry`; this only reads and writes its CBOR.

import { decodeAnteProofValue, verifyAnteProof } from "./ante-proof";
import { asBytes, cborDecode, cborEncode, mapGet } from "./cbor";
import { ANTE_REGISTRY_CONTRACT_ID } from "./embedded";
import { contractKeyFromId, FreenetClient } from "./freenet";
import { bytesEqual } from "./util";
import { migrateRegistry, type MigrationReport } from "./migrate";
import { anteProofToCborValue } from "./ante-proof";

export { ANTE_REGISTRY_CONTRACT_ID } from "./embedded";

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
        const result = verifyAnteProof(decodeAnteProofValue(v), 0);
        return result.ok ? result.bits : null;
      }
    }
    return null;
  }

  /// Carry levels forward from registry generations stranded by a re-key.
  ///
  /// Safe for anyone to run, for anyone's proofs: every one is re-validated by
  /// the contract's own `admit` on the way in. See `migrate.ts` for the probe
  /// rules — in particular that a predecessor which times out is unresolved
  /// rather than empty, so `complete: false` means "run me again later".
  async carryForward(
    predecessors: readonly string[],
    minBitsFloor: number,
  ): Promise<MigrationReport> {
    return migrateRegistry(
      this.client,
      ANTE_REGISTRY_CONTRACT_ID,
      predecessors,
      minBitsFloor,
      async (proofs) => {
        const delta = cborEncode({ proofs: proofs.map(anteProofToCborValue) });
        await this.client.updateContractDelta(this.key, delta);
      },
    );
  }

  /// Publish a proof — one ground for `IDENTITY_LEVEL_PURPOSE`, straight from
  /// `AnteClient.commit`. Monotonic on the contract side: a weaker proof is a
  /// harmless no-op.
  async publishProof(proofCbor: Uint8Array): Promise<void> {
    const delta = cborEncode({ proofs: [cborDecode(proofCbor)] });
    await this.client.updateContractDelta(this.key, delta);
  }
}
