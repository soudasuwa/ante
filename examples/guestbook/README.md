# Guestbook — integrating ante into a Freenet app

A standalone Freenet app: anyone can sign the guestbook, but every post carries
a **proof of work**. Entries are grouped by how much the author committed, so a
drive-by spammer's posts sit at the bottom and cost real CPU to make at all.

How high your message sits is how long you were willing to let your browser
grind — you watch the number climb and post when you have had enough. The tier
bands (16–17 / 18–19 / 20–21 / 22–23 / 24+) are 2 bits apart, so each is ~4× the
work of the one below, calibrated to the ~200k hashes/s that pure-JS blake3
actually manages in a browser.

It exists to show the **integration surface**. ante is not a big dependency —
it's one call to get a proof and one call to check one. Everything else here is
ordinary Freenet contract + web code.

```
examples/guestbook/
  contract/   the guestbook contract (Rust → WASM). Stores entries, rejects
              any whose proof doesn't verify. Links `ante-core` only.
  web/        the UI (TypeScript). Talks to the contract, and to the ante
              delegate via `@ante/client`.
```

## Where ante is, and where it isn't

The code is split so the boundary is obvious:

| File | ante? | what it does |
|---|---|---|
| `web/src/guestbook.ts` | **no** | CBOR wire types, contract GET / delta UPDATE — what a client for *any* contract looks like |
| `web/src/ante.ts` | **yes, all of it** | `attach` the delegate, `grind` a proof per post, `verify` proofs on display |
| `web/src/main.ts` | glue | form → `ante.ts` for a proof → `guestbook.ts` to store it |
| `contract/src/lib.rs` | two lines | bind the proof to the message, then `entry.proof.verify(params.min_bits)?` |

## The integration, in full

### 1. Producer — the contract (`contract/src/lib.rs`)

Link `ante-core` (no delegate, no key custody — just the verifier) and check
each entry:

```rust
use ante_core::AnteProof;

fn check(&self, params: &GuestbookParameters) -> Result<(), String> {
    // ... name / text length checks ...
    // Bound to THIS message, not merely to the guestbook — see below.
    if self.proof.purpose != content_purpose(&params.purpose, &self.name, &self.text) {
        return Err("proof is not bound to this message".into());
    }
    self.proof.verify(params.min_bits).map(|_| ()).map_err(|e| format!("{e}"))
}
```

`min_bits` and `purpose` are **contract parameters** — the anti-spam policy is
fixed when you publish, and part of the contract's address.

### Bind the proof to the message, or the work is free

An `AnteProof` commits to `(identity, purpose, nonce)` and **nothing else**. A
fixed `purpose` therefore buys the author unlimited posts from a single grind:
attach the same proof to any text and it still verifies. Worse, the challenge is
`blake3(purpose ‖ vk)` and grinding starts at nonce 0, so the *same* search runs
every time — an author with a lucky nonce early in their sequence re-finds it
instantly, forever. That is a one-time toll, not per-post proof of work.

The fix is to fold the message into the purpose:

```rust
pub fn content_purpose(prefix: &str, name: &str, text: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&(name.len() as u32).to_le_bytes());   // length-prefixed, so
    h.update(name.as_bytes());                      // ("ab","c") and ("a","bc")
    h.update(&(text.len() as u32).to_le_bytes());   // cannot collide
    h.update(text.as_bytes());
    format!("{prefix}:{}", hex(&h.finalize().as_bytes()[..8]))
}
```

Now every distinct message is its own challenge and needs its own search.
`content_purpose` is mirrored in `web/src/guestbook.ts` and the two are pinned
against each other by the shared wire vector.

**This generalises.** It is the same trick the whitepaper prescribes for
freshness (`myapp:comment:2026-W12`): whatever a proof must be non-transferable
across, put it in the purpose. If your app charges work per action, ask what an
attacker could re-use one proof for, and bind that.

### 2. Producer — the web app (`web/src/ante.ts`)

`@ante/client` offers two shapes, and which you pick is a product decision.

**Fixed bar** — you choose the cost, the user waits:

```ts
const outcome = await ante.commit(contentPurpose(name, text), { minBits: 16 });
```

**Open-ended** — the *user* chooses the cost, by deciding when to stop. This is
what the guestbook uses, because it is what makes the tiers mean something:

```ts
import { AnteClient } from "@ante/client";

const ante = await AnteClient.attach(fn);              // once, after connecting

const session = await ante.grind(contentPurpose(name, text), {
  minBits: 16,                                          // the contract's floor
  onProgress: (p) => render(p.best?.bits ?? 0, p.elapsed),
});

// …the grind keeps improving in a worker while the user watches.
// When they click post:
const outcome = await session.commit();                 // signs the best so far
// outcome.proof  — the decoded proof, to put in your record
// outcome.bytes  — its CBOR, if you'd rather store it opaquely
```

Either way the delegate raises a **consent prompt on the user's node** before
signing; it holds the identity key and the app never sees it. If the user
declines, `outcome.kind === "denied"`.

Open-ended grinding is self-calibrating: a fast desktop and a slow phone both
produce a sensible spread for the same amount of human patience, which a
hardcoded `minBits` cannot do.

### 3. Carrying the proof through your own data model (`web/src/guestbook.ts`)

The guestbook's `Entry` is `{ name, text, proof }`. `@ante/client` gives you
the proof as a value you drop into your own CBOR:

```ts
import { anteProofToCborValue, cborEncode } from "@ante/client";

const delta = cborEncode({
  entries: [{ name, text, proof: anteProofToCborValue(proof) }],
});
await fn.updateContractDelta(key, delta);
```

The field names match `ante_core::proof::AnteProof`, so the contract decodes it
with no glue. `contract/src/tests.rs` and `web/test/wire.test.ts` pin the exact
bytes on both sides.

### 4. Verifier — client-side (`web/src/ante.ts`)

The contract already rejects bad proofs on write. The UI re-checks anyway, so a
forged entry that somehow reached state is never *shown* as valid, and so each
entry can be labelled with the work it demonstrates:

```ts
import { verifyAnteProof } from "@ante/client";

// Both halves: bound to this message, and clearing the bar.
if (entry.proof.purpose !== contentPurpose(entry.name, entry.text)) return null;
const result = verifyAnteProof(entry.proof, 16);
if (result.ok) label(`${result.bits} bits`);
```

That's the whole integration — four call sites.

## Run it locally

You need a Freenet node running (`freenet` — see <https://freenet.org>) and
this repo's toolchain (`rustup target add wasm32-unknown-unknown`, `npm
install` at the repo root).

```bash
# from the repo root
./scripts/sync-delegate.sh                       # embed the delegate in @ante/client
./scripts/publish-guestbook.sh                   # build + publish the contract, prints an id
```

Put the printed id in `web/src/guestbook.ts` (`GUESTBOOK_CONTRACT_ID`) — it is
build-time only, with no runtime override, so edit and rebuild:

```bash
npm run dev --workspace ante-guestbook-web
# open http://localhost:5173/?node=127.0.0.1:7509
```

`?node=` works only in a dev build. Nothing published reads an address from the
URL: a parameter that repoints the contract, the node, or the "back up your
key" link would let a crafted link show attacker data — or phish a recovery
code — under the genuine app's address. See
[DEPLOYMENTS.md](../../DEPLOYMENTS.md#who-can-move-a-pointer).

## Publish it to Freenet

```bash
npm run build --workspace ante-guestbook-web
fdev website init guestbook            # one-time; back up the key file
fdev website update examples/guestbook/web/dist --key guestbook
```

This gives you **two ids, and they are not interchangeable**:

- the **website** id (from `fdev website`) — the page you open at
  `<node>/v1/contract/web/<id>/`;
- the **contract** id (from `publish-guestbook.sh`) — the entries, which the
  page reads over the node's WebSocket API.

Opening the contract id as a web URL fails with `failed unpacking contract`:
the gateway is trying to unzip CBOR state as a site. The live ids for both are
in [DEPLOYMENTS.md](../../DEPLOYMENTS.md).

## What ante does and does not do here

**Does:** make each post cost a measurable, verifiable slice of CPU bound to one
identity and to this guestbook. A script that ignores ante cannot post; one that
implements it pays per post.

**Does not:** stop a determined author, or someone with a lot of CPU, from
posting a lot. Those are the app's call — raise `min_bits`, add a per-author
cap, require a [ghost key](https://freenet.org/ghostkey) for more. ante is the
floor, not the ceiling.
