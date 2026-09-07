# ante — design

## What it is

A drop-in way for a Freenet app to require a **small, measurable proof-of-work
commitment** from a user before accepting a write — a guestbook entry, a
comment, a first post. It fills the gap between:

- **no effort at all to sybil** (a bare keypair, free to mint by the thousand), and
- **needs a [ghost key](https://freenet.org/ghostkey)** (a donation, a
  centralized mint — too much friction for a guestbook).

An app that consumes ante asks: *did this identity burn a bit of CPU for this
action?* Not: *is this a real person?* Whales are explicitly out of scope. This
is a stepping stone; reputation and vouching live above it.

## The object

An **`AnteProof`** — `{ identity_vk, purpose, nonce, ts, signature }`:

- `nonce` solves `blake3(challenge(purpose, identity_vk) || nonce_le)` to some
  number of leading zero bits.
- `signature` is by `identity_vk` over `{vk, purpose, nonce, ts}`.
- The **bit count is not stored** — a verifier recomputes it from the nonce, so
  it can never be overstated. `verify(min_bits)` returns the achieved bits.

`purpose` is a domain-separation string the app chooses (`"myapp:comment:v1"`).
A proof for one purpose does not verify as another — both the work and the
signature are bound to it.

`ts` is producer wall-clock. **Not trusted for freshness, not calibrated.** A
consumer that cares about hardware-era drift applies its own discount.

## What a proof proves

- The key **cost something** for this purpose — not a zero-cost sybil.
- **Not** that the key is unique, human-held, or not one of many an attacker
  ground (each costs the same).

## Components

| Crate / dir | Role |
|---|---|
| `ante-core` | The primitive + `AnteProof` + `verify` + the registry CRDT. No `freenet-stdlib` dep — a contract that only verifies links just this. |
| `ante-delegate` | Freenet delegate. Custodies **one shared** Ed25519 identity, signs proofs behind a user consent prompt, and exports / imports the seed for backup. Compiles to WASM. |
| `client/` | `@ante/client` — the delegate embedded, a 2-line producer API, the TS PoW + verifier, the recovery-code codec. |
| `web/` | Identity-management UI: create an identity, grind bits, back it up, manage per-app permissions. |

## The two flows

Both use one mechanism: **prompt → grind → sign**.

### Per-action (an app asks)

1. App → delegate `GetIdentity` → learns the user's verifying key (one shared
   key; every app sees the same one, which is what makes a level portable).
2. App → delegate `Challenge { purpose }` → gets the exact bytes to grind.
3. App grinds a nonce in a Web Worker.
4. App → delegate `Commit { purpose, nonce, min_bits, ts }`.
   - Delegate checks the nonce clears `min_bits` (no prompt for a dud).
   - Delegate raises the consent prompt: *"App X wants to spend ~N bits on your
     identity <fp> for <purpose>. Allow?"*
   - On **Allow** it signs an `AnteProof` and returns it; on **Deny**, `Denied`.
5. App attaches the proof to its contract write. The contract calls
   `AnteProof::verify(its_own_min_bits)`.

### Per-identity level (the bundled UI)

The same `Commit` flow, with `purpose = "ante:identity-level:v1"` and a
user-chosen bit target. The resulting proof is a portable statement that this
identity is *not a one-off sybil* — worth at least the bits it shows. Phase 2
records the best such proof per identity in a registry contract so apps can
read a level without triggering a fresh grind.

## Consent round-trip mechanics

`Commit`, `ExportIdentity`, and `ImportIdentity` can't be answered in one
`process()` call. The delegate:

1. writes `Pending { request_id, origin_tag, action }` to its scratch context
   (host-held, ~10 min TTL, keyed by delegate) — `action` is `Commit { purpose,
   nonce, ts }`, `Export`, or `Import { seed, replacing }`,
2. emits `RequestUserInput { request_id, message, responses }` — `[Allow,
   Always allow, Deny]` for a commit, `[Reveal, Cancel]` / `[Import, Cancel]`
   for backup / recovery.

The user's click returns as `InboundDelegateMsg::UserResponse` on a later
`process()`. The delegate then checks:

- `request_id` matches the parked prompt (**which** question) — a mismatch
  leaves the prompt standing, it does not clear it,
- the answering origin matches `origin_tag` (**whose** question) — the runtime
  feeds a genuine answer back through the same attested origin,

clears the context, and performs the action (or returns `Denied`).

## Key custody

**One** Ed25519 seed for the whole delegate, at `ante:identity:v1:primary` in
the node's encrypted secret store — every calling app shares it, so a level
published to the registry is portable. Generated from host entropy on first
use; an all-zero seed (entropy failure) is refused.

The private key normally never leaves the delegate — callers see only the
verifying key and finished proofs. The one exception is `ExportIdentity`:
behind its own prompt it returns the raw seed so the user can save a recovery
code (`ante-` + base58(seed ‖ blake3(seed)[:4])). `ImportIdentity` is the
inverse — it restores the seed on a new node or after the secret store is lost,
and clears the replaced identity's "always allow" grants. An exportable key is
a phishable key; for a low-stakes PoW identity that trade beats losing the
accumulated level to a node wipe.

## "Always allow" grants

The first `Commit` from an app prompts with a third button, **Always allow**.
Choosing it records the attested `origin_tag` in `ante:grants:v1`; subsequent
commits from that origin sign without a prompt until the user revokes the grant
from the UI. `Allow` signs once and records nothing.

## Non-goals

- No freshness / epoch binding on the PoW. A consumer that needs it folds a
  recent marker into its `purpose` string.
- No defense against a resourced adversary. By design.

## Before v0.2: upgrade migration

Both the delegate and the registry contract are content-addressed
(`blake3(code_hash ‖ params)`), so any rebuild that changes their WASM —
a bug fix, a dependency bump — produces a new key and strands what was stored
under the old one: every user's identity seed (delegate) and every published
level (registry).

**How little it takes — and where it does not.** `panic!` and `expect` bake
`line!()` into the binary, so a shifted line above one changes the bytes.
Measured, not theorised:

| edit | delegate | contracts |
|---|---|---|
| one comment line in `ante-core/src/lib.rs` | **re-keys** | unchanged |
| one comment line in `proof.rs` / `pow.rs` / `registry.rs` | — | unchanged |

The delegate moves because it calls `ante_core::to_cbor`, whose
`expect("CBOR serialization cannot fail")` sits near the top of `lib.rs`, on
every reply. The contracts survive the same edits because they set
`panic = "abort"` with `strip = true` and carry their own `cbor()` helper rather
than linking that one. That asymmetry is a property to *verify*, not assume —
which is what the guard below is for. Treat `ante-core` and `ante-delegate` as
frozen between deliberate releases; batch edits rather than trickling them.

Two guards make that concrete, both run in CI:

- `scripts/check-keys.sh` compares the delegate key **and both contract code
  hashes** against the committed `artifact-keys.toml`. A re-key fails the build
  until someone records it with `ANTE_ACCEPT_REKEY=1`, which turns it into a
  reviewable diff. Contracts are covered because a moved contract address
  strands all its state — every guestbook entry, every published level.
- The same job builds the delegate twice from clean and compares hashes, so a
  build that is not byte-stable is caught here rather than in production. (This
  is why `wasm-opt` is *not* run: it is deterministic only for a fixed version,
  and "is binaryen installed" is not a property the key may depend on.)

Reproducibility is across *machines*, not just rebuilds on one. Two things were
needed for that, and both were missing until CI disagreed with a laptop:

- `rust-toolchain.toml` pins rustc. The compiler substitutes
  `/rustc/<commit-hash>/` for std's own source paths, which no
  `--remap-path-prefix` can remove — so a floating `stable` re-keys every
  artifact on each Rust release.
- The remaps cover the whole worktree, not just the crate being built. The
  delegate links `ante-core` from beside it, and `to_cbor`'s `expect()` put
  `ante-core/src/lib.rs` — an absolute path — into rodata. `build-delegate.sh`
  also only *checked* for `$CARGO_HOME`, which is why the leak survived.

The committed per-crate `Cargo.lock` prevents *accidental* re-keys. For the
delegate, `ExportIdentity` / `ImportIdentity` already give the user a manual
path across a re-key: save the recovery code before upgrading, restore it
after. A *deliberate*, hands-off upgrade would still want
[`freenet-migrate`](https://github.com/freenet/freenet-migrate) (the tool
ghostkeys uses). When cutting v0.2:

1. Record the current WASM `code_hash`es in a `legacy.toml` per crate.
2. Registry: impl `freenet_scaffold::ComposableState` for `RegistryState`
   (the hand-rolled `merge` already satisfies the semantics) so
   `carry_forward` can fold old state through the contract's own validator.
3. Delegate: wire the seed export/import into a `SecretTransport` impl so the
   carry-forward is automatic, not a copy-paste.

Not done now — v0.1 has one user and no successor.
