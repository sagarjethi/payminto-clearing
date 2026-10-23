# Payminto Clearing Node

The self-hosted node that checks every agent voucher against its mandate, records it in a double-entry ledger, and clears batches of vouchers on the `ClearingHub` contract.
It never holds user funds: settlement moves net amounts directly wallet to wallet through the hub.
The build contract is `docs/SPEC.md` section 5; this file covers running and configuring it.

## Run it locally

From the repository root:

```sh
pnpm install
scripts/dev-local.sh
```

The script starts `anvil` on port 8545 if nothing answers there, deploys `ClearingHub` and `MockStablecoin` with `forge script script/DeployLocal.s.sol` (anvil key 0), and starts the node with anvil key 9 as `OPERATOR_KEY` and `ADMIN_TOKEN=dev-admin-token`.
It refuses to run against anything that is not chain 31337.
Each deployment gets its own SQLite file under `apps/node/data/`, because a database is bound to one chain, hub and token and the node refuses to mix them.

To run the node alone against an existing deployment:

```sh
cp apps/node/.env.example apps/node/.env   # edit as needed
pnpm --filter @payminto/node dev
```

`dev` reads `contracts/deployments/<CHAIN_ID>.json` for `HUB_ADDRESS` and `TOKEN_ADDRESS` unless they are set.
Stop with Ctrl-C or SIGTERM: the node stops accepting requests, closes SSE streams, lets an in-flight settlement finish booking, and closes the database.

## Configuration

All variables are validated once at startup with zod.
Errors name the variable and never print its value, and logs never contain keys or tokens.

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `CHAIN_ID` | `31337` | 31337, 133 or 177 |
| `RPC_URL` | network default | JSON-RPC endpoint |
| `HUB_ADDRESS` | deployments file | ClearingHub address |
| `TOKEN_ADDRESS` | deployments file, then network default | Settlement token |
| `OPERATOR_KEY` | required | Signs receipts and HSP adapter receipts, submits `openMandate` and `settleBatch` (gas only) |
| `ADMIN_TOKEN` | required (12+ chars) | Bearer token for admin routes, the dashboard and SSE |
| `DB_PATH` | `./data/clearing.db` | SQLite file (WAL mode) |
| `SETTLE_INTERVAL_SEC` | `0` | Auto-settle period; 0 means manual only |
| `SETTLE_MIN_CALLS` | `1` | Auto-settle skips below this many unsettled calls |
| `PUBLIC_URL` | `http://localhost:8787` | Node URL advertised to agents in x402 requirements |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated dashboard origins |
| `HSP_MODE` | `local` | `local` (built-in adapter and verifier) or `coordinator` |
| `HSP_COORDINATOR_URL`, `HSP_API_KEY`, `HSP_CHAIN_NAME`, `HSP_VERIFYING_CONTRACT` | unset | Required in `coordinator` mode; the verifying contract defaults to the hub in `local` mode |
| `HSP_COSIGN_TIMEOUT_SEC` | `20` | How long a batch waits for debtor agents to co-sign HSP mandates |
| `FUNDS_REFRESH_SEC` | `30` | Balance and allowance refresh period while calls are unsettled |
| `DEPLOYMENTS_DIR` | `contracts/deployments` | Where `<chainId>.json` is read from |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (JSON lines on stdout) |

## How a call is cleared

1. The provider's paywall (`@payminto/sdk`) forwards the agent's voucher to `POST /v1/vouchers`.
2. The node verifies the voucher signature (EOA, or ERC-1271 for contract agents), then loads mandate state and evaluates every rule in the SPEC 5.4 order inside one `BEGIN IMMEDIATE` transaction, so parallel calls cannot overspend.
3. An accepted call gets a receipt signed by the operator over its Merkle leaf, a ledger journal (debit provider receivable, credit agent payable), and a `call.accepted` event; a refused call gets a recorded denial with its rule.
4. `POST /v1/settlements` (or the interval worker) takes the latest voucher per (mandate, payee), checks each mandate and settled position on chain, drops agents whose wallet cannot fund their projected net debit, and splits the claims into chunks of at most 64.
5. Per chunk it builds the receipts tree, derives `batchId = keccak256(abi.encode(chainId, hub, receiptsRoot, seq))`, creates one HSP mandate per projected net transfer and waits for debtor co-signatures, simulates and sends `settleBatch`, then decodes `NetTransfer` events and reconciles them with the off-chain projection.
6. HSP: in `local` mode the node observes the settlement, signs an adapter receipt and runs the verifier (`ACCEPT` or `REJECT`); transfers whose debtor did not co-sign are `UNSIGNED`.
   In `coordinator` mode co-signed mandates are registered with the HashKey Coordinator and observed until `SETTLED`; failures are retried in the background and never block the ledger.

Interrupted batches are recovered on restart: unsent batches are failed and their calls return to `accepted`, sent ones are finalized from their receipt.

## Data safety

Tests always use a fresh `mkdtemp` directory and never `DB_PATH`.
The only destructive tool is `pnpm --filter @payminto/node db:reset <path>`, which deletes a database file and refuses unless the path ends in `.test.db` or `.demo.db`, lives in the OS temp dir, or `--i-know-this-is-disposable` is passed (guard in `src/db/guard.ts`).
It also refuses the `DB_PATH` of the current environment unless that flag is given.

## Tests

```sh
pnpm --filter @payminto/node test        # unit, integration and end-to-end (boots its own anvil on a random port)
pnpm --filter @payminto/node typecheck
```

`test/e2e.test.ts` deploys the contracts, starts the node in-process on a temp database, serves two provider apps behind the SDK paywall, runs about 50 parallel paid calls from two agents (one of them also a payee, so netting happens) plus denied calls, settles, and checks balances, netting, HSP records, the trial balance and an on-chain `verifyReceipt` proof.
