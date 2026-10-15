#!/bin/bash
# Maestro CLI to /opt/maestro. Pinned to the 2.5.x release the laptop AVD
# path is verified on, so recipes behave the same on both backends, and
# checked against the sha256 Maestro publishes beside the release
# (checksums_sha256.txt for cli-2.5.1; the value below was compared to it and
# to a fresh download on 2026-10-14).
set -euo pipefail

# The mobile-integration playbook documents recipes verified against Maestro
# 2.3.0-2.5.1 (the dadb 1.2.10 line); 2.5.1 stays inside that window. A bump is
# a new version AND a new sha256, together.
MAESTRO_VERSION=2.5.1
MAESTRO_SHA256=2d924bfd37cccabca438a727213648cbfe4f8bb711559ec8e9d199dc09a5ce52
INSTALL_DIR=/opt/maestro

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "https://github.com/mobile-dev-inc/maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip" \
  -o "$work/maestro.zip"
echo "${MAESTRO_SHA256}  $work/maestro.zip" | sha256sum -c -

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
unzip -q "$work/maestro.zip" -d "$INSTALL_DIR"

# Maestro distributes as `maestro/bin/maestro`; symlink for convenience.
ln -sf "$INSTALL_DIR/maestro/bin/maestro" /usr/local/bin/maestro

# Smoke test.
maestro --version | tee /var/log/maestro-version.log
echo "maestro=${MAESTRO_VERSION} sha256=${MAESTRO_SHA256}" >>/opt/ace/MANIFEST.txt
