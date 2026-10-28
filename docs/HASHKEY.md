# HashKey Chain reference

Everything Payminto Clearing relies on about HashKey Chain, measured live with read-only RPC calls on 2026-10-29.
The same values live in code in `packages/protocol/src/hashkey.ts` and `packages/protocol/src/chains.ts`.
Re-check them at any time with `pnpm --filter @payminto/protocol verify:hashkey`.

## 1. Networks

| | Mainnet | Testnet |
|---|---|---|
| Chain id | 177 | 133 |
| RPC | https://mainnet.hsk.xyz | https://testnet.hsk.xyz |
| Fallback RPCs | https://hashkey.drpc.org, https://177.rpc.thirdweb.com | https://133.rpc.thirdweb.com |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hskchain.net |
| Verify API (Blockscout) | https://hsk.blockscout.com/api/ | https://testnet-explorer.hskchain.net/api/ |
| Faucet | - | https://faucet.hsk.xyz/faucet |
| Native token | HSK, 18 decimals | HSK, 18 decimals |
| Block time | 2 s | 2 s |
| Block gas limit | 30,000,000 | 30,000,000 |

`testnet-explorer.hsk.xyz`, which older docs mention, does not resolve; use `testnet-explorer.hskchain.net`.
Sourcify also verifies contracts on both chains.

## 2. Stack, finality and confirmations

HashKey Chain is an OP Stack L2 with the Ecotone, Fjord and Isthmus upgrades active (`GasPriceOracle.version()` is `1.3.1-beta.1`).

| Head | Mainnet lag behind `latest` | Testnet lag | Meaning |
|---|---|---|---|
| `latest` (unsafe) | 0 | 0 | Sequencer has included it; can still reorg. |
| `safe` | about 12 blocks (24 s) | about 300 blocks | Batch data posted to Ethereum. |
| `finalized` | about 822 blocks (about 27 min) | about 2,070 blocks | Ethereum has finalized the batch. |

Payminto Clearing books a settlement as included at one confirmation and treats it as final once its block is at or below the `safe` head.
Operators who need L1 finality can wait for `finalized` instead.
There is no public mempool (`txpool_content` is not exposed), which makes front-running of `settleBatch` impractical.

## 3. Fees

- Mainnet base fee sits at a 500 gwei floor; the priority fee is about 0.001 gwei.
- Testnet base fee is 1 gwei, so testnet gas costs say nothing about mainnet costs.
- On top of L2 execution, every transaction pays an L1 data fee for posting its data to Ethereum, computed by the GasPriceOracle predeploy `0x420000000000000000000000000000000000000F` (`getL1Fee(bytes)`, `getL1FeeUpperBound(uint256)`).
- Measured: a 64-claim `settleBatch` (22,692 bytes of calldata) pays about 0.00118 HSK of L1 fee against about 0.95 HSK of L2 execution, under 0.15% of the total.
- There is no operator fee (`operatorFeeScalar()` reverts).
- viem's OP Stack formatters, used by our chain definitions, expose `l1Fee` and `l1GasUsed` on every receipt.

Settlement gas for every batch size is in `docs/GAS.md`.

## 4. Tokens

| Token | Chain | Address | Decimals | EIP-712 domain | Signature approvals |
|---|---|---|---|---|---|
| USDC.e (default) | 177 | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | 6 | name `Bridged USDC`, version `2` | EIP-2612 permit and EIP-3009 |
| USDT | 177 | `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` | 6 | none | none, use Permit2 |
| WHSK | 177 | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | 18 | none | none |
| USDC (default) | 133 | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | 6 | name `USD Coin`, version `2` | EIP-2612 permit and EIP-3009 |

- USDC.e is a FiatToken: it has a blacklist (`isBlacklisted(address)`), and a blacklisted party makes any transfer to or from it revert, so a clearing node must screen every party before settling a batch.
- `0x4200000000000000000000000000000000000006` on HashKey Chain is the OP Stack WETH predeploy, not wrapped HSK; WHSK is the address above.
- The USDC.e domain name is `Bridged USDC`, not `USD Coin`; signing with the wrong name produces signatures the token rejects.

## 5. Shared infrastructure (same address on 177 and 133)

| Contract | Address | How Payminto Clearing uses it |
|---|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Signature approvals for tokens without EIP-2612 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batched balance, allowance and blacklist reads |
| CREATE2 deployer (Arachnid) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | Deterministic ClearingHub address across chains |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | Smart-account agents |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Smart-account agents |
| Safe 1.4.1 singleton | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | Mandate owners via ERC-1271 |
| Safe 1.4.1 L2 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | Mandate owners via ERC-1271 |
| Safe proxy factory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | Creating a treasury Safe |
| Safe fallback handler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | ERC-1271 signature checks on Safes |
| Safe MultiSendCallOnly | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | Batched Safe transactions |
| EAS | `0x4200000000000000000000000000000000000021` | Attestations (predeploy) |
| EAS SchemaRegistry | `0x4200000000000000000000000000000000000020` | Attestation schemas (predeploy) |
| GasPriceOracle | `0x420000000000000000000000000000000000000F` | L1 data fee |
| L1Block | `0x4200000000000000000000000000000000000015` | L1 origin data |

Chain-specific:

| Contract | Mainnet (177) | Testnet (133) |
|---|---|---|
| Chainlink CCIP router | `0xf2Fd62c083F3BF324e99ce157D1a42d7EbA77f1d` | `0x1360c71dd2458B6d4A5Ad5946d9011BafA0435d7` |
| APRO USDC/USD (8 dp) | `0x244Ce344df8837c9d938867E2Ffbf0E4B0169B56` | - |
| APRO USDT/USD (8 dp) | `0x823d7f90f7A3498DB6595886b6B5dC95E6B0B7f3` | - |
| APRO BTC/USD (8 dp) | `0x204ED500ab56A2E19B051561258E3A45c850360F` | - |

Not verified, so deliberately not in code: an APRO HSK/USD feed (the published address has only 38 hex characters) and the HashKey KYC SBT address.

## 6. RPC limits

- `eth_getLogs` accepts at most 5,001 blocks per request (inclusive) and answers wider ranges with JSON-RPC error `-32602 block range too large`.
- Forty rapid sequential calls produced no rate limiting, and JSON-RPC batching works.
- Production nodes should still configure a fallback RPC and retry with jittered exponential backoff.

## 7. HSP (HashKey Settlement Protocol)

- Status on 2026-10-29: the `project-hsp` GitHub organisation has no public repositories, `@hsp/core` and `@hsp/sdk` are not on npm, and the HashKey documentation repository last changed on 2026-06-22.
- Payminto Clearing implements HSP wire v1 (`packages/protocol/src/hsp.ts`): EIP-712 domain `HSP` version `1`, the `eip712-eoa.v1` signer profile, address recipients, the capability-set hash and the decimal-string wire form.
- Every net transfer of a batch becomes an HSP mandate whose `settlementBinding` is the batch id, co-signed by the paying agent.
- In `local` mode the node is the HSP adapter and verifier; in `coordinator` mode it registers each payment with the HSP Coordinator once credentials are issued.

## 8. Deploying

Deployment and verification steps are in `docs/DEPLOY.md`.
