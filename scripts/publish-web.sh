#!/usr/bin/env bash
# Publish (or update) the ante web UI as a Freenet website.
#
# `fdev website` is the built-in stable-URL container: a committed, never-
# recompiled contract WASM + your signing key fix the URL forever
# (key = blake3(website_contract_wasm ‖ your_verifying_key)); `update` pushes
# new content to the same URL with a higher version.
#
# First run:
#   fdev website init ante          # generates ~/.config/freenet/website-keys/ante.toml — BACK IT UP
#   ./scripts/publish-web.sh
#
# Losing the key file means you can never update the site again.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_NAME="${ANTE_WEBSITE_KEY:-ante}"
FDEV_ARGS="${FDEV_ARGS:-}"

command -v fdev >/dev/null || {
  echo "fdev not found — install it from https://freenet.org/install.sh" >&2
  exit 1
}

if ! fdev website list 2>/dev/null | grep -q "^${KEY_NAME} "; then
  echo "No website key '${KEY_NAME}'. Run:  fdev website init ${KEY_NAME}" >&2
  echo "(then back up ~/.config/freenet/website-keys/${KEY_NAME}.toml)" >&2
  exit 1
fi

echo "building the delegate + UI…"
"$REPO_ROOT/scripts/sync-delegate.sh" >/dev/null
(cd "$REPO_ROOT/web" && npm run build)

echo "publishing…"
# `publish` and `update` are the same call — the node PUTs or UPDATEs based on
# whether the contract already exists, and the contract enforces a strictly
# increasing version.
# shellcheck disable=SC2086
fdev $FDEV_ARGS website update "$REPO_ROOT/web/dist" --key "$KEY_NAME"
