import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  publicActions,
  recoverMessageAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  decodeHeader,
  EIP712_EOA_PROFILE,
  encodeHeader,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  hspMandateFromWire,
  hspPaymentId,
  hspTypedData,
  receiptLeaf,
  SCHEME,
  voucherTypedData,
  X402_VERSION,
  type ClearingReceipt,
  type PaymentRequirement,
  type VoucherPayment,
} from "@payminto/protocol";
import { z } from "zod";
import {
  cosignItemSchema,
  errorSchema,
  infoSchema,
  NodeApiError,
  NodeHttp,
  paymentRequirementSchema,
  paymentRequiredSchema,
  paymentResponseSchema,
  positionSchema,
  type CosignItem,
} from "./node-api.ts";
import { computeRequestHash, Emitter, KeyedMutex, revokeMessage, sleep as defaultSleep } from "./util.ts";

/** Where the agent keeps receipts it was given; they justify (or refuse) HSP co-sign requests. */
export interface ReceiptStore {
  add(receipt: ClearingReceipt): void;
  get(callId: Hex): ClearingReceipt | undefined;
  all(): ClearingReceipt[];
}

export class MemoryReceiptStore implements ReceiptStore {
  readonly #m = new Map<string, ClearingReceipt>();
  add(r: ClearingReceipt) {
    this.#m.set(r.callId.toLowerCase(), r);
  }
  get(id: Hex) {
    return this.#m.get(id.toLowerCase());
  }
  all() {
    return [...this.#m.values()];
  }
}

export type AgentClientOptions = {
  chainId: number;
  hub: Address;
  /** Agent key. Only signTypedData / signMessage are used; it never leaves the process. */
  account: LocalAccount;
  mandateId: Hex;
  /** Trusted clearing node. When unset, the node advertised in the 402 requirement is used. */
  nodeUrl?: string;
  /** Start the HSP co-sign loop automatically after the first paid call. */
  autoCosign?: boolean;
  cosignIntervalMs?: number;
  /** STALE_CUMULATIVE retries (default 3). */
  maxRetries?: number;
  /** Refuse requirements above this price (atomic units) without signing. */
  maxPrice?: bigint;
  /** Expected node operator address in receipts. */
  trustedNode?: Address;
  /** Extra HSP verifying contracts the agent accepts besides the hub (coordinator deployments). */
  hspVerifyingContracts?: readonly Address[];
  receipts?: ReceiptStore;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ReceiptEvent = { receipt: ClearingReceipt; url: string; price: bigint };
export type DeniedEvent = { code: string; message: string; details?: Record<string, unknown>; url: string; payee?: Address; amount?: bigint };
export type CosignedEvent = { hspPaymentId: Hex; batchId: Hex; amount: bigint; recipient: Address };
export type CosignRefusedEvent = { hspPaymentId: Hex; batchId: Hex; reason: string };

type AgentEvents = {
  receipt: ReceiptEvent;
  denied: DeniedEvent;
  cosigned: CosignedEvent;
  cosignRefused: CosignRefusedEvent;
  error: Error;
};

type PreparedRequest = { url: string; method: string; headers: Headers; body: Uint8Array | undefined };

async function prepare(input: string | URL | Request, init?: RequestInit): Promise<PreparedRequest> {
  if (input instanceof Request) {
    const buf = new Uint8Array(await input.arrayBuffer());
    return { url: input.url, method: input.method, headers: new Headers(input.headers), body: buf.length ? buf : undefined };
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const b = init?.body;
  let body: Uint8Array | undefined;
  if (b === undefined || b === null) body = undefined;
  else if (typeof b === "string") body = new TextEncoder().encode(b);
  else if (b instanceof Uint8Array) body = b;
  else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else if (b instanceof URLSearchParams) {
    body = new TextEncoder().encode(b.toString());
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  } else if (b instanceof Blob) body = new Uint8Array(await b.arrayBuffer());
  else throw new TypeError("AgentClient.fetch supports string, bytes, Blob and URLSearchParams bodies (streams cannot be replayed)");
  return { url: String(input), method, headers, body };
}

/**
 * Agent side of Payminto Clearing: pays x402 `payminto-voucher` requirements with signed cumulative vouchers,
 * verifies every receipt, and co-signs HSP mandates only for net debits its own receipts justify.
 */
export class AgentClient extends Emitter<AgentEvents> {
  readonly chainId: number;
  readonly hub: Address;
  readonly account: LocalAccount;
  readonly mandateId: Hex;
  readonly receipts: ReceiptStore;
  readonly #o: AgentClientOptions;
  readonly #fetch: typeof fetch;
  readonly #mutex = new KeyedMutex();
  readonly #positions = new Map<string, bigint>();
  /** Batch each receipt was used to justify: a receipt backs co-signatures of one batch only. */
  readonly #callBatch = new Map<string, string>();
  /** Total HSP amount already co-signed per batch. */
  readonly #cosignedByBatch = new Map<string, bigint>();
  readonly #handledCosigns = new Set<string>();
  #nodeUrl: string | undefined;
  #cosignTimer: ReturnType<typeof setInterval> | null = null;
  #cosignBusy: Promise<unknown> | null = null;

  constructor(o: AgentClientOptions) {
    super();
    this.#o = o;
    this.chainId = o.chainId;
    this.hub = getAddress(o.hub);
    this.account = o.account;
    this.mandateId = o.mandateId.toLowerCase() as Hex;
    this.receipts = o.receipts ?? new MemoryReceiptStore();
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
    this.#nodeUrl = o.nodeUrl?.replace(/\/+$/, "");
  }

  get address(): Address {
    return this.account.address;
  }

  #node(): NodeHttp {
    if (!this.#nodeUrl) throw new Error("AgentClient has no nodeUrl yet: pass nodeUrl or make a paid call first");
    return new NodeHttp(this.#nodeUrl, { fetch: this.#fetch });
  }

  /** Current position for a payee from the node (what the next voucher must extend). */
  async position(payee: Address): Promise<{ cumulative: bigint; settled: bigint }> {
    const p = await this.#node().get(`/v1/mandates/${this.mandateId}/position?payee=${getAddress(payee)}`, positionSchema);
    return { cumulative: BigInt(p.cumulative), settled: BigInt(p.settled) };
  }

  /** fetch() that pays `payminto-voucher` 402 requirements and returns the provider's response. */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = await prepare(input, init);
    const first = await this.#send(req, null);
    if (first.status !== 402) return first;

    const requirement = await this.#pickRequirement(first);
    if (!requirement) return first;
    const amount = BigInt(requirement.amount);
    const payee = getAddress(requirement.payTo);
    if (this.#o.maxPrice !== undefined && amount > this.#o.maxPrice) {
      this.emit("denied", { code: "CLIENT_MAX_PRICE", message: `price ${amount} exceeds maxPrice ${this.#o.maxPrice}`, url: req.url, payee, amount });
      return first;
    }
    if (!this.#nodeUrl) this.#nodeUrl = requirement.extra.clearingNode.replace(/\/+$/, "");
    const requestHash = computeRequestHash(req.method, req.url, req.body);
    return this.#mutex.run(`${this.mandateId}:${payee}`, () => this.#pay(req, payee, amount, requestHash));
  }

  async #pickRequirement(res: Response): Promise<PaymentRequirement | null> {
    let required = decodeHeader<unknown>(res.headers.get(HEADER_REQUIRED));
    if (!required) required = await res.clone().json().catch(() => null);
    const parsed = paymentRequiredSchema.safeParse(required);
    if (!parsed.success) return null;
    for (const a of parsed.data.accepts) {
      const r = paymentRequirementSchema.safeParse(a);
      if (!r.success) continue;
      if (r.data.scheme !== SCHEME || r.data.network !== `eip155:${this.chainId}`) continue;
      if (!isAddressEqual(r.data.extra.clearingHub, this.hub)) continue;
      return r.data as PaymentRequirement;
    }
    return null;
  }

  #send(req: PreparedRequest, payment: string | null): Promise<Response> {
    const headers = new Headers(req.headers);
    if (payment) headers.set(HEADER_SIGNATURE, payment);
    return this.#fetch(req.url, { method: req.method, headers, body: req.body as BodyInit | undefined });
  }

  async #pay(req: PreparedRequest, payee: Address, amount: bigint, requestHash: Hex): Promise<Response> {
    const key = payee.toLowerCase();
    const maxRetries = this.#o.maxRetries ?? 3;
    const sleep = this.#o.sleep ?? defaultSleep;
    const random = this.#o.random ?? Math.random;
    let position = this.#positions.get(key);
    if (position === undefined) position = (await this.position(payee)).cumulative;

    for (let attempt = 0; ; attempt++) {
      const cumulative = position + amount;
      const signature = await this.account.signTypedData(
        voucherTypedData(this.chainId, this.hub, { mandateId: this.mandateId, payee, cumulative }),
      );
      const payment: VoucherPayment = {
        x402Version: X402_VERSION,
        scheme: SCHEME,
        network: `eip155:${this.chainId}`,
        payload: { mandateId: this.mandateId, payee, amount: amount.toString(), cumulative: cumulative.toString(), signature, requestHash },
      };
      const res = await this.#send(req, encodeHeader(payment));
      const paid = decodeHeader<unknown>(res.headers.get(HEADER_RESPONSE));
      if (paid) {
        this.#positions.set(key, cumulative);
        await this.#acceptReceipt(paid, { payee, amount, cumulative, requestHash, url: req.url });
        return res;
      }
      if (res.status !== 402) {
        // Unknown payment outcome: forget the cached position so the next call resyncs with the node.
        this.#positions.delete(key);
        return res;
      }
      const denial = errorSchema.safeParse(await res.clone().json().catch(() => null));
      const code = denial.success ? denial.data.error.code : "PAYMENT_REQUIRED";
      const details = denial.success ? denial.data.error.details : undefined;
      if (code === "STALE_CUMULATIVE" && attempt < maxRetries) {
        const fromDetails = positionSchema.safeParse(details?.position);
        position = fromDetails.success ? BigInt(fromDetails.data.cumulative) : (await this.position(payee)).cumulative;
        this.#positions.set(key, position);
        // Jittered backoff: 25-75 ms, doubling per attempt, so racing processes spread out.
        await sleep(Math.round((25 + random() * 50) * 2 ** attempt));
        continue;
      }
      if (code === "STALE_CUMULATIVE") this.#positions.delete(key);
      this.emit("denied", {
        code,
        message: denial.success ? denial.data.error.message : "payment required",
        details,
        url: req.url,
        payee,
        amount,
      });
      return res;
    }
  }

  async #acceptReceipt(raw: unknown, expect: { payee: Address; amount: bigint; cumulative: bigint; requestHash: Hex; url: string }): Promise<void> {
    const parsed = paymentResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.emit("error", new Error("provider returned a malformed PAYMENT-RESPONSE"));
      return;
    }
    const r = parsed.data.receipt as ClearingReceipt;
    const problem = await this.#verifyReceipt(r, expect).catch((err: unknown) => String(err));
    if (problem) {
      // Not stored: an unverifiable receipt can never justify an HSP co-signature.
      this.emit("error", new Error(`receipt rejected: ${problem}`));
      return;
    }
    this.receipts.add(r);
    this.emit("receipt", { receipt: r, url: expect.url, price: expect.amount });
    if (this.#o.autoCosign && !this.#cosignTimer) this.startCosignLoop();
  }

  async #verifyReceipt(
    r: ClearingReceipt,
    e: { payee: Address; amount: bigint; cumulative: bigint; requestHash: Hex },
  ): Promise<string | null> {
    if (r.mandateId.toLowerCase() !== this.mandateId) return "mandate mismatch";
    if (!isAddressEqual(r.payee, e.payee)) return "payee mismatch";
    if (BigInt(r.amount) !== e.amount || BigInt(r.cumulative) !== e.cumulative) return "amount mismatch";
    if (r.requestHash.toLowerCase() !== e.requestHash.toLowerCase()) return "request hash mismatch";
    const leaf = receiptLeaf({
      callId: r.callId,
      mandateId: r.mandateId,
      payee: r.payee,
      amount: BigInt(r.amount),
      cumulative: BigInt(r.cumulative),
      requestHash: r.requestHash,
      timestamp: BigInt(r.timestamp),
    });
    if (leaf.toLowerCase() !== r.leaf.toLowerCase()) return "leaf mismatch";
    const signer = await recoverMessageAddress({ message: { raw: r.leaf }, signature: r.nodeSignature }).catch(() => null);
    if (!signer || !isAddressEqual(signer, r.node)) return "bad node signature";
    if (this.#o.trustedNode && !isAddressEqual(r.node, this.#o.trustedNode)) return "untrusted node";
    return null;
  }

  /** Approves the hub to pull up to `amount` from the agent wallet (net settlement uses transferFrom). */
  async ensureAllowance(
    walletClient: WalletClient<Transport, Chain | undefined, Account>,
    amount: bigint,
    opts: { token?: Address; publicClient?: PublicClient } = {},
  ): Promise<Hex | null> {
    if (!isAddressEqual(walletClient.account.address, this.address)) throw new Error("walletClient account is not the agent account");
    const token = opts.token ?? (await this.#node().get("/v1/info", infoSchema)).token.address;
    const reader = opts.publicClient ?? walletClient.extend(publicActions);
    const current = await reader.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.address, this.hub] });
    if (current >= amount) return null;
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.hub, amount],
      chain: walletClient.chain ?? null,
      account: walletClient.account,
    });
    const rcpt = await reader.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`approve reverted in ${hash}`);
    return hash;
  }

  /** Revokes this mandate at the node (agent-signed), stopping new vouchers immediately. */
  async revoke(): Promise<unknown> {
    const signature = await this.account.signMessage({ message: revokeMessage(this.mandateId) });
    return this.#node().post(`/v1/mandates/${this.mandateId}/revoke`, z.unknown(), { signature });
  }

  // ------------------------------------------------------------------ HSP co-sign

  /**
   * Decides whether to co-sign an HSP mandate. Refuses anything not addressed to this agent, not bound to the
   * stated batch, signed under an unexpected domain, or whose amount exceeds what this agent's own verified
   * receipts in that batch add up to (defence against a malicious node).
   */
  checkCosign(item: CosignItem): { ok: true; justified: bigint } | { ok: false; reason: string } {
    const td = item.typedData;
    const body = hspMandateFromWire(td.message);
    if (td.domain.chainId !== this.chainId || body.chainId !== BigInt(this.chainId)) return { ok: false, reason: "wrong chain" };
    const allowedVc = [this.hub, ...(this.#o.hspVerifyingContracts ?? [])];
    if (!allowedVc.some((a) => isAddressEqual(a, td.domain.verifyingContract))) return { ok: false, reason: "unexpected verifying contract" };
    if (body.signer.profileId.toLowerCase() !== EIP712_EOA_PROFILE.toLowerCase()) return { ok: false, reason: "unexpected signer profile" };
    const payer = getAddress(`0x${body.signer.payload.slice(-40)}`);
    if (!isAddressEqual(payer, this.address) || !isAddressEqual(item.payer, this.address)) return { ok: false, reason: "not addressed to this agent" };
    if (body.settlementBinding.toLowerCase() !== item.batchId.toLowerCase()) return { ok: false, reason: "settlementBinding is not the batch id" };
    if (body.amount !== BigInt(item.amount)) return { ok: false, reason: "amount differs from the typed data" };
    if (hspPaymentId(this.chainId, td.domain.verifyingContract, body).toLowerCase() !== item.hspPaymentId.toLowerCase()) {
      return { ok: false, reason: "hspPaymentId does not match the mandate" };
    }
    const batch = item.batchId.toLowerCase();
    let justified = 0n;
    for (const c of item.calls) {
      const mine = this.receipts.get(c.callId);
      if (!mine || mine.mandateId.toLowerCase() !== this.mandateId) continue;
      const usedFor = this.#callBatch.get(c.callId.toLowerCase());
      if (usedFor !== undefined && usedFor !== batch) continue;
      justified += BigInt(mine.amount);
    }
    const already = this.#cosignedByBatch.get(batch) ?? 0n;
    if (already + body.amount > justified) {
      return { ok: false, reason: `co-signing ${body.amount} would exceed this agent's receipts in the batch (${justified}, already co-signed ${already})` };
    }
    return { ok: true, justified };
  }

  /** One co-sign pass: fetches pending HSP mandates for this agent, checks and signs them. */
  async cosignOnce(): Promise<{ signed: Hex[]; refused: Array<{ hspPaymentId: Hex; reason: string }> }> {
    const run = async () => {
      const items = await this.#node().get(`/v1/agents/${this.address}/cosign`, z.array(z.unknown()));
      const signed: Hex[] = [];
      const refused: Array<{ hspPaymentId: Hex; reason: string }> = [];
      for (const raw of items) {
        const parsed = cosignItemSchema.safeParse(raw);
        if (!parsed.success) continue;
        const item = parsed.data;
        // Only the mandate this client holds receipts for: other clients of the same wallet handle theirs.
        if (!item.calls.some((c) => c.mandateId === this.mandateId)) continue;
        if (this.#handledCosigns.has(item.hspPaymentId)) continue;
        const verdict = this.checkCosign(item);
        this.#handledCosigns.add(item.hspPaymentId);
        if (!verdict.ok) {
          refused.push({ hspPaymentId: item.hspPaymentId, reason: verdict.reason });
          this.emit("cosignRefused", { hspPaymentId: item.hspPaymentId, batchId: item.batchId, reason: verdict.reason });
          continue;
        }
        const body = hspMandateFromWire(item.typedData.message);
        const signerProof = await this.account.signTypedData(hspTypedData(this.chainId, item.typedData.domain.verifyingContract, body));
        try {
          await this.#node().post(`/v1/cosign/${item.hspPaymentId}`, z.unknown(), { signerProof });
          const batch = item.batchId.toLowerCase();
          for (const c of item.calls) if (this.receipts.get(c.callId)) this.#callBatch.set(c.callId.toLowerCase(), batch);
          this.#cosignedByBatch.set(batch, (this.#cosignedByBatch.get(batch) ?? 0n) + body.amount);
          signed.push(item.hspPaymentId);
          this.emit("cosigned", { hspPaymentId: item.hspPaymentId, batchId: item.batchId, amount: body.amount, recipient: item.recipient });
        } catch (err) {
          if (!(err instanceof NodeApiError && err.code === "COSIGN_CLOSED")) this.#handledCosigns.delete(item.hspPaymentId);
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
      return { signed, refused };
    };
    // Never run two passes at once.
    const prev = this.#cosignBusy ?? Promise.resolve();
    const next = prev.then(run, run);
    this.#cosignBusy = next.catch(() => undefined);
    return next;
  }

  startCosignLoop(intervalMs = this.#o.cosignIntervalMs ?? 1_000): void {
    if (this.#cosignTimer) return;
    this.#cosignTimer = setInterval(() => {
      this.cosignOnce().catch((err: unknown) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
    }, intervalMs);
    (this.#cosignTimer as { unref?: () => void }).unref?.();
  }

  stopCosignLoop(): void {
    if (this.#cosignTimer) clearInterval(this.#cosignTimer);
    this.#cosignTimer = null;
  }
}
