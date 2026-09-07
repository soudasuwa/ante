# Reproducible builder for ante's on-network artifacts.
#
# WHY THIS EXISTS
#
# Every address in ante is derived from bytes: the delegate key is
# blake3(blake3(wasm)), a contract instance is blake3(blake3(wasm) ‖ params).
# The whole claim is that you do not have to trust the publisher, because you
# can rebuild the bytes and check the address yourself.
#
# Until this file, you could not. The build was only ever *same-path*
# reproducible: cargo bakes the absolute path of a path dependency into
# `-C metadata`, which changes symbol layout, and no --remap-path-prefix
# reaches that. ante-core at /home/alice/ante and ante-core at
# /home/bob/ante produce different bytes and therefore different keys, so
# artifact-keys.toml could only ever be verified on one machine by one person.
#
# That is not a theoretical gap. The published keys were once ones that no
# clean build reproduced, and every check in between passed, because the check
# ran on the same machine that made them.
#
# Fixing it needs exactly one thing: a path everyone shares. Hence the fixed
# WORKDIR, CARGO_HOME and RUSTUP_HOME below. Change any of the three and every
# artifact re-keys, so treat them as part of the protocol, not as build config.
#
#   docker build -f build/Dockerfile -t ante-build .
#   docker run --rm ante-build            # prints the keys
#
# or just: ./scripts/build-in-container.sh

FROM debian:bookworm-slim

# The three paths that must be identical everywhere. None of them may equal a
# remap TARGET, which is the trap this hit twice: the build scripts rewrite
# $WORKTREE_DIR to the literal "/ante" and $CARGO_HOME/registry/src to
# "/cargo-registry", then grep the WASM for the real paths to prove nothing
# machine-specific leaked. Setting WORKDIR=/ante or CARGO_HOME=/cargo makes that
# grep match its own remapped output and fail a build that is perfectly clean.
#
# So the real paths are /work and /opt/..., and they are remapped to /ante and
# /cargo-registry exactly as a host build's paths are. The strings inside the
# artifact therefore look identical whether it was built here or on a laptop;
# what the fixed path buys is the part no remap reaches, cargo's `-C metadata`.
#
# /opt/... rather than /cargo and /rustup, for a reason worth stating: the
# build scripts remap $CARGO_HOME/registry/src to the literal "/cargo-registry",
# and then grep the WASM for $CARGO_HOME to prove nothing machine-specific
# leaked. With CARGO_HOME=/cargo that grep matches its OWN remap target and the
# guard fails on a build that is perfectly clean. Keeping the two namespaces
# apart is cheaper than teaching the guard to special-case them.
ENV CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# The toolchain version lives in rust-toolchain.toml and NOWHERE else. Copying
# it first means the pin has a single source of truth: bumping it there rebuilds
# with the new compiler here too, with no second place to forget. (A bump is a
# deliberate re-key — see the file's own header.)
COPY rust-toolchain.toml ./
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --default-toolchain none \
    && rustup show

# Sources last, so a source edit does not re-download the toolchain.
COPY . .

# --locked: the committed Cargo.lock is authoritative. Without it a build here
# could silently resolve a newer dependency and produce bytes that do not match
# what the lockfile describes, which is the same class of surprise this whole
# file exists to remove.
RUN ./scripts/build-delegate.sh --locked \
    && (cd contracts/ante-registry && ../../scripts/build-contract.sh --locked) \
    && (cd examples/guestbook/contract && ../../../scripts/build-contract.sh --locked)

# Default command prints what was built, so `docker run` is a complete answer to
# "what keys does this source produce?".
CMD ["./scripts/print-keys.sh"]
