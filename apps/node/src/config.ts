import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { networks } from "@payminto/protocol";

export const DEFAULT_DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "deployments");

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
  .transform((v) => v as Hex);

const intFromEnv = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      if (!/^\d+$/.test(v)) {
        ctx.addIssue({ code: "custom", message: "must be a non-negative integer" });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `must be >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  PORT: intFromEnv(8787),
  HOST: z.string().default("0.0.0.0"),
  CHAIN_ID: intFromEnv(31337).refine((n) => n in networks, `must be one of ${Object.keys(networks).join(", ")}`),
  RPC_URL: z.url().optional(),
  HUB_ADDRESS: address.optional(),
  TOKEN_ADDRESS: address.optional(),
  OPERATOR_KEY: privateKey,
  ADMIN_TOKEN: z.string().min(12, "must be at least 12 characters"),
  DB_PATH: z.string().min(1).default("./data/clearing.db"),
  SETTLE_INTERVAL_SEC: intFromEnv(0),
  SETTLE_MIN_CALLS: intFromEnv(1, 1),
  PUBLIC_URL: z.url().default("http://localhost:8787"),
  HSP_MODE: z.enum(["local", "coordinator"]).default("local"),
  HSP_COORDINATOR_URL: z.url().optional(),
  HSP_API_KEY: z.string().min(1).optional(),
  HSP_CHAIN_NAME: z.string().min(1).optional(),
  HSP_VERIFYING_CONTRACT: address.optional(),
  HSP_COSIGN_TIMEOUT_SEC: intFromEnv(20),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEPLOYMENTS_DIR: z.string().optional(),
  FUNDS_REFRESH_SEC: intFromEnv(30, 1),
});

export type Config = {
  port: number;
  host: string;
  chainId: number;
  rpcUrl: string;
  hub: Address;
  token: Address;
  operatorKey: Hex;
  adminToken: string;
  dbPath: string;
  settleIntervalSec: number;
  settleMinCalls: number;
  publicUrl: string;
  hsp: {
    mode: "local" | "coordinator";
    coordinatorUrl?: string;
    apiKey?: string;
    chainName?: string;
    verifyingContract: Address;
    cosignTimeoutSec: number;
  };
  corsOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  fundsRefreshSec: number;
  /** Block the hub was deployed at, for event scans. */
  deployBlock: bigint;
};

const deploymentSchema = z.object({
  clearingHub: address,
  token: address.optional(),
  chainId: z.number().int(),
  blockNumber: z.number().int().nonnegative().optional(),
});

export type Deployment = z.infer<typeof deploymentSchema>;

export function readDeployment(chainId: number, dir = DEFAULT_DEPLOYMENTS_DIR): Deployment | null {
  const file = join(dir, `${chainId}.json`);
  if (!existsSync(file)) return null;
  const parsed = deploymentSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new ConfigError([`${file}: ${z.prettifyError(parsed.error)}`]);
  if (parsed.data.chainId !== chainId) throw new ConfigError([`${file}: chainId ${parsed.data.chainId} does not match ${chainId}`]);
  return parsed.data;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Parses and validates the environment once at startup. Error messages name variables, never their values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = parsed.data;
  const net = networks[e.CHAIN_ID]!;
  const problems: string[] = [];
  const deployment = readDeployment(e.CHAIN_ID, e.DEPLOYMENTS_DIR ?? DEFAULT_DEPLOYMENTS_DIR);

  const hub = e.HUB_ADDRESS ?? deployment?.clearingHub ?? net.clearingHub;
  if (!hub) problems.push(`HUB_ADDRESS: required (no contracts/deployments/${e.CHAIN_ID}.json found)`);

  const zero = "0x0000000000000000000000000000000000000000";
  const defaultToken = net.token.address !== zero ? net.token.address : undefined;
  const token = e.TOKEN_ADDRESS ?? deployment?.token ?? defaultToken;
  if (!token) problems.push(`TOKEN_ADDRESS: required (no token in contracts/deployments/${e.CHAIN_ID}.json)`);

  if (e.HSP_MODE === "coordinator") {
    if (!e.HSP_COORDINATOR_URL) problems.push("HSP_COORDINATOR_URL: required when HSP_MODE=coordinator");
    if (!e.HSP_API_KEY) problems.push("HSP_API_KEY: required when HSP_MODE=coordinator");
    if (!e.HSP_CHAIN_NAME) problems.push("HSP_CHAIN_NAME: required when HSP_MODE=coordinator");
    if (!e.HSP_VERIFYING_CONTRACT) problems.push("HSP_VERIFYING_CONTRACT: required when HSP_MODE=coordinator");
  }
  const rpcUrl = e.RPC_URL ?? net.chain.rpcUrls.default.http[0];
  if (!rpcUrl) problems.push("RPC_URL: required");
  if (problems.length) throw new ConfigError(problems);

  return {
    port: e.PORT,
    host: e.HOST,
    chainId: e.CHAIN_ID,
    rpcUrl: rpcUrl!,
    hub: hub!,
    token: token!,
    operatorKey: e.OPERATOR_KEY,
    adminToken: e.ADMIN_TOKEN,
    dbPath: e.DB_PATH,
    settleIntervalSec: e.SETTLE_INTERVAL_SEC,
    settleMinCalls: e.SETTLE_MIN_CALLS,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    hsp: {
      mode: e.HSP_MODE,
      coordinatorUrl: e.HSP_COORDINATOR_URL?.replace(/\/+$/, ""),
      apiKey: e.HSP_API_KEY,
      chainName: e.HSP_CHAIN_NAME,
      verifyingContract: e.HSP_VERIFYING_CONTRACT ?? hub!,
      cosignTimeoutSec: e.HSP_COSIGN_TIMEOUT_SEC,
    },
    corsOrigins: e.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    fundsRefreshSec: e.FUNDS_REFRESH_SEC,
    deployBlock: BigInt(deployment?.blockNumber ?? 0),
  };
}

/** Config summary that is safe to log or expose: no keys, no tokens. */
export function redactedConfig(c: Config) {
  return {
    port: c.port,
    chainId: c.chainId,
    rpcUrl: c.rpcUrl.replace(/\/\/([^@/]*)@/, "//***@"),
    hub: c.hub,
    token: c.token,
    dbPath: c.dbPath,
    settleIntervalSec: c.settleIntervalSec,
    settleMinCalls: c.settleMinCalls,
    publicUrl: c.publicUrl,
    hspMode: c.hsp.mode,
    hspCoordinatorUrl: c.hsp.coordinatorUrl,
    hspVerifyingContract: c.hsp.verifyingContract,
    hspCosignTimeoutSec: c.hsp.cosignTimeoutSec,
    corsOrigins: c.corsOrigins,
  };
}
