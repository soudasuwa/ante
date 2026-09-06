# ante-registry-contract

Records each identity's best `ante:identity-level:v1` [`AnteProof`](../../ante-core),
so an app can read an identity's level with a plain contract GET instead of
triggering a grind.

Thin `#[contract]` shell over [`ante_core::registry`] — all the CRDT and
verification logic is there, so a consuming app links the same code
(`RegistryState::level(vk)`) without pulling `freenet-stdlib`.

## Model

- **State:** `identity_vk -> best AnteProof`.
- **Monotonic:** an identity raises its level by publishing a better proof; it
  can never lower it. Merge keeps the higher-bits proof (tie broken on the
  greater signature), so any arrival order converges.
- **Re-verified on read:** a corrupt stored proof reads as "no level", never an
  inflated one.
- **Parameters** (publish-time): `{ purpose, min_bits_floor }`. The registry
  refuses anything below the floor; a consumer can still demand more on read.

## Update paths

- **Delta** (`RegistryDelta { proofs }`) — a deliberate submission. Any
  inadmissible proof rejects the whole update, loudly. An unimproved proof is a
  harmless no-op.
- **Full state** — a peer's whole registry; inadmissible entries are skipped,
  not fatal.

## Build / test / publish

```bash
cargo test                                        # 7 tests, native
cargo build --release --target wasm32-unknown-unknown

# publish (needs fdev + a running node):
fdev publish --code target/wasm32-unknown-unknown/release/ante_registry_contract.wasm \
  --parameters <cbor of RegistryParameters>
```
