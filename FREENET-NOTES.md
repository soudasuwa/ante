# Notes on building for Freenet

Things that cost us days, are not in Freenet's documentation, and would cost the
next person the same. Verified against **freenet-core 0.2.133–0.2.134** in
September 2026 — check them again before trusting them, and if one is fixed
upstream, good.

Each is written as: what happens, why, and how we found out. The "how" matters,
because most of these fail *silently* and look like a bug in your own code.

---

## Consent prompts do not exist in local mode

`freenet local` has no permission-prompt machinery at all. `run_local_node`
(`crates/core/src/node.rs`) calls `executor.delegate_request(...)` and hands the
result straight back to the client. The whole
`RequestUserInput → DashboardPrompter → UserResponse` loop lives in
`contract_handling`, spawned from exactly one place: `node/p2p_impl.rs`, the
**network-mode** node.

So under local mode a delegate that prompts gets its `RequestUserInput` returned
verbatim. Nothing prompts, nothing answers, and your app sees a delegate
response with no `ApplicationMessage` in it. Every prompting operation fails and
it looks precisely like a bug in your delegate.

**Two things make this expensive to diagnose.** The relevant node logs are
debug-level and compiled out of release builds. And the WARN-level
prompt-timeout line never fires, because the prompt is never raised at all — so
the node looks healthy and says nothing.

**How to tell:** your client receives a delegate response whose only outbound
message is `RequestUserInput`. **Fix:** test consent in network mode.

## The consent overlay belongs to the node, not to your app

The prompt is rendered by the gateway *shell page* and delivered over
`/permission/events/ws` to "every open Freenet tab". An app served from a dev
server is a different origin running your code alone: it never subscribes, so no
prompt can render or be answered there, and every prompt auto-denies after 60 s
(`USER_INPUT_TIMEOUT`).

It is also the only context where your delegate sees a real
`MessageOrigin::WebApp` attestation — which is what grants and prompt
origin-checks are keyed on. **A dev server cannot test consent.** Serve the app
from the node.

## The permission endpoints are loopback-gated, and fail closed

`/permission/*` is gated on `peer_is_loopback`, which rejects a missing
`ConnectInfo` rather than trusting it. Under Docker's default bridge network the
host reaches the container through the bridge gateway, so those requests arrive
from `172.x` and get a **403** — the browser cannot subscribe, no overlay
renders, and every prompting operation fails for a reason that looks like your
app's fault.

Use `--network host`. The official compose file does, for this reason among
others.

## A delegate cannot do long work

A delegate is a single-threaded, message-driven `process()`. Anything that takes
seconds — proof-of-work, heavy crypto — blocks the node's contract executor for
the duration. Do the work in your web app's worker and let the delegate sign.

If you need consent *before* the work rather than after, ask in one call, park
an authorization in the delegate's secret store, and consume it on the call that
follows. The delegate never has to do the work to gate it.

## The delegate has no clock

There is no time source. `freenet_stdlib::time::now()` is deprecated for
contracts (v0.2.132) and heading for a trap. Any timestamp reaches you from the
caller and is unauthenticated, so anything you build on it — expiry, freshness,
rate limits — is a number the caller chooses.

For authorizations, single-use is the only bound that cannot be lied about. For
freshness, put an epoch in a domain-separation string (`myapp:action:2026-W12`)
and let the *contract's* parameters decide what is current.

## A published contract that was never updated returns ZERO BYTES, not NotFound

This is the newcomer path for every app, and it is not an edge case — it is what
every first visitor sees. Decoding it without checking gives you a parse error
on the very first screen ("unexpected end of input" or similar).

Guard every state decode with an explicit empty check, and make sure the guard
is on *all* of them: `validate_state` and every `update_state` variant.

## Silence is not absence

A contract or delegate generation that does not answer is not evidence that it
holds nothing. It may be a node that never had it, a slow fetch, or a real
absence, and you cannot tell them apart. If you are migrating state forward,
record a non-answer as *unresolved* and retry on the next load; never treat it
as empty and move on, or you will silently drop data on a slow day.

Where the protocol lets you, add an explicit "there is nothing here" answer —
that is a fact you can act on, and silence never is.

---

# Reproducible builds, which you need and probably do not have

Every Freenet address is derived from bytes: a delegate key is
`blake3(blake3(wasm))`, a contract instance `blake3(blake3(wasm) ‖ params)`. So
"can someone else rebuild this and get the same address?" is not a nicety, it is
whether your users have to trust you. Four things get in the way.

## cargo hashes a path dependency's ABSOLUTE PATH into `-C metadata`

No `--remap-path-prefix` reaches it. A crate at `/home/alice/app` and the same
crate at `/home/bob/app` produce different bytes and therefore different
addresses. **The only fix is a shared path**: build in a container with a fixed
`WORKDIR`. See `build/Dockerfile` here.

## rustc applies the LAST matching `--remap-path-prefix`, not the first

So a narrow rule placed before a broad one silently does nothing. We put a
sysroot remap first, measured no change, and nearly concluded the leak was
elsewhere. Put narrow rules last.

## The toolchain's INSTALLATION NAME leaks into artifacts

`--remap-path-prefix=$RUSTUP_HOME=/rustup` keeps the directory name, so std's own
source paths come through as
`/rustup/toolchains/stable-x86_64-.../lib/rustlib/src/...` on one machine and
`.../1.98.1-x86_64-.../...` on another. The **same compiler**, installed twice
under two names, gave 36 differing bytes across 6 paths — a different key.

`rust-toolchain.toml` pins the version but not the name it is installed under,
and `stable` resolving to the pinned version is the ordinary case on a
developer's machine. Remap the sysroot (`rustc --print sysroot`), and remember
the last-match rule above.

## cargo's fingerprint does not include the toolchain's installation path

Only source and flags. So an artifact cached under one toolchain is reused under
another, and a key-checking script reports green on bytes the current
environment would never produce. **This is how our published keys came to be
ones no clean build reproduced, while every check in between passed in under a
second.** Make the toolchain identity part of your cache key, or build clean.

## Watch for remap targets colliding with real paths

If you remap `$WORKTREE_DIR` to the literal `/ante` and then grep the artifact
for machine-specific paths, a `WORKDIR=/ante` makes the grep match its own
remapped output and fail a build that is perfectly clean. Keep real paths and
remap targets in separate namespaces.

## A comment can re-key a contract

Adding seven doc-comment lines above a function moved our guestbook contract's
code hash. `line!()` from a `panic!` elsewhere in the file is baked into rodata,
and every line after an insertion shifts. `panic = "abort"` and `strip = true`
do **not** prevent it.

So an artifact's identity depends on line numbers in its own file. Batch changes
that re-key, and know the price before adding a comment to a published contract.

---

# Operational

- **The node writes NOTHING to the console unless `FREENET_LOG_TO_CONSOLE=1`.**
  Its console layer is gated on stdout being a terminal, so the one deployment
  where stdout is the only log interface is exactly the one that turns logging
  off. Debug and trace are additionally compiled out of release builds — so
  `RUST_LOG=debug` gets you a warning about "trace filter directives that would
  enable traces disabled statically" and nothing else.
- **`freenet local` will not create its own config directory.** It exits with
  "Configuration directory not found" rather than making one. `mkdir -p` first.
- **`fdev --node-url` wants the whole path**, including
  `/v1/contract/command?encodingProtocol=native`. A bare `ws://host:port` gets a
  200 instead of a 101 upgrade, and the error says `HTTP error: 200 OK`. `-p
  <port>` is simpler and does the right thing.
- **`fdev publish` with no `--state` PUTs empty state.** On a network node that
  is a real write to the live contract. It is harmless if your merge is a proper
  join-semilattice (empty ∪ real = real) — which is a good argument for the merge
  laws, not an argument that the write was fine.
- **`RegisterDelegate`'s `cipher` and `nonce` are ignored** since freenet-core
  #4140; the DEK is derived from the node KEK. **`RegisterDelegateWithPredecessors`
  copy-forward is disabled unconditionally.**
- **freenet-core retains delegate WASM indefinitely.** Only an explicit
  `UnregisterDelegate` removes it, so a generation the node once registered stays
  addressable — which is what makes recovering a stranded identity possible at
  all.
- **A web app's URL is permanent.** `fdev website` keys on
  `blake3(container_wasm ‖ publisher_key)`, and neither input is your content, so
  updates land on the same address. Do not design around a rotating URL.
- **Gateway sandbox:** separate-file Web Workers are blocked (bundle them
  inline), `localStorage` throws rather than returning null, and there is no
  Clipboard API. The shell page's CSP is `default-src 'none'` with `img-src
  data:`, which also blocks its own favicon request — a console error you can
  ignore.

---

*Written while building [ante](./README.md). If any of this is wrong or has been
fixed upstream, the freenet-core source is the authority — every claim above
names where to look.*
