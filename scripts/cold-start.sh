#!/usr/bin/env bash
# Stand up a node that has never seen ante, publish the contracts onto it, and
# hand back two dev-server URLs pointed at it.
#
# This exists because incremental testing cannot answer the question it answers.
# Every check we run day to day happens on a node that already holds our state,
# our delegate, and every superseded generation — so it exercises the returning
# user and silently skips the newcomer. The first run of this script found a
# real bug that way: the automatic migration sweeps announced themselves to
# people who had nothing to migrate, so a first-time visitor's opening screen
# read "3 earlier registries did not answer".
#
# It also pins down a fact worth keeping: a published contract that has never
# been updated answers a GET with ZERO BYTES, not NotFound. That is the newcomer
# path, and an unguarded decode of it is the "CBOR: unexpected end of input"
# crash. The script asserts it rather than trusting that we remembered.
#
#   ./scripts/cold-start.sh          # bring it up
#   ./scripts/cold-start.sh --down   # tear it all down
#
# The node runs in local mode with no peers, so contracts must be published by
# hand here. A real newcomer's node fetches them from the network instead. That
# overstates the setup burden and understates nothing about the client — which
# is the half we change.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLD="${ANTE_COLD_DIR:-/tmp/ante-cold}"
WS_PORT="${ANTE_COLD_PORT:-7599}"
VAULT_PORT="${ANTE_COLD_VAULT_PORT:-5173}"
GB_PORT="${ANTE_COLD_GB_PORT:-5174}"

down() {
  pkill -f "config-dir $COLD/config" 2>/dev/null || true
  pkill -f "vite --port $VAULT_PORT" 2>/dev/null || true
  pkill -f "vite --port $GB_PORT" 2>/dev/null || true
  rm -rf "$COLD"
  echo "cold environment torn down"
}
[ "${1:-}" = "--down" ] && { down; exit 0; }

command -v fdev >/dev/null || { echo "fdev not found" >&2; exit 1; }
command -v freenet >/dev/null || { echo "freenet not found" >&2; exit 1; }

echo "==> wiping any previous cold environment"
down >/dev/null 2>&1 || true

# freenet refuses to start if these do not already exist.
mkdir -p "$COLD/config" "$COLD/data"

echo "==> starting a node that has never seen ante (ws :$WS_PORT)"
freenet local --ws-api-port "$WS_PORT" \
  --config-dir "$COLD/config" --data-dir "$COLD/data" \
  > "$COLD/node.log" 2>&1 &
NODE_PID=$!
echo "$NODE_PID" > "$COLD/node.pid"

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$WS_PORT/v1/version" && break
  kill -0 "$NODE_PID" 2>/dev/null || { echo "node died — see $COLD/node.log" >&2; exit 1; }
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$WS_PORT/v1/version" || {
  echo "node never answered — see $COLD/node.log" >&2; exit 1; }
echo "    up: $(curl -s "http://127.0.0.1:$WS_PORT/v1/version")"

# Regenerate params from the values of record rather than reusing a file, so a
# mismatch between deployments.json and what we actually build shows up here.
echo "==> rebuilding params and confirming the recorded addresses derive from them"
REG_WASM="$REPO_ROOT/contracts/ante-registry/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"
GB_WASM="$REPO_ROOT/examples/guestbook/contract/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm"
[ -f "$REG_WASM" ] || (cd "$REPO_ROOT/contracts/ante-registry" && "$REPO_ROOT/scripts/build-contract.sh")
[ -f "$GB_WASM" ]  || (cd "$REPO_ROOT/examples/guestbook/contract" && "$REPO_ROOT/scripts/build-contract.sh")

cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v1}" \
  --floor "${ANTE_REGISTRY_FLOOR:-12}" --out "$COLD/reg.params" >/dev/null
(cd "$REPO_ROOT/examples/guestbook/contract" && cargo run -q --example params -- \
  --purpose "${ANTE_GUESTBOOK_PURPOSE:-ante-guestbook:post:v1}" \
  --min-bits "${ANTE_GUESTBOOK_MIN_BITS:-16}" --out "$COLD/gb.params" >/dev/null)

REG_ID="$(fdev get-contract-id --code "$REG_WASM" --parameters "$COLD/reg.params")"
GB_ID="$(fdev get-contract-id --code "$GB_WASM"  --parameters "$COLD/gb.params")"

python3 - "$REPO_ROOT/deployments.json" "$REG_ID" "$GB_ID" <<'PYEOF'
import json, sys
path, reg, gb = sys.argv[1:4]
d = json.load(open(path))
bad = False
for name, built in (("registry", reg), ("guestbook", gb)):
    rec = d["contracts"][name]["instance"]
    if rec == built:
        print(f"    ok  {name:<10} {built}")
    else:
        print(f"    BAD {name:<10} built {built} but deployments.json records {rec}")
        bad = True
sys.exit(1 if bad else 0)
PYEOF

echo "==> publishing onto the cold node"
fdev -p "$WS_PORT" publish --code "$REG_WASM" --parameters "$COLD/reg.params" contract >/dev/null 2>&1
fdev -p "$WS_PORT" publish --code "$GB_WASM"  --parameters "$COLD/gb.params"  contract >/dev/null 2>&1

# The assertion this script exists for. A never-updated contract answers with an
# empty body; anything that decodes it without checking crashes on a newcomer's
# very first screen.
echo "==> asserting a never-updated contract reads as zero bytes, not NotFound"
fail=0
for pair in "registry:$REG_ID" "guestbook:$GB_ID"; do
  name="${pair%%:*}"; id="${pair#*:}"
  if fdev -p "$WS_PORT" execute get "$id" -o "$COLD/$name.state" --timeout 30 >/dev/null 2>&1; then
    n=$(wc -c < "$COLD/$name.state")
    if [ "$n" -eq 0 ]; then
      echo "    ok  $name reads 0 bytes"
    else
      echo "    note $name reads $n bytes — not virgin state"
    fi
  else
    echo "    BAD $name did not answer a GET at all"; fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1

echo "==> starting dev servers (?node= is dev-build only, which is why these are dev servers)"
(cd "$REPO_ROOT/web" && npx vite --port "$VAULT_PORT" --strictPort > "$COLD/vault-dev.log" 2>&1 &)
(cd "$REPO_ROOT/examples/guestbook/web" && npx vite --port "$GB_PORT" --strictPort > "$COLD/gb-dev.log" 2>&1 &)
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$VAULT_PORT" \
    && curl -sf -o /dev/null "http://127.0.0.1:$GB_PORT" && break
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

  ./scripts/cold-start.sh --down    when finished
EOF
