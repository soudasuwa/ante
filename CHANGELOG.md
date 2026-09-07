# Changelog

## v0.1.0 — 2026-09-07

First public release. Beta: the design is settled and the data-loss paths are
closed, but it has not been used by anyone but its authors.

### What it is

A mandatory proof-of-work commitment for Freenet identities. An app asks a
user's ante delegate for a signed `AnteProof`: evidence that this identity
burned a measurable slice of CPU **for this specific action**. Verifying costs
one blake3 hash and one signature check.

It is the step between *no effort at all to sybil* and *needs a ghost key*. A
proof shows a key cost something. It does **not** show the key is unique,
human-held, or not one of many an attacker made — see `DESIGN.md`.

### Consent comes before the cost

An app asks `RequestGrind { purpose, min_bits }` and the node prompts *before*
any work happens: "<app> wants to spend some of this device's CPU, at least 18
bits (a few seconds), for <purpose>. Nothing spent yet." Approving parks a
single-use authorization, so the `Commit` that follows does not ask again.

The delegate still does not grind — it is a single-threaded message loop, and a
minute of hashing inside it would block the node's contract executor. Only the
decision moved. What that buys: refusing is free, the choice arrives before the
expense rather than after it, and the prompt can describe a cost in seconds
instead of asking about one already sunk.

Scoped to `(origin_tag, purpose, min_bits)` and consumed on use. One app cannot
spend another's approval, an approval for one message cannot sign a different
one, and the bar shown in the prompt is the bar it authorises. Single-use rather
than expiring because the delegate has no clock — `ts` is caller-supplied, so any
expiry would be a number the caller chooses.

`Commit` still prompts on its own when nothing was authorised, so an app that
never calls `RequestGrind` keeps working.

### Everything starts empty

Both contracts were reset at launch, to `ante-guestbook:post:v2` and
`ante:identity-level:v2`. Freenet state is a grow-only CRDT — there is no delete
— so a new address is the only clean slate. These are parameter changes, not
code changes, so no WASM moved and no key was re-keyed.

Every predecessor list is deliberately empty, which is the opposite of the usual
rule. The carry-forward sweeps work, and would have faithfully restored the
pre-release test posts and test identity levels the reset existed to drop. So
nothing published before launch is reachable by the apps: it remains at its old
address, readable by anyone who knows it, and is no longer swept forward.

### Live on Freenet

Three apps, addresses in `DEPLOYMENTS.md`: the **home** page, the **vault**
(create an identity, raise its level, manage which apps may use it, save a
recovery code), and a **guestbook** showing an end-to-end integration.

### Verifiable builds

Every address is derived from bytes, so the published artifacts can be checked
by anyone:

```bash
./scripts/build-in-container.sh --check
```

A fixed-path container build, compared against `artifact-keys.toml`, run by CI
on every push. This matters more than it sounds: before it existed, the record
could only be verified on the machine that produced it, and it had drifted to
keys that no clean build reproduced.

### Data survives updates

Changing a contract or the delegate changes its address, which strands
everything stored at the old one. Three mechanisms close that, all exercised
against real published generations rather than only in tests:

- **Contract carry-forward.** Registry levels and guestbook posts are swept from
  superseded generations on load. A predecessor that does not answer is recorded
  *unresolved*, never *empty* — silence is not absence — so the sweep repeats
  until every generation has genuinely answered.
- **Stranded-identity recovery.** An identity left behind by a delegate re-key
  is detected automatically and can be adopted, behind two consent prompts. The
  probe (`HasIdentity`) is a pure read; it never creates.
- **Recovery codes.** `ante-` + base58 of the seed and a checksum, so an
  identity survives losing the node entirely.

### Known limits, stated rather than fixed

- The registry summary is linear at ~64 bytes per entry. Comfortable to roughly
  5,000 identities; past that it needs bucketed digests, which is a wire change
  and therefore a re-key.
- `ts` in a proof is client-supplied and unauthenticated. Apps needing freshness
  should put an epoch in the purpose string (`myapp:comment:2026-W12`).
- blake3 favours anyone with a GPU. A memory-hard puzzle would narrow the gap at
  the cost of much more expensive verification.
- Proofs from one identity are linkable across apps by design — that is what
  makes a level portable. Unlinkable per-action proofs are a different mechanism
  the primitive already supports.

### Security

Report privately — see `SECURITY.md`. Not through public issues.
