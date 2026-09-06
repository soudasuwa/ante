#!/usr/bin/env bash
# Publish the ante-registry contract and record its id in @ante/client.
#
# Needs `fdev` on PATH and a running node (defaults to 127.0.0.1:7509 — pass
# FDEV_ARGS='--node-url ws://…' for a remote one). Run once, and again only if
# the contract or its parameters change (a new build re-keys the instance).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/contracts/ante-registry"
DELEGATE_WASM="$REPO_ROOT/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm"

PURPOSE="${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v1}"
FLOOR="${ANTE_REGISTRY_FLOOR:-12}"
FDEV_ARGS="${FDEV_ARGS:-}"

command -v fdev >/dev/null || {
  echo "fdev not found — install it from https://freenet.org/install.sh" >&2
  exit 1
}

echo "building the contract WASM (reproducible)…"
(cd "$CONTRACT_DIR" && "$REPO_ROOT/scripts/build-contract.sh")
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "$PURPOSE" --floor "$FLOOR" --out "$PARAMS" >/dev/null
echo "params: purpose=$PURPOSE floor=$FLOOR bits"

INSTANCE_ID="$(fdev get-contract-id --code "$WASM" --parameters "$PARAMS")"
echo "instance id: $INSTANCE_ID"

echo "publishing…"
# shellcheck disable=SC2086
fdev $FDEV_ARGS publish --code "$WASM" --parameters "$PARAMS" contract

# Record it in embedded.ts (keeping the delegate bytes already there).
[ -f "$DELEGATE_WASM" ] || "$REPO_ROOT/scripts/build-delegate.sh"
"$REPO_ROOT/scripts/gen-embedded.sh" "$DELEGATE_WASM" "$INSTANCE_ID"

echo
echo "next: rebuild the UIs — (cd web && npm run build)"
