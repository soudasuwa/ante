#!/usr/bin/env bash
# Publish the ante-registry contract and stage its id for the web UI.
#
# Needs `fdev` on PATH and a running local node. Run once (and again only if
# you change the registry contract or its parameters — a new build re-keys it).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/contracts/ante-registry"
GEN="$REPO_ROOT/web/.gen"

PURPOSE="${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v1}"
FLOOR="${ANTE_REGISTRY_FLOOR:-12}"

command -v fdev >/dev/null || {
  echo "fdev not found. Install it: cargo install --git https://github.com/freenet/freenet-core fdev" >&2
  exit 1
}

echo "building the contract WASM…"
(cd "$CONTRACT_DIR" && cargo build --release --target wasm32-unknown-unknown)
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"

PARAMS_HEX="$(cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "$PURPOSE" --floor "$FLOOR" | awk '/^hex/ {print $2}')"

echo "purpose: $PURPOSE   floor: $FLOOR bits"
echo "params (hex): $PARAMS_HEX"
echo
echo "publishing…"
# fdev's exact publish flags vary by version — adjust if it complains. The
# goal: register this WASM with these parameters and print the instance id.
fdev publish --code "$WASM" --parameters "$PARAMS_HEX" contract

echo
echo "Paste the instance id fdev printed:"
read -r INSTANCE_ID

mkdir -p "$GEN"
printf '%s\n' "$INSTANCE_ID" > "$GEN/registry_contract_id.txt"
echo "wrote $GEN/registry_contract_id.txt — rebuild the UI to pick it up."
