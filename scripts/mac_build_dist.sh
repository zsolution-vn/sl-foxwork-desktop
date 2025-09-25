#!/usr/bin/env bash
set -euo pipefail

# mac_build_dist.sh
# Build & Notarize Mattermost macOS app (x64 + arm64) for distribution using Developer ID identity.
# Requirements:
#   - Keychain has "Developer ID Application: ... (TEAMID)" identity, or provide via CSC_NAME
#   - Environment vars for notarization:
#       APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
# Usage:
#   CSC_NAME="Developer ID Application: Your Company (TEAMID)" \
#   APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... \
#   bash scripts/mac_build_dist.sh [--open]

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OPEN_APP=false
if [[ "${1:-}" == "--open" ]]; then
  OPEN_APP=true
fi

# Check for App Store Connect API Key (preferred) or Apple ID credentials
if [[ -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" || -z "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo "[mac-build-dist] ERROR: Either App Store Connect API Key or Apple ID credentials must be set for notarization." >&2
    echo "[mac-build-dist] For API Key: APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH" >&2
    echo "[mac-build-dist] For Apple ID: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID" >&2
    exit 1
  fi
fi

if [[ -z "${CSC_NAME:-}" ]]; then
  echo "[mac-build-dist] Detecting Developer ID identity from Keychain..."
  IDENTITY_LINE=$(security find-identity -v -p codesigning | grep "Developer ID Application:" | head -n1 || true)
  if [[ -z "$IDENTITY_LINE" ]]; then
    echo "[mac-build-dist] ERROR: No 'Developer ID Application' identity found in Keychain. Set CSC_NAME or import .p12." >&2
    exit 1
  fi
  # Extract quoted identity string and remove "Developer ID Application:" prefix if present
  CSC_NAME=$(echo "$IDENTITY_LINE" | sed -E 's/^[^\"]+\"(.*)\"$/\1/' | sed -E 's/^Developer ID Application: //')
  export CSC_NAME
fi

echo "[mac-build-dist] Using identity: $CSC_NAME"

# Show notarization method
if [[ -n "${APPLE_API_KEY_ID:-}" ]]; then
  echo "[mac-build-dist] Using App Store Connect API Key for notarization"
  # Export electron-builder compatible environment variables
  export APPLE_API_KEY="$APPLE_API_KEY_PATH"
  export APPLE_API_KEY_ID="$APPLE_API_KEY_ID"
  export APPLE_API_ISSUER="$APPLE_API_ISSUER"
else
  echo "[mac-build-dist] Using Apple ID credentials for notarization"
fi

echo "[mac-build-dist] Cleaning output directories..."
rm -rf "$ROOT_DIR/release" "$ROOT_DIR/dist"

echo "[mac-build-dist] Building production bundles..."
npm run build-prod

echo "[mac-build-dist] Building signed & notarized macOS universal app (x64 + arm64)..."
npx --yes electron-builder --mac --universal --publish=never

APP_UNIVERSAL="$ROOT_DIR/release/mac-universal/FoxWork.app"

echo "[mac-build-dist] Verifying signatures..."
codesign -dv --verbose=4 "$APP_UNIVERSAL" | cat || true

echo "[mac-build-dist] Gatekeeper assessment (should pass after notarization):"
spctl -a -vvv --type execute "$APP_UNIVERSAL" 2>&1 | cat || true

if $OPEN_APP; then
  echo "[mac-build-dist] Opening universal app: $APP_UNIVERSAL"
  open "$APP_UNIVERSAL" || true
fi

echo "[mac-build-dist] Done. Universal app in release/mac/ and artifacts in release/6.0.0-*/"


