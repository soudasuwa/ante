#!/usr/bin/env bash
# Publish the example guestbook contract and print the instance id to drop into
# examples/guestbook/web/src/guestbook.ts (or pass as ?contract=<id>).
#
# Needs `fdev` on PATH and a running node (127.0.0.1:7509 by default — set
# FDEV_ARGS='--node-url ws://…' otherwise). The purpose / min-bits here MUST
# match GUESTBOOK_PURPOSE / GUESTBOOK_MIN_BITS in the web app.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/examples/guestbook/contract"

PURPOSE="${ANTE_GUESTBOOK_PURPOSE:-ante-guestbook:post:v1}"
MIN_BITS="${ANTE_GUESTBOOK_MIN_BITS:-16}"
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
WASM="$CONTRACT_DIR/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
(cd "$CONTRACT_DIR" && cargo run -q --example params -- \
  --purpose "$PURPOSE" --min-bits "$MIN_BITS" --out "$PARAMS" >/dev/null)
echo "params: purpose=$PURPOSE min_bits=$MIN_BITS"

INSTANCE_ID="$(fdev get-contract-id --code "$WASM" --parameters "$PARAMS")"
echo "instance id: $INSTANCE_ID"

# Record the generation this one replaces. The lineage has to accumulate as a
# side effect of publishing, not depend on anyone remembering — a predecessor
# that is not recorded is state a future migration cannot reach.
python3 - "$REPO_ROOT/deployments.json" "guestbook" "$INSTANCE_ID" <<'PYEOF'
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

cat <<EOF

published. now either:
  - set GUESTBOOK_CONTRACT_ID = "$INSTANCE_ID" in
    examples/guestbook/web/src/guestbook.ts, or
  - open the app with ?contract=$INSTANCE_ID

then: npm run build --workspace ante-guestbook-web
EOF
