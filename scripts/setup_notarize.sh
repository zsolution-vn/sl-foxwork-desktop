#!/usr/bin/env bash
set -euo pipefail

# setup_notarize.sh
# Setup App Store Connect API Key for notarization
# Usage: bash scripts/setup_notarize.sh <KEY_ID> <ISSUER_ID> <PATH_TO_P8_FILE>

if [[ $# -ne 3 ]]; then
    echo "Usage: bash scripts/setup_notarize.sh <KEY_ID> <ISSUER_ID> <PATH_TO_P8_FILE>"
    echo "Example: bash scripts/setup_notarize.sh ABCDE12345 1a2b3c4d-5e6f-7890-abcd-ef1234567890 /path/to/AuthKey_ABCDE12345.p8"
    exit 1
fi

KEY_ID="$1"
ISSUER_ID="$2"
P8_PATH="$3"

# Validate inputs
if [[ ! -f "$P8_PATH" ]]; then
    echo "ERROR: P8 file not found: $P8_PATH" >&2
    exit 1
fi

if [[ ! "$KEY_ID" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "ERROR: Invalid Key ID format. Should be 10 characters (A-Z, 0-9)" >&2
    exit 1
fi

if [[ ! "$ISSUER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: Invalid Issuer ID format. Should be UUID format" >&2
    exit 1
fi

echo "[setup-notarize] Setting up App Store Connect API Key for notarization..."

# Get absolute path to P8 file
P8_ABSOLUTE_PATH=$(cd "$(dirname "$P8_PATH")" && pwd)/$(basename "$P8_PATH")

# Export environment variables
export APPLE_API_KEY_ID="$KEY_ID"
export APPLE_API_ISSUER="$ISSUER_ID"
export APPLE_API_KEY_PATH="$P8_ABSOLUTE_PATH"

echo "[setup-notarize] Environment variables set:"
echo "  APPLE_API_KEY_ID=$APPLE_API_KEY_ID"
echo "  APPLE_API_ISSUER=$APPLE_API_ISSUER"
echo "  APPLE_API_KEY_PATH=$APPLE_API_KEY_PATH"

# Test API key
echo "[setup-notarize] Testing API key..."
if xcrun notarytool history --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --key "$APPLE_API_KEY_PATH" >/dev/null 2>&1; then
    echo "[setup-notarize] ✅ API key is valid"
else
    echo "[setup-notarize] ❌ API key test failed. Please check your credentials." >&2
    exit 1
fi

echo "[setup-notarize] Ready to build and notarize!"
echo "[setup-notarize] Run: npm run mac:build:dist"
echo "[setup-notarize] Or: npm run mac:build:dist:open"

