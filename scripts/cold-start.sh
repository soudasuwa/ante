#!/usr/bin/env bash
# Stand up a node that has never seen ante, publish the contracts onto it, and
# hand back two dev-server URLs pointed at it.
#
# This exists because incremental testing cannot answer the question it answers.
# Every check we run day to day happens on a node that already holds our state,
# our delegate, our secrets and every superseded generation — so it exercises
# the returning user and silently skips the newcomer. The first run of this
# found a real bug that way: the automatic migration sweeps announced themselves
# to people who had nothing to migrate, so a first-time visitor's opening screen
# read "3 earlier registries did not answer".
#
#   ./scripts/cold-start.sh            # local mode (default)
#   ./scripts/cold-start.sh --network  # network mode, the only way to test signing
#   ./scripts/cold-start.sh --down     # tear it all down
#   ./scripts/cold-start.sh --logs     # follow the node log
#
# CONSENT PROMPTS DO NOT EXIST IN LOCAL MODE. This is a property of freenet-core,
# not of the harness or of ante, and it cost a day to find, so it is written down
# here rather than left to be rediscovered:
#
#   `run_local_node` (node.rs) calls `executor.delegate_request(...)` and returns
#   the result straight to the client. The whole RequestUserInput ->
#   DashboardPrompter -> UserResponse loop lives in `contract_handling`, which is
#   spawned from exactly one place: p2p_impl.rs, the NETWORK-mode node.
#
# So under `freenet local` a delegate that prompts gets its RequestUserInput
# handed back to the caller verbatim. Nothing prompts, nothing answers, and the
# app sees a response with no ApplicationMessage in it. Every prompting operation
# — Commit, export, import — fails, and it looks exactly like a bug in the app.
# It is not. Use --network to test any of them.
#
# What each mode is actually good for:
#
#   local    empty contract state, the zero-byte decode path, migration silence
#            for a first-time visitor. Isolated, fast, deterministic, offline.
#            Cannot sign.
#   network  the consent round-trip and the real newcomer identity flow, on a
#            cold secret store with no delegate registration and no grants.
#            Joins the REAL network, so contract state is the REAL published
#            state — the guestbook will have real posts in it, and anything you
#            post there is a real post. Not a sandbox.
#
# WHY DOCKER, and not a `freenet local` on the host
#
# Three reasons, each learned by getting it wrong first:
#
#   1. Coldness. A host node inherits ~/.config/freenet and ~/.local/share.
#      "Cold" then means "cold except for the parts that matter most" — the
#      secret store the delegate keeps identities in, and the delegate
#      registration itself. A fresh container has no such history, and --rm
#      guarantees the next run starts from nothing again.
#   2. Logs. The node writes NOTHING to the console unless
#      FREENET_LOG_TO_CONSOLE is set (its console layer is gated on stdout being
#      a terminal), and nothing at debug level without RUST_LOG. An earlier
#      round of this produced an empty log and no way to tell a denied consent
#      prompt from a delegate that returned nothing. Both are set below.
#   3. Lifecycle. A backgrounded host node dies with whatever shell started it.
#      The container outlives the shell, which is the difference between a
#      harness and a thing you have to keep restarting.
#
# The official image runs `freenet network` from its entrypoint with no way to
# ask for local mode, so this bypasses the entrypoint and calls the image binary
# directly. That skips the entrypoint's mkdir, and `freenet local` will not
# create its own config dir ("Configuration directory not found"), hence the sh
# wrapper. It also skips the update supervisor, which a short-lived test node
# does not want anyway.
#
# The node runs local with no peers, so contracts are published by hand here. A
# real newcomer's node fetches them from the network. That overstates the setup
# and understates nothing about the client, which is the half we change.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ANTE_COLD_IMAGE:-ghcr.io/freenet/freenet-core:latest}"
NAME="${ANTE_COLD_NAME:-ante-cold}"
WS_PORT="${ANTE_COLD_PORT:-7599}"
VAULT_PORT="${ANTE_COLD_VAULT_PORT:-5173}"
GB_PORT="${ANTE_COLD_GB_PORT:-5174}"
WORK="${ANTE_COLD_DIR:-/tmp/ante-cold}"
# local | network. See the CONSENT note below before changing the default.
MODE="${ANTE_COLD_MODE:-local}"
[ "${1:-}" = "--network" ] && { MODE=network; shift; }
[ "${1:-}" = "--local" ] && { MODE=local; shift; }
NET_PORT="${ANTE_COLD_NET_PORT:-31338}"

case "${1:-}" in
  --down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    pkill -f "vite --port $VAULT_PORT" 2>/dev/null || true
    pkill -f "vite --port $GB_PORT" 2>/dev/null || true
    rm -rf "$WORK"
    echo "cold environment torn down"
    exit 0 ;;
  --logs)
    exec docker logs -f "$NAME" ;;
esac

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
command -v fdev   >/dev/null || { echo "fdev not found" >&2; exit 1; }

echo "==> wiping any previous cold environment"
docker rm -f "$NAME" >/dev/null 2>&1 || true
pkill -f "vite --port $VAULT_PORT" 2>/dev/null || true
pkill -f "vite --port $GB_PORT" 2>/dev/null || true
rm -rf "$WORK"; mkdir -p "$WORK"

echo "==> starting a node that has never seen ante ($MODE mode, $IMAGE, ws :$WS_PORT)"
# --rm so nothing survives to warm up the next run. No volume, for the same
# reason: the writable layer goes with the container.
#
# HOST NETWORKING IS LOAD-BEARING, not a shortcut around publishing a port.
# The consent prompt endpoints (/permission/*) are gated on the request coming
# from loopback — `peer_is_loopback`, which fails closed. Under Docker's default
# bridge the host reaches the container via the bridge gateway address, so every
# one of those requests arrives from 172.x and is refused with a 403. The
# browser then cannot subscribe to /permission/events/ws, the overlay never
# renders, nobody can answer, and every prompting operation — Commit, export,
# import — fails. A bridge-networked harness does not test the consent path; it
# breaks it, and would have reported a fault in our code that was not there.
#
# With host networking the container's loopback IS the host's, so the gate
# passes and the API keeps its default loopback-only bind. That bind is why no
# port is published and why FREENET_WS_API_ADDRESS is deliberately NOT set: the
# client API is fully privileged, and widening it is only needed under bridge,
# which is the arrangement we just rejected.
#
# Needs Linux. On Docker Desktop host networking is not the same thing, and the
# consent path cannot be tested this way.
if [ "$MODE" = network ]; then
  # Network mode uses the image's own entrypoint, which is the update supervisor
  # and runs `freenet network`. A fresh container still gives a cold secret store
  # and no delegate registration, which is the part a newcomer test needs; what
  # it does NOT give is empty contract state, because the node fetches the real
  # published contracts from the real network.
  docker run -d --rm --name "$NAME" \
    --network host \
    -e FREENET_LOG_TO_CONSOLE=1 \
    -e RUST_LOG="${ANTE_COLD_LOG:-freenet=info}" \
    -e WS_API_PORT="$WS_PORT" \
    -e NETWORK_PORT="$NET_PORT" \
    "$IMAGE" >/dev/null
else
  docker run -d --rm --name "$NAME" \
    --network host \
    -e FREENET_LOG_TO_CONSOLE=1 \
    -e RUST_LOG="${ANTE_COLD_LOG:-freenet=info}" \
    --entrypoint /bin/sh \
    "$IMAGE" \
    -c "mkdir -p /data/config /data/node /data/logs && exec /usr/local/lib/freenet/freenet local \
        --ws-api-port $WS_PORT --config-dir /data/config --data-dir /data/node" >/dev/null
fi

for _ in $(seq 1 90); do
  curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$WS_PORT/v1/version" 2>/dev/null && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || {
    echo "node container died:" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2; exit 1; }
  sleep 2
done
curl -sf -o /dev/null "http://127.0.0.1:$WS_PORT/v1/version" || {
  echo "node never answered; docker logs $NAME" >&2; exit 1; }
echo "    up: $(curl -s "http://127.0.0.1:$WS_PORT/v1/version")"

# Regenerate params from the values of record rather than reusing a file, so a
# drift between deployments.json and what we actually build fails here instead
# of at publish time.
# Cheap, and it fails in the one way that is otherwise invisible until a human
# clicks a button 60 seconds into a manual test.
echo "==> checking the consent-prompt endpoint accepts us as loopback"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$WS_PORT/permission/pending" || echo 000)"
if [ "$code" = "200" ]; then
  echo "    ok  /permission/pending -> 200"
else
  echo "    BAD /permission/pending -> $code (403 means we are not loopback to the node;" >&2
  echo "        consent prompts cannot be delivered or answered, so Commit/export/import" >&2
  echo "        would all fail for reasons that are the harness's fault, not ante's)" >&2
  exit 1
fi

echo "==> rebuilding params and confirming the recorded addresses derive from them"
REG_WASM="$REPO_ROOT/contracts/ante-registry/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"
GB_WASM="$REPO_ROOT/examples/guestbook/contract/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm"
[ -f "$REG_WASM" ] || (cd "$REPO_ROOT/contracts/ante-registry" && "$REPO_ROOT/scripts/build-contract.sh")
[ -f "$GB_WASM" ]  || (cd "$REPO_ROOT/examples/guestbook/contract" && "$REPO_ROOT/scripts/build-contract.sh")

cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v2}" \
  --floor "${ANTE_REGISTRY_FLOOR:-12}" --out "$WORK/reg.params" >/dev/null
(cd "$REPO_ROOT/examples/guestbook/contract" && cargo run -q --example params -- \
  --purpose "${ANTE_GUESTBOOK_PURPOSE:-ante-guestbook:post:v2}" \
  --min-bits "${ANTE_GUESTBOOK_MIN_BITS:-16}" --out "$WORK/gb.params" >/dev/null)

REG_ID="$(fdev get-contract-id --code "$REG_WASM" --parameters "$WORK/reg.params")"
GB_ID="$(fdev get-contract-id --code "$GB_WASM"  --parameters "$WORK/gb.params")"

python3 - "$REPO_ROOT/deployments.json" "$REG_ID" "$GB_ID" <<'PYEOF'
import json, sys
path, reg, gb = sys.argv[1:4]
d = json.load(open(path)); bad = False
for name, built in (("registry", reg), ("guestbook", gb)):
    rec = d["contracts"][name]["instance"]
    print(f"    ok  {name:<10} {built}" if rec == built
          else f"    BAD {name:<10} built {built} but deployments.json records {rec}")
    bad |= rec != built
sys.exit(1 if bad else 0)
PYEOF

if [ "$MODE" = network ]; then
  # NOTHING is published in network mode, and that is the point. The network
  # already holds these contracts and these sites; a real newcomer's node fetches
  # them. Publishing here would write to the REAL network from a throwaway test
  # node: `fdev publish` PUTs empty state onto live contracts, and `website
  # update` bumps the live sites to whatever happens to be in ./dist. Neither is
  # destructive — a union merge means empty ∪ real = real, which is exactly what
  # the merge laws buy — but both are real writes nobody asked for, and the
  # second one publishes an unreviewed local build to real users.
  echo "==> network mode: publishing nothing (the network already has it)"
  echo "    contract state here is LIVE state, so the empty-state assertions"
  echo "    below are skipped — they only mean anything on an isolated node."
else
echo "==> publishing onto the cold node"
fdev -p "$WS_PORT" publish --code "$REG_WASM" --parameters "$WORK/reg.params" contract >/dev/null 2>&1
fdev -p "$WS_PORT" publish --code "$GB_WASM"  --parameters "$WORK/gb.params"  contract >/dev/null 2>&1

# The assertion this script exists for. A published contract that has never been
# updated answers a GET with an EMPTY body, not NotFound — so the newcomer path
# and the "CBOR: unexpected end of input" crash we already hit once are the same
# path, and it is the default case rather than an edge case.
echo "==> asserting a never-updated contract reads as zero bytes, not NotFound"
fail=0
for pair in "registry:$REG_ID" "guestbook:$GB_ID"; do
  name="${pair%%:*}"; id="${pair#*:}"
  if fdev -p "$WS_PORT" execute get "$id" -o "$WORK/$name.state" --timeout 30 >/dev/null 2>&1; then
    n=$(wc -c < "$WORK/$name.state")
    [ "$n" -eq 0 ] && echo "    ok  $name reads 0 bytes" \
                   || echo "    note $name reads $n bytes — not virgin state"
  else
    echo "    BAD $name did not answer a GET at all"; fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1

# The apps have to be served BY the node, not by a dev server, for the consent
# path to exist at all. The prompt overlay is part of the node's gateway shell
# page and is delivered over /permission/events/ws to "every open Freenet tab";
# a vite tab is a different origin running our app alone, so it never subscribes
# and no prompt can ever render or be answered there. It is also the only way
# the delegate sees a real MessageOrigin::WebApp attestation, which is what
# grants and the prompt's own origin check are keyed on. Testing Commit from a
# dev server tests neither.
echo "==> publishing the web apps onto the cold node"
for site in ante:web guestbook:examples/guestbook/web home:site; do
  key="${site%%:*}"; dir="${site#*:}"
  if [ -d "$REPO_ROOT/$dir/dist" ]; then
    fdev -p "$WS_PORT" website update "$REPO_ROOT/$dir/dist" --key "$key" >/dev/null 2>&1 \
      && echo "    ok  $key" || echo "    BAD $key failed to publish"
  else
    echo "    -   $key skipped ($dir/dist not built)"
  fi
done

fi

echo "==> starting dev servers (a code-iteration convenience, NOT the newcomer path)"
(cd "$REPO_ROOT/web" && setsid npx vite --port "$VAULT_PORT" --strictPort \
   > "$WORK/vault-dev.log" 2>&1 < /dev/null &)
(cd "$REPO_ROOT/examples/guestbook/web" && setsid npx vite --port "$GB_PORT" --strictPort \
   > "$WORK/gb-dev.log" 2>&1 < /dev/null &)
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$VAULT_PORT" 2>/dev/null \
    && curl -sf -o /dev/null "http://127.0.0.1:$GB_PORT" 2>/dev/null && break
  sleep 1
done

SUPERSEDED=$(python3 -c "
import json;d=json.load(open('$REPO_ROOT/deployments.json'))
print(sum(len(d['contracts'][n].get('superseded',[])) for n in ('registry','guestbook')))")

GW="http://127.0.0.1:$WS_PORT/v1/contract/web"
ANTE_KEY="$(fdev website list 2>/dev/null | awk '$1=="ante"{print $2}')"
GB_KEY="$(fdev website list 2>/dev/null | awk '$1=="guestbook"{print $2}')"
HOME_KEY="$(fdev website list 2>/dev/null | awk '$1=="home"{print $2}')"

if [ "$MODE" = network ]; then
  CONTEXT="cold environment ready, on the REAL network. the secret store is fresh —
no identity, no delegate registration, no grants — so the identity and consent
flow is genuinely first-time. contract state is NOT fresh: the guestbook holds
real posts, the registry holds real levels, and anything you post here is a
real post. this is the mode that can test signing."
else
  CONTEXT="cold environment ready, isolated. none of the $SUPERSEDED superseded generations
exist on this node, so every migration probe will fail — silence is the correct
outcome, and an empty book is the correct outcome."
fi

cat <<EOF

$CONTEXT

TEST HERE — served by the node, which is what a newcomer actually opens:

  guestbook  $GW/$GB_KEY/
  vault      $GW/$ANTE_KEY/
  home       $GW/$HOME_KEY/

walk it in this order:
  1. guestbook FIRST, without ever opening the vault. it should mint an
     identity with no migration chatter$( [ "$MODE" = local ] && echo ", and show an empty book" ).
  2. then the vault. it should find the identity the guestbook already made,
     not mint a second one.
  3. sign and post.$( [ "$MODE" = local ] \
       && echo " (WILL FAIL in local mode — see the NOTE below.)" \
       || echo " your node should raise a consent prompt; that prompt
     is the thing local mode cannot do." )

$( [ "$MODE" = local ] && cat <<'LOCALNOTE'
NOTE: this is LOCAL mode, which has no consent-prompt machinery at all — see
the header. Signing, export and import WILL fail here with "the node returned
only RequestUserInput", and that is the harness, not ante. To test those:

  ./scripts/cold-start.sh --network

LOCALNOTE
)
the dev servers below are for iterating on code, and cannot test signing either:
the consent overlay belongs to the node's gateway shell, so it never renders
on a dev-server origin.

  guestbook  http://127.0.0.1:$GB_PORT/?node=127.0.0.1:$WS_PORT
  vault      http://127.0.0.1:$VAULT_PORT/?node=127.0.0.1:$WS_PORT

  ./scripts/cold-start.sh --logs    watch the node (consent prompts included)
  ./scripts/cold-start.sh --down    when finished
EOF
