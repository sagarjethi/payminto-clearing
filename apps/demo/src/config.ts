import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { formatAmount, networks, toAtomic } from "@payminto/protocol";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEMO_DIR = resolve(REPO_ROOT, "apps", "demo");
export const LIVE_CHAINS = [133, 177] as const;

/** Anvil default dev keys: publicly known, local only. Refused on any live network. */
export const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
] as const satisfies readonly Hex[];

export type Prices = { market: bigint; risk: bigint; writer: bigint; deep: bigint; rogue: bigint };

/** Prices on the local chain match SPEC 8; live networks use tiny prices so a full rehearsal costs cents. */
export const LOCAL_PRICES: Prices = { market: 2_000n, risk: 10_000n, writer: 50_000n, deep: 250_000n, rogue: 20_000n };
export const LIVE_PRICES: Prices = { market: 100n, risk: 500n, writer: 2_500n, deep: 12_500n, rogue: 1_000n };

export type Plan = {
  treasuryMarket: number;
  treasuryRisk: number;
  briefs: number;
  /** Each brief makes the Research Writer buy this many quotes and scans. */
  briefQuotes: number;
  briefScans: number;
  tradingMarket: number;
  tradingRisk: number;
};

/** Splits a target call count into the scenario mix. Every brief adds 1 + briefQuotes + briefScans paid calls. */
export function planFor(totalCalls: number): Plan {
  const n = Math.max(20, Math.floor(totalCalls));
  const briefs = Math.max(1, Math.round(n * 0.04));
  const treasuryMarket = Math.round(n * 0.24);
  const treasuryRisk = Math.round(n * 0.12);
  const tradingRisk = Math.round(n * 0.08);
  const used = treasuryMarket + treasuryRisk + briefs * 4 + tradingRisk;
  return { treasuryMarket, treasuryRisk, briefs, briefQuotes: 2, briefScans: 1, tradingMarket: Math.max(1, n - used), tradingRisk };
}

export function plannedCalls(p: Plan): number {
  return p.treasuryMarket + p.treasuryRisk + p.briefs * (1 + p.briefQuotes + p.briefScans) + p.tradingMarket + p.tradingRisk;
}

/** Upper bound of what the run can move, counting the two attack attempts as if they were paid. */
export function plannedSpend(p: Plan, prices: Prices) {
  const treasury = BigInt(p.treasuryMarket) * prices.market + BigInt(p.treasuryRisk) * prices.risk + BigInt(p.briefs) * prices.writer + prices.deep;
  const trading = BigInt(p.tradingMarket) * prices.market + BigInt(p.tradingRisk) * prices.risk + prices.rogue;
  const writer = BigInt(p.briefs) * (BigInt(p.briefQuotes) * prices.market + BigInt(p.briefScans) * prices.risk);
  return { treasury, trading, writer, total: treasury + trading + writer };
}

const key = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
  .transform((v) => v as Hex);
const addr = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
const int = (def: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)));

const envSchema = z.object({
  DEMO_CHAIN_ID: int(31337),
  DEMO_RPC_URL: z.url().optional(),
  DEMO_CALLS: int(500),
  DEMO_CONCURRENCY: int(24),
  DEMO_NODE_PORT: int(8787),
  DEMO_PROVIDER_BASE_PORT: int(4101),
  DEMO_OFFLINE: z.enum(["0", "1"]).optional(),
  DEMO_DATA_DIR: z.string().optional(),
  DEMO_ADMIN_TOKEN: z.string().min(12, "must be at least 12 characters").optional(),
  DEMO_HSP_COSIGN_TIMEOUT_SEC: int(15),
  // Live networks only.
  DEMO_LIVE_NETWORK_CONFIRM: z.string().optional(),
  DEMO_MAX_SPEND_USDC: z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a decimal USDC amount").default("1"),
  DEMO_OPERATOR_KEY: key.optional(),
  DEMO_OWNER_KEY: key.optional(),
  DEMO_TREASURY_KEY: key.optional(),
  DEMO_TRADING_KEY: key.optional(),
  DEMO_WRITER_KEY: key.optional(),
  DEMO_MARKET_PAYEE: addr.optional(),
  DEMO_RISK_PAYEE: addr.optional(),
  DEMO_ROGUE_PAYEE: addr.optional(),
});

export type Keys = { deployer: Hex | null; operator: Hex; owner: Hex; treasury: Hex; trading: Hex; writer: Hex };
export type Payees = { market: Address; risk: Address; rogue: Address };

export type DemoConfig = {
  chainId: number;
  live: boolean;
  /** Undefined on local: the demo boots its own anvil. */
  rpcUrl: string | undefined;
  calls: number;
  plan: Plan;
  prices: Prices;
  concurrency: number;
  nodePort: number;
  providerBasePort: number;
  offline: boolean;
  dataDir: string | undefined;
  adminToken: string;
  cosignTimeoutSec: number;
  keys: Keys;
  payees: Payees;
  maxSpend: bigint;
  spend: ReturnType<typeof plannedSpend>;
  /** Live only: the existing deployments file. */
  deployment: { clearingHub: Address; token?: Address } | null;
};

export class DemoConfigError extends Error {
  constructor(problems: string[]) {
    super(`Refusing to start the demo:\n  - ${problems.join("\n  - ")}`);
    this.name = "DemoConfigError";
  }
}

const LOCAL_ROGUE: Address = getAddress(privateKeyToAccount(ANVIL_KEYS[7]).address);

/**
 * Parses the demo environment and applies the live-network safety guard before anything touches a chain:
 * on 133/177 it needs DEMO_LIVE_NETWORK_CONFIRM=yes, explicit non-dev keys, an existing deployments file,
 * and a planned spend at or under DEMO_MAX_SPEND_USDC (default 1).
 */
export function loadDemoConfig(env: Record<string, string | undefined> = process.env, opts: { deploymentsDir?: string } = {}): DemoConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new DemoConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const e = parsed.data;
  const problems: string[] = [];
  const chainId = e.DEMO_CHAIN_ID;
  if (!(chainId in networks)) throw new DemoConfigError([`DEMO_CHAIN_ID: ${chainId} is not one of ${Object.keys(networks).join(", ")}`]);
  const live = (LIVE_CHAINS as readonly number[]).includes(chainId);
  const prices = live ? LIVE_PRICES : LOCAL_PRICES;
  const plan = planFor(e.DEMO_CALLS);
  const spend = plannedSpend(plan, prices);
  const maxSpend = toAtomic(e.DEMO_MAX_SPEND_USDC, 6);

  let keys: Keys;
  let payees: Payees;
  let deployment: DemoConfig["deployment"] = null;
  if (!live) {
    keys = { deployer: ANVIL_KEYS[0], owner: ANVIL_KEYS[1], treasury: ANVIL_KEYS[2], trading: ANVIL_KEYS[3], writer: ANVIL_KEYS[4], operator: ANVIL_KEYS[9] };
    payees = {
      market: getAddress(privateKeyToAccount(ANVIL_KEYS[5]).address),
      risk: getAddress(privateKeyToAccount(ANVIL_KEYS[6]).address),
      rogue: LOCAL_ROGUE,
    };
  } else {
    if (e.DEMO_LIVE_NETWORK_CONFIRM !== "yes") {
      problems.push(`DEMO_LIVE_NETWORK_CONFIRM: chain ${chainId} is a live HashKey network; set DEMO_LIVE_NETWORK_CONFIRM=yes to spend real tokens`);
    }
    const need = <T>(name: string, v: T | undefined): T => {
      if (v === undefined) problems.push(`${name}: required on chain ${chainId}`);
      return v as T;
    };
    keys = {
      deployer: null,
      operator: need("DEMO_OPERATOR_KEY", e.DEMO_OPERATOR_KEY),
      owner: need("DEMO_OWNER_KEY", e.DEMO_OWNER_KEY),
      treasury: need("DEMO_TREASURY_KEY", e.DEMO_TREASURY_KEY),
      trading: need("DEMO_TRADING_KEY", e.DEMO_TRADING_KEY),
      writer: need("DEMO_WRITER_KEY", e.DEMO_WRITER_KEY),
    };
    payees = {
      market: need("DEMO_MARKET_PAYEE", e.DEMO_MARKET_PAYEE),
      risk: need("DEMO_RISK_PAYEE", e.DEMO_RISK_PAYEE),
      // Never paid: it is the prompt-injection target and must be denied.
      rogue: e.DEMO_ROGUE_PAYEE ?? getAddress("0x000000000000000000000000000000000000dEaD"),
    };
    const dev = new Set<string>(ANVIL_KEYS.map((k) => k.toLowerCase()));
    for (const [name, k] of Object.entries(keys)) {
      if (k && dev.has(k.toLowerCase())) problems.push(`${name} key: is a public anvil dev key; never use it on a live network`);
    }
    if (!e.DEMO_ADMIN_TOKEN) problems.push("DEMO_ADMIN_TOKEN: required on a live network (the local default is public)");
    const dir = opts.deploymentsDir ?? join(REPO_ROOT, "contracts", "deployments");
    const file = join(dir, `${chainId}.json`);
    if (!existsSync(file)) problems.push(`${file}: missing; deploy ClearingHub first (docs/DEPLOY.md), the demo never deploys to a live network`);
    else {
      const d = z.object({ clearingHub: addr, token: addr.optional(), chainId: z.number() }).safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!d.success || d.data.chainId !== chainId) problems.push(`${file}: not a deployments file for chain ${chainId}`);
      else deployment = { clearingHub: d.data.clearingHub, token: d.data.token };
    }
    if (spend.total > maxSpend) {
      problems.push(
        `planned spend ${formatAmount(spend.total)} USDC exceeds DEMO_MAX_SPEND_USDC ${formatAmount(maxSpend)}; lower DEMO_CALLS or raise the cap deliberately`,
      );
    }
  }
  if (e.DEMO_CONCURRENCY < 1) problems.push("DEMO_CONCURRENCY: must be at least 1");
  if (problems.length) throw new DemoConfigError(problems);

  return {
    chainId,
    live,
    rpcUrl: e.DEMO_RPC_URL ?? (live ? networks[chainId]!.chain.rpcUrls.default.http[0] : undefined),
    calls: plannedCalls(plan),
    plan,
    prices,
    concurrency: e.DEMO_CONCURRENCY,
    nodePort: e.DEMO_NODE_PORT,
    providerBasePort: e.DEMO_PROVIDER_BASE_PORT,
    offline: e.DEMO_OFFLINE === "1",
    dataDir: e.DEMO_DATA_DIR,
    // Local only: the same public dev token the dashboard pre-fills for a local node.
    adminToken: e.DEMO_ADMIN_TOKEN ?? "dev-admin-token",
    cosignTimeoutSec: e.DEMO_HSP_COSIGN_TIMEOUT_SEC,
    keys,
    payees,
    maxSpend,
    spend,
    deployment,
  };
}
