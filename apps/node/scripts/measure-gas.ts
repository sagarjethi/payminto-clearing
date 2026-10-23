/**
 * Measures real gas on a throwaway anvil: openMandate, settleBatch with 1, 2, 16 and 64 claims (with netting,
 * first and repeat settlement), and a plain ERC-20 transfer, then writes docs/gas.json and docs/GAS.md.
 *
 *   pnpm --filter @payminto/node gas
 *
 * Local anvil only; it never touches a live network or a shared database.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { erc20Abi, getAddress, keccak256, maxUint256, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  clearingHubAbi,
  mandateId as computeMandateId,
  mandateTypedData,
  payeesRoot,
  policyHash,
  voucherTypedData,
  type Mandate,
} from "@payminto/protocol";
import { projectNetting } from "../src/netting.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil } from "../test/helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HSK_BASE_FEE_GWEI = 500n; // research/01-hsp-hashkey-tech.md, measured 2026-10-24
const CALLS_PER_CLAIM = 10; // gas does not depend on it: the receipts tree is one bytes32 on chain

const anvil = await startAnvil();
try {
  const { hub, token } = await deployClearing(anvil);
  const deployer = anvil.wallet(ANVIL_KEYS[0]);
  const owner = privateKeyToAccount(ANVIL_KEYS[9]);
  const agentKeys = ANVIL_KEYS.slice(1, 9);
  const agents = agentKeys.map((k) => privateKeyToAccount(k));
  const gas = async (hash: Hex) => {
    const r = await anvil.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
    return r;
  };

  // Plain ERC-20 transfers: to an address that never held the token (cold) and to one that does (warm).
  await mint(anvil, token, agents[0]!.address, 10n ** 12n);
  const a0 = anvil.wallet(agentKeys[0]!);
  const coldTo = getAddress(`0x${"c0".repeat(20)}`);
  const transferCold = (await gas(await a0.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [coldTo, 1_000n] }))).gasUsed;
  const transferWarm = (await gas(await a0.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [coldTo, 1_000n] }))).gasUsed;

  // One mandate per agent, all funded and approved.
  const now = (await anvil.pub.getBlock()).timestamp;
  const mandates = new Map<Address, Hex>();
  let openMandateGas = 0n;
  for (const [i, a] of agents.entries()) {
    const policy = { perCallCap: "1000000", dailyCap: "1000000000", maxCallsPerMinute: 0, purpose: `gas ${i}` };
    const m: Mandate = {
      owner: owner.address,
      agent: a.address,
      token,
      totalCap: 10n ** 15n,
      validAfter: now - 60n,
      validUntil: now + 86_400n,
      payeesRoot: payeesRoot([]),
      policyHash: policyHash(policy),
      salt: keccak256(toBytes(`gas-${i}`)),
    };
    const sig = await owner.signTypedData(mandateTypedData(31337, hub, m));
    const r = await gas(await deployer.writeContract({ address: hub, abi: clearingHubAbi, functionName: "openMandate", args: [m, sig] }));
    if (i === 0) openMandateGas = r.gasUsed;
    mandates.set(a.address, computeMandateId(31337, hub, m));
    await mint(anvil, token, a.address, 10n ** 12n);
    await gas(await anvil.wallet(agentKeys[i]!).writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [hub, maxUint256] }));
  }

  // Payees: the agents themselves (so obligations net) plus eight provider wallets that start empty.
  const providers = Array.from({ length: 8 }, (_, i) => getAddress(`0x${(0xa000 + i).toString(16).padStart(40, "0")}`));
  const parties: Address[] = [...agents.map((a) => a.address), ...providers];
  const cumulative = new Map<string, bigint>();
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  function pairs(k: number): Array<{ agentIdx: number; payee: Address }> {
    if (k === 1) return [{ agentIdx: 0, payee: providers[0]! }];
    if (k === 2) return [{ agentIdx: 1, payee: agents[2]!.address }, { agentIdx: 2, payee: providers[1]! }];
    const out = new Map<string, { agentIdx: number; payee: Address }>();
    while (out.size < k) {
      const agentIdx = Math.floor(rand() * agents.length);
      const payee = parties[Math.floor(rand() * parties.length)]!;
      if (payee === agents[agentIdx]!.address) continue;
      out.set(`${agentIdx}:${payee}`, { agentIdx, payee });
    }
    return [...out.values()];
  }

  type Row = { claims: number; calls: number; kind: "first" | "repeat"; gasUsed: bigint; transfers: number; calldataBytes: number };
  const rows: Row[] = [];
  let batchSeq = 0;
  async function settle(ps: Array<{ agentIdx: number; payee: Address }>, kind: Row["kind"]) {
    const claims = [];
    const flows = [];
    for (const { agentIdx, payee } of ps) {
      const agent = agents[agentIdx]!;
      const id = mandates.get(agent.address)!;
      const delta = BigInt(CALLS_PER_CLAIM) * BigInt(1_000 + Math.floor(rand() * 9_000));
      const cum = (cumulative.get(`${id}:${payee}`) ?? 0n) + delta;
      cumulative.set(`${id}:${payee}`, cum);
      const voucher = { mandateId: id, payee, cumulative: cum };
      claims.push({ voucher, agentSig: await agent.signTypedData(voucherTypedData(31337, hub, voucher)), payeeProof: [] as Hex[] });
      flows.push({ agent: agent.address, payee, delta });
    }
    const batchId = keccak256(toBytes(`gas-batch-${++batchSeq}`));
    const hash = await deployer.writeContract({
      address: hub,
      abi: clearingHubAbi,
      functionName: "settleBatch",
      args: [batchId, keccak256(toBytes(`root-${batchSeq}`)), token, claims],
    });
    const r = await gas(hash);
    const tx = await anvil.pub.getTransaction({ hash });
    const transfers = parseEventLogs({ abi: clearingHubAbi, logs: r.logs, eventName: "NetTransfer" }).length;
    if (transfers !== projectNetting(flows).transfers.length) throw new Error("projection mismatch");
    rows.push({ claims: ps.length, calls: ps.length * CALLS_PER_CLAIM, kind, gasUsed: r.gasUsed, transfers, calldataBytes: (tx.input.length - 2) / 2 });
  }
  for (const k of [1, 2, 16, 64]) {
    const ps = pairs(k);
    await settle(ps, "first"); // new (mandate, payee) slots and, for some providers, first token balance
    await settle(ps, "repeat"); // the steady state: same pairs, higher cumulative
  }

  const result = {
    measuredAt: new Date().toISOString(),
    environment: "anvil (local), solc 0.8.24 optimizer 200 runs, MockStablecoin (OpenZeppelin ERC-20)",
    callsPerClaim: CALLS_PER_CLAIM,
    erc20Transfer: { cold: transferCold.toString(), warm: transferWarm.toString() },
    openMandate: openMandateGas.toString(),
    settleBatch: rows.map((r) => ({ ...r, gasUsed: r.gasUsed.toString(), gasPerClaim: (r.gasUsed / BigInt(r.claims)).toString() })),
  };
  writeFileSync(join(ROOT, "docs", "gas.json"), JSON.stringify(result, null, 2) + "\n");

  const fmt = (n: bigint) => n.toLocaleString("en-US");
  const hsk = (g: bigint) => {
    const wei = g * HSK_BASE_FEE_GWEI * 10n ** 9n;
    const s = (Number(wei / 10n ** 12n) / 1e6).toFixed(6);
    return s;
  };
  const big = rows.find((r) => r.claims === 64 && r.kind === "repeat")!;
  const naive = BigInt(big.calls) * transferWarm;
  const lines = [
    "# Gas: measured, not estimated",
    "",
    "<!-- Generated by `pnpm --filter @payminto/node gas` (apps/node/scripts/measure-gas.ts). Re-run instead of editing numbers by hand. -->",
    "",
    `Measured on ${result.measuredAt.slice(0, 10)} on a local anvil with the repository's ClearingHub (solc 0.8.24, optimizer 200 runs) and MockStablecoin, an OpenZeppelin ERC-20.`,
    "Each settleBatch claim is the latest voucher of one (mandate, payee) pair, so it clears any number of calls: gas depends on claims and net transfers, never on calls, because the hub stores one receipts root per batch.",
    `The table assumes ${CALLS_PER_CLAIM} calls per claim only to show calls settled; any other number gives the same gas.`,
    "\"First\" settles new (mandate, payee) pairs and pays some providers for the first time (cold storage); \"repeat\" settles the same pairs again, which is the steady state.",
    "Obligations are a seeded random graph among 8 agents and 8 providers, where agents are also payees, so the hub nets them.",
    "",
    "## Headline",
    "",
    `${big.calls} calls settled in one batch for ${fmt(big.gasUsed)} gas versus ${fmt(naive)} gas for one ERC-20 transfer per call, about ${(Number(naive) / Number(big.gasUsed)).toFixed(1)}x less.`,
    `That batch had ${big.claims} claims and ${big.transfers} net transfers.`,
    `Per claim it costs ${fmt(big.gasUsed / BigInt(big.claims))} gas, so batching beats one transfer per call (${fmt(transferWarm)} gas) as soon as a (mandate, payee) pair has about ${(Number(big.gasUsed / BigInt(big.claims)) / Number(transferWarm)).toFixed(2)} calls or more per batch, and every extra call on a pair is free on chain.`,
    "The node reports the same comparison live in `GET /v1/overview` (`gasSaved`), using the measured existing-recipient transfer gas as the naive cost per call.",
    "",
    "## Measurements",
    "",
    "| Operation | Claims | Calls settled | Net transfers | Gas used | Gas per claim | Calldata bytes | HSK at 500 gwei |",
    "|---|---|---|---|---|---|---|---|",
    `| ERC-20 transfer, new recipient | - | 1 | 1 | ${fmt(transferCold)} | - | - | ${hsk(transferCold)} |`,
    `| ERC-20 transfer, existing recipient | - | 1 | 1 | ${fmt(transferWarm)} | - | - | ${hsk(transferWarm)} |`,
    `| openMandate (once per mandate) | - | - | - | ${fmt(openMandateGas)} | - | - | ${hsk(openMandateGas)} |`,
    ...rows.map(
      (r) =>
        `| settleBatch, ${r.kind} | ${r.claims} | ${r.calls} | ${r.transfers} | ${fmt(r.gasUsed)} | ${fmt(r.gasUsed / BigInt(r.claims))} | ${r.calldataBytes} | ${hsk(r.gasUsed)} |`,
    ),
    "",
    "## Cost at a given gas price",
    "",
    "cost in HSK = gasUsed x gasPrice (gwei) x 10^-9.",
    "cost in USD = cost in HSK x HSK/USD.",
    "Naive cost of N calls paid one by one = N x ERC-20 transfer gas x gasPrice, versus one settleBatch for all of them.",
    "The HSK column uses a base fee of 500 gwei, the HashKey Chain mainnet value measured on 2026-10-24 (research/01-hsp-hashkey-tech.md); re-check it at submission time.",
    "HSK/USD: fill in from a live price source at submission time (not stated here on purpose).",
    "",
    "## Caveats",
    "",
    "- HashKey Chain is an OP Stack L2, so every transaction also pays an L1 data fee that grows with calldata; the calldata column is there to estimate it and it is not included in the gas figures.",
    "- Mainnet USDC.e is a proxied token with more logic than MockStablecoin, so each transferFrom costs somewhat more there; re-run this against a fork for exact mainnet numbers.",
    "- Payee allowlist proofs add calldata and about one hash per proof level per claim; these measurements use mandates without an allowlist.",
    "",
  ];
  writeFileSync(join(ROOT, "docs", "GAS.md"), lines.join("\n"));
  process.stdout.write(lines.slice(10, 13).join("\n") + "\nwrote docs/GAS.md and docs/gas.json\n");
} finally {
  anvil.stop();
}
