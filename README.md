# ante

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
ante-core/      the primitive + AnteProof + verify  (no freenet-stdlib dependency)
ante-delegate/  the Freenet delegate: key custody + consent prompt + signing (→ WASM)
web/            identity-management UI: create an identity, grind bits, hold proofs
tools/          delegate-key: compute a delegate's address from its WASM
scripts/        build-delegate.sh, sync-delegate.sh
examples/
  guestbook-contract/   a Freenet contract that requires an ante proof per entry
```

## Status

**Phase 1** — the delegate, the primitive, and the UI. A proof is held by
whoever receives it.

**Phase 2** (not started) — a registry contract that records each identity's
best proof, so apps can read a level without a fresh grind. The two ship
together; Phase 1 is not independently useful.

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

rustup target add wasm32-unknown-unknown # once
./scripts/sync-delegate.sh               # build the delegate WASM -> web/.gen/

cd web && npm install
npm test                                 # cross-impl guard (TS verifier vs a Rust vector)
npm run dev                              # the UI, against your local node
```

`npm run dev` serves on its own origin, so pass your node with a query param:
`http://localhost:5173/?node=127.0.0.1:7509`. Served through the node's gateway
it needs no param.

## License

MIT OR Apache-2.0.
