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
| **ante** (home, `site/`) | `home` | <http://127.0.0.1:7509/v1/contract/web/6Ffg43GVU9Zec9VTbaVKaWATrz4p7YcShaKEYUZ73EXg/> |
| **ante vault** (`web/`) | `ante` | <http://127.0.0.1:7509/v1/contract/web/AGdogAU4KTER6MpmLcYVAUjPGat3sQS536crq7wPYb2r/> |
| **ante guestbook** (example) | `guestbook` | <http://127.0.0.1:7509/v1/contract/web/HLqqoWvQZMRy1JF9g1DV34VUeagCzgGvC4mNepSC6WWV/> |

The home page is the entry point: it explains what ante is, lists these
addresses so a visitor can check what they opened, and renders the whitepaper.
It needs no node connection at all (1 KB of JS against the other two's ~708 KB,
which is almost entirely the embedded delegate).

Every address above also lives in **`deployments.json`**, which the apps import
at build time so they can link to each other without a second copy drifting.
That file is the source of truth; this table mirrors it and CI checks the two
agree.

Republish with:

```bash
fdev website update ./site/dist --key home     # home page
./scripts/publish-web.sh                       # vault
npm run build --workspace ante-guestbook-web \
  && fdev website update ./examples/guestbook/web/dist --key guestbook
```

## Do not open these

State, not sites. Apps reach them with a contract GET/UPDATE over the node's
WebSocket API; there is nothing to render.

| Contract | Instance | Parameters | Publish |
|---|---|---|---|
| ante-registry | `GJefZKcv5zUGCmQ6oMYYfNzfK7rwZQ73VuBXBVTmHL9m` | purpose `ante:identity-level:v1`, floor 12 bits | `./scripts/publish-registry.sh` |
| guestbook example | `DAGX9qjonjTPFyfLP9rEsJtzT9XSuFBEWeaxc9WVPZu8` | purpose `ante-guestbook:post:v2`, min_bits 16 | `./scripts/publish-guestbook.sh` |

**The guestbook was reset for launch (2026-09-07).** Its purpose moved to
`ante-guestbook:post:v2`, which is a new instance and therefore an empty book —
Freenet state is a grow-only CRDT, so there is no delete, and a fresh address is
the only clean slate. Its `superseded` list is deliberately EMPTY: leaving the
predecessor there would have the carry-forward sweep faithfully restore every
pre-launch test post, which is the opposite of the intent. The old instance
still exists and still holds them; nothing points at it.

That is the one case where dropping a predecessor is correct. Everywhere else it
is data a future migration cannot reach, which is why the publish scripts record
lineage automatically — the entry here had to be removed by hand, after
publishing, on purpose.

The registry keeps its full lineage: identity levels are worth carrying, and a
level is not spam.

Both moved twice on 2026-09-07, and this is the last time they should move for
a build reason. The first move fixed a non-reproducible build; the second
adopted the fixed-path container build as canonical, which changes the bytes one
final time and makes the keys independent of where the repo lives. From here
CI verifies the record on every push. Detail on the first move follows.

The build was found to be non-reproducible — the
toolchain's *installation directory name* leaked into every artifact, so the
same compiler installed under two names produced two different addresses — and
fixing that changed the bytes, which changes the address. The previous
generations are recorded in `deployments.json` under `superseded`, and both apps
sweep them on load to carry levels and posts forward. They stay readable;
nothing was deleted.

The guestbook *website* (`HLqqo…`) reads the guestbook *contract* (`DAGX9…`).
Two different ids for one example — that is the normal shape of a Freenet app,
not a quirk of this one.

The registry id is written into the generated `client/src/embedded.ts`, which is
gitignored — so **this table is the only committed record of it**. After a fresh
clone, `./scripts/publish-registry.sh` recomputes and republishes it; to point at
the existing instance without republishing:

```bash
./scripts/gen-embedded.sh ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm \
  GJefZKcv5zUGCmQ6oMYYfNzfK7rwZQ73VuBXBVTmHL9m
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

Kept so a stale id can be recognised rather than puzzled over — **and because
these are the addresses a carry-forward migration will probe**. The machine-
readable copy is `deployments.json` (`contracts.*.superseded`, newest first),
appended automatically by the publish scripts; code-hash lineage lands in
`artifact-keys.toml` the same way. A generation missing from those is state no
migration can reach. See WHITEPAPER.md §16 item 7.

| What | Old id | Why it moved |
|---|---|---|
| ante-registry | `GFFaptbqcNprDPCkpQmRnLQLdeeXv6kDVSoiM5B6YThK` | doc-comment edits in `ante-core::registry` shifted the compiled bytes |
| guestbook | `Fw691FL9RYGJmYm7mVxhyMMTUy4KdWWCJXxUUNFzHgr9` | proofs were not bound to the message, so one grind bought unlimited posts (see the guestbook README) |
| ante-registry | `E8jXsQgvKkn1kzEpSDFwDRUbqZW3Tc1Z7BtmXQwyfb1J` | build made reproducible across machines: pinned rustc + the worktree path remap |
| ante-registry | `67bb1FuQfrsZnWLvGVDswwta2HMxtUEDQa93y3QasJKz` | empty delta to a converged peer (`fdev verify-merge`) |
| guestbook | `FFAmyrCBVnMpEcC515gKWnxK2HnrphSZ3Xj6ce8Pkmhw` | same |
| guestbook | `3haJKAbJzRXTem9fZw8SrKTjfZjVfVK3KzzB6YnXwbpL` | same |
