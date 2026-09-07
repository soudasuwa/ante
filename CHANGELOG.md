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
