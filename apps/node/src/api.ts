import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  explorerAddress,
  explorerTx,
  networkFor,
  SCHEME,
  X402_VERSION,
  type ClearingReceipt,
  type DenialRule,
} from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db/database.ts";
import { ApiError } from "./errors.ts";
import type { EventBus, NodeEvent } from "./events.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import type { MandateService } from "./mandates.ts";
import { databaseGauges, renderGauges, type Metrics } from "./metrics.ts";
import { clientIp, TokenBuckets, type TakeResult } from "./ratelimit.ts";
import { overview } from "./overview.ts";
import { receiptVerifiedOnchain } from "./proofs.ts";
import type { SettlementService } from "./settlement.ts";
import { batchSummaryJson, providerPublicJson, nowIso, type ProviderRow, type Store } from "./store.ts";
import type { VoucherService } from "./vouchers.ts";

export const NODE_VERSION = "0.1.0";

export type NodeServices = {
  config: Config;
  db: Database;
  store: Store;
  chain: ChainClient;
  ledger: Ledger;
  events: EventBus;
  vouchers: VoucherService;
  mandates: MandateService;
  settlement: SettlementService;
  log: Logger;
  token: { address: Address; symbol: string; decimals: number };
  /** Called on shutdown to end open SSE streams. */
  sseClosers: Set<() => void>;
  metrics: Metrics;
  limiters: { provider: TokenBuckets; ip: TokenBuckets };
};

// ---------------------------------------------------------------------------
// Validation (zod at the trust boundary)
// ---------------------------------------------------------------------------

const zAddress = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
const zBytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex")
  .transform((v) => v.toLowerCase() as Hex);
const zHex = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex")
  .transform((v) => v as Hex);
const zUint = z.string().regex(/^(0|[1-9]\d{0,77})$/, "must be a decimal string of atomic units");
const zUintBig = zUint.transform((v) => BigInt(v));

const policySchema = z.object({
  perCallCap: zUint,
  dailyCap: zUint,
  maxCallsPerMinute: z.number().int().min(0).max(1_000_000),
  purpose: z.string().max(500),
});

const mandateJsonSchema = z.object({
  owner: zAddress,
  agent: zAddress,
  token: zAddress,
  totalCap: zUintBig,
  validAfter: zUintBig,
  validUntil: zUintBig,
  payeesRoot: zBytes32,
  policyHash: zBytes32,
  salt: zBytes32,
});

const createMandateSchema = z.object({
  mandate: mandateJsonSchema,
  ownerSignature: zHex,
  policy: policySchema,
  payees: z.array(zAddress).max(1024),
  label: z.string().trim().min(1).max(120),
});

const createProviderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  payee: zAddress,
  priceAtomic: zUint.refine((v) => BigInt(v) > 0n, "must be positive"),
  resource: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(60).default("api"),
});

const voucherSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal(SCHEME),
  network: z.string(),
  payload: z.object({
    mandateId: zBytes32,
    payee: zAddress,
    amount: zUintBig,
    cumulative: zUintBig,
    signature: zHex,
    requestHash: zBytes32,
  }),
  providerId: z.string().min(1).max(64),
  requestHash: zBytes32,
});

const cosignSchema = z.object({ signerProof: zHex });
const revokeSchema = z.object({ signature: zHex.optional() }).default({});

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "request body failed validation", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

function param<T extends z.ZodType>(value: string | undefined, schema: T, name: string): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", `invalid ${name}`, { [name]: r.error.issues[0]?.message ?? "invalid" });
  return r.data;
}

function limitOf(c: Context, def = 50, max = 500): number {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new ApiError(400, "VALIDATION_ERROR", "limit must be a positive integer");
  return Math.min(Number(raw), max);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function hashApiKey(key: string): string {
  return sha256(key).toString("hex");
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1]!.trim() : null;
}

type Vars = { Variables: { provider: ProviderRow } };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApi(s: NodeServices): Hono<Vars> {
  const { config, store, chain, events, log } = s;
  const app = new Hono<Vars>();
  const nowSec = () => Math.floor(Date.now() / 1000);
  const net = networkFor(config.chainId);

  app.use(
    "*",
    cors({
      origin: (origin) => (config.corsOrigins.includes("*") ? origin || "*" : config.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Last-Event-ID"],
      maxAge: 600,
    }),
  );

  app.use(
    "*",
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (c) => c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body exceeds 512 KiB" } }, 413),
    }),
  );

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    s.metrics.inc("payminto_http_requests_total", "HTTP requests by method and status class.", {
      method: c.req.method,
      status: `${Math.floor(c.res.status / 100)}xx`,
    });
    // Path only: the query string may carry the SSE admin token.
    log.debug("http", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) });
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toJSON(), err.status as 400);
    log.error("unhandled error", { method: c.req.method, path: c.req.path, err });
    return c.json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  const isAdmin = (c: Context) => {
    const t = bearer(c);
    return !!t && safeEqual(t, config.adminToken);
  };
  const tooMany = (c: Context, scope: "provider" | "ip", r: Extract<TakeResult, { ok: false }>) => {
    s.metrics.inc("payminto_rate_limited_total", "Requests refused with 429, by limiter.", { scope });
    c.header("Retry-After", String(r.retryAfterSec));
    return c.json({ error: { code: "RATE_LIMITED", message: `too many requests, retry in ${r.retryAfterSec}s`, details: { scope } } }, 429);
  };

  // Per-IP token bucket for every request that is not admin-authenticated: public reads, cosign, signed revokes and
  // failed auth attempts. Provider voucher traffic is limited per provider key below instead. /healthz stays open
  // for container and load-balancer probes.
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/healthz" || (c.req.method === "POST" && c.req.path === "/v1/vouchers")) return next();
    if (isAdmin(c)) return next();
    const r = s.limiters.ip.take(clientIp(c, config.trustProxyHops));
    if (!r.ok) return tooMany(c, "ip", r);
    return next();
  });

  const admin: MiddlewareHandler<Vars> = async (c, next) => {
    const t = bearer(c);
    if (!t || !safeEqual(t, config.adminToken)) throw new ApiError(401, "UNAUTHORIZED", "admin bearer token required");
    await next();
  };
  const provider: MiddlewareHandler<Vars> = async (c, next) => {
    const t = bearer(c);
    const p = t ? store.providerByKeyHash(hashApiKey(t)) : undefined;
    if (!p) {
      // Unknown keys share the caller's IP bucket, so guessing keys cannot bypass the per-key limit.
      const r = s.limiters.ip.take(clientIp(c, config.trustProxyHops));
      if (!r.ok) return tooMany(c, "ip", r);
      throw new ApiError(401, "UNAUTHORIZED", "provider API key required");
    }
    const r = s.limiters.provider.take(p.id);
    if (!r.ok) return tooMany(c, "provider", r);
    c.set("provider", p);
    await next();
  };

  // ------------------------------------------------------------------ public

  app.get("/healthz", async (c) => {
    let blockNumber: number | null = null;
    try {
      blockNumber = Number(await chain.public.getBlockNumber());
    } catch {
      blockNumber = null;
    }
    const ok = blockNumber !== null;
    return c.json(
      { ok, chainId: config.chainId, hub: chain.hub, token: chain.token, operator: chain.operator.address, blockNumber, hspMode: config.hsp.mode },
      ok ? 200 : 503,
    );
  });

  // Prometheus scrape target. Admin-authenticated: configure `authorization: { credentials: <ADMIN_TOKEN> }` in the
  // scrape job, or scrape through a proxy that adds the header (docs/OPERATIONS.md).
  app.get("/metrics", admin, async (c) => {
    const [head, gas] = await Promise.all([
      chain.public.getBlockNumber().catch(() => null),
      chain.public.getBalance({ address: chain.operator.address }).catch(() => null),
    ]);
    const scanned = store.getMeta("revocations_scanned_block");
    const mem = process.memoryUsage();
    const lines = [
      ...renderGauges([
        {
          name: "payminto_node_info",
          help: "Static node information.",
          samples: [{ labels: { version: NODE_VERSION, chain_id: String(config.chainId), hsp_mode: config.hsp.mode }, value: 1 }],
        },
        { name: "payminto_chain_head_block", help: "Latest block seen from RPC_URL.", samples: head === null ? [] : [{ value: head }] },
        { name: "payminto_rpc_up", help: "1 when the RPC answered this scrape.", samples: [{ value: head === null ? 0 : 1 }] },
        {
          name: "payminto_revocations_scanned_block",
          help: "Last block scanned for on-chain MandateRevoked events.",
          samples: scanned === undefined ? [] : [{ value: BigInt(scanned) }],
        },
        { name: "payminto_operator_gas_balance_wei", help: "Native balance of the operator, which pays settlement gas.", samples: gas === null ? [] : [{ value: gas }] },
        { name: "payminto_unsettled_calls", help: "Accepted calls not yet in a batch.", samples: [{ value: store.unsettledCallCount() }] },
        { name: "payminto_sse_clients", help: "Open /v1/events streams.", samples: [{ value: s.sseClosers.size }] },
        { name: "payminto_ratelimit_keys", help: "Tracked rate-limit buckets.", samples: [
          { labels: { scope: "provider" }, value: s.limiters.provider.size },
          { labels: { scope: "ip" }, value: s.limiters.ip.size },
        ] },
        ...databaseGauges(s.db),
        { name: "process_resident_memory_bytes", help: "Resident set size.", samples: [{ value: mem.rss }] },
        { name: "process_uptime_seconds", help: "Seconds since the node started.", samples: [{ value: Math.round((Date.now() - s.metrics.startedAt) / 1000) }] },
      ]),
      ...s.metrics.renderCounters(),
    ];
    return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  app.get("/v1/info", async (c) => {
    const gas = await chain.public.getBalance({ address: chain.operator.address }).catch(() => null);
    return c.json({
      version: NODE_VERSION,
      chainId: config.chainId,
      network: { chainId: config.chainId, name: net.chain.name, caip2: net.caip2, explorer: net.explorer || null, testnet: !!net.chain.testnet },
      hub: chain.hub,
      hubExplorerUrl: explorerAddress(config.chainId, chain.hub),
      token: s.token,
      explorer: net.explorer || null,
      operator: chain.operator.address,
      /** Native gas balance of the operator (wei), which pays openMandate and settleBatch gas. */
      ...(gas !== null ? { operatorGasBalance: gas.toString() } : {}),
      publicUrl: config.publicUrl,
      hspMode: config.hsp.mode,
      hsp: { mode: config.hsp.mode, verifyingContract: config.hsp.verifyingContract, cosignTimeoutSec: config.hsp.cosignTimeoutSec },
      settleIntervalSec: config.settleIntervalSec,
      settlement: { intervalSec: config.settleIntervalSec, minCalls: config.settleMinCalls, maxClaimsPerBatch: 64 },
    });
  });

  app.get("/v1/providers", (c) => {
    const now = nowSec();
    return c.json(store.providers().map((p) => providerPublicJson(p, store.providerCalls24h(p.id, now))));
  });

  app.get("/v1/mandates/:id/position", (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const payee = param(c.req.query("payee"), zAddress, "payee");
    if (!store.mandate(id)) throw new ApiError(404, "UNKNOWN_MANDATE", "No open mandate with this id on this node");
    return c.json(s.vouchers.positionJson(id, payee));
  });

  // Public: the signed mandate, its policy and allowlist. Safe to expose (the mandate is public on chain and commits
  // to both via policyHash and payeesRoot); agents verify those hashes and enforce the policy before signing.
  app.get("/v1/mandates/:id/policy", (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const m = store.mandate(id);
    if (!m) throw new ApiError(404, "UNKNOWN_MANDATE", "No open mandate with this id on this node");
    const summary = store.mandateSummary(m, nowSec());
    return c.json({ id: m.id, status: summary.status, mandate: summary.mandate, policy: summary.policy, payees: summary.payees });
  });

  app.get("/v1/receipts/:callId/proof", async (c) => {
    const callId = param(c.req.param("callId"), zBytes32, "callId");
    const call = store.call(callId);
    if (!call) throw new ApiError(404, "NOT_FOUND", "call not found");
    const batch = call.batch_seq !== null ? store.batch(String(call.batch_seq)) : undefined;
    const proof = call.proof ? (JSON.parse(call.proof) as Hex[]) : [];
    // True only if this node's operator settled the batch, signed the leaf, and the Merkle proof verifies on chain.
    const onchainVerified =
      batch && batch.status === "confirmed" ? await receiptVerifiedOnchain(chain, batch.batch_id, call.leaf, call.node_signature, proof) : null;
    const receipt: ClearingReceipt = {
      callId: call.call_id,
      mandateId: call.mandate_id,
      payee: call.payee,
      amount: call.amount,
      cumulative: call.cumulative,
      requestHash: call.request_hash,
      timestamp: call.timestamp,
      leaf: call.leaf,
      nodeSignature: call.node_signature,
      node: chain.operator.address,
    };
    return c.json({
      receipt,
      status: call.status,
      batchId: batch?.batch_id ?? null,
      batchStatus: batch?.status ?? null,
      receiptsRoot: batch?.receipts_root ?? null,
      proof,
      leaf: call.leaf,
      txHash: batch?.tx_hash ?? null,
      explorerUrl: batch?.tx_hash ? explorerTx(config.chainId, batch.tx_hash) : null,
      onchainVerified,
    });
  });

  app.get("/v1/agents/:address/cosign", (c) => {
    const address = param(c.req.param("address"), zAddress, "address");
    return c.json(s.settlement.pendingCosigns(address));
  });

  app.post("/v1/cosign/:hspPaymentId", async (c) => {
    const id = param(c.req.param("hspPaymentId"), zBytes32, "hspPaymentId");
    const { signerProof } = await body(c, cosignSchema);
    return c.json(await s.settlement.cosign(id, signerProof));
  });

  app.get("/v1/events", (c) => {
    const t = bearer(c) ?? c.req.query("token") ?? null;
    if (!t || !safeEqual(t, config.adminToken)) throw new ApiError(401, "UNAUTHORIZED", "admin token required (header or ?token=)");
    const lastRaw = c.req.header("last-event-id") ?? c.req.query("since");
    const lastId = lastRaw && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
    return streamSSE(c, async (stream) => {
      const queue: NodeEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const close = () => {
        closed = true;
        wake?.();
      };
      const unsubscribe = events.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      s.sseClosers.add(close);
      stream.onAbort(close);
      try {
        let sent = 0;
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: nowIso(), node: chain.operator.address }), retry: 3000 });
        if (lastId !== null) {
          for (const e of events.since(lastId)) {
            await stream.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
            sent = Number(e.id);
          }
        }
        while (!closed && !stream.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 15_000);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = null;
            if (queue.length === 0 && !closed) await stream.write(": ping\n\n");
          }
          while (queue.length && !closed) {
            const e = queue.shift()!;
            if (Number(e.id) <= sent) continue;
            await stream.writeSSE({ event: e.type, id: e.id, data: JSON.stringify(e) });
          }
        }
      } finally {
        unsubscribe();
        s.sseClosers.delete(close);
      }
    });
  });

  // ---------------------------------------------------------------- provider

  app.post("/v1/vouchers", provider, async (c) => {
    const p = c.get("provider");
    const b = await body(c, voucherSchema);
    if (b.providerId !== p.id) throw new ApiError(403, "PROVIDER_MISMATCH", "providerId does not match the API key");
    if (b.network !== net.caip2) throw new ApiError(400, "NETWORK_MISMATCH", `network must be ${net.caip2}`);
    if (b.payload.payee !== p.payee) throw new ApiError(400, "PAYEE_MISMATCH", "voucher payee is not this provider's payee");
    if (b.payload.requestHash !== b.requestHash) {
      throw new ApiError(400, "REQUEST_HASH_MISMATCH", "payload.requestHash differs from the provider's requestHash");
    }
    const r = await s.vouchers.accept(p, b.payload);
    if (r.ok) return c.json({ receipt: r.receipt, position: r.position });
    return c.json({ error: { code: r.rule as DenialRule, message: r.message, details: r.details } }, 402);
  });

  // ------------------------------------------------------------------- admin

  app.get("/v1/overview", admin, (c) => c.json({ ...overview(s.db, store, config.chainId, nowSec()), token: s.token }));

  app.get("/v1/mandates", admin, (c) => {
    const now = nowSec();
    return c.json(store.mandates().map((m) => store.mandateSummary(m, now)));
  });

  app.get("/v1/mandates/:id", admin, async (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const m = store.mandate(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "mandate not found");
    const onchain = await chain.mandate(m.id).catch(() => undefined);
    const positions = s.db
      .all<{ payee: Address; cumulative: string; settled: string }>(
        "SELECT payee, cumulative, settled FROM positions WHERE mandate_id = ? ORDER BY payee",
        m.id,
      )
      .map((p) => ({ ...p, pending: (BigInt(p.cumulative) - BigInt(p.settled)).toString() }));
    return c.json({
      ...store.mandateSummary(m, nowSec()),
      ownerSignature: m.owner_signature,
      revokedBy: m.revoked_by,
      revokeTxHash: m.revoke_tx_hash,
      openTxExplorerUrl: m.open_tx_hash ? explorerTx(config.chainId, m.open_tx_hash) : null,
      onchain:
        onchain === undefined
          ? null
          : onchain === null
            ? { open: false }
            : {
                open: true,
                spent: onchain.spent.toString(),
                totalCap: onchain.totalCap.toString(),
                revokedAt: onchain.revokedAt === 0n ? null : Number(onchain.revokedAt),
                validUntil: Number(onchain.validUntil),
              },
      positions,
      recentCalls: store.listCalls({ mandateId: m.id, limit: 50 }).items,
      denials: store.listDenials({ mandateId: m.id, limit: 50 }),
      spendSeries: store.spendSeries(m.id, nowSec()),
    });
  });

  app.post("/v1/mandates", admin, async (c) => {
    const b = await body(c, createMandateSchema);
    const row = await s.mandates.create(b);
    return c.json(store.mandateSummary(row, nowSec()), 201);
  });

  app.post("/v1/mandates/:id/revoke", async (c) => {
    const id = param(c.req.param("id"), zBytes32, "id");
    const m = store.mandate(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "mandate not found");
    const t = bearer(c);
    let by: string;
    if (t && safeEqual(t, config.adminToken)) by = "admin";
    else {
      const { signature } = await body(c, revokeSchema);
      if (!signature) throw new ApiError(401, "UNAUTHORIZED", "admin bearer token or an agent/owner revoke signature required");
      by = await s.mandates.authorizeSignedRevoke(m, signature);
    }
    return c.json(await s.mandates.revoke(m.id, by));
  });

  app.get("/v1/providers/:id", admin, (c) => {
    const p = store.provider(c.req.param("id"));
    if (!p) throw new ApiError(404, "NOT_FOUND", "provider not found");
    const revenue = s.db.get<{ settled: string; pending: string; calls: number }>(
      `SELECT bigsum(CASE WHEN status = 'settled' THEN amount END) AS settled,
              bigsum(CASE WHEN status != 'settled' THEN amount END) AS pending, COUNT(*) AS calls
       FROM calls WHERE provider_id = ?`,
      p.id,
    )!;
    const denials = s.db.get<{ n: number }>("SELECT COALESCE(SUM(repeats), 0) AS n FROM denials WHERE provider_id = ?", p.id)!.n;
    return c.json({
      ...providerPublicJson(p, store.providerCalls24h(p.id, nowSec())),
      createdAt: p.created_at,
      callsTotal: revenue.calls,
      denials,
      revenue: { settled: revenue.settled, pending: revenue.pending },
      recentCalls: store.listCalls({ providerId: p.id, limit: 50 }).items,
    });
  });

  app.post("/v1/providers", admin, async (c) => {
    const b = await body(c, createProviderSchema);
    const id = `prv_${randomBytes(6).toString("hex")}`;
    const apiKey = `pmk_${randomBytes(24).toString("base64url")}`;
    const createdAt = nowIso();
    s.db.run(
      `INSERT INTO providers (id, name, description, payee, price_atomic, resource, category, api_key_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      b.name,
      b.description,
      b.payee,
      b.priceAtomic,
      b.resource,
      b.category,
      hashApiKey(apiKey),
      createdAt,
    );
    log.info("provider registered", { providerId: id, payee: b.payee });
    const p = store.provider(id)!;
    return c.json({ ...providerPublicJson(p, 0), createdAt, apiKey }, 201);
  });

  app.get("/v1/calls", admin, (c) => {
    const status = c.req.query("status");
    if (status && !["accepted", "settling", "settled"].includes(status)) {
      throw new ApiError(400, "VALIDATION_ERROR", "status must be accepted, settling or settled");
    }
    const cursor = c.req.query("cursor");
    if (cursor && !/^\d+$/.test(cursor)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    const mandateId = c.req.query("mandateId");
    const payee = c.req.query("payee");
    return c.json(
      store.listCalls({
        mandateId: mandateId ? param(mandateId, zBytes32, "mandateId") : undefined,
        payee: payee ? param(payee, zAddress, "payee") : undefined,
        status: status || undefined,
        providerId: c.req.query("providerId") || undefined,
        limit: limitOf(c),
        cursor: cursor ? Number(cursor) : undefined,
      }),
    );
  });

  app.get("/v1/denials", admin, (c) => c.json(store.listDenials({ limit: limitOf(c) })));

  app.get("/v1/batches", admin, (c) => {
    return c.json(store.batches(limitOf(c)).map((b) => batchSummaryJson(b, config.chainId)));
  });

  app.get("/v1/batches/:id", admin, (c) => {
    const b = store.batch(c.req.param("id"));
    if (!b) throw new ApiError(404, "NOT_FOUND", "batch not found");
    return c.json(store.batchDetailJson(b, config.chainId));
  });

  app.post("/v1/settlements", admin, async (c) => c.json(await s.settlement.settle("manual")));

  app.get("/v1/ledger", admin, (c) => {
    const cursor = c.req.query("cursor");
    if (cursor && !/^\d+$/.test(cursor)) throw new ApiError(400, "VALIDATION_ERROR", "invalid cursor");
    return c.json(s.ledger.entries({ account: c.req.query("account") || undefined, limit: limitOf(c, 100, 1000), cursor: cursor ? Number(cursor) : undefined }));
  });

  app.get("/v1/ledger/trial-balance", admin, (c) => c.json(s.ledger.trialBalance()));

  app.get("/v1/netting/preview", admin, (c) => c.json(s.settlement.preview()));

  return app;
}
