/**
 * Wire shapes of the Clearing Node HTTP API (docs/SPEC.md 5.6 and 5.7).
 * Every response is parsed with these schemas at the trust boundary, so a backend shape change
 * surfaces as a clear "unexpected response" error instead of a silently wrong number.
 * Amounts are decimal strings of atomic units; they are only ever converted with BigInt.
 */
import { z } from "zod";
import { DENIAL_RULES, type DenialRule } from "@payminto/protocol";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex");
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an address");
export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected bytes32");
/** Atomic units. Numbers are accepted and normalised so a backend that sends JSON numbers still parses. */
export const atomicSchema = z
  .union([z.string().regex(/^-?\d+$/, "expected an integer amount"), z.number().int(), z.bigint()])
  .transform((v) => v.toString());
/** ISO time or unix seconds, normalised to ISO. */
export const timeSchema = z.union([z.string(), z.number()]).transform((v) => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  return /^\d+$/.test(v) ? new Date(Number(v) * 1000).toISOString() : v;
});

const denialRuleKeys = Object.keys(DENIAL_RULES) as [DenialRule, ...DenialRule[]];
export const denialRuleSchema = z.enum(denialRuleKeys);

export const tokenSchema = z.object({
  address: addressSchema,
  symbol: z.string(),
  decimals: z.number().int(),
});
export type Token = z.infer<typeof tokenSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  chainId: z.number(),
  hub: addressSchema,
  token: z.union([addressSchema, tokenSchema]),
  operator: addressSchema,
  /** Null when the node cannot reach its RPC (the node then answers 503). */
  blockNumber: z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v))),
  hspMode: z.string(),
});
export type Health = z.infer<typeof healthSchema>;

export const infoSchema = z.object({
  network: z.union([
    z.object({ chainId: z.number(), name: z.string() }).passthrough(),
    z.string().transform((name) => ({ chainId: 0, name })),
  ]),
  chainId: z.number().optional(),
  hub: addressSchema,
  token: tokenSchema,
  explorer: z.string().nullable().optional(),
  operator: addressSchema,
  version: z.string(),
  hspMode: z.string().optional(),
  operatorGasBalance: atomicSchema.optional(),
  settleIntervalSec: z.number().optional(),
  publicUrl: z.string().optional(),
});
export type Info = z.infer<typeof infoSchema>;

export const policySchema = z.object({
  perCallCap: atomicSchema,
  dailyCap: atomicSchema,
  maxCallsPerMinute: z.number(),
  purpose: z.string(),
});

export const mandateJsonSchema = z.object({
  owner: addressSchema,
  agent: addressSchema,
  token: addressSchema,
  totalCap: atomicSchema,
  validAfter: atomicSchema,
  validUntil: atomicSchema,
  payeesRoot: bytes32Schema,
  policyHash: bytes32Schema,
  salt: bytes32Schema,
});

export const mandateStatusSchema = z.enum(["pending", "open", "revoked", "expired", "failed"]);
export type MandateStatus = z.infer<typeof mandateStatusSchema>;

export const spendSchema = z.object({
  settled: atomicSchema,
  pending: atomicSchema,
  today: atomicSchema,
  remaining: atomicSchema,
});

export const callStatusSchema = z.enum(["accepted", "settled", "settling"]);

export const callSchema = z.object({
  id: bytes32Schema,
  mandateId: bytes32Schema,
  agent: addressSchema,
  payee: addressSchema,
  providerId: z.string().nullable().optional(),
  amount: atomicSchema,
  cumulative: atomicSchema,
  requestHash: bytes32Schema,
  status: callStatusSchema,
  batchId: bytes32Schema.nullable().optional(),
  createdAt: timeSchema,
});
export type Call = z.infer<typeof callSchema>;

export const denialSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  rule: denialRuleSchema,
  message: z.string(),
  mandateId: bytes32Schema.nullable().optional(),
  agent: addressSchema.nullable().optional(),
  payee: addressSchema.nullable().optional(),
  providerId: z.string().nullable().optional(),
  amount: atomicSchema.nullable().optional(),
  createdAt: timeSchema,
});
export type Denial = z.infer<typeof denialSchema>;

export const mandateSchema = z.object({
  id: bytes32Schema,
  label: z.string(),
  status: mandateStatusSchema,
  mandate: mandateJsonSchema,
  policy: policySchema,
  payees: z.array(addressSchema),
  spend: spendSchema,
  openTxHash: hex.nullable().optional(),
  revokedAt: timeSchema.nullable().optional(),
  createdAt: timeSchema,
  /** Wallet health the node tracks for the agent (balance and hub allowance, atomic units). */
  agentBalance: atomicSchema.nullable().optional(),
  agentAllowance: atomicSchema.nullable().optional(),
});
export type MandateRecord = z.infer<typeof mandateSchema>;

export const mandateDetailSchema = mandateSchema.extend({
  recentCalls: z.array(callSchema).default([]),
  denials: z.array(denialSchema).default([]),
  /** The hub's view of the mandate, when the node could read it. */
  onchain: z
    .object({ open: z.boolean(), revokedAt: z.number().nullable().optional(), spent: atomicSchema.optional() })
    .nullable()
    .optional(),
  /** Daily spend buckets for the chart; optional because the SPEC does not pin it. */
  spendSeries: z.array(z.object({ day: z.string(), amount: atomicSchema })).optional(),
});
export type MandateDetail = z.infer<typeof mandateDetailSchema>;

export const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  payee: addressSchema,
  priceAtomic: atomicSchema,
  resource: z.string(),
  category: z.string(),
  calls24h: z.number().default(0),
  revenue: z
    .object({ settled: atomicSchema, pending: atomicSchema })
    .optional(),
  callsTotal: z.number().optional(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerCreatedSchema = z.object({ id: z.string(), apiKey: z.string() });

export const hspStatusSchema = z.enum(["PENDING", "COSIGNED", "UNSIGNED", "SUBMITTED", "SETTLED", "ACCEPT", "REJECT", "FAILED"]);
export type HspStatus = z.infer<typeof hspStatusSchema>;

export const netTransferSchema = z.object({
  from: addressSchema,
  to: addressSchema,
  amount: atomicSchema,
  logIndex: z.number().nullable().optional(),
  hsp: z
    .object({
      paymentId: hex.nullable().optional(),
      status: hspStatusSchema,
      reason: z.string().nullable().optional(),
      cosigned: z.boolean().optional(),
      updatedAt: timeSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type NetTransfer = z.infer<typeof netTransferSchema>;

export const claimSchema = z.object({
  mandateId: bytes32Schema,
  agent: addressSchema,
  payee: addressSchema,
  cumulative: atomicSchema,
  delta: atomicSchema,
  calls: z.number().optional(),
});
export type Claim = z.infer<typeof claimSchema>;

export const batchStatusSchema = z.enum(["building", "cosigning", "submitted", "confirmed", "failed"]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const batchSchema = z.object({
  id: bytes32Schema,
  seq: z.number(),
  status: batchStatusSchema,
  receiptsRoot: bytes32Schema.nullable(),
  token: addressSchema,
  txHash: hex.nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
  gross: atomicSchema,
  net: atomicSchema,
  calls: z.number(),
  claims: z.number(),
  transfers: z.number(),
  gasUsed: atomicSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: timeSchema,
  confirmedAt: timeSchema.nullable().optional(),
});
export type Batch = z.infer<typeof batchSchema>;

export const batchDetailSchema = batchSchema.extend({
  claimList: z.array(claimSchema),
  netTransfers: z.array(netTransferSchema),
});
export type BatchDetail = z.infer<typeof batchDetailSchema>;

export const overviewSchema = z.object({
  volume: z.object({ settled: atomicSchema, pending: atomicSchema }),
  calls: z.object({ last24h: z.number(), all: z.number() }),
  denials24h: z.number(),
  activeMandates: z.number(),
  providers: z.number(),
  batches: z.number(),
  gasSaved: z.object({
    /** Gas units avoided versus one ERC-20 transfer per call. */
    gas: atomicSchema,
    /** Same, priced in the native token (atomic, 18 dp) at the observed gas price, when known. */
    native: atomicSchema.nullable().optional(),
  }),
  compressionRatio: z.number(),
  lastBatch: batchSchema.nullable(),
});
export type Overview = z.infer<typeof overviewSchema>;

export const nettingPreviewSchema = z.object({
  token: addressSchema.optional(),
  gross: z.array(z.object({ from: addressSchema, to: addressSchema, amount: atomicSchema, calls: z.number() })),
  net: z.array(z.object({ from: addressSchema, to: addressSchema, amount: atomicSchema })),
  grossTotal: atomicSchema.optional(),
  netTotal: atomicSchema.optional(),
  calls: z.number().optional(),
  compression: z.number(),
  skipped: z
    .array(z.object({ mandateId: bytes32Schema, reason: z.string() }))
    .optional(),
});
export type NettingPreview = z.infer<typeof nettingPreviewSchema>;

export const settlementResultSchema = z.union([
  z.object({ batchIds: z.array(bytes32Schema) }),
  z.object({ skipped: z.string() }),
]);
export type SettlementResult = z.infer<typeof settlementResultSchema>;

export const receiptSchema = z.object({
  callId: bytes32Schema,
  mandateId: bytes32Schema,
  payee: addressSchema,
  amount: atomicSchema,
  cumulative: atomicSchema,
  requestHash: bytes32Schema,
  timestamp: z.number(),
  leaf: bytes32Schema,
  nodeSignature: hex,
  node: addressSchema,
});
export type Receipt = z.infer<typeof receiptSchema>;

export const proofSchema = z.object({
  receipt: receiptSchema,
  batchId: bytes32Schema.nullable(),
  receiptsRoot: bytes32Schema.nullable(),
  proof: z.array(bytes32Schema),
  leaf: bytes32Schema,
  txHash: hex.nullable().optional(),
  explorerUrl: z.string().nullable().optional(),
  onchainVerified: z.boolean().nullable().optional(),
});
export type ReceiptProof = z.infer<typeof proofSchema>;

export const ledgerEntrySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  journalId: z.union([z.string(), z.number()]).transform(String),
  /** Journal kind, e.g. call.accepted or batch.settled, when the node reports it. */
  kind: z.string().nullable().optional(),
  account: z.string(),
  debit: atomicSchema,
  credit: atomicSchema,
  memo: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  createdAt: timeSchema,
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const trialBalanceSchema = z.object({
  accounts: z.array(z.object({ account: z.string(), debit: atomicSchema, credit: atomicSchema, balance: atomicSchema })),
  totalDebit: atomicSchema,
  totalCredit: atomicSchema,
  balance: atomicSchema,
});
export type TrialBalance = z.infer<typeof trialBalanceSchema>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.union([
    z.object({ items: z.array(item), nextCursor: z.string().nullable().optional() }),
    z.array(item).transform((items) => ({ items, nextCursor: null })),
  ]);

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

export type EventType =
  | "call.accepted"
  | "call.denied"
  | "mandate.opened"
  | "mandate.revoked"
  | "batch.started"
  | "batch.submitted"
  | "batch.confirmed"
  | "batch.failed"
  | "hsp.updated"
  | "funds.warning";

export const EVENT_TYPES: readonly EventType[] = [
  "call.accepted",
  "call.denied",
  "mandate.opened",
  "mandate.revoked",
  "batch.started",
  "batch.submitted",
  "batch.confirmed",
  "batch.failed",
  "hsp.updated",
  "funds.warning",
];

export type NodeEvent = { type: EventType; id: string; at: string; data: Record<string, unknown> };

export const revokeResultSchema = z.union([
  z.object({
    mandate: mandateSchema,
    onchain: z
      .object({
        revoked: z.boolean(),
        submitted: z.boolean().optional(),
        txHash: hex.nullable().optional(),
        call: z.object({ to: addressSchema, data: hex, allowedSenders: z.array(addressSchema).optional() }).nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
  mandateSchema.transform((mandate) => ({ mandate, onchain: null })),
]);
export type RevokeResult = z.infer<typeof revokeResultSchema>;
