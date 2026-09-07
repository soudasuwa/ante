# ante

[![CI](https://github.com/soudasuwa/ante/actions/workflows/ci.yml/badge.svg)](https://github.com/soudasuwa/ante/actions/workflows/ci.yml)

A small, mandatory **proof of commitment** for [Freenet](https://freenet.org)
identities — the stepping stone between *no effort at all to sybil* and *needs a
[ghost key](https://freenet.org/ghostkey)*.

> **Archived, and still running.** Development stopped at `v0.2.0`. The apps
> below are live on Freenet and stay live: their addresses are permanent and
> nothing here depends on a server we run. The repository is left as a worked
> reference — see [what to take from it](#taking-something-from-this) below.

## Try it

Freenet addresses, so `127.0.0.1:7509` is **your own node**, not ours. Anyone
running Freenet opens the same link locally.

| | |
|---|---|
| **ante** — what it is, and the whitepaper | `http://127.0.0.1:7509/v1/contract/web/6Ffg43GVU9Zec9VTbaVKaWATrz4p7YcShaKEYUZ73EXg/` |
| **ante vault** — create a key, raise its level, manage apps, save a recovery code | `http://127.0.0.1:7509/v1/contract/web/AGdogAU4KTER6MpmLcYVAUjPGat3sQS536crq7wPYb2r/` |
| **ante guestbook** — a working integration, end to end | `http://127.0.0.1:7509/v1/contract/web/HLqqoWvQZMRy1JF9g1DV34VUeagCzgGvC4mNepSC6WWV/` |

No Freenet node yet? [freenet.org](https://freenet.org) — the guestbook is the
one to open first.

## What it is

An app that wants to keep a guestbook or a comment box from filling with
zero-cost spam asks a user's ante delegate for a signed **`AnteProof`**:
evidence that this identity spent a measurable, real moment of CPU on *this
specific action*. Verifying is one blake3 hash and one signature check.

*Commitment* rather than *work* or *stake* is deliberate. Work implies output;
stake implies something at risk and recoverable. This is neither — nothing is
produced and nothing comes back. What it demonstrates is that somebody was
willing to spend something real on this exact thing.

> **Scope.** A proof shows a key *cost something*. It does **not** show the key
> is unique, human-held, or not one of many an attacker made. Resisting a
> resourced adversary is not this project's job — ghost keys and reputation
> systems sit above it. See [DESIGN.md](DESIGN.md).

## Taking something from this

The repository is archived, so nothing here is going to change under you. Four
things are worth lifting, in rough order of how much time they will save:

**[FREENET-NOTES.md](FREENET-NOTES.md)** — platform facts that cost us days and
are not in Freenet's own documentation. Consent prompts do not exist in local
mode. The consent overlay belongs to the node's shell page, so a dev server
cannot test it. A published-but-never-updated contract returns zero bytes, not
NotFound. rustc applies the *last* matching `--remap-path-prefix`. cargo's
fingerprint does not cover the toolchain's install path, so a key check can pass
on bytes your machine would never produce. Read this one before you build
anything on Freenet, whether or not you care about ante.

**A reproducible build you can copy** — [`build/Dockerfile`](build/Dockerfile)
plus [`scripts/build-in-container.sh`](scripts/build-in-container.sh). Any
Freenet address is derived from bytes, so "can a stranger rebuild this and get
the same address?" decides whether your users have to trust you. cargo hashes a
path dependency's absolute path into `-C metadata` and no remap reaches it, so a
fixed `WORKDIR` is the whole answer. CI runs `--check` on every push.

**A cold-start harness** — [`scripts/cold-start.sh`](scripts/cold-start.sh)
stands up a node that has never seen your app. Every check you run day to day
happens on a node that already holds your state, your delegate and your secrets,
so it can only ever exercise the returning user. This one found three real bugs
the test suite could not, because they were bugs about *not having anything yet*.

**The migration machinery** — [`client/src/migrate.ts`](client/src/migrate.ts)
and the `superseded` lists in [`deployments.json`](deployments.json). Changing a
contract or a delegate changes its address and strands everything at the old one.
The rule that matters: a generation that does not answer is **unresolved**, never
**empty** — silence is not absence, and treating it as absence silently drops
data on a slow day.

📄 **[WHITEPAPER.md](WHITEPAPER.md)** — the full account: why proof of work,
every design decision and the reasoning behind it, exact wire formats, the
failure modes we hit, the threat model, and what we would do next. Written to
be enough to rebuild the system from.

🌐 **[DEPLOYMENTS.md](DEPLOYMENTS.md)** — what is live on Freenet: the three
web-app URLs (home, vault, guestbook), the published contract instances, and
the delegate key record.

🔍 **Verify the published artifacts yourself.** Every address is derived from
bytes — the delegate key is `blake3(blake3(wasm))`, a contract instance is
`blake3(blake3(wasm) ‖ params)` — so you do not have to take the record on
trust:

```bash
./scripts/build-in-container.sh --check
```

That builds at a fixed path in a container and compares against
`artifact-keys.toml`. A host build cannot reproduce those bytes (cargo hashes a
path dependency's absolute path into `-C metadata`), which is exactly why the
container exists. CI runs the same check on every push.

## The documents

Everything here is meant to be read by someone who was not in the room. Each one
has a different job:

| | |
|---|---|
| **[WHITEPAPER.md](WHITEPAPER.md)** | The complete account: why proof of commitment, every design decision and its reasoning, exact wire formats, the threat model, the failure modes we hit and what we would do next. Written to be enough to **rebuild the system from scratch** if this repository vanished. Long, and the length is the point. |
| **[FREENET-NOTES.md](FREENET-NOTES.md)** | Platform facts that cost us days and are not in Freenet's documentation — consent, reproducible builds, silent failure modes. **Useful even if you never touch ante.** Read it before building anything on Freenet. |
| **[DESIGN.md](DESIGN.md)** | What a proof does and does not prove, and where ante sits relative to ghost keys and reputation. Read this before assuming it protects something it does not. |
| **[DEPLOYMENTS.md](DEPLOYMENTS.md)** | What is live: the three app URLs, the published contract instances, the delegate key record, and the lineage of everything they replaced. |
| **[CHANGELOG.md](CHANGELOG.md)** | What shipped, and — at equal length — the limits that did not get solved. |
| **[SECURITY.md](SECURITY.md)** | How to report a vulnerability privately. |

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

**Archived at `v0.2.0`.** Everything described here is built, published and
working; see [CHANGELOG.md](CHANGELOG.md) for what shipped and, at equal length,
the limits that did not get solved.

What it does today: an identity lives in the delegate on your own node, shared
across every app that uses ante. An app asks before spending anything —
`RequestGrind` prompts with the cost in seconds *before* the work starts, so
refusing is free — then grinds in its own worker and gets a signed proof. A
level published once to the registry is readable by any app with a plain
contract GET, and the identity survives a wiped node through its recovery code.

Where we stopped, and why it is a reasonable place to stop: ante cannot enforce
anything. Nothing prevents a Freenet app from grinding, or mining, in a worker
without asking. That would have to come from the platform. What ante shows is
that the *policy* side is tractable — an app can be made to declare what it
wants to spend and what for, before it spends it, and a user can answer once and
not be pestered again. If a platform ever wants to gate computation on consent,
the surface it needs is here and works.

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
npm run dev --workspace ante-vault-web              # the UI, against your local node
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
npm run build --workspace ante-vault-web            # or restart `npm run dev` to pick up the id
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

The repository is archived, so issues and pull requests are closed. It is
MIT/Apache-2.0 — fork it, lift whatever is useful, no need to ask.

If you find a security problem in something still running, please use
[private reporting](SECURITY.md) rather than a public issue.

## Credits

Built by **Alessandro Delass** with **Claude Opus 5** (Anthropic), September 2026.

The honest division of labour, since the question is usually left vague: Claude
wrote most of the code, the tests and the prose here. The direction and every
design decision were human, and so were a good share of the findings that
mattered — the "25 bits instantly" report that exposed proofs not being bound to
their message, the insistence on fixing the cause rather than the symptom when
identities were being stranded, the observation that consent belongs *before* the
cost rather than after it, and the argument that *commitment* is a better name
than *work* for what this measures.

Every commit is co-authored, so `git log` shows the same story in more detail.

Small project, and a step in a direction worth taking: an AI and a person
building something neither would have finished alone, with the reasoning written
down rather than lost.

## License

MIT OR Apache-2.0 — dual licensing, which is the Rust ecosystem's convention.
"OR" means **you choose either one**; you are not bound by both. MIT is short and
permissive; Apache-2.0 adds an explicit patent grant and is preferred by some
organisations. Both require you to keep the copyright notice, which is the
attribution ante asks for in return.
