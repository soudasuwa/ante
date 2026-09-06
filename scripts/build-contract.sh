#!/usr/bin/env bash
# Build a contract crate's WASM the one canonical way, from inside its
# directory.
#
# A contract's address IS its WASM bytes (`blake3(wasm ‖ params)`), so the
# build must not bake in machine-specific paths — `panic!` embeds `file!()` as
# rodata, and for the cargo registry that is an absolute path under
# $CARGO_HOME. Remap them to fixed placeholders and refuse the build if any
# leaked.
set -euo pipefail

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
CRATE_DIR="$(pwd)"

export RUSTFLAGS="${RUSTFLAGS:-} \
  --remap-path-prefix=$CARGO_HOME_DIR/registry/src=/cargo-registry \
  --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup \
  --remap-path-prefix=$CRATE_DIR=/crate"

cargo build --target wasm32-unknown-unknown --release "$@"

WASM="$(find target/wasm32-unknown-unknown/release -maxdepth 1 -name '*.wasm' -print -quit)"
[ -n "$WASM" ] || { echo "no .wasm produced" >&2; exit 1; }

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory -o "$WASM.opt" "$WASM" && mv "$WASM.opt" "$WASM"
fi

echo "wasm: $WASM ($(wc -c < "$WASM") bytes)"
command -v b3sum >/dev/null 2>&1 && echo "code_hash: $(b3sum --no-names "$WASM")"

for leak in "$CARGO_HOME_DIR" "$RUSTUP_HOME_DIR" "$CRATE_DIR"; do
  if grep -a -q -F "$leak" "$WASM"; then
    echo "ERROR: '$leak' is embedded in the WASM — the contract id would be machine-specific." >&2
    exit 1
  fi
done
