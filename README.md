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

📄 **[WHITEPAPER.md](WHITEPAPER.md)** — the full account: why proof of work,
every design decision and the reasoning behind it, exact wire formats, the
failure modes we hit, the threat model, and what we would do next. Written to
be enough to rebuild the system from.

🌐 **[DEPLOYMENTS.md](DEPLOYMENTS.md)** — what is live on Freenet: the two
web-app URLs, the published contract instances, and the delegate key record.

## Layout

```
ante-core/      the primitive + AnteProof + verify + the registry CRDT
                (no freenet-stdlib dependency — a verifier links only this)
ante-delegate/  the Freenet delegate: key custody + consent prompt + signing +
                seed export/import for backup (→ WASM)
contracts/
  ante-registry/        records each identity's best identity-level proof (→ WASM)
client/         @ante/client — the delegate embedded + a 2-line API an app calls
                (AnteClient.attach → ante.commit(purpose)); the TS PoW + verifier
web/            identity-management UI: create an identity, grind bits, back it up
tools/          delegate-key: compute a delegate's address from its WASM
scripts/        build-delegate.sh, sync-delegate.sh, build-contract.sh,
                check-keys.sh (guards against an accidental re-key)
examples/
  guestbook/    a standalone Freenet app showing how to integrate @ante/client
```

## Status

**Phase 1** (works end to end) — the delegate, the primitive, and the UI. An
app gets an `AnteProof` per action, ground on demand. The identity has a
recovery code (`ExportIdentity` / `ImportIdentity`), so it survives a node
whose secret store is wiped.

**Phase 2** (published, live) — `ante-core::registry` and
`contracts/ante-registry/`: an identity publishes its level once, and an app
reads it with a plain contract GET (`RegistryState::level(vk)`) instead of
triggering a grind. Monotonic — you raise your level, never lower it. The live
instance is in [DEPLOYMENTS.md](DEPLOYMENTS.md).

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
./scripts/sync-delegate.sh               # build the delegate WASM -> client/src/embedded.ts

npm install                              # workspaces: client + web
npm test                                 # cross-impl guard (TS verifier vs a Rust vector)
npm run dev --workspace web              # the UI, against your local node
```

`npm run dev` serves on its own origin, so pass your node with a query param:
`http://localhost:5173/?node=127.0.0.1:7509`. Served through the node's gateway
it needs no param.

That parameter is honoured **only in a dev build** and is stripped from anything
published. A URL parameter that repoints the node hands over the whole trust
root — an attacker who gets you to open the genuine app with their node in the
query string serves your state and draws your consent prompts, with the real
address in the bar. For the same reason no published page reads a contract id
from the URL: see [DEPLOYMENTS.md](DEPLOYMENTS.md#who-can-move-a-pointer).

An app integrates ante through the `@ante/client` package — never by talking to
the delegate directly. See [examples/guestbook/](examples/guestbook/).

### Phase 2: the registry

Optional — the UI works without it, showing only the local best level.

```bash
# fdev: install from https://freenet.org/install.sh  (cargo install fdev needs rustc >= 1.94)
./scripts/publish-registry.sh            # build, publish, write the id into client/src/embedded.ts
npm run build --workspace web            # or restart `npm run dev` to pick up the id
```

Once configured, the "Strengthen your identity" panel publishes each proof to
the registry, and any app can read a level with
`RegistryState::level(vk)` after a plain contract GET.

### Publishing the UI to Freenet

`fdev website` gives a permanent URL (derived from a signing key you keep):

```bash
fdev website init ante        # generates + prints the URL; BACK UP the key file
./scripts/publish-web.sh       # build + publish; re-run to push updates
```

## Contributing & security

Source and issues: <https://github.com/soudasuwa/ante>. Security vulnerabilities
go through [private reporting](SECURITY.md), not public issues.

## License

MIT OR Apache-2.0.
