#!/usr/bin/env bash
# Build ante's artifacts at a fixed path, so the keys can be checked by anyone.
#
#   ./scripts/build-in-container.sh            # build and print the keys
#   ./scripts/build-in-container.sh --check    # ...and compare with artifact-keys.toml
#   ./scripts/build-in-container.sh --extract  # ...and copy the WASM out
#
# This is the canonical build. A host build (scripts/build-delegate.sh) is for
# iterating; its bytes depend on where the repo happens to live, because cargo
# hashes a path dependency's absolute path into `-C metadata` and no
# --remap-path-prefix reaches that. Only a shared path makes the keys agree
# across machines, which is the difference between "trust me" and "check it".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ANTE_BUILD_IMAGE:-ante-build}"
MODE="${1:-}"

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }

echo "==> building the image (fixed WORKDIR /work)"
docker build -q -f "$REPO_ROOT/build/Dockerfile" -t "$IMAGE" "$REPO_ROOT" >/dev/null

echo "==> keys from the container build"
KEYS="$(docker run --rm "$IMAGE")"
echo "$KEYS" | sed 's/^/    /'

if [ "$MODE" = "--extract" ]; then
  OUT="$REPO_ROOT/build/out"
  mkdir -p "$OUT"
  CID="$(docker create "$IMAGE")"
  trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
  docker cp "$CID:/work/ante-delegate/target/wasm32-unknown-unknown/release/ante_delegate.wasm" "$OUT/"
  docker cp "$CID:/work/contracts/ante-registry/target/wasm32-unknown-unknown/release/ante_registry_contract.wasm" "$OUT/"
  docker cp "$CID:/work/examples/guestbook/contract/target/wasm32-unknown-unknown/release/ante_guestbook_contract.wasm" "$OUT/"
  echo "==> WASM extracted to build/out/"
fi

if [ "$MODE" = "--check" ]; then
  echo "==> comparing with artifact-keys.toml"
  python3 - "$REPO_ROOT/artifact-keys.toml" <<PYEOF
import re, sys
text = open(sys.argv[1]).read()
# Only the CURRENT blocks; [[superseded]] entries are history, not the claim.
current = text.split("[[superseded]]")[0]

def get(pattern):
    m = re.search(pattern, current, re.M)
    return m.group(1) if m else None

recorded = {
    "delegate":      get(r'^key\s*=\s*"([0-9a-f]{64})"'),
    "ante-registry": get(r'^ante_registry_code_hash\s*=\s*"([0-9a-f]{64})"'),
    "guestbook":     get(r'^guestbook_code_hash\s*=\s*"([0-9a-f]{64})"'),
}

built = {}
for line in """$KEYS""".strip().splitlines():
    parts = line.split()
    if len(parts) == 2:
        built[parts[0]] = parts[1]

status = 0
for name in ("delegate", "ante-registry", "guestbook"):
    r, b = recorded.get(name), built.get(name)
    if r is None:
        print(f"    ?  {name:<14} not found in artifact-keys.toml"); status = 1
    elif r == b:
        print(f"    ok {name:<14} {b}")
    else:
        print(f"    NO {name:<14} container built {b}")
        print(f"       {'':<14} record says   {r}")
        status = 1
if status:
    print()
    print("The container build disagrees with the committed record. Either the")
    print("record was made by a host build (its bytes depend on the repo's path,")
    print("which is why this container exists), or the source has moved since.")
    print("Adopting the container as canonical is a deliberate re-key: run")
    print("ANTE_ACCEPT_REKEY=1 ./scripts/check-keys.sh and publish.")
sys.exit(status)
PYEOF
fi
