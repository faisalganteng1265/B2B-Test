#!/usr/bin/env bash
# Deploys MockUSDT/MockUSDC to the configured chain (default Base Sepolia), mints client balances,
# writes deployments/<chainId>.json, and tops up client wallets with gas ETH.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && source .env; set +a
RPC="${RPC_URLS%%,*}"
: "${DEPLOYER_PRIVATE_KEY:?set in .env}" "${CLIENT_WALLETS:?set in .env}"

echo "waiting for RPC $RPC ..."
for i in $(seq 1 30); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 2; done
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
echo "chainId=$CHAIN_ID"

if [ -f "deployments/$CHAIN_ID.json" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "deployments/$CHAIN_ID.json exists (set FORCE=1 to redeploy)"
else
  (cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow -q)
  echo "wrote deployments/$CHAIN_ID.json"
fi

# Gas top-up so client wallets can send test deposits.
MIN_WEI=$(cast to-wei "${CLIENT_GAS_MIN_ETH:-0.005}")
TOPUP=${CLIENT_GAS_TOPUP_ETH:-0.02}
IFS=',' read -ra W <<< "$CLIENT_WALLETS"
for w in "${W[@]}"; do
  bal=$(cast balance "$w" --rpc-url "$RPC")
  if python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) < int(sys.argv[2]) else 1)" "$bal" "$MIN_WEI"; then
    echo "topping up $w with $TOPUP ETH"
    cast send "$w" --value "${TOPUP}ether" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
  fi
done
cat "deployments/$CHAIN_ID.json"
