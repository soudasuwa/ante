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
| `ante-core` | The primitive + `AnteProof` + `verify`. No `freenet-stdlib` dep — a contract that only verifies links just this. |
| `ante-delegate` | Freenet delegate. Custodies one Ed25519 identity per calling origin, signs proofs behind a user consent prompt. Compiles to WASM. |
| `web/` | Identity-management UI: create an identity, grind bits, hold proofs, manage per-app permissions. |

## The two flows

Both use one mechanism: **prompt → grind → sign**.

### Per-action (an app asks)

1. App → delegate `GetIdentity` → learns the user's verifying key for its origin.
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

`Commit` can't be answered in one `process()` call. The delegate:

1. writes `PendingCommit { request_id, origin_ns, purpose, nonce, ts }` to its
   scratch context (host-held, ~10 min TTL, keyed by delegate),
2. emits `RequestUserInput { request_id, message, responses: [Allow, Deny] }`.

The user's click returns as `InboundDelegateMsg::UserResponse` on a later
`process()`. The delegate then checks:

- `request_id` matches the parked prompt (**which** question) — a mismatch
  leaves the prompt standing, it does not clear it,
- the answering origin matches `origin_ns` (**whose** question) — the runtime
  feeds a genuine answer back through the same attested origin,

clears the context, and signs (or returns `Denied`).

## Key custody

One Ed25519 seed per calling origin, in the node's encrypted secret store,
namespaced `ante:identity:v1:webapp:<contract-id>` /
`ante:identity:v1:delegate:<key>`. The private key never leaves the delegate;
callers see only the verifying key and finished proofs. Generated from host
entropy on first use; an all-zero seed (entropy failure) is refused.

## Non-goals (Phase 1)

- No registry contract yet — a proof is held by whoever the delegate handed it
  to. (Phase 2.)
- No "always allow" grant — every `Commit` prompts. (Could change.)
- No freshness / epoch binding on the PoW. A consumer that needs it folds a
  recent marker into its `purpose` string.
- No defense against a resourced adversary. By design.
