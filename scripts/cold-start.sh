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
#   ./scripts/cold-start.sh          # bring it up
#   ./scripts/cold-start.sh --down   # tear it all down
#   ./scripts/cold-start.sh --logs   # follow the node log
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

echo "==> starting a node that has never seen ante ($IMAGE, ws :$WS_PORT)"
# --rm so nothing survives to warm up the next run. No volume, for the same
# reason: the writable layer goes with the container.
#
# The client API is fully privileged, so it is bound to 0.0.0.0 only INSIDE the
# container and published to the host's loopback alone — never 0.0.0.0 on the
# host. Under Docker's default bridge, loopback-in-container would be
# unreachable from a browser, which is why the bind address is widened at all.
docker run -d --rm --name "$NAME" \
  -p "127.0.0.1:$WS_PORT:$WS_PORT" \
  -e FREENET_WS_API_ADDRESS=0.0.0.0 \
  -e FREENET_LOG_TO_CONSOLE=1 \
  -e RUST_LOG="${ANTE_COLD_LOG:-freenet=debug}" \
  --entrypoint /bin/sh \
  "$IMAGE" \
  -c "mkdir -p /data/config /data/node /data/logs && exec /usr/local/lib/freenet/freenet local \
      --ws-api-port $WS_PORT --config-dir /data/config --data-dir /data/node" >/dev/null

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
echo "==> rebuilding params and confirming the recorded addresses derive from them"
REG_WASM="$REPO_ROOT/contracts/ante-registry/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"
GB_WASM="$REPO_ROOT/examples/guestbook/contract/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm"
[ -f "$REG_WASM" ] || (cd "$REPO_ROOT/contracts/ante-registry" && "$REPO_ROOT/scripts/build-contract.sh")
[ -f "$GB_WASM" ]  || (cd "$REPO_ROOT/examples/guestbook/contract" && "$REPO_ROOT/scripts/build-contract.sh")

cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v1}" \
  --floor "${ANTE_REGISTRY_FLOOR:-12}" --out "$WORK/reg.params" >/dev/null
(cd "$REPO_ROOT/examples/guestbook/contract" && cargo run -q --example params -- \
  --purpose "${ANTE_GUESTBOOK_PURPOSE:-ante-guestbook:post:v1}" \
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

echo "==> starting dev servers (?node= is dev-build only, hence dev servers)"
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

cat <<EOF

cold environment ready. none of the $SUPERSEDED superseded generations exist on this
node, so every migration probe will fail — silence is the correct outcome.

  guestbook  http://127.0.0.1:$GB_PORT/?node=127.0.0.1:$WS_PORT
  vault      http://127.0.0.1:$VAULT_PORT/?node=127.0.0.1:$WS_PORT

walk it in this order:
  1. guestbook FIRST, without ever opening the vault. it should mint an
     identity and show an empty book, with no migration chatter.
  2. then the vault. it should find the identity the guestbook already made,
     not mint a second one.
  3. post, then reload. posting is what first gives the contract non-empty
     state, so this is where the zero-byte path stops being the one in use.

  ./scripts/cold-start.sh --logs    watch the node (consent prompts included)
  ./scripts/cold-start.sh --down    when finished
EOF
