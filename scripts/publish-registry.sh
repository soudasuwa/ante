#!/usr/bin/env bash
# Publish the ante-registry contract and stage its id for the web UI.
#
# Needs `fdev` on PATH and a running local node (defaults to 127.0.0.1:7509 —
# pass FDEV_ARGS='--address 1.2.3.4' or '--node-url ws://…' for a remote one).
# Run once, and again only if you change the contract or its parameters (a new
# build re-keys the instance).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/contracts/ante-registry"
GEN="$REPO_ROOT/web/.gen"

PURPOSE="${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v1}"
FLOOR="${ANTE_REGISTRY_FLOOR:-12}"
FDEV_ARGS="${FDEV_ARGS:-}"

command -v fdev >/dev/null || {
  echo "fdev not found — install it from https://freenet.org/install.sh" >&2
  exit 1
}

echo "building the contract WASM…"
(cd "$CONTRACT_DIR" && cargo build --release --target wasm32-unknown-unknown)
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"

mkdir -p "$GEN"
PARAMS="$GEN/registry_params.cbor"
cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "$PURPOSE" --floor "$FLOOR" --out "$PARAMS" >/dev/null
echo "params: purpose=$PURPOSE floor=$FLOOR bits  ->  $PARAMS"

# The instance id is a pure function of (code, parameters) — compute it without
# touching the node so we can stage it even if publish is slow.
INSTANCE_ID="$(fdev get-contract-id --code "$WASM" --parameters "$PARAMS")"
echo "instance id: $INSTANCE_ID"

echo "publishing…"
# shellcheck disable=SC2086
fdev $FDEV_ARGS publish --code "$WASM" --parameters "$PARAMS" contract

printf '%s\n' "$INSTANCE_ID" > "$GEN/registry_contract_id.txt"
echo
echo "staged $GEN/registry_contract_id.txt"
echo "now: cd web && npm run build   (or restart npm run dev)"
