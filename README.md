# ante

[![CI](https://github.com/soudasuwa/ante/actions/workflows/ci.yml/badge.svg)](https://github.com/soudasuwa/ante/actions/workflows/ci.yml)

A small, mandatory proof-of-work commitment for [Freenet](https://freenet.org)
identities — the stepping stone between *no effort at all to sybil* and *needs a
[ghost key](https://freenet.org/ghostkey)*.

An app that wants to keep a guestbook or a comment box from filling with
zero-cost spam asks a user's ante delegate for a signed **`AnteProof`**: proof
that this identity burned a measurable slice of CPU for this specific action.
Verifying is one blake3 hash and one signature check.

> **Scope.** A proof shows a key *cost something*. It does **not** show the key
> is unique, human-held, or not one of many an attacker made. Resisting a
> resourced adversary is not this project's job — ghost keys and reputation
> systems sit above it. See [DESIGN.md](DESIGN.md).

## Layout

```
ante-core/      the primitive + AnteProof + verify + the registry CRDT
                (no freenet-stdlib dependency — a verifier links only this)
ante-delegate/  the Freenet delegate: key custody + consent prompt + signing (→ WASM)
contracts/
  ante-registry/        records each identity's best identity-level proof (→ WASM)
web/            identity-management UI: create an identity, grind bits, hold proofs
tools/          delegate-key: compute a delegate's address from its WASM
scripts/        build-delegate.sh, sync-delegate.sh
examples/
  guestbook-contract/   a Freenet contract that requires an ante proof per entry
```

## Status

**Phase 1** (works end to end) — the delegate, the primitive, and the UI. An
app gets an `AnteProof` per action, ground on demand.

**Phase 2** (contract done; UI wiring + publish pending) — `ante-core::registry`
and `contracts/ante-registry/`: an identity publishes its level once, and an
app reads it with a plain contract GET (`RegistryState::level(vk)`) instead of
triggering a grind. Monotonic — you raise your level, never lower it.

## Verifying a proof (consumer side)

```rust
use ante_core::AnteProof;

// `min_bits` is your policy: set it so one identity's grind costs more than the
// value at risk per action. Treat multiple identities independently.
match proof.verify(20) {
    Ok(bits) => { /* accept — identity showed `bits` bits for this purpose */ }
    Err(e)   => { /* reject: e is InsufficientWork / BadSignature / ... */ }
}
```

## Building

```bash
cargo test --workspace                   # ante-core + tools
(cd ante-delegate && cargo test)         # delegate logic, native
(cd contracts/ante-registry && cargo test)

rustup target add wasm32-unknown-unknown # once
./scripts/sync-delegate.sh               # build the delegate WASM -> web/.gen/

cd web && npm install
npm test                                 # cross-impl guard (TS verifier vs a Rust vector)
npm run dev                              # the UI, against your local node
```

`npm run dev` serves on its own origin, so pass your node with a query param:
`http://localhost:5173/?node=127.0.0.1:7509`. Served through the node's gateway
it needs no param.

### Phase 2: the registry

Optional — the UI works without it, showing only the local best level.

```bash
cargo install --git https://github.com/freenet/freenet-core fdev   # once
./scripts/publish-registry.sh            # build, publish, write web/.gen/registry_contract_id.txt
cd web && npm run build                  # or restart `npm run dev` to pick up the id
```

Once configured, the "Strengthen your identity" panel publishes each proof to
the registry, and any app can read a level with
`RegistryState::level(vk)` after a plain contract GET.

## License

MIT OR Apache-2.0.
