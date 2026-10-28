# Payminto Clearing demo

Three paid services, three agents and the scripted live demo, on the real stack: ClearingHub, the Clearing Node, the SDK paywall, `AgentClient` and the MCP server.
The build contract is `docs/SPEC.md` section 8.

## One command

```sh
pnpm install
pnpm demo
```

It starts its own anvil on a free port, deploys with `forge script script/DeployLocal.s.sol`, starts the Clearing Node in-process on a fresh `*.demo.db`, registers and serves the providers, mints test USDC, opens three mandates on chain, runs about 500 paid calls at concurrency 24, settles, and prints a summary.
The summary shows calls, gross, net, on-chain transfers decoded from the tx receipts, the compression ratio, settlement gas versus a measured one-transfer-per-call baseline, every denial with its rule, HSP status per transfer, a Merkle proof checked on chain with `verifyReceipt`, the trial balance, and the dashboard URL.
It exits non-zero if any check fails.
Ctrl-C stops the node, providers and anvil; anvil also runs under a watchdog that stops it if the demo process dies.

## Stage mode

```sh
pnpm demo:stage
```

Same stack, paced (about 14 calls per second, `DEMO_STAGE_PACE`), advancing one demo step per Enter: mandate, agents buying with the two attacks, netting preview, settle (click Settle now in the dashboard, or press Enter in the terminal), batch with HSP status, a judge-picked call proven on chain, and the books.
Node and providers keep running afterwards so the dashboard stays live; Ctrl-C stops everything.
Start the dashboard in a second terminal with the URL the demo prints, for example:

```sh
NEXT_PUBLIC_NODE_URL=http://localhost:8787 pnpm --filter dashboard dev
```

The local admin token is the public dev token `dev-admin-token` that the dashboard pre-fills for a local node.

## Cast

| Who | Port | Price (local) | Role |
|---|---|---|---|
| Market Data | 4101 | 0.002 USDC per quote | HSK, BTC and ETH quotes from CoinGecko (cached 30 s, 1.5 s timeout) with a deterministic fallback; every response has a `source` field |
| Risk Scan | 4102 | 0.01 USDC per address | Deterministic heuristic score, labelled as such in every response |
| Research Writer | 4103 | 0.05 USDC per brief | An agent and a provider: each brief buys 2 quotes and 1 scan with its own mandate |
| Premium Alpha (unlisted) | 4104 | 0.02 USDC | The attacker endpoint promoted by an injected post; no mandate allows its payee |
| Treasury Agent | - | - | Pays through `AgentClient` directly; payees Market Data, Risk Scan, Research Writer; per-call cap 0.05 USDC |
| Trading Agent | - | - | Pays only through the MCP tools (`call_paid_service`, `prove_receipt`); payees Market Data, Risk Scan |

The attacks run mid-traffic and are each denied twice.
Layer 1: the agent's own SDK refuses before signing (`PAYEE_NOT_ALLOWED` for the injection, `PER_CALL_CAP` for a 0.25 USDC deep dive).
Layer 2: the same agent key with its client guard switched off, standing in for a compromised runtime, signs anyway and the Clearing Node denies it with the same rule and records it, so it shows on the dashboard.

## Live networks

The same scenario runs on HashKey Chain testnet (133) or mainnet (177) with tiny prices (Market Data 0.0001, Risk Scan 0.0005, Research Writer 0.0025 USDC).
It never deploys there: `contracts/deployments/<chainId>.json` must exist.
It refuses to start unless every one of these holds, before touching the chain:

- `DEMO_LIVE_NETWORK_CONFIRM=yes`.
- The planned spend, printed first, is at or below `DEMO_MAX_SPEND_USDC` (default `1`).
- Every key is given explicitly and none is a public anvil dev key: `DEMO_OPERATOR_KEY`, `DEMO_OWNER_KEY`, `DEMO_TREASURY_KEY`, `DEMO_TRADING_KEY`, `DEMO_WRITER_KEY`.
- Payee wallets are given: `DEMO_MARKET_PAYEE`, `DEMO_RISK_PAYEE` (`DEMO_ROGUE_PAYEE` defaults to the dead address and is never paid).
- `DEMO_ADMIN_TOKEN` is set, and `DEMO_RPC_URL` (or the network default) serves the declared chain.

Agent wallets must already hold the token; the demo approves the hub for exactly the mandate cap, never unlimited.

```sh
DEMO_CHAIN_ID=133 DEMO_LIVE_NETWORK_CONFIRM=yes DEMO_CALLS=100 DEMO_MAX_SPEND_USDC=0.1 \
  DEMO_OPERATOR_KEY=... DEMO_OWNER_KEY=... DEMO_TREASURY_KEY=... DEMO_TRADING_KEY=... DEMO_WRITER_KEY=... \
  DEMO_MARKET_PAYEE=0x... DEMO_RISK_PAYEE=0x... DEMO_ADMIN_TOKEN=... pnpm demo:stage
```

## Other knobs

| Var | Default | Meaning |
|---|---|---|
| `DEMO_CALLS` | `500` | Target paid calls (split into the scenario mix) |
| `DEMO_CONCURRENCY` | `24` | Parallel callers |
| `DEMO_NODE_PORT` | `8787` | Node port; falls back to a free port (and says so) when busy |
| `DEMO_PROVIDER_BASE_PORT` | `4101` | Providers use this port and the next three |
| `DEMO_RPC_URL` | own anvil | Use an existing chain instead |
| `DEMO_OFFLINE` | unset | `1` skips the live price source |
| `DEMO_DATA_DIR` | `apps/demo/data` | Each run gets `run-<time>/` with `clearing-<chainId>.demo.db` and `node.log` |

## Data safety

Every run uses a new database whose name ends in `.demo.db`, checked with the node's own `assertDisposableTarget` guard before the node starts.
`forge script DeployLocal` writes the shared `contracts/deployments/31337.json`; the demo restores that file's previous content and keeps its own copy in the run directory, so other local sessions are not disturbed.

## Tests

```sh
pnpm --filter @payminto/demo test
```

`test/demo.test.ts` runs the whole scenario compressed to 60 calls against its own anvil and asserts the summary: one confirmed, reconciled batch with fewer transfers than calls, gross equal to the planned mix, both attacks denied in the agent and at the node with the right rules, every transfer an accepted co-signed HSP payment, trial balance zero, hub empty, a proof verified on chain, and the MCP server over stdio.
`test/config.test.ts` covers the live-network safety guard.
