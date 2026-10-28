# Payminto Clearing

**Agent payments, cleared on HashKey Chain.**

AI agents pay APIs, MCP tools and other agents per call with gas-free signed vouchers, inside a budget their owner signed once.
A self-hosted Clearing Node checks every call, then clears hundreds of them into a few netted, HSP-wrapped transfers on HashKey Chain.
Every single call stays provable on chain, and nobody, including the node operator, ever holds the money.

Built for the HashKey Chain Horizon Hackathon (Mumbai edition), track: Agent Payments & A2A Settlement.

## Why it exists

Paying every agent call on chain does not work: a stablecoin transfer costs about 34,000 gas, which rivals the price of a 0.002 USDC API call.
x402 moves single payments, AP2 proves consent, ERC-8004 proves identity, but nothing owns the middle layer that budgets, meters, nets and proves agent spend, and nothing offers it self-hosted.
Payminto Clearing is that layer.

## How it works

1. **Mandate.** An owner (a person, a treasury, or a Safe) signs an EIP-712 mandate: total cap, per-call cap, daily cap, rate limit, payee allowlist, expiry.
2. **Vouchers.** The agent calls a paid endpoint, gets HTTP 402 (x402 v2), and retries with a signed cumulative voucher. No gas, one signature.
3. **Policy, three times.** The agent SDK refuses to sign anything outside the mandate, the node refuses to accept it, and the contract enforces the hard limits again at settlement.
4. **Netting.** `ClearingHub.settleBatch` verifies every signature and cap on chain, nets all obligations between all agents and providers, and moves only net amounts, wallet to wallet.
5. **HSP.** Each net transfer is an HSP payment whose `settlementBinding` is the batch id, and the node acts as an HSP adapter that verifies and signs the receipt.
6. **Proof.** The Merkle root of every call receipt is stored per batch, so anyone can prove any single call with `verifyReceipt`.

Built for HashKey Chain specifically ([docs/HASHKEY.md](docs/HASHKEY.md)):
- **Finality.** A settlement is `included` at one confirmation and `confirmed`, booked and HSP-verified only once its block is at or below the `safe` head; a reorged-out settlement is rebroadcast, never double-booked.
- **Gasless agents.** An agent signs an EIP-2612 permit for USDC.e ("Bridged USDC", version 2) and the node opens its mandate with `openMandateWithPermit`: the agent holds no HSK and sends no transaction.
- **USDC.e blacklist.** Every party is screened with `isBlacklisted` through Multicall3 before a batch is sent, so one blacklisted wallet cannot revert a whole netting batch.
- **Fees and RPC.** The OP Stack L1 data fee is priced into the operator preflight and stored per batch; RPC calls retry with jittered backoff, and stuck settlements are replaced with the same nonce and 12.5 % higher fees.
- **Ecosystem contracts.** Safe 1.4.1 owners (ERC-1271), Multicall3, the CREATE2 deployer, the GasPriceOracle and EAS attestations per batch (`EAS_ATTEST=true`), all proven on a testnet fork by `pnpm test:fork`.

Measured: one batch cleared 640 calls for 1.91M gas, versus 22.04M gas for one transfer per call, 11.6x less ([docs/GAS.md](docs/GAS.md)).

## Repository

| Path | What |
|---|---|
| [`contracts/`](contracts) | `ClearingHub.sol` (Foundry): mandates, vouchers, multilateral netting, receipt roots. No owner, no upgrade keys, never holds funds. |
| [`packages/protocol/`](packages/protocol) | Shared TypeScript: ABI, EIP-712 types, Merkle trees, policy hashing, HSP wire v1, x402 headers. Tested for parity against the deployed contract. |
| [`packages/sdk/`](packages/sdk) | `@payminto/sdk`: `OwnerClient`, `AgentClient` (x402 fetch, pre-sign policy guard, HSP co-signing), `paywall()` for providers. |
| [`apps/node/`](apps/node) | The self-hosted Clearing Node: API, policy engine, SQLite ledger, settlement worker, HSP adapter, live events. |
| [`apps/dashboard/`](apps/dashboard) | Operator console: overview, netting, mandates, providers, batches, receipt proofs, ledger. |
| [`apps/mcp/`](apps/mcp) | MCP server that gives any MCP-capable agent a budget-bound wallet. |
| [`apps/demo/`](apps/demo) | Three paid services, two agents, scripted attacks, and the one-command demo. |
| [`docs/`](docs) | Spec, architecture and threat model, gas, deploy guide, strategy, pitch and submission. |

## Quick start (local, no real money)

Requirements: Node 22.18+ (`nvm install` reads `.nvmrc`), pnpm 9 (`corepack enable`), Foundry 1.5+ (`anvil` and `forge` on PATH).
The code runs TypeScript directly with Node's built-in type stripping, so there is no build step.

```bash
git clone <this repo> payminto-clearing && cd payminto-clearing
pnpm install
pnpm demo
```

`pnpm demo` starts a private anvil chain, deploys the contracts with `forge`, starts the node and three paid services, runs about 500 agent calls including two blocked attacks, settles them, prints the result with an on-chain proof check, and exits.
It uses only public anvil dev keys on chain 31337, so no real money is involved.

To watch it in the dashboard, use the staged run, which keeps the node up and walks through the story one Enter at a time:

```bash
pnpm demo:stage                                                         # terminal 1
NEXT_PUBLIC_NODE_URL=http://localhost:8787 pnpm --filter dashboard dev  # terminal 2
```

Open http://localhost:3000 and sign in with the local admin token `dev-admin-token`.
If port 8787 is busy, `demo:stage` prints the port it picked; use that in `NEXT_PUBLIC_NODE_URL`.

Tests:

```bash
pnpm contracts:test
pnpm test
pnpm typecheck
pnpm test:fork   # optional: anvil --fork-url https://testnet.hsk.xyz with the real testnet USDC, a real Safe and EAS
```

CI runs the same commands plus the dashboard build, `pnpm demo` on a clean checkout, and the Docker stack ([.github/workflows/ci.yml](.github/workflows/ci.yml)); the fork suite runs as a non-blocking job because it depends on the public testnet RPC.

## Self-host with Docker

The node and dashboard ship as Docker images (Node 22 slim, non-root, SQLite on a named volume, health checks).
A local stack with its own anvil chain needs no keys and no money:

```bash
docker compose --profile local up --build
```

This starts anvil, deploys `ClearingHub` and a mock USDC once (`forge script`), then the node on http://localhost:8787 and the dashboard on http://localhost:3000 (admin token `dev-admin-token`).
Chain state and the node database survive restarts; `docker compose --profile local down -v` wipes both.

For HashKey Chain, copy `.env.docker.example` to `.env`, set `CHAIN_ID`, a fresh `OPERATOR_KEY` and a random 32+ character `ADMIN_TOKEN`, then run `docker compose up -d --build`.
On chains 133 and 177 the node refuses to start with a public anvil/hardhat key, the dev admin token, or no deploy block.
Ports bind to 127.0.0.1; put a TLS reverse proxy in front as described in [docs/OPERATIONS.md](docs/OPERATIONS.md), which also covers backups, upgrades, monitoring and key handling.

## HashKey Chain

| | Mainnet (177) | Testnet (133) |
|---|---|---|
| ClearingHub | `<HUB_ADDRESS_MAINNET>` | `<HUB_ADDRESS_TESTNET>` |
| Settlement token | USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hskchain.net |

Deployment steps are in [docs/DEPLOY.md](docs/DEPLOY.md); running a node in production is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Status and honesty notes

- The official HSP SDK repository and the hackathon Coordinator were not reachable when we built this, so the node implements HSP wire v1 behind one interface, with a built-in adapter and verifier, and a Coordinator client ready for credentials that resolves the chain and verifying contract from the Coordinator's `GET /chains`.
- Per-call and daily caps are enforced by the agent and the node; total cap, allowlist and expiry are additionally enforced on chain. The mandate's `policyHash` commits to the off-chain rules.
- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the trust model and known limitations.

## License

MIT
