# Guestbook — integrating ante into a Freenet app

A standalone Freenet app: anyone can sign the guestbook, but every post carries
a **proof of work**. Entries are grouped by how much the author committed, so a
drive-by spammer's posts sit at the bottom and cost real CPU to make at all.

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
| `web/src/ante.ts` | **yes, all of it** | `attach` the delegate, `commit` a proof per post, `verify` proofs on display |
| `web/src/main.ts` | glue | form → `ante.ts` for a proof → `guestbook.ts` to store it |
| `contract/src/lib.rs` | one line | `entry.proof.verify(params.min_bits)?` in `validate_state` / `update_state` |

## The integration, in full

### 1. Producer — the contract (`contract/src/lib.rs`)

Link `ante-core` (no delegate, no key custody — just the verifier) and check
each entry:

```rust
use ante_core::AnteProof;

fn check(&self, params: &GuestbookParameters) -> Result<(), String> {
    // ... name / text length checks ...
    if self.proof.purpose != params.purpose {
        return Err("proof is for a different purpose".into());
    }
    self.proof.verify(params.min_bits).map(|_| ()).map_err(|e| format!("{e}"))
}
```

`min_bits` and `purpose` are **contract parameters** — the anti-spam policy is
fixed when you publish, and part of the contract's address.

### 2. Producer — the web app (`web/src/ante.ts`)

```ts
import { AnteClient } from "@ante/client";

const ante = await AnteClient.attach(fn);              // once, after connecting

const outcome = await ante.commit("ante-guestbook:post:v1", {
  minBits: 16,
  onProgress: (tried, hps) => { /* update the grind indicator */ },
});
// outcome.proof  — the decoded proof, to put in your record
// outcome.bytes  — its CBOR, if you'd rather store it opaquely
```

`commit` runs the whole round trip: fetch a challenge from the delegate, grind
proof of work in a worker, then a **consent prompt on the user's node**. The
delegate holds the identity key; the app never sees it. If the user declines,
`outcome.kind === "denied"`.

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

Put the printed id in `web/src/guestbook.ts` (`GUESTBOOK_CONTRACT_ID`), or pass
it as a query param, then:

```bash
npm run dev --workspace ante-guestbook-web
# open http://localhost:5173/?node=127.0.0.1:7509&contract=<id>
```

## Publish it to Freenet

```bash
npm run build --workspace ante-guestbook-web
fdev website init guestbook            # one-time; back up the key file
fdev website update examples/guestbook/web/dist --key guestbook
```

## What ante does and does not do here

**Does:** make each post cost a measurable, verifiable slice of CPU bound to one
identity and to this guestbook. A script that ignores ante cannot post; one that
implements it pays per post.

**Does not:** stop a determined author, or someone with a lot of CPU, from
posting a lot. Those are the app's call — raise `min_bits`, add a per-author
cap, require a [ghost key](https://freenet.org/ghostkey) for more. ante is the
floor, not the ceiling.
