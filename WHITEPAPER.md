# ante — a proof-of-work identity commitment for Freenet

**Status:** v0.1, working end to end.
**Repository:** <https://github.com/soudasuwa/ante>
**License:** MIT OR Apache-2.0

---

## 0. What this document is

A complete account of ante: the problem it solves, the reasoning behind every
design decision, the exact wire formats, the failure modes we hit, and the
things we chose not to do. It is written so that if the code disappeared
tomorrow, someone could rebuild the system — and, more importantly, rebuild the
*judgement* that produced it — from this file alone.

Sections 1–3 are the argument. Sections 4–7 are the specification. Sections
8–12 are the system as built. Section 13 is what went wrong and what it taught
us. Section 14 is what we would do next. The appendix has every constant and a
pinned test vector.

---

## 1. The problem

[Freenet](https://freenet.org) applications are decentralised: contracts hold
shared state on untrusted peers, and anyone can write to a contract that accepts
their write. This is the point of the platform, and it means a guestbook, a
comment box, or a small forum has no natural defence against a script that
posts ten thousand entries. There is no server to rate-limit at, no account to
suspend, no IP to block that means anything.

Freenet's answer for identity is the **ghost key** — a cryptographic credential
backed by a donation, giving a strong, scarce, verifiable identity. Ghost keys
work. But they are heavy: they cost real money, they involve a third party, and
requiring one to sign a guestbook is absurd. The friction is wildly out of
proportion to the stakes.

So there is a gap:

```
no effort at all                                          needs a ghost key
├──────────────────────────────────────────────────────────────────────────┤
        ↑                                                       ↑
   anyone can spam                                    real money, real scarcity
   a guestbook forever                                for a comment box?
```

**ante fills that gap.** It is a small, mandatory, measurable CPU cost attached
to an identity, verifiable by anyone in one hash and one signature check. Not
scarcity. Not personhood. Just: *this key cost something*.

The name is from poker. An ante is the small forced bet everyone posts before a
hand — not enough to matter to a serious player, enough that you cannot play
infinite hands for free.

### Why proof of work, specifically

Proof of work has a bad reputation from cryptocurrency, where it is used to
order a global ledger and consumes a country's electricity doing it. That is not
this. Here it is used the way Hashcash originally proposed it in 1997: as a
**client puzzle** that makes an action cost a bounded, verifiable amount of
one specific resource.

The properties that matter for this use:

- **No issuer.** Nothing to run, nothing to trust, nothing to take down. A
  contract on an untrusted peer can verify a proof with no network access and no
  external state. This is the decisive property — every alternative
  (rate-limiting, CAPTCHAs, attestation, reputation) needs someone to run it.
- **Verification is asymmetric and cheap.** Producing 20 bits costs ~2²⁰
  hashes; checking it costs one. A contract running in a WASM sandbox on a
  stranger's machine can afford the check.
- **The cost is measurable and expressible as policy.** "This action requires 18
  bits" is a number an app author can reason about and tune.
- **It degrades gracefully.** If an attacker outspends the bar, the app raises
  it, or moves to ghost keys. Nothing breaks; the floor just was not high
  enough.

What it emphatically does not give you is a person. See §3.

---

## 2. Design goals

1. **A consumer links one small crate and calls one function.** Verification
   must not require the delegate, key custody, network access, or a Freenet
   dependency. In practice: `ante-core` has no `freenet-stdlib` dependency, and
   `AnteProof::verify(min_bits) -> Result<u32, VerifyError>` is the whole
   consumer API.
2. **The private key never leaves the user's device**, and an app never sees it
   — only finished proofs.
3. **Every spend of the identity is consented to.** An app cannot silently burn
   the user's identity on an action they did not take.
4. **The proof is bound to a purpose.** A proof minted for one app must be
   useless in another. Otherwise the first app to collect proofs becomes a proof
   vending machine.
5. **Work is portable.** A user who has ground once should not have to grind
   again for every app they meet.
6. **The policy is the consumer's.** ante does not decide what "enough" is; it
   reports what was demonstrated and the consumer applies its own threshold.

Goals 4 and 5 are in tension — §6 is how that tension resolves.

---

## 3. Scope: what a proof does and does not mean

This section exists because getting it wrong is the most likely way to misuse
the system.

**An `AnteProof` establishes exactly one thing:** the holder of this Ed25519
key performed a search costing approximately 2ⁿ hash evaluations, bound to this
specific purpose string, and signed that fact.

It does **not** establish:

- **Uniqueness.** Nothing stops one person minting a thousand identities. Each
  costs the same as the first. ante raises the price of a sybil from zero to
  something; it does not make sybils impossible or even hard at scale.
- **Personhood.** There is no human in the loop that a machine could not
  replace.
- **Freshness.** The `ts` field is producer wall-clock, unauthenticated, and
  enforced by nothing. A proof from 2019 verifies identically today. A consumer
  needing freshness must fold a recent marker into its own `purpose` string
  (e.g. `myapp:comment:2026-W12`) — that is the supported mechanism.
- **Calibrated cost.** 20 bits on a 2015 laptop and 20 bits on a 2035 phone are
  different amounts of real work. The bit count is a hash count, not an economic
  quantity. A consumer that cares must discount over time itself.

**Explicitly out of scope, permanently:**

- Resisting an adversary with a botnet or serious hardware. ante is a floor, not
  a ceiling. Above it sit ghost keys and reputation systems, and those are the
  right tools for that job.
- One person, many identities.
- Denial of service by flooding an app with valid-but-cheap proofs. That is the
  consuming app's policy problem (raise `min_bits`, cap per author, require more
  for expensive actions).

When someone asks "but can't an attacker just…" — the answer is usually **yes,
and that is fine**, because the alternative being compared against is not a
perfect system, it is *no cost at all*.

---

## 4. The primitive

### 4.1 The challenge

A nonce is ground against a **challenge preimage** that binds a purpose string
and an identity's verifying key:

```
CHALLENGE_CONTEXT ‖ len(purpose) as u32 little-endian ‖ purpose ‖ identity_vk
```

with `CHALLENGE_CONTEXT = b"ante:pow-challenge:v1"` (21 bytes) and
`identity_vk` the 32-byte Ed25519 public key.

Three details, each load-bearing:

- **The context prefix** is domain separation. It guarantees a digest computed
  here can never collide with a digest computed for some other protocol that
  happens to hash similar material. The version suffix means a future layout
  change is a different namespace rather than a silent reinterpretation.
- **The length prefix** makes `(purpose, identity_vk)` unambiguous. Without it,
  `("ab", vk)` and `("a", 'b' ‖ vk‑shifted)` would produce identical bytes, and
  a nonce ground for one would be valid for the other. Any time two
  variable-length fields are concatenated, one of them must be length-prefixed.
- **Binding the verifying key** means each `(purpose, identity)` pair is its own
  independent search space. You cannot grind once and hand the nonce to a
  friend, and you cannot move your nonce to a different purpose.

### 4.2 The work

```
digest = blake3(challenge_bytes ‖ nonce as u64 little-endian)
bits   = number of leading zero bits of digest        (0..=256)
```

BLAKE3 because it is fast, has a clean 32-byte output, and has good
implementations in both Rust and JavaScript (`@noble/hashes`). Leading zero bits
rather than a target threshold because it is trivially explicable — "how many
zeros at the front" — and each additional bit is exactly a doubling of expected
work.

**The bit count is never stored.** It is recomputed at verification time from
`(purpose, identity_vk, nonce)`, which are all in the proof. This is the single
most important structural decision in the primitive: because the claim is
derived rather than asserted, **it cannot be overstated**. There is no field a
liar could inflate. A proof either grades to N bits or it does not, and every
verifier computes the same N.

Expected tries to reach N bits is 2ᴺ. Because the grinder returns the *first*
nonce clearing the bar, roughly half of all proofs clear one extra bit for free.
This surprises users ("I asked for 18 and got 19") and is correct — the UI
should report achieved bits, not requested bits.

### 4.3 The proof

```rust
struct AnteProof {
    identity_vk: [u8; 32],   // Ed25519 verifying key
    purpose: String,         // 1..=256 bytes
    nonce: u64,              // the solution
    ts: u64,                 // producer wall-clock ms — untrusted, see §3
    signature: Signature,    // Ed25519 over the bytes below
}
```

The signature covers:

```
SIGNING_CONTEXT ‖ identity_vk ‖ len(purpose) as u32 le ‖ purpose
                ‖ nonce as u64 le ‖ ts as u64 le
```

with `SIGNING_CONTEXT = b"ante:proof-signature:v1"`.

**Why sign at all,** when the work is already bound to the key? Because without
a signature, a proof is *transferable*. Anyone who observes your proof could
attach it to their own message and claim it, since the work alone does not
demonstrate possession of the private key. The signature is what turns "this
work was done for this key" into "the holder of this key asserts this".

Signing `ts` inside the same blob means a timestamp cannot be tampered with
independently — not because `ts` is trusted, but because a proof should be one
atomic, non-malleable statement.

### 4.4 Verification

```rust
fn verify(&self, min_bits: u32) -> Result<u32, VerifyError>
```

Checks run cheapest-first, which is a deliberate DoS consideration for a
contract running on someone else's machine:

1. `identity_vk` parses as a valid Ed25519 point → else `MalformedKey`.
2. `purpose` is 1..=256 bytes → else `BadPurpose`.
3. One BLAKE3 hash for the bit count; `achieved < min_bits` → `InsufficientWork
   { have, need }`. **A cheap proof is rejected before any signature check.**
4. Ed25519 `verify_strict` → else `BadSignature`.

On success it returns the achieved bits, which is usually more useful to a
caller than a bare boolean (the guestbook uses it to sort entries into tiers).

`verify_strict` rather than `verify` — it rejects small-order public keys and
non-canonical signature encodings, closing the malleability classes that make
"same key, two valid signatures" possible.

`MAX_PURPOSE_BYTES = 256` exists to stop a hostile caller putting a megabyte of
text into a consent prompt or a stored proof.

### 4.5 What a proof does *not* bind — the sharpest footgun

A proof commits to `(identity_vk, purpose, nonce, ts)`. **That is the complete
list.** In particular it says nothing about the action it was minted for, and
this is the mistake we actually shipped.

The guestbook originally used one fixed `purpose` for every post. Three
consequences, none obvious in isolation and jointly fatal:

1. The challenge is `blake3(CONTEXT ‖ purpose ‖ vk)` — identical for every post
   by that author.
2. Grinding starts at nonce 0, so the *same search* runs every time. An author
   whose sequence happens to contain a high-bit nonce early re-finds it
   instantly, forever, for free. This is deterministic per identity: some
   authors are permanently lucky, others permanently unlucky.
3. Nothing tied the proof to the text, so that single proof validated an
   unlimited number of *different* messages.

It was never per-post proof of work. It was a one-time toll, and for a lucky
identity not even that. It surfaced as a user reporting "25 bits instantly" —
a number that was entirely real, and whose realness was the bug.

**The fix, and the general rule.** Fold whatever the proof must not be
transferable across into the purpose string:

```
purpose = "myapp:post:v1" ‖ ":" ‖ hex(blake3(len(name) ‖ name ‖ len(text) ‖ text)[..8])
```

with each variable-length field length-prefixed, for the same reason the
challenge layout prefixes `purpose` (§4.1). Every distinct message becomes its
own challenge and requires its own search.

This is the same mechanism §3 prescribes for freshness (`myapp:comment:2026-W12`).
The purpose string is the *only* place an application can express what a proof
is for, so the design question for any consumer is: **what could an attacker
re-use this proof for, and is that in the purpose?**

A per-identity *level* is the deliberate exception — `ante:identity-level:v1` is
fixed precisely because re-grinding it should re-find the same proof. You are
claiming a standing property, not paying for an action.

---

## 5. Architecture on Freenet

Freenet applications are built from three kinds of component, and knowing which
is which is most of the design.

| | **Contract** | **Delegate** | **Web app** |
|---|---|---|---|
| Runs | on untrusted peers | locally, in the user's kernel | in the browser |
| Holds | public shared state | private secrets | nothing durable |
| Propagates | yes, globally | **no, never** | shipped as contract state |
| Addressed by | `blake3(code_hash ‖ params)` | `blake3(code_hash ‖ params)` | `blake3(container_wasm ‖ publisher_key)` |

**Contracts** are closer to a database *table* than a database: the WASM defines
the schema and the rules; each parametrisation is an independent instance. State
must converge under a join-semilattice merge (§10).

**Delegates** are the local trust zone. They run in the user's own kernel, hold
secrets in a per-delegate encrypted namespace, and — critically — **do not
propagate**. A delegate is not published to the network; it is handed to a node
by an app that wants to use it. This is what makes them safe to give private
keys to: there is no mechanism by which the delegate or its secrets leave the
device.

That non-propagation has a consequence people find surprising: **every app that
wants to use a delegate must ship the delegate's bytes and register them on the
user's node.** Registration is idempotent and content-addressed, so ten apps
shipping identical bytes all end up talking to one delegate instance. §11 covers
what follows from this.

**The split ante uses:**

```
ante-core        the primitive + AnteProof + verify + the registry CRDT
                 no freenet-stdlib dependency — a verifier links only this
ante-delegate    key custody, consent prompt, signing, backup  (→ WASM)
contracts/
  ante-registry  published identity levels                     (→ WASM)
client/          @ante/client — the delegate embedded + a 2-call producer API
web/             the identity-management UI
examples/
  guestbook/     a standalone app showing the integration
```

`ante-core` having no Freenet dependency is not incidental. It means a verifier
— a contract, a CLI tool, a server, another project entirely — links a small
crate with five dependencies and gets the whole consumer side. The producer
side, which needs key custody and a consent UI and therefore needs Freenet, is a
separate crate that nobody has to link to check a proof.

---

## 6. The identity model

### 6.1 The tension

Goal 4 (proofs bound to a purpose, so they cannot be replayed across apps) and
goal 5 (work is portable, so you grind once) pull in opposite directions. There
are two coherent resolutions:

**Per-app identities.** The delegate derives a distinct key per calling app.
Apps cannot correlate a user across contexts — genuinely good for privacy. But
the work is not portable: every new app means grinding from scratch, and there
is no such thing as "this identity is established" because there is no *this
identity*, there are dozens.

**One shared identity.** The delegate holds a single key used everywhere. Grind
once, and any app can look up what you have demonstrated. But every app you use
sees the same public key and can correlate you.

### 6.2 What we chose, and why

**One shared identity.**

The deciding argument is that portability is the entire value proposition. A
per-app scheme delivers a proof-of-work tax with none of the accumulated benefit
— it is strictly worse than each app rolling its own puzzle, since it adds a
delegate for nothing. A user who has committed 24 bits should get credit for it
everywhere; that is what makes the commitment worth making.

Also, put plainly: **a normal person needs one identity.** A system whose mental
model is "you have an unbounded number of identities and cannot see any of them"
is not one an ordinary user can reason about, back up, or recover.

The privacy cost is real and we do not paper over it. Two mitigations:

1. **Consent is per-app and visible.** Every first spend from a new app raises a
   prompt naming the caller (§7). Correlation is not silent.
2. **Unlinkable commitment is a different mechanism.** An app that genuinely
   needs per-action anonymity should use raw per-post proof of work with an
   ephemeral key and not involve the delegate at all. ante does not pretend to
   cover that case.

The identity is stored at secret key `ante:identity:v1:primary` as a 32-byte
seed, generated from host entropy on first use. An all-zero seed is refused — if
the host CSPRNG has failed, a predictable identity key must never ship.

---

## 7. Consent

### 7.1 Why the delegate signs

The delegate could have handed the app a key. It does not, and the reason is the
whole point of having a delegate: an app that holds your key can spend it
whenever it likes, forever, including after you stop using it.

Instead: the app grinds (which needs only the *public* key, so it can run
anywhere — a Web Worker, off the delegate), then asks the delegate to sign. The
delegate raises a consent prompt showing the attested calling app, the purpose,
and the achieved bits. On approval it signs; on refusal it returns `Denied`.

This mirrors how ghost keys work, deliberately. The pattern — *the app supplies
the material, the delegate supplies the signature, the user authorises the
specific act* — is the established Freenet shape for key custody, and matching
it means users see a consistent model.

The prompt is raised by the **node's runtime**, not by the app. The app cannot
draw it, style it, or fake it, and the caller identity shown in the chrome is
runtime-attested rather than self-reported.

### 7.2 The round-trip

A consent request cannot be answered in one call, so it is parked:

1. The app sends `Commit { purpose, nonce, min_bits, ts }`.
2. The delegate **first checks the nonce clears `min_bits`** — so the user is
   never asked to approve a dud — then writes
   `Pending { request_id, origin_tag, action }` to its scratch context
   (host-held, ~10 min TTL) and emits `RequestUserInput`.
3. The node shows the prompt and **holds the request open** — up to exactly 60 s
   (`USER_INPUT_TIMEOUT` in freenet-core), then auto-denies. There is no
   intermediate response: the app's single reply carries the post-approval
   outcome. A client must therefore wait past 60 s; ante's waits 75 s.
4. The click returns as `UserResponse` on a later invocation. The delegate
   checks two things before acting:
   - **which** question — `request_id` matches the parked prompt. On mismatch
     it errors *without clearing the context*, so a stray or guessed id cannot
     knock down a real pending prompt.
   - **whose** question — the answering origin matches the parked `origin_tag`.
     A genuine answer is fed back through the same invocation chain that raised
     the prompt, so it always arrives under the same attested origin. Anything
     else is someone answering a dialog that was not theirs.
5. It clears the context and performs the action.

Three request types share this machinery: `Commit`, `ExportIdentity`,
`ImportIdentity`. They use **distinct button vocabularies** — `Allow` /
`Always allow` / `Deny` for a commit, `Reveal` / `Cancel` for an export,
`Import` / `Cancel` for an import — so an answer intended for one action can
never be read as approval of another.

### 7.3 "Always allow" grants

Prompting on every single commit is correct and unusable. An app that posts
comments would prompt per comment.

The resolution is the one browsers and ghost keys converged on: the first commit
from an app prompts with a third option, **Always allow**. Choosing it records
the runtime-attested `origin_tag` in `ante:grants:v1`; subsequent commits from
that origin sign with no prompt until revoked. `Allow` signs once and records
nothing.

We considered and rejected "skip the prompt when the caller is the same contract
as last time" — it is an implicit grant the user never made and cannot see. A
grant must be an affirmative choice, listed somewhere, and revocable. The web UI
has a "Connected apps" panel that does exactly that.

Because the origin tag is runtime-attested, a grant cannot be claimed by an app
that was not granted it.

---

## 8. Backup and recovery

This section exists because of a failure we hit in production, and it is the
most instructive part of the project.

### 8.1 The failure

Identities kept disappearing. Every so often the user's identity would reset and
a fresh one would appear in its place.

The obvious suspect was the delegate re-keying (§12) — but the delegate build
was verified byte-reproducible and its key was stable. The actual cause was one
layer down:

- The identity seed lives in the node's encrypted secret store, at
  `<data>/db/local/`.
- It is encrypted with a per-delegate DEK, derived `HKDF-SHA256(node KEK,
  delegate_key)`.
- The node KEK lives in a file, `<data>/secrets/local/node_kek`.

**Lose either directory and every delegate's secrets become undecryptable.** The
delegate cannot tell the difference between "your secret is unreadable" and "you
have no secret", so it does the only thing it can: mints a new identity.

In this case the node ran in Docker and a redeploy was dropping the volume. But
the general shape is what matters: **the identity was a single copy of an
unrecoverable secret, held in storage the user did not control and could not
inspect.** That is a design flaw regardless of what wiped the volume.

There is a platform mechanism for exactly this — `RegisterDelegateWithPredecessors`,
which copies secrets forward from a named predecessor delegate — but its
copy-forward path is **currently disabled in freenet-core** for a security
reason (the registering origin is forgeable, so it could be used to steal
another delegate's secrets). We could not rely on it.

### 8.2 The fix

Two new prompting requests:

- **`ExportIdentity` → `IdentitySeed { seed }`.** Reveals the raw 32-byte seed
  so the user can save it. Always prompts; this is the one operation that
  exposes the private key, and the prompt says so in those words.
- **`ImportIdentity { seed }` → `Imported { verifying_key }`.** Sets the seed,
  restoring a backup on a new node or after a wipe. Always prompts. If an
  identity already exists the prompt names both the incoming and outgoing
  fingerprints and warns the current one will be forgotten; on approval its
  "always allow" grants are cleared, because consent given for one identity does
  not transfer to another. Re-importing the seed you already have is a silent
  no-op.

The seed is surfaced as a **recovery code**:

```
"ante-" ‖ base58( seed(32 bytes) ‖ blake3(seed)[0..4] )
```

The 4-byte checksum catches a typo or a truncated paste *before* it is imported
as a different key — a failure that would otherwise be silent and permanent. The
client can also derive the fingerprint from a code without importing it, so a UI
can show "this restores identity `7Kx…`" before the user commits.

### 8.3 The trade, stated honestly

An exportable key is a phishable key. Ghost keys deliberately make theirs
non-exportable, and that is defensible for a credential that cost money.

For ante it is the wrong call. The identity is low-stakes by construction — it
represents CPU time, not money or personhood — and the realistic threat is not
"someone phishes my guestbook identity", it is "my node's storage got wiped and
I lost my accumulated level for the third time". Between those two, recoverable
wins, and it is not close.

The controls are: a prompt that names the operation in plain language, a
warning that anyone holding the code controls the identity, and the fact that
the code is shown only on explicit request.

---

## 9. Phase 1 in full: the request protocol

Everything an app can ask the delegate. CBOR-encoded, carried in the payload of
a Freenet `ApplicationMessage`.

| Request | Prompts | Response |
|---|---|---|
| `GetIdentity` | no | `Identity { verifying_key }` — creates one on first use |
| `Challenge { purpose }` | no | `Challenge { bytes }` — the exact preimage to grind |
| `Commit { purpose, nonce, min_bits, ts }` | **yes**¹ | `Committed { proof }` or `Denied` |
| `ListGrants` | no | `Grants { origins }` |
| `RevokeGrant { origin }` | no | `Revoked` — `None` revokes all |
| `ExportIdentity` | **yes** | `IdentitySeed { seed }` or `Denied` |
| `ImportIdentity { seed }` | **yes** | `Imported { verifying_key }` or `Denied` |

¹ unless the origin holds an "always allow" grant.

Any request can return `Error { message }`.

`Challenge` exists so a client never has to reimplement the domain-separation
layout. The layout lives in Rust, in one place; the client asks for bytes and
hashes them. This is why the TypeScript grinder cannot drift from the Rust one
in the part that matters.

The typical flow is three calls and one worker:

```
GetIdentity  → vk                    (once, no prompt)
Challenge    → bytes                 (per purpose, no prompt)
   grind blake3(bytes ‖ nonce_le) off-thread
Commit       → AnteProof             (prompt, or silent if granted)
```

---

## 10. Phase 2: the registry

Phase 1 gives an app a proof per action, ground on demand. That is enough, but
it means every app that wants to know "is this identity established" triggers a
fresh grind.

The registry is a contract holding, per identity, the best proof it has
published for one canonical purpose (`ante:identity-level:v1`). An identity
grinds once and publishes; any app reads a level with a plain contract GET and
no grind at all.

```rust
struct RegistryParameters { purpose: String, min_bits_floor: u32 }
struct RegistryState      { levels: BTreeMap<[u8; 32], AnteProof> }
struct RegistryDelta      { proofs: Vec<AnteProof> }
struct RegistrySummary    { bits: BTreeMap<[u8; 32], u32> }
```

### 10.1 The merge, and why it converges

Freenet replicas converge only if the merge is a **join-semilattice**:
associative, commutative, and **idempotent**. Delivery is at-least-once and
unordered, so the same update *will* arrive twice; a merge that changes state on
re-application never settles.

ante's merge is, per identity, a maximum:

- more bits wins;
- on a tie, the lexicographically greater signature wins.

Both are pure functions of the proofs involved, so every peer picks the same
winner regardless of arrival order. The tie-break is not cosmetic: without a
total order, two peers holding two equally-strong proofs for one identity would
each keep their own and heal forever.

The result is **monotonic** — an identity raises its level and can never lower
it, which is also what makes it safe to cache.

Every stored proof is re-verified on read (`level()` returns `None` for a proof
that no longer verifies), so a corrupted or hand-crafted state cannot inflate
anyone's level. `is_well_formed` additionally checks each proof is filed under
its own key.

Six tests pin the laws directly: `merge(A,A) == A`, a delta applied twice,
associativity over three states, order-independent tie-breaking, and an empty
delta to a converged peer.

Beyond the tests, both contracts are checked with `fdev verify-merge`, which
runs the same verifier the network runs against the compiled WASM
(`scripts/verify-merge.sh`). Current result: **86 cases, 86 held, zero
violations** for each — enforceable and diagnostic alike. Its one earlier
finding is worth recording, because it is the kind of thing tests do not catch:
`get_state_delta` returned ~10 bytes of CBOR framing to an already-converged
peer instead of nothing. Harmless per exchange, but it ships on every
anti-entropy heartbeat between every pair of converged peers, forever. Both
contracts now return a literally empty `StateDelta`, and both accept one on the
apply side — which is the half that is easy to forget, since an empty buffer is
not valid CBOR.

### 10.2 A known scaling limit, stated plainly

`RegistrySummary` is **linear in the number of registered identities**, and a
summary ships to every interested peer on every anti-entropy heartbeat (~5 min)
whether or not anything changed. Measured at ~64 bytes per entry with
realistic keys — ciborium encodes `[u8; 32]` as an array of 32 integers, and
~91% of random bytes cost two bytes each, so one key alone is ~63:

| identities | summary |
|---|---|
| 1 000 | ~64 KB |
| 10 000 | ~644 KB |

(Measure this with realistic keys, never `0..N`: small integers encode in one
byte and understate the cost by a third. That mistake has shipped before.)

Fine at the scale this was built for; untenable past roughly 5 000 identities.

The fix is known and standard: replace the flat map with K fixed buckets, each
holding a digest of that bucket's contents, making the summary constant-size.
`get_state_delta` then returns a *superset* of the true delta, which is sound
here precisely because `admit` is idempotent. It is deferred only because
changing this type re-keys the contract and strands every published level, so it
should be batched with any other wire change rather than shipped alone.

We are documenting this rather than fixing it because an undocumented scaling
cliff is a trap, and a documented one is a decision.

---

## 11. Distribution: vendored, not pointed at

How does an app find the ante delegate?

The general Freenet advice for building on someone else's app is: **do not
hardcode their key.** It is `blake3(code_hash ‖ params)`, so it moves on every
re-key of theirs — including a bare version bump — and the failure is silent:
every read comes back looking like "this user has nothing stored". The
recommended fix is to resolve an author-signed pointer at runtime, or failing
that read the key out of their published webapp bundle (which is what ghost keys
does today).

**ante sidesteps this entirely: the consumer does not look up an external
delegate at all.** `@ante/client` *contains* the delegate WASM; `AnteClient.attach()`
registers those bytes on the user's node. The delegate takes no parameters, so
its key is simply `blake3(blake3(wasm))` — and the app already has the wasm, so
it computes the key locally. No pointer, no bundle-scraping, no stale constant.

This is a different relationship than ghost keys has with its consumers. Ghost
keys is a standalone installed *app* that third parties talk to. ante is a
*library* you vendor and version-pin through your package manager.

**The consequence, which must be understood:** the identity is shared across
every app shipping the *same* `@ante/client` version. Same wasm → same delegate
→ same secret namespace. Apps on different versions see the user as two
different identities. This makes the delegate's byte-stability not a hygiene
concern but a compatibility contract, which is §12.

The alternative — one canonical delegate instance that ante operates and
upgrades centrally, resolved via a pointer — was considered and rejected. It
reintroduces exactly the failure the general advice warns about: ante could
re-key underneath every consumer, silently, at a time of its choosing. Vendoring
gives the app control over when it moves.

---

## 12. Content addressing and the re-key problem

This is the sharpest edge in the entire system.

A delegate's key is `blake3(blake3(wasm) ‖ params)`. It is the **namespace every
user's identity is stored under**. If the WASM changes by one byte, the key
changes, and every identity stored under the old key becomes unreachable. The
delegate cannot detect this — from its perspective there simply is no stored
identity — so it silently mints a new one.

The same applies to contracts: a contract's address *is* its bytes, so a rebuild
that changes them strands all existing state.

### 12.1 How little it takes

We measured this, and the result is worse than expected:

> **Adding a single comment line to `ante-core/src/lib.rs` changes the delegate
> key.**

`panic!` and `expect` bake `line!()` into the binary as part of their panic
location. `to_cbor`'s `expect("CBOR serialization cannot fail")` sits near the
top of `lib.rs`, and the delegate calls `to_cbor` on every reply. Shift that
line and the constant changes, so the WASM changes, so the key changes.

A corollary discovered the same way: **`wasm-opt` must not be run** on artifacts
whose bytes are their address, at least not conditionally. It is deterministic
only for a fixed version, so "is binaryen installed, and which one" becomes a
machine dependency baked into every identity namespace — a laptop and a CI
runner would disagree about the delegate's identity. The ~15% size saving is not
worth that. If size ever matters, pin a version and make it a required step, not
an optional one.

### 12.2 What we do about it

**A limit worth stating plainly.** "Reproducible" here means *same-path*
reproducible. Two copies of one commit, at two directories, with the same rustc
and the same flags, produce WASM of identical size and identical strings but
different bytes — cargo hashes a path dependency's absolute path into
`-C metadata`, which reorders symbols and rodata, and `ante-core` sits beside
each artifact rather than inside it. No `--remap-path-prefix` reaches it,
because the flags are not what carries the path; the package identity is.

That is enough to catch an accidental re-key, which is the failure that hurts.
It is not enough for a third party to rebuild and confirm the published bytes.
Getting there requires building at a fixed absolute path — a container with a
fixed `WORKDIR` — and is listed in §16.

Three defences, all automated:

1. **Committed per-crate `Cargo.lock`** for the delegate and each contract, so a
   workspace-wide `cargo update` cannot silently change their dependency
   versions. They are separate workspace roots for this reason alone.
2. **Path remapping** (`--remap-path-prefix`) so absolute paths from the build
   machine do not end up in the binary, plus a grep of the output that *fails
   the build* if any leaked. Without this, a laptop and a CI runner produce
   different keys for identical source.
3. **A committed key record.** `artifact-keys.toml` holds the
   current `code_hash` and `key`. `scripts/check-keys.sh` fails when the
   build disagrees, and CI runs it. A re-key is then a **reviewable diff**
   someone had to opt into with `ANTE_ACCEPT_REKEY=1`, not a surprise.

CI additionally builds the delegate twice from clean and compares hashes, so a
build that is not byte-stable fails there rather than in production.

### 12.3 The upgrade path

Since `RegisterDelegateWithPredecessors` copy-forward is disabled upstream, a
deliberate delegate upgrade today is:

1. Tell users to save their recovery code **before** upgrading.
2. Ship the new delegate; each user's identity appears to reset.
3. Each user restores from their code.

Manual, but bounded and honest. When the platform's copy-forward is re-enabled,
wiring the existing seed export/import into a `SecretTransport` implementation
would make it automatic — the mechanism is already there, it just needs a
different transport.

The general rule that falls out of all of this: **treat `ante-core` and
`ante-delegate` as frozen between deliberate releases, and batch changes.** A
release that re-keys should carry every pending re-keying change at once, since
the second one is free.

---

## 13. Integration, and what it should feel like

The test of the design is what a consuming app has to do. The reference is
`examples/guestbook/` — a standalone Freenet app where every post carries a
proof, entries are bucketed by committed bits, and each proof is re-verified
before display.

It is deliberately split so the boundary is visible:

| file | ante? | what it is |
|---|---|---|
| `web/src/guestbook.ts` | **none** | CBOR wire types, contract GET, delta UPDATE — what a client for *any* contract looks like |
| `web/src/ante.ts` | **all of it** | attach, commit, verify |
| `web/src/main.ts` | glue | form → proof → contract write |
| `contract/src/lib.rs` | one line | `proof.verify(params.min_bits)?` |

**Four call sites, total:**

```ts
const ante = await AnteClient.attach(fn);              // once

const outcome = await ante.commit("myapp:post:v1", {   // per action
  minBits: 16,
  onProgress: (tried, hps) => showRate(tried, hps),
});

cborEncode({ name, text, proof: anteProofToCborValue(outcome.proof) });

verifyAnteProof(entry.proof, 16);                      // per displayed item
```

and in the contract:

```rust
if self.proof.purpose != params.purpose { return Err("wrong purpose".into()); }
self.proof.verify(params.min_bits).map(|_| ()).map_err(|e| format!("{e}"))
```

`min_bits` and `purpose` are contract **parameters**, so the anti-spam policy is
fixed at publish time and is part of the contract's address. It cannot be
lowered after the fact by whoever happens to be writing.

An earlier plan folded the guestbook into the main ante UI as a second view.
That was wrong: an example that shares a codebase with the thing it demonstrates
teaches nothing about integrating, because all the hard parts are already
wired. Making it standalone forced the extraction of `@ante/client`, which is
what made the producer API two lines instead of a page of copy-paste.

### 13.1 Cross-implementation pinning

There are two independent implementations of the verifier — Rust
(`ante-core`) and TypeScript (`client/src/ante-proof.ts`) — and they must agree
byte for byte forever.

They are held together by a **single pinned test vector**: a fixed seed,
purpose, and timestamp produce a fixed challenge preimage and a fixed CBOR
encoding, both hardcoded in a Rust test and a TypeScript test. If either side
drifts, a test fails. `cargo run -p ante-core --example print_vector`
regenerates it after a deliberate change.

The guestbook does the same thing one level up: the exact CBOR of a single-entry
delta is pinned on the Rust side and matched by a TypeScript round-trip test, so
a browser post is provably a delta the contract accepts.

---

## 14. Environment lessons

Things that cost real time, recorded so they cost nobody else any.

**The gateway sandbox is stricter than a normal page.** A Freenet webapp is
served into a sandboxed iframe with an *opaque origin* (no `allow-same-origin`)
and a CSP of roughly `default-src {origin} 'unsafe-inline' 'unsafe-eval' blob:
data:`. Consequences:

- **Separate-file Web Workers are blocked.** `new Worker('/assets/worker.js')`
  fails. The fix is an inlined blob worker — with Vite, `import W from
  './worker?worker&inline'`, because the CSP does allow `blob:`.
- **`localStorage` throws**, it does not return null. Any access must be inside
  `try`/`catch`, and a design that depends on persistence in the page is a
  design that does not work here.
- **The async Clipboard API is not granted.** A copy button needs the
  `document.execCommand('copy')` fallback via a temporary textarea.

**`fdev` specifics.** `fdev publish --parameters` takes a *path to a file* of
raw bytes, not a hex string. `fdev website update ./dir` publishes the directory
as-is — point it at `dist/`, not the project root, unless you want to publish
`node_modules`. `fdev website` is the built-in stable-URL container: the URL is
`blake3(container_wasm ‖ your_publisher_key)`, neither of which contains your
content, so **your app has one permanent URL and is upgraded in place**. Do not
design around a rotating URL. Back up the key file; losing it means never
updating that URL again.

**Pure-JS BLAKE3 is ~100k hashes/sec**, not the GB/s of a native build. This
sets the practical ceiling on interactive grinding: ~18 bits is a second or two,
~20 is around ten seconds, ~24 is a minute or more. The inner loop must avoid
per-iteration allocation — one input buffer, rewrite only the 8 nonce bytes —
which is worth roughly 2–3×. Any UI copy about timings should be measured, not
guessed.

**`RegisterDelegate`'s `cipher` and `nonce` fields are ignored** by current
freenet-core (since #4140 the per-delegate DEK is derived from the node's own
KEK). They remain in the wire format for compatibility. Do not send a fresh
random value per call anyway — on any node that still honours the field, that
would strand every secret. Send something stable.

---

## 15. Threat model

**What an attacker can do, and what stops them.**

| Attack | Defence |
|---|---|
| Reuse a proof in another app | `purpose` is bound into the challenge *and* the signature |
| Claim someone else's proof | the signature proves possession of the private key |
| Overstate the work done | bits are recomputed from the nonce, never stored |
| Tamper with nonce / ts / purpose | all covered by the signature |
| Replay one signed entry verbatim | app-level: the guestbook keys entries by `blake3(vk ‖ nonce ‖ text)`, so replays collapse to one |
| **Reuse one proof for a different message** | app-level, and easy to get wrong — see §4.5. The proof binds `(identity, purpose, nonce)` and nothing else, so the app must fold the message into `purpose` |
| Answer someone else's consent prompt | the answering origin must match the parked, runtime-attested origin tag |
| Knock down a pending prompt with a guessed id | id mismatch errors *without* clearing the parked state |
| Get a proof without the user noticing | every first spend per app prompts; grants are explicit, listed and revocable |
| Extract the private key | it never leaves the delegate except through `ExportIdentity`, which always prompts |
| Claim an app's grant | the origin tag is runtime-attested, not self-reported |
| Serve fake state, or phish a recovery code, under the genuine app's address | no published page reads an address from the URL — see below |
| Inflate a level in the registry | every stored proof is re-verified on read |
| Lower someone's level | the merge is monotonic |
| Grind cheaply and flood | **not defended** — app policy (`min_bits`, per-author caps) |
| Mint many identities | **not defended, by design** |
| Outspend the bar with real hardware | **not defended, by design** — raise the bar or require a ghost key |

**Trust assumptions.** The user trusts their own node (it holds the secret store
and draws the consent prompts). The consumer trusts nothing — verification is
self-contained. No party is trusted to report work honestly, because nobody
reports work; it is recomputed.

### An address must never come from the URL

A Freenet app's address is its strongest signal: content-addressed code, a
permanent URL, a publisher key nobody else holds. A query parameter that
repoints anything throws that away while keeping the appearance of it.

We shipped three and removed them all:

- `?contract=` — a link to the genuine guestbook, at its genuine address,
  showing data the sender controls.
- `?node=` — worse. The node is the whole trust root: it holds the secret
  store and it *draws the consent prompts*. Repointing it means the attacker
  serves the state and renders the dialog asking you to approve things.
- `?vault=` — worst. It aimed the app's own *"back up your key"* link, so a
  link to the real guestbook could deliver someone to a clone that asks them to
  paste their recovery seed.

Every address is now fixed at build time. `?node=` survives only in `vite dev`
builds, gated on `import.meta.env.DEV` and verifiably dead-code-eliminated from
published bundles (`grep 'get("node")' dist/assets/*.js` → zero).

**The pointer is the published bundle, and its update authority is the
website's publisher key.** Changing where an app reads from requires
republishing the site, which only the key holder can do. A separate signed
pointer contract would rest on that same key, so it adds a moving part without
adding a guarantee; it earns its place only when the target must change without
a site republish, or when third-party apps need to discover the contracts
themselves.

---

## 16. Open problems and what we would do next

Roughly in priority order.

1. **Automatic secret carry-forward across a delegate re-key.** Today the user
   restores manually from a recovery code. When freenet-core re-enables
   copy-forward, wire the existing export/import into a `SecretTransport`.
2. **Bucketed registry summaries** (§10.2), before the registry exceeds a few
   thousand identities. Batch with any other wire change.
3. **Freshness.** `ts` is unauthenticated and always will be. If apps start
   caring, the supported answer is epoch-in-purpose
   (`myapp:comment:2026-W12`) — worth making a first-class helper rather than
   documentation.
4. **Hardware calibration.** 20 bits means less every year. A "bits, discounted
   by year" helper would let consumers express policy in stable terms.
5. **Unlinkable per-action proofs.** For apps that want the cost without the
   correlation: ephemeral key, raw proof, no delegate. It is a different
   mechanism sharing the same primitive, and the primitive already supports it.
6. **Memory-hard puzzles.** BLAKE3 favours anyone with a GPU. Argon2 or
   similar would flatten the attacker/user gap considerably. The cost is a much
   more expensive verification, which a contract may not be able to afford —
   worth measuring before deciding.
7. **Carry-forward migration, before 1.0.** Today a re-key strands the
   contract's state: your identity survives (recovery code) but your published
   level does not, because it lived in a registry instance that moved. Fine in
   beta; not shippable at release, since "never update" is not an option and
   neither is losing data.

   The ecosystem answer is
   [`freenet-migrate`](https://github.com/freenet/freenet-migrate), which
   packages what River and Delta each hand-rolled: a committed predecessor
   registry, build-time hash validation with a CI guard, and a **sans-IO
   backward-probe** the app drives — designed that way precisely because
   "browsers have no request/response correlation". It builds for wasm32, so a
   TypeScript UI can drive it through the adapter it already expects.

   ante needs only part of it. Carry-forward normally means folding an opaque
   state and hoping the validator catches problems; **ante's state decomposes
   into independently-valid `AnteProof`s**, so migration is just resubmitting
   them through the normal delta path, which re-validates every one via
   `admit`. No `ComposableState`, no merge-then-verify — and permissionless,
   since nothing unverified can enter. What is worth taking from the crate is
   the probe's *decision* logic, which is the subtle part: silence is not
   absence, and "`NotFound` is not proof either, and on this network it is
   wrong more often than it is right."

   Crucially the probe is client-side, so adopting it **re-keys nothing**.

   The half that cannot wait, and is done: the **lineage**. Every superseded
   generation is recorded automatically — code hashes into `artifact-keys.toml`
   by `check-keys.sh` on an accepted re-key, instance ids into
   `deployments.json` by the publish scripts. A predecessor that was never
   recorded is state no migration can reach, and reconstructing one later means
   git archaeology against builds that are only same-path reproducible. That is
   why it accumulates as a side effect of the rituals rather than depending on
   anyone's memory.

8. **A fixed-path (containerised) build**, so a third party can rebuild the
   delegate and confirm the published key. Today the build is only same-path
   reproducible (§12.1), which catches accidental re-keys but does not let
   anyone verify the shipped bytes independently. A `Dockerfile` with a fixed
   `WORKDIR` is the whole fix.
9. **`fdev verify-merge` in CI.** It runs today via `scripts/verify-merge.sh`
   and passes cleanly, but CI does not install `fdev`, so it is a pre-publish
   step rather than a per-commit gate.
10. **Memory-hard puzzles** — see item 6 above; kept separate because it changes
   the primitive rather than the packaging.

---

## Appendix A: Constants

```
CHALLENGE_CONTEXT      b"ante:pow-challenge:v1"
SIGNING_CONTEXT        b"ante:proof-signature:v1"
MAX_PURPOSE_BYTES      256
IDENTITY_LEVEL_PURPOSE "ante:identity-level:v1"

challenge_bytes  = CHALLENGE_CONTEXT ‖ len(purpose) u32le ‖ purpose ‖ identity_vk
digest           = blake3(challenge_bytes ‖ nonce u64le)
bits             = leading zero bits of digest
signing_bytes    = SIGNING_CONTEXT ‖ identity_vk ‖ len(purpose) u32le ‖ purpose
                                   ‖ nonce u64le ‖ ts u64le
fingerprint      = bs58(identity_vk[0..8])
recovery code    = "ante-" ‖ base58(seed(32) ‖ blake3(seed)[0..4])

delegate secret keys
  ante:identity:v1:primary   the 32-byte identity seed
  ante:grants:v1             CBOR { origins: [origin_tag] }
  ante:prompt-seq:v1         u32 le, monotonic prompt id counter

origin_tag       "webapp:" ‖ contract_instance_id   (32 bytes)
                 "delegate:" ‖ delegate_key
                 "unattested" | "unknown-origin"

delegate key     blake3(blake3(wasm) ‖ params), params empty
node timeouts    USER_INPUT_TIMEOUT 60 s; DELEGATE_CONTEXT_TTL ~10 min
client waits     75 s for a prompting request, 15 s otherwise

guestbook example
  entry key      blake3(identity_vk ‖ nonce u64le ‖ text)
  MAX_NAME_BYTES 40,  MAX_TEXT_BYTES 500
  tiers          16–19 / 20–23 / 24–27 / 28+, newest first within a tier
```

All multi-byte integers in hand-rolled preimages are **little-endian**. All
structured payloads are **CBOR** (ciborium), with struct fields in declaration
order; `[u8; N]` encodes as a CBOR *array* of N integers, not a byte string.
Maps in state and summaries must be `BTreeMap`/`BTreeSet` — never `HashMap` —
because peers compare state bytes to decide convergence, and a nondeterministic
ordering makes identical states look different forever.

## Appendix B: Pinned test vector

Any reimplementation must reproduce these exactly.

```
seed            2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a
verifying key   197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61
purpose         ante:identity-level:v1
ts              1726000000000
nonce           35609
achieved bits   16

challenge_bytes
616e74653a706f772d6368616c6c656e67653a763116000000616e74653a6964656e746974
792d6c6576656c3a7631197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa
8b3d368d61

AnteProof, CBOR
a56b6964656e746974795f766b98201819187f186b182318e1186c1885183218c618ab18c8
183818fa18cd185e18a7188918be0c187618b2189203183403189b18fa188b183d1836188d
186167707572706f736576616e74653a6964656e746974792d6c6576656c3a7631656e6f6e
6365198b196274731b00000191dd9dec00697369676e6174757265984018f6188b07189c18
d5182b184518e8187f185e187118a418e618cc189e18ff1897185f189e1838188018ef186d
1860188f18c50f18de18e618f118de186e189d186518510f1834182f189a1869189e0d18d0
185a18cc189a188418ad14184b187e184a18bc186e1858121872189718ea18ad182718e418
970a
```

Note the CBOR: `98 20` is a 32-element *array* (major type 4), which is how
ciborium encodes `[u8; 32]` — not `58 20`, a byte string. Getting this wrong is
the most likely reimplementation error.

## Appendix C: Repository map

```
ante-core/            the primitive, AnteProof, verify, the registry CRDT
  src/pow.rs            challenge layout, digest, bits, grind
  src/proof.rs          AnteProof, verify, the pinned wire-format test
  src/protocol.rs       the app ⇄ delegate request/response enums
  src/registry.rs       the CRDT + merge-law tests
  src/testvec.rs        the canonical cross-implementation vector
ante-delegate/        the delegate (→ WASM)
  src/identity.rs       seed custody, export/import, origin tags
  src/consent.rs        the prompt round-trip for all three prompting requests
  src/grants.rs         "always allow"
  src/env.rs            host seam + in-memory double for native tests
  delegate-key.toml     the committed key record (§12.2)
contracts/ante-registry/   thin #[contract] shell over ante-core::registry
client/               @ante/client — the delegate embedded + the producer API
  src/ante.ts           AnteClient: attach, commit, export, import, grants
  src/ante-proof.ts     the TypeScript verifier (pinned against Rust)
  src/pow.ts            the grinder;  src/pow-worker.ts  runs it off-thread
  src/recovery.ts       the recovery code codec
  src/cbor.ts           a CBOR codec matching ciborium
  src/freenet.ts        node WebSocket, contract GET/UPDATE
web/                  the identity-management UI
examples/guestbook/   a standalone app: contract + web + README
scripts/              build, sync, publish, and the key guard
```

---

*Written alongside the implementation, not after it. Where this document and the
code disagree, the code is what shipped — but the reasoning here is why.*
