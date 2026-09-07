#!/usr/bin/env bash
# DEPLOYMENTS.md is for humans; deployments.json is what the apps compile in.
# They must not drift, or the docs will point somewhere the apps do not.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
status=0
while read -r addr; do
  [ -z "$addr" ] && continue
  if grep -q -F "$addr" "$REPO_ROOT/DEPLOYMENTS.md"; then
    echo "  ✓ $addr"
  else
    echo "  ✗ $addr is in deployments.json but not DEPLOYMENTS.md" >&2
    status=1
  fi
done < <(python3 -c "
import json
d = json.load(open('$REPO_ROOT/deployments.json'))
for s in d['sites'].values(): print(s['contract'])
for c in d['contracts'].values(): print(c['instance'])
")
[ "$status" -eq 0 ] && echo "deployments.json and DEPLOYMENTS.md agree"
exit "$status"
