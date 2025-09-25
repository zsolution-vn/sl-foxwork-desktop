#!/usr/bin/env bash
set -euo pipefail

# mac_build_dev.sh
# Build Mattermost macOS app (x64 + arm64) for local development using Apple Development identity from Keychain.
# Usage: bash scripts/mac_build_dev.sh [--open]

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OPEN_APP=false
if [[ "${1:-}" == "--open" ]]; then
  OPEN_APP=true
fi

echo "[mac-build-dev] Cleaning output directories..."
rm -rf "$ROOT_DIR/release" "$ROOT_DIR/dist"

echo "[mac-build-dev] Building production bundles..."
npm run build-prod

if [[ -z "${CSC_NAME:-}" ]]; then
  echo "[mac-build-dev] Detecting Apple Development identity from Keychain..."
  IDENTITY_LINE=$(security find-identity -v -p codesigning | grep "Apple Development:" | head -n1 || true)
  if [[ -z "$IDENTITY_LINE" ]]; then
    echo "[mac-build-dev] ERROR: No 'Apple Development' identity found in Keychain." >&2
    exit 1
  fi
  # Extract quoted identity string at the end of the line
  CSC_NAME=$(echo "$IDENTITY_LINE" | sed -E 's/^[^\"]+\"(.*)\"$/\1/')
  export CSC_NAME
fi

echo "[mac-build-dev] Using identity: $CSC_NAME"

echo "[mac-build-dev] Building macOS app (x64, arm64) with electron-builder..."
npx --yes electron-builder --mac --x64 --arm64 --publish=never

APP_X64="$ROOT_DIR/release/mac/FoxWork.app"
APP_ARM64="$ROOT_DIR/release/mac-arm64/FoxWork.app"

echo "[mac-build-dev] Verifying signatures..."
codesign -dv --verbose=4 "$APP_X64" | cat || true
codesign -dv --verbose=4 "$APP_ARM64" | cat || true

echo "[mac-build-dev] Gatekeeper assessment (expected 'rejected' for Development cert):"
spctl -a -vvv --type execute "$APP_X64" 2>&1 | cat || true

if $OPEN_APP; then
  echo "[mac-build-dev] Opening app: $APP_X64"
  open "$APP_X64" || true
fi

echo "[mac-build-dev] Done. Artifacts in release/6.0.0-*/ and app bundles in release/mac[ -arm64]/"


