#!/usr/bin/env bash
# Post-publish check that behaves like a user who has never seen this repository:
# a fresh temp directory, a fresh npm cache, and only what npm serves.
#
#   scripts/verify-published.sh            # cap-mcp-bridge@latest
#   scripts/verify-published.sh 0.1.0      # a specific version
#
# Catches a missing shebang, an unbuilt dist, or a `files` array that left something out.
set -euo pipefail

VERSION="${1:-latest}"
URL="${2:-https://services.odata.org/V4/Northwind/Northwind.svc}"
PKG="cap-mcp-bridge@${VERSION}"

cd "$(mktemp -d)"
export npm_config_cache="$(mktemp -d)"   # nothing resolves from a warm cache either
echo "working in $PWD (npm cache $npm_config_cache)"

echo "== $PKG --version"
npx -y "$PKG" --version

echo "== $PKG --print-model against $URL (first 12 lines)"
npx -y "$PKG" --url "$URL" --print-model --log-level warn | head -n 12

echo "== OK: $PKG runs cold"
