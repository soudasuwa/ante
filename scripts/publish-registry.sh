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

PURPOSE="${ANTE_REGISTRY_PURPOSE:-ante:identity-level:v2}"
FLOOR="${ANTE_REGISTRY_FLOOR:-12}"
FDEV_ARGS="${FDEV_ARGS:-}"

command -v fdev >/dev/null || {
  echo "fdev not found — install it from https://freenet.org/install.sh" >&2
  exit 1
}

if [ -n "${ANTE_SKIP_BUILD:-}" ]; then
  echo "using the existing contract WASM (ANTE_SKIP_BUILD)"
else
  echo "building the contract WASM (reproducible)…"
  (cd "$CONTRACT_DIR" && "$REPO_ROOT/scripts/build-contract.sh")
fi
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
cargo run -q --manifest-path "$REPO_ROOT/Cargo.toml" -p registry-params -- \
  --purpose "$PURPOSE" --floor "$FLOOR" --out "$PARAMS" >/dev/null
echo "params: purpose=$PURPOSE floor=$FLOOR bits"

INSTANCE_ID="$(fdev get-contract-id --code "$WASM" --parameters "$PARAMS")"
echo "instance id: $INSTANCE_ID"

# Record the generation this one replaces. The lineage has to accumulate as a
# side effect of publishing, not depend on anyone remembering — a predecessor
# that is not recorded is state a future migration cannot reach.
python3 - "$REPO_ROOT/deployments.json" "registry" "$INSTANCE_ID" <<'PYEOF'
import json, sys
path, name, new = sys.argv[1:4]
d = json.load(open(path))
c = d["contracts"][name]
old = c.get("instance", "")
if old and old != new:
    c.setdefault("superseded", []).insert(0, old)
    print(f"  lineage: {name} {old} -> superseded")
c["instance"] = new
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
PYEOF

echo "publishing…"
# shellcheck disable=SC2086
fdev $FDEV_ARGS publish --code "$WASM" --parameters "$PARAMS" contract

# Record it in embedded.ts (keeping the delegate bytes already there).
[ -f "$DELEGATE_WASM" ] || "$REPO_ROOT/scripts/build-delegate.sh"
"$REPO_ROOT/scripts/gen-embedded.sh" "$DELEGATE_WASM" "$INSTANCE_ID"

echo
echo "next: rebuild the UIs — (cd web && npm run build)"
