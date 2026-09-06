# ante-guestbook-contract

The Freenet contract behind the [guestbook example](../). It requires an
[`AnteProof`](../../../ante-core) per entry. **Not published** — it exists to
show `AnteProof::verify` in a real `validate_state` / `update_state`.

## What it demonstrates

- The consuming side links **only `ante-core`** — no delegate, no key custody.
  It pulls ed25519/blake3/serde transitively, which is all a verifier needs.
- `Entry::check` is the whole integration: purpose match, length bounds, then
  `proof.verify(params.min_bits)`.
- Entries are a **grow-only set** keyed by `blake3(author_vk || nonce || text)`,
  so a verbatim replay of one signed entry collapses to one key, and merge is
  the set union (order-independent).
- The anti-spam policy — `purpose` and `min_bits` — is contract **parameters**,
  fixed at publish time.

## What it does not do

Rate-limit a determined author, or stop someone with a lot of CPU. That is the
app's call: raise `min_bits`, add a per-author cap, or require a ghost key for
more. ante is the floor, not the ceiling.

## Build / test

```bash
cargo test                                        # native
cargo build --release --target wasm32-unknown-unknown
```
