#!/usr/bin/env bash
# Verifies the deployed ClearingHub source on HashKey Chain.
# Usage: script/verify.sh <133|177> [hub-address]
# The address defaults to deployments/<chainId>.json. Tries Blockscout first, then falls back to Sourcify.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHAIN_ID="${1:-}"
case "$CHAIN_ID" in
  177) VERIFIER_URL="https://hsk.blockscout.com/api/" ;;
  133) VERIFIER_URL="https://testnet-explorer.hskchain.net/api/" ;;
  *)
    echo "usage: script/verify.sh <133|177> [hub-address]" >&2
    exit 64
    ;;
esac

HUB="${2:-}"
if [[ -z "$HUB" ]]; then
  FILE="deployments/${CHAIN_ID}.json"
  [[ -f "$FILE" ]] || { echo "no $FILE and no address given" >&2; exit 1; }
  HUB="$(sed -n 's/.*"clearingHub": *"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$FILE")"
  [[ -n "$HUB" ]] || { echo "could not read clearingHub from $FILE" >&2; exit 1; }
fi

CONTRACT="src/ClearingHub.sol:ClearingHub"
echo "verifying $CONTRACT at $HUB on chain $CHAIN_ID"

if forge verify-contract "$HUB" "$CONTRACT" --chain "$CHAIN_ID" --verifier blockscout --verifier-url "$VERIFIER_URL" --watch; then
  echo "verified on Blockscout ($VERIFIER_URL)"
  exit 0
fi

echo "Blockscout verification failed, falling back to Sourcify" >&2
forge verify-contract "$HUB" "$CONTRACT" --chain "$CHAIN_ID" --verifier sourcify --watch
echo "verified on Sourcify"
