import { createPublicClient, getAddress, http, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  clearingHubAbi,
  decodeHeader,
  DENIAL_RULES,
  formatAmount,
  HEADER_RESPONSE,
  networkFor,
  verifyReceiptProof,
  type ClearingReceipt,
  type DenialRule,
} from "@payminto/protocol";
import { AgentClient, NodeHttp, type DeniedEvent, type VerifiedPolicy } from "@payminto/sdk";

// Everything read from the clearing node or a provider is untrusted input: parse it.
const zAddr = z.string().transform((v, ctx) => {
  try {
    return getAddress(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "address" });
    return z.NEVER;
  }
});
const zUint = z.string().regex(/^\d{1,78}$/);
const zB32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v.toLowerCase() as Hex);

const infoSchema = z
  .object({
    hub: zAddr,
    token: z.object({ address: zAddr, symbol: z.string(), decimals: z.number().int() }),
    operator: zAddr,
  })
  .loose();
const catalogSchema = z.array(
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      payee: zAddr,
      priceAtomic: zUint,
      resource: z.string(),
      category: z.string(),
      calls24h: z.number().optional(),
    })
    .loose(),
);
const positionSchema = z.object({ cumulative: zUint, settled: zUint }).loose();
const proofSchema = z
  .object({
    receipt: z.object({ callId: zB32, mandateId: zB32, payee: zAddr, amount: zUint, cumulative: zUint, requestHash: zB32, timestamp: z.number(), leaf: zB32 }).loose(),
    status: z.string(),
    batchId: zB32.nullable(),
    batchStatus: z.string().nullable().optional(),
    receiptsRoot: zB32.nullable(),
    proof: z.array(zB32),
    leaf: zB32,
    txHash: z.string().nullable(),
    explorerUrl: z.string().nullable(),
    onchainVerified: z.boolean().nullable(),
  })
  .loose();

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) });
const paymentResponseSchema = z.object({ receipt: z.object({ callId: zB32, payee: zAddr, amount: zUint, cumulative: zUint }).loose() }).loose();

export type Service = {
  id: string;
  name: string;
  description: string;
  category: string;
  url: string;
  payee: Address;
  priceAtomic: string;
  price: string;
  calls24h: number | null;
  /** null when the wallet cannot see the mandate allowlist. */
  allowedByMandate: boolean | null;
};

export type CallArgs = {
  serviceId?: string;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean>;
  body?: unknown;
};

export type Paid = { callId: Hex; payee: Address; amountAtomic: string; amount: string; cumulativeAtomic: string };

export type CallOutcome =
  | { ok: true; status: number; url: string; service: string | null; paid: Paid | null; body: unknown; truncated: boolean }
  | {
      ok: false;
      kind: "denied";
      rule: string;
      ruleText: string;
      message: string;
      /** "agent": refused by this wallet before signing; "node": refused by the clearing node and recorded there. */
      enforcedBy: "agent" | "node";
      status: number;
      url: string;
      service: string | null;
      details?: Record<string, unknown>;
    }
  | { ok: false; kind: "error"; message: string; status: number | null; url: string | null; service: string | null; body?: unknown };

export type HistoryEntry = { at: string; service: string | null; url: string; receipt: ClearingReceipt; price: string };

export type WalletOptions = {
  nodeUrl: string;
  chainId: number;
  hub?: Address;
  agentKey: Hex;
  mandateId: Hex;
  rpcUrl?: string;
  maxPrice?: bigint;
  trustedNode?: Address;
  /** Check the mandate policy before signing (default true, the SDK default). */
  enforcePolicy?: boolean;
  fetch?: typeof fetch;
  /** Largest response body (characters) returned to the model. */
  maxBodyChars?: number;
};

const MAX_HISTORY = 1_000;

/**
 * A budgeted wallet for an LLM agent: every paid call goes through AgentClient, so it is bound to one mandate
 * and the clearing node enforces every cap atomically. Keeps the receipts it was given for proof requests.
 */
export class AgentWallet {
  readonly agent: AgentClient;
  readonly node: NodeHttp;
  readonly chainId: number;
  readonly hub: Address;
  readonly mandateId: Hex;
  readonly history: HistoryEntry[] = [];
  readonly #o: WalletOptions;
  readonly #public: PublicClient | null;
  #info: z.infer<typeof infoSchema> | null = null;

  private constructor(o: WalletOptions, hub: Address, info: z.infer<typeof infoSchema>) {
    this.#o = o;
    this.chainId = o.chainId;
    this.hub = hub;
    this.mandateId = o.mandateId.toLowerCase() as Hex;
    this.#info = info;
    this.node = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
    this.agent = new AgentClient({
      nodeUrl: o.nodeUrl,
      chainId: o.chainId,
      hub,
      account: privateKeyToAccount(o.agentKey),
      mandateId: this.mandateId,
      autoCosign: true,
      maxPrice: o.maxPrice,
      trustedNode: o.trustedNode ?? info.operator,
      enforcePolicy: o.enforcePolicy,
      fetch: o.fetch,
    });
    this.#public = o.rpcUrl ? (createPublicClient({ transport: http(o.rpcUrl) }) as PublicClient) : null;
  }

  /** Connects to the node, checks it clears the configured hub, and builds the wallet. */
  static async connect(o: WalletOptions): Promise<AgentWallet> {
    const node = new NodeHttp(o.nodeUrl, { fetch: o.fetch });
    const info = await node.get("/v1/info", infoSchema);
    if (o.hub && !isAddressEqual(o.hub, info.hub)) {
      throw new Error(`clearing node at ${o.nodeUrl} clears hub ${info.hub}, but HUB_ADDRESS is ${o.hub}`);
    }
    return new AgentWallet(o, o.hub ?? info.hub, info);
  }

  get address(): Address {
    return this.agent.address;
  }

  get token() {
    return this.#info!.token;
  }

  fmt(atomic: bigint | string): string {
    return `${formatAmount(atomic, this.token.decimals)} ${this.token.symbol}`;
  }

  /** Stops the HSP co-sign loop (call on shutdown). */
  close(): void {
    this.agent.stopCosignLoop();
  }

  /** The mandate, policy and allowlist, verified by the SDK against the mandate id (a node cannot loosen them). */
  async #policy(): Promise<VerifiedPolicy | null> {
    return this.agent.loadPolicy().catch(() => null);
  }

  async services(): Promise<Service[]> {
    const [catalog, pol] = await Promise.all([this.node.get("/v1/providers", catalogSchema), this.#policy()]);
    const allow = pol?.payees;
    return catalog.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      url: p.resource,
      payee: p.payee,
      priceAtomic: p.priceAtomic,
      price: this.fmt(p.priceAtomic),
      calls24h: p.calls24h ?? null,
      allowedByMandate: allow ? allow.some((a) => isAddressEqual(a, p.payee)) : null,
    }));
  }

  async #resolve(a: CallArgs): Promise<{ url: string; service: string | null }> {
    let base: string;
    let service: string | null = null;
    if (a.serviceId) {
      const s = (await this.services()).find((x) => x.id === a.serviceId || x.name.toLowerCase() === a.serviceId!.toLowerCase());
      if (!s) throw new Error(`unknown serviceId "${a.serviceId}"; call list_paid_services for valid ids`);
      service = s.name;
      base = a.url ?? s.url;
    } else if (a.url) {
      base = a.url;
    } else {
      throw new Error("pass either serviceId or url");
    }
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      throw new Error(`"${base}" is not an absolute URL; pass url explicitly`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https URLs can be called");
    for (const [k, v] of Object.entries(a.query ?? {})) u.searchParams.set(k, String(v));
    return { url: u.toString(), service };
  }

  /** Calls a service, paying its x402 payminto-voucher requirement from the mandate if it asks for one. */
  async call(a: CallArgs): Promise<CallOutcome> {
    let target: { url: string; service: string | null };
    try {
      target = await this.#resolve(a);
    } catch (err) {
      return { ok: false, kind: "error", message: (err as Error).message, status: null, url: a.url ?? null, service: a.serviceId ?? null };
    }
    const method = a.method ?? (a.body === undefined ? "GET" : "POST");
    const init: RequestInit = { method, headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" } };
    if (a.body !== undefined && method !== "GET") {
      init.body = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
      init.headers = { ...init.headers, "content-type": typeof a.body === "string" ? "text/plain" : "application/json" };
    }
    let clientDenial: DeniedEvent | null = null;
    const off = this.agent.on("denied", (d) => {
      if (d.url === target.url && d.code.startsWith("CLIENT_")) clientDenial = d;
    });
    let res: Response;
    try {
      res = await this.agent.fetch(target.url, init);
    } catch (err) {
      return { ok: false, kind: "error", message: `request failed: ${(err as Error).message}`, status: null, ...target };
    } finally {
      off();
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: keep text
    }

    if (res.status === 402) {
      const cd = clientDenial as DeniedEvent | null;
      if (cd) {
        return { ok: false, kind: "denied", rule: cd.code, ruleText: "Price above this wallet's MAX_PRICE_ATOMIC", message: cd.message, enforcedBy: "agent", status: 402, ...target };
      }
      const e = errorBodySchema.safeParse(body);
      if (e.success && e.data.error.code !== "PAYMENT_REQUIRED") {
        const rule = e.data.error.code;
        const ruleText = rule in DENIAL_RULES ? DENIAL_RULES[rule as DenialRule] : "Payment refused";
        const enforcedBy = e.data.error.details?.enforcedBy === "agent" ? "agent" : "node";
        return { ok: false, kind: "denied", rule, ruleText, message: e.data.error.message, enforcedBy, status: 402, details: e.data.error.details, ...target };
      }
      return {
        ok: false,
        kind: "error",
        message: "the service requires a payment this wallet cannot make: no payminto-voucher offer for this network and clearing hub",
        status: 402,
        ...target,
      };
    }

    let paid: Paid | null = null;
    const pr = paymentResponseSchema.safeParse(decodeHeader<unknown>(res.headers.get(HEADER_RESPONSE)));
    if (pr.success) {
      const r = pr.data.receipt;
      const stored = this.agent.receipts.get(r.callId);
      // Only receipts the AgentClient verified (node signature, leaf, amounts) count as paid.
      if (stored) {
        paid = { callId: r.callId, payee: r.payee, amountAtomic: r.amount, amount: this.fmt(r.amount), cumulativeAtomic: r.cumulative };
        this.history.push({ at: new Date().toISOString(), service: target.service, url: target.url, receipt: stored, price: r.amount });
        if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      }
    }
    const max = this.#o.maxBodyChars ?? 16_000;
    let truncated = false;
    if (typeof body === "string" && body.length > max) {
      body = body.slice(0, max);
      truncated = true;
    } else if (body !== null && typeof body === "object" && JSON.stringify(body).length > max) {
      body = JSON.stringify(body).slice(0, max);
      truncated = true;
    }
    if (!res.ok) return { ok: false, kind: "error", message: `service answered HTTP ${res.status}`, status: res.status, body, ...target };
    return { ok: true, status: res.status, paid, body, truncated, ...target };
  }

  /** Budget: verified mandate and policy, node positions per allowed payee, and on-chain state when RPC_URL is set. */
  async budget() {
    const pol = await this.#policy();
    const payees = pol?.payees ?? [...new Map((await this.services()).map((s) => [s.payee.toLowerCase(), s.payee])).values()];
    let cumulative = 0n;
    let settled = 0n;
    for (const payee of payees) {
      const p = await this.node.get(`/v1/mandates/${this.mandateId}/position?payee=${payee}`, positionSchema).catch(() => null);
      if (!p) continue;
      cumulative += BigInt(p.cumulative);
      settled += BigInt(p.settled);
    }
    let onchain: { spent: bigint; revokedAt: number } | null = null;
    if (this.#public) {
      const m = await this.#public
        .readContract({ address: this.hub, abi: clearingHubAbi, functionName: "mandates", args: [this.mandateId] })
        .catch(() => null);
      if (m) {
        const t = m as readonly [Address, Address, Address, bigint, bigint, bigint, bigint, bigint, Hex];
        onchain = { spent: t[7], revokedAt: Number(t[5]) };
      }
    }
    const now = Date.now();
    const sessionToday = this.history.filter((h) => now - Date.parse(h.at) < 86_400_000).reduce((s, h) => s + BigInt(h.price), 0n);
    const pending = cumulative - settled;
    const settledTotal = onchain && onchain.spent > settled ? onchain.spent : settled;
    const total = settledTotal + pending;
    const out: Record<string, unknown> = {
      mandateId: this.mandateId,
      agent: this.address,
      token: this.token,
      spent: { total: this.fmt(total), settled: this.fmt(settledTotal), pending: this.fmt(pending), totalAtomic: total.toString() },
      sessionCalls: this.history.length,
      spentThisSession24h: this.fmt(sessionToday),
    };
    if (pol) {
      const cap = pol.mandate.totalCap;
      const remaining = cap > total ? cap - total : 0n;
      out.totalCap = this.fmt(cap);
      out.remaining = this.fmt(remaining);
      out.remainingAtomic = remaining.toString();
      out.perCallCap = this.fmt(pol.policy.perCallCap);
      out.dailyCap = this.fmt(pol.policy.dailyCap);
      out.maxCallsPerMinute = pol.policy.maxCallsPerMinute === 0 ? "unlimited" : pol.policy.maxCallsPerMinute;
      out.purpose = pol.policy.purpose;
      out.validFrom = new Date(Number(pol.mandate.validAfter) * 1000).toISOString();
      out.expiresAt = new Date(Number(pol.mandate.validUntil) * 1000).toISOString();
      out.allowedPayees = pol.payees;
      out.policyVerified = "mandate, policy and allowlist hash to this mandate id";
    } else out.note = "the node did not serve a verifiable policy for this mandate; caps unknown, payments will be refused by this wallet";
    if (onchain) out.revoked = onchain.revokedAt > 0;
    return out;
  }

  receipts(limit = 10) {
    return this.history
      .slice(-Math.max(1, Math.min(limit, 100)))
      .reverse()
      .map((h) => ({
        callId: h.receipt.callId,
        at: h.at,
        service: h.service,
        url: h.url,
        payee: h.receipt.payee,
        amount: this.fmt(h.receipt.amount),
        cumulative: this.fmt(h.receipt.cumulative),
        leaf: h.receipt.leaf,
        node: h.receipt.node,
      }));
  }

  /** Proves one call against the batch receipts root stored on chain, checking the node's answer independently. */
  async prove(callId: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) throw new Error("callId must be a 0x-prefixed 32-byte id from get_receipts");
    const id = callId.toLowerCase() as Hex;
    const p = await this.node.get(`/v1/receipts/${id}/proof`, proofSchema);
    const mine = this.agent.receipts.get(id) ?? null;
    if (!p.batchId || !p.receiptsRoot) {
      return { callId: id, status: p.status, settled: false, message: "This call is cleared but not settled yet; it lands in the next batch. Ask again after settlement." };
    }
    const r = p.receipt;
    const localProofValid = verifyReceiptProof(
      p.receiptsRoot,
      { callId: r.callId, mandateId: r.mandateId, payee: r.payee, amount: BigInt(r.amount), cumulative: BigInt(r.cumulative), requestHash: r.requestHash, timestamp: BigInt(r.timestamp) },
      p.proof,
    );
    const matchesMyReceipt = mine ? mine.leaf.toLowerCase() === p.leaf.toLowerCase() : null;
    let independentlyVerifiedOnchain: boolean | null = null;
    if (this.#public) {
      independentlyVerifiedOnchain = (await this.#public
        .readContract({ address: this.hub, abi: clearingHubAbi, functionName: "verifyReceipt", args: [p.batchId, p.leaf, p.proof] })
        .catch(() => null)) as boolean | null;
    }
    return {
      callId: id,
      status: p.status,
      settled: true,
      batchId: p.batchId,
      batchStatus: p.batchStatus ?? null,
      receiptsRoot: p.receiptsRoot,
      leaf: p.leaf,
      proofLength: p.proof.length,
      proof: p.proof,
      txHash: p.txHash,
      explorerUrl: p.explorerUrl ?? (p.txHash ? explorerOrNull(this.chainId, p.txHash) : null),
      amount: this.fmt(r.amount),
      payee: r.payee,
      nodeSaysVerifiedOnchain: p.onchainVerified,
      independentlyVerifiedOnchain,
      localProofValid,
      matchesMyReceipt,
    };
  }
}

function explorerOrNull(chainId: number, hash: string): string | null {
  const base = networkFor(chainId).explorer;
  return base ? `${base}/tx/${hash}` : null;
}
