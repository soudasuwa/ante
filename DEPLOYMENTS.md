# Deployments

What is live on Freenet, and the facts needed to rebuild or update it.

Everything here is content-addressed: an id *is* the bytes it was published
from. A row changing means a re-key — see [DESIGN.md](DESIGN.md#before-v02-upgrade-migration)
for what that costs and [WHITEPAPER.md](WHITEPAPER.md) §12 for why it happens so
easily.

> **Two kinds of id live below, and only one of them is a URL.** A *website*
> contract holds a site you can open in a browser. A *data* contract holds
> application state — opening one at `/v1/contract/web/…` fails with
> `failed unpacking contract`, because the gateway is trying to unzip CBOR.

## Open these

Published with `fdev website`, whose contract key is
`blake3(container_wasm ‖ publisher_key)`. Neither input contains the site
content, so **these URLs are permanent and updated in place**. The publisher key
lives in `~/.config/freenet/website-keys/<name>.toml` — **back those files up;
losing one means that URL can never be updated again.**

| Site | Key name | URL (on a node at `127.0.0.1:7509`) |
|---|---|---|
| Identity UI (`web/`) | `ante` | <http://127.0.0.1:7509/v1/contract/web/AGdogAU4KTER6MpmLcYVAUjPGat3sQS536crq7wPYb2r/> |
| Guestbook example | `guestbook` | <http://127.0.0.1:7509/v1/contract/web/HLqqoWvQZMRy1JF9g1DV34VUeagCzgGvC4mNepSC6WWV/> |

Republish with:

```bash
./scripts/publish-web.sh                       # identity UI
npm run build --workspace ante-guestbook-web \
  && fdev website update ./examples/guestbook/web/dist --key guestbook
```

## Do not open these

State, not sites. Apps reach them with a contract GET/UPDATE over the node's
WebSocket API; there is nothing to render.

| Contract | Instance | Parameters | Publish |
|---|---|---|---|
| ante-registry | `E8jXsQgvKkn1kzEpSDFwDRUbqZW3Tc1Z7BtmXQwyfb1J` | purpose `ante:identity-level:v1`, floor 12 bits | `./scripts/publish-registry.sh` |
| guestbook example | `3haJKAbJzRXTem9fZw8SrKTjfZjVfVK3KzzB6YnXwbpL` | purpose `ante-guestbook:post:v1`, min_bits 16 | `./scripts/publish-guestbook.sh` |

The guestbook *website* (`HLqqo…`) reads the guestbook *contract* (`3haJK…`).
Two different ids for one example — that is the normal shape of a Freenet app,
not a quirk of this one.

The registry id is written into the generated `client/src/embedded.ts`, which is
gitignored — so **this table is the only committed record of it**. After a fresh
clone, `./scripts/publish-registry.sh` recomputes and republishes it; to point at
the existing instance without republishing:

```bash
./scripts/gen-embedded.sh ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm \
  E8jXsQgvKkn1kzEpSDFwDRUbqZW3Tc1Z7BtmXQwyfb1J
```

## Who can move a pointer

Every address an app reads is **fixed at build time**. No published page takes a
contract id, a node, or a link target from the URL.

That is deliberate. A `?contract=` parameter would let anyone hand out a link
that is the genuine app — genuine address, genuine code, genuine publisher —
displaying data they control, with the address bar vouching for it. A `?vault=`
one was worse: it aimed the *"back up your key"* link, so a link to the real
guestbook could send someone to a clone that asks them to paste their recovery
code. Both are gone; `?node=` survives only in `vite dev` builds and is
dead-code-eliminated from anything published.

So the pointer is the published bundle, and the authority to move it is the
**website's publisher key**: changing where an app reads from means republishing
the site, which only the key holder can do. A separate signed pointer contract
would add a moving part without adding a guarantee — it would rest on the same
key. It becomes worth building only if the target must change *without* a site
republish, or if third-party apps need to discover these contracts on their own.

To point a local build somewhere else, edit the constant and rebuild:
`examples/guestbook/web/src/guestbook.ts` (`GUESTBOOK_CONTRACT_ID`).

## Delegate

Not published — delegates never propagate. Each app ships the bytes and
registers them on the user's node (see WHITEPAPER.md §11). The current key is
recorded in [`artifact-keys.toml`](artifact-keys.toml)
and guarded by `./scripts/check-keys.sh`.

**When this key changes, every stored identity becomes unreachable** and each
user must restore from their recovery code. Say so in the release notes, and
tell people to save their code *before* upgrading.

## Superseded

Kept so a stale id can be recognised rather than puzzled over.

| What | Old id | Why it moved |
|---|---|---|
| ante-registry | `GFFaptbqcNprDPCkpQmRnLQLdeeXv6kDVSoiM5B6YThK` | doc-comment edits in `ante-core::registry` shifted the compiled bytes |
| guestbook | `Fw691FL9RYGJmYm7mVxhyMMTUy4KdWWCJXxUUNFzHgr9` | proofs were not bound to the message, so one grind bought unlimited posts (see the guestbook README) |
