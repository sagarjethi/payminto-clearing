# Deploying ClearingHub to HashKey Chain

The hub has no owner, no admin keys and no upgrade path, so a deployment is final and safe to share.
It never holds funds.
Deploying costs only gas in HSK.

## 1. Prerequisites

- Foundry 1.5 or newer (`forge --version`).
- A deployer wallet with a little HSK: a few cents of HSK is plenty at HashKey Chain gas prices.
- Testnet HSK comes from https://faucet.hsk.xyz/faucet.

Keep the deployer key out of shell history and out of this repo.
The simplest safe option is a Foundry keystore:

```bash
cast wallet import payminto-deployer --interactive
```

## 2. Testnet first (chain 133)

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url hashkey_testnet --broadcast --account payminto-deployer
```

The address is written to `contracts/deployments/133.json`.
Verify the source on the testnet explorer:

```bash
forge verify-contract <HUB_ADDRESS> src/ClearingHub.sol:ClearingHub --chain 133 --verifier blockscout --verifier-url https://testnet-explorer.hsk.xyz/api/
```

## 3. Mainnet (chain 177) - required for a demo slot

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url hashkey --broadcast --account payminto-deployer
forge verify-contract <HUB_ADDRESS> src/ClearingHub.sol:ClearingHub --chain 177 --verifier blockscout --verifier-url https://hsk.blockscout.com/api/
```

The address is written to `contracts/deployments/177.json`, which the node and dashboard read automatically.
Sourcify also supports chain 177 and 133 if Blockscout verification is slow: add `--verifier sourcify`.

## 4. Point a Clearing Node at it

```bash
CHAIN_ID=177 \
OPERATOR_KEY=<node operator key, holds a little HSK for settlement gas> \
ADMIN_TOKEN=<long random string> \
pnpm --filter @payminto/node start
```

The token defaults to mainnet USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a`.
Agents need USDC.e in their own wallets and a one-time `approve(hub, cap)`; the SDK `ensureAllowance` does this.

## 5. A real mainnet smoke test for the submission

1. Fund two agent wallets with 1 USDC.e each and a little HSK.
2. Create one mandate per agent with a 1 USDC.e total cap from the dashboard.
3. Run the demo against mainnet with tiny prices (for example 0.001 USDC.e per call).
4. Settle once and record the `settleBatch` transaction link on https://hsk.blockscout.com for the submission.

Total cost is well under 2 USD including gas.
