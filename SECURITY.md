# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability** — especially not
one that could be exploited against deployed ante delegates or the published
registry / website contracts.

Instead, use GitHub's private vulnerability reporting:
**[Security → Report a vulnerability](https://github.com/soudasuwa/ante/security/advisories/new)**
on this repository.

If that is unavailable, email **alessandro@delass.ee** with `ante security` in
the subject.

Please include: what you found, how to reproduce it, and the impact you think
it has. A proof-of-concept helps but is not required.

## Scope

In scope:

- `ante-core` — the proof primitive and verifier (signature bypass, work
  overstatement, purpose-binding escape, CBOR parsing).
- `ante-delegate` — key custody and the consent round-trip: prompt spoofing,
  answering another origin's prompt, or reaching the identity seed **without**
  the `ExportIdentity` prompt. Export and import deliberately move the seed, so
  the bug class there is "the seed moved and the user was never asked", or "the
  prompt described one action and a different one ran".
- `@ante/client` — issuing `ExportIdentity` / `ImportIdentity` the user did not
  initiate, or a recovery code that decodes to a key other than the fingerprint
  shown next to it.
- `contracts/ante-registry` — admitting an invalid or overstated proof,
  lowering a level, breaking convergence.
- The TypeScript verifier (`client/src/ante-proof.ts`) drifting from
  `ante-core`.

Out of scope (documented non-goals — see [DESIGN.md](DESIGN.md)):

- Resisting an attacker with significant CPU / a botnet. ante is a cost floor,
  not personhood.
- One person minting many identities (each costs the same).
- Denial of service by flooding a contract with valid-but-cheap proofs — that
  is the consuming app's policy (`min_bits`, per-author caps).
- Anything downstream of a leaked recovery code. It *is* the identity, by
  design; the prompt before revealing it is the control.
- Node-level secret storage. If the node's secret store or KEK is lost or
  read by someone else, that is a Freenet/operator concern — ante's answer is
  the recovery code, not a second layer of encryption.

## What "fixed" looks like

A wire-format change to `AnteProof` is breaking for every proof already stored
anywhere, so a fix there ships as a new `purpose`/version rather than a silent
reinterpret. The pin tests (`ante-core::proof::cbor_wire_format_is_pinned`,
`client/test/ante-proof.test.ts`) are the tripwire.

A fix inside the delegate re-keys it (`blake3(wasm)`), which strands every
identity stored under the old key. Users must be told to save their recovery
code *before* upgrading; the release note is part of the fix.
