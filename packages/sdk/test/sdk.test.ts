import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildNetTransferMandate,
  encodeHeader,
  hspMandateToWire,
  hspPaymentId,
  hspTypes,
  isHspMandateSignedBy,
  isVoucherSignedBy,
  receiptLeaf,
  type ClearingReceipt,
} from "@payminto/protocol";
import { AgentClient, computeRequestHash, KeyedMutex, paywall, type DeniedEvent } from "../src/index.ts";

// Anvil dev keys (public, local only).
const AGENT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const NODE = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
const EVIL = privateKeyToAccount("0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97");
const HUB = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const PAYEE = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const PAYEE_2 = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const MANDATE = keccak256(toBytes("mandate-1"));
const NODE_URL = "http://node.test";

type Script = {
  /** Positions served by GET /position, lagging the truth by this many calls (simulates another process). */
  lagPosition?: number;
  alwaysStale?: boolean;
  receiptSigner?: typeof NODE;
  cosignItems?: unknown[];
};

/** In-memory clearing node + two providers behind the real SDK paywall. Everything goes through one fetch. */
function world(script: Script = {}) {
  const truth = new Map<string, bigint>();
  const accepted: Array<{ payee: Address; cumulative: bigint }> = [];
  const inflight = new Map<string, number>();
  let maxInflightSamePayee = 0;
  let maxInflightAll = 0;
  let totalInflight = 0;
  const cosigned: Array<{ id: string; signerProof: Hex }> = [];
  const voucherPosts: unknown[] = [];

  const node = new Hono();
  node.get("/v1/info", (c) =>
    c.json({ version: "t", network: { chainId: 31337, caip2: "eip155:31337" }, hub: HUB, token: { address: TOKEN, symbol: "USDC", decimals: 6 }, operator: NODE.address, publicUrl: NODE_URL }),
  );
  node.get("/v1/providers", (c) =>
    c.json([
      { id: "prv_a", name: "A", description: "quotes", payee: PAYEE, priceAtomic: "2000", resource: "/q", category: "data", calls24h: 0 },
      { id: "prv_b", name: "B", description: "briefs", payee: PAYEE_2, priceAtomic: "5000", resource: "/b", category: "data", calls24h: 0 },
    ]),
  );
  node.get("/v1/mandates/:id/position", (c) => {
    const payee = getAddress(c.req.query("payee")!);
    const t = truth.get(payee) ?? 0n;
    const price = payee === PAYEE ? 2000n : 5000n;
    const lag = BigInt(script.lagPosition ?? 0) * price;
    return c.json({ mandateId: MANDATE, payee, cumulative: (t > lag ? t - lag : 0n).toString(), settled: "0" });
  });
  node.post("/v1/vouchers", async (c) => {
    const b = (await c.req.json()) as { payload: { payee: Address; amount: string; cumulative: string; signature: Hex; requestHash: Hex; mandateId: Hex } };
    voucherPosts.push(b);
    const p = b.payload;
    const payee = getAddress(p.payee);
    totalInflight++;
    inflight.set(payee, (inflight.get(payee) ?? 0) + 1);
    maxInflightSamePayee = Math.max(maxInflightSamePayee, inflight.get(payee)!);
    maxInflightAll = Math.max(maxInflightAll, totalInflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight.set(payee, inflight.get(payee)! - 1);
    totalInflight--;
    const pos = truth.get(payee) ?? 0n;
    const position = { mandateId: MANDATE, payee, cumulative: pos.toString(), settled: "0" };
    if (script.alwaysStale || BigInt(p.cumulative) !== pos + BigInt(p.amount)) {
      return c.json({ error: { code: "STALE_CUMULATIVE", message: "stale", details: { position } } }, 402);
    }
    if (!(await isVoucherSignedBy(31337, HUB, { mandateId: MANDATE, payee, cumulative: BigInt(p.cumulative) }, p.signature, AGENT.address))) {
      return c.json({ error: { code: "BAD_SIGNATURE", message: "bad" } }, 402);
    }
    truth.set(payee, BigInt(p.cumulative));
    accepted.push({ payee, cumulative: BigInt(p.cumulative) });
    const base = {
      callId: keccak256(toBytes(`${payee}:${p.cumulative}`)),
      mandateId: MANDATE,
      payee,
      amount: BigInt(p.amount),
      cumulative: BigInt(p.cumulative),
      requestHash: p.requestHash,
      timestamp: 1_800_000_000n,
    };
    const leaf = receiptLeaf(base);
    const signer = script.receiptSigner ?? NODE;
    const receipt: ClearingReceipt = {
      ...base,
      amount: p.amount,
      cumulative: p.cumulative,
      timestamp: 1_800_000_000,
      leaf,
      nodeSignature: await signer.signMessage({ message: { raw: leaf } }),
      node: NODE.address,
    };
    return c.json({ receipt, position: { ...position, cumulative: p.cumulative } });
  });
  node.get("/v1/agents/:address/cosign", (c) => c.json(script.cosignItems ?? []));
  node.post("/v1/cosign/:id", async (c) => {
    cosigned.push({ id: c.req.param("id"), ...((await c.req.json()) as { signerProof: Hex }) });
    return c.json({ ok: true });
  });

  const provider = new Hono();
  const fetchAll = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "node.test") return node.request(url.pathname + url.search, init);
    return provider.request(input instanceof Request ? input : url.toString(), init);
  }) as typeof fetch;
  const payA = paywall({ nodeUrl: NODE_URL, providerId: "prv_a", apiKey: "pmk_a", fetch: fetchAll });
  const payB = paywall({ nodeUrl: NODE_URL, providerId: "prv_b", apiKey: "pmk_b", fetch: fetchAll });
  provider.get("/q", payA.hono(), (c) => c.json({ ok: true, paidCumulative: c.get("payminto").receipt.cumulative }));
  provider.post("/b", payB.hono(), async (c) => c.json({ echo: await c.req.json() }));
  provider.get("/exact", (c) =>
    c.json({ x402Version: 2, accepts: [{ scheme: "exact" }] }, 402, { "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts: [{ scheme: "exact" }] }) }),
  );

  const sleeps: number[] = [];
  const agent = (over: Partial<ConstructorParameters<typeof AgentClient>[0]> = {}) =>
    new AgentClient({
      chainId: 31337,
      hub: HUB,
      account: AGENT,
      mandateId: MANDATE,
      fetch: fetchAll,
      trustedNode: NODE.address,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      ...over,
    });
  return {
    agent,
    fetchAll,
    truth,
    accepted,
    cosigned,
    sleeps,
    voucherPosts,
    stats: () => ({ maxInflightSamePayee, maxInflightAll }),
  };
}

describe("AgentClient.fetch", () => {
  it("answers a 402 with a voucher, learns the node from the requirement and verifies the receipt", async () => {
    const w = world();
    const a = w.agent();
    const receipts: ClearingReceipt[] = [];
    a.on("receipt", (r) => receipts.push(r.receipt));
    const res = await a.fetch("http://provider.test/q?pair=HSK-USDC");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paidCumulative: "2000" });
    expect(res.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(receipts).toHaveLength(1);
    expect(a.receipts.all()).toHaveLength(1);
    // Second call uses the cached position: no extra position lookup is needed and cumulative extends by the price.
    await a.fetch("http://provider.test/q?pair=BTC-USDC");
    expect(w.accepted.map((x) => x.cumulative)).toEqual([2000n, 4000n]);
  });

  it("re-signs on STALE_CUMULATIVE using the position in the denial, with jittered backoff", async () => {
    const w = world({ lagPosition: 2 });
    // Another process already spent 3 calls on this payee.
    w.truth.set(PAYEE, 6000n);
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(200);
    expect(w.accepted).toEqual([{ payee: PAYEE, cumulative: 8000n }]);
    expect(w.sleeps).toEqual([50]);
    expect(denied).toEqual([]);
  });

  it("gives up after 3 retries, emits denied and returns the 402", async () => {
    const w = world({ alwaysStale: true });
    const a = w.agent();
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("STALE_CUMULATIVE");
    expect(w.voucherPosts).toHaveLength(4);
    expect(w.sleeps).toEqual([50, 100, 200]);
    expect(denied.map((d) => d.code)).toEqual(["STALE_CUMULATIVE"]);
  });

  it("serializes vouchers per (mandate, payee) but runs different payees in parallel", async () => {
    const w = world();
    const a = w.agent();
    const jobs = [
      ...Array.from({ length: 12 }, (_, i) => a.fetch(`http://provider.test/q?i=${i}`)),
      ...Array.from({ length: 6 }, (_, i) => a.fetch("http://provider.test/b", { method: "POST", body: JSON.stringify({ i }), headers: { "content-type": "application/json" } })),
    ];
    const res = await Promise.all(jobs);
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(w.stats().maxInflightSamePayee).toBe(1);
    expect(w.stats().maxInflightAll).toBe(2);
    expect(w.truth.get(PAYEE)).toBe(24_000n);
    expect(w.truth.get(PAYEE_2)).toBe(30_000n);
    expect(w.sleeps).toEqual([]); // no self-races, so no STALE retries
  });

  it("does not store a receipt whose node signature does not verify", async () => {
    const w = world({ receiptSigner: EVIL });
    const a = w.agent();
    const errors: Error[] = [];
    a.on("error", (e) => errors.push(e));
    const res = await a.fetch("http://provider.test/q");
    expect(res.status).toBe(200);
    expect(errors.map((e) => e.message)).toEqual(["receipt rejected: bad node signature"]);
    expect(a.receipts.all()).toHaveLength(0);
  });

  it("leaves non-voucher 402s alone and refuses prices above maxPrice without signing", async () => {
    const w = world();
    const a = w.agent({ maxPrice: 1000n });
    expect((await a.fetch("http://provider.test/exact")).status).toBe(402);
    const denied: DeniedEvent[] = [];
    a.on("denied", (d) => denied.push(d));
    expect((await a.fetch("http://provider.test/q")).status).toBe(402);
    expect(denied.map((d) => d.code)).toEqual(["CLIENT_MAX_PRICE"]);
    expect(w.voucherPosts).toHaveLength(0);
  });
});

describe("paywall", () => {
  it("returns an x402 v2 requirement without a payment and checks the request hash before asking the node", async () => {
    const w = world();
    const res = await w.fetchAll("http://provider.test/q?x=1");
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: Array<Record<string, unknown>>; error: { code: string } };
    expect(body.error.code).toBe("PAYMENT_REQUIRED");
    expect(body.accepts[0]).toMatchObject({
      scheme: "payminto-voucher",
      network: "eip155:31337",
      asset: TOKEN,
      payTo: PAYEE,
      amount: "2000",
      extra: { clearingNode: NODE_URL, clearingHub: HUB, providerId: "prv_a", tokenSymbol: "USDC", tokenDecimals: 6 },
    });
    // A voucher bound to a different request is refused locally.
    const sig = await AGENT.signTypedData({
      domain: { name: "Payminto Clearing", version: "1", chainId: 31337, verifyingContract: HUB },
      types: { Voucher: [{ name: "mandateId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "cumulative", type: "uint256" }] },
      primaryType: "Voucher",
      message: { mandateId: MANDATE, payee: PAYEE, cumulative: 2000n },
    });
    const payment = {
      x402Version: 2,
      scheme: "payminto-voucher",
      network: "eip155:31337",
      payload: { mandateId: MANDATE, payee: PAYEE, amount: "2000", cumulative: "2000", signature: sig, requestHash: computeRequestHash("GET", "/other") },
    };
    const r2 = await w.fetchAll("http://provider.test/q?x=1", { headers: { "PAYMENT-SIGNATURE": encodeHeader(payment) } });
    expect(r2.status).toBe(402);
    expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("REQUEST_HASH_MISMATCH");
    expect(w.voucherPosts).toHaveLength(0);
  });

  it("binds the request hash to method, path, query and body", () => {
    const h = computeRequestHash("GET", "http://a.test/q?x=1");
    expect(computeRequestHash("get", "https://other-host/q?x=1")).toBe(h);
    expect(computeRequestHash("GET", "http://a.test/q?x=2")).not.toBe(h);
    expect(computeRequestHash("POST", "http://a.test/q?x=1")).not.toBe(h);
    expect(computeRequestHash("GET", "http://a.test/q?x=1", new TextEncoder().encode("{}"))).not.toBe(h);
  });
});

describe("HSP co-sign (malicious node defence)", () => {
  const BATCH = keccak256(toBytes("batch-1"));

  function item(amount: bigint, calls: Array<{ callId: Hex; amount: string }>, over: { payer?: Address; batchId?: Hex; badId?: boolean } = {}) {
    const body = buildNetTransferMandate({
      payer: over.payer ?? AGENT.address,
      recipient: PAYEE,
      token: TOKEN,
      amount,
      chainId: 31337,
      batchId: BATCH,
      deadline: 1_900_000_000n,
    });
    const id = hspPaymentId(31337, HUB, body);
    return {
      hspPaymentId: over.badId ? keccak256(toBytes("forged")) : id,
      batchId: over.batchId ?? BATCH,
      payer: over.payer ?? AGENT.address,
      recipient: PAYEE,
      token: TOKEN,
      amount: amount.toString(),
      deadline: 1_900_000_000,
      calls: calls.map((c) => ({ ...c, mandateId: MANDATE, payee: PAYEE, cumulative: "0" })),
      typedData: { domain: { name: "HSP", version: "1", chainId: 31337, verifyingContract: HUB }, types: hspTypes, primaryType: "Mandate", message: hspMandateToWire(body) },
    };
  }

  async function agentWithReceipts(script: Script) {
    const w = world(script);
    const a = w.agent({ nodeUrl: NODE_URL });
    for (let i = 0; i < 3; i++) await a.fetch(`http://provider.test/q?i=${i}`); // 3 x 2000
    return { w, a, calls: a.receipts.all().map((r) => ({ callId: r.callId, amount: r.amount })) };
  }

  it("co-signs a mandate its receipts justify and refuses one that overstates the debit", async () => {
    const setup = await agentWithReceipts({});
    const honest = item(6000n, setup.calls);
    const greedy = item(6001n, setup.calls);
    const cosignItems: unknown[] = [greedy, honest];
    const w = world({ cosignItems });
    // Reuse the same agent receipts with a node that serves the co-sign items.
    const a = w.agent({ nodeUrl: NODE_URL, receipts: setup.a.receipts });
    const r = await a.cosignOnce();
    expect(r.refused.map((x) => x.hspPaymentId)).toEqual([greedy.hspPaymentId]);
    expect(r.refused[0]!.reason).toMatch(/exceed/);
    expect(r.signed).toEqual([honest.hspPaymentId]);
    expect(w.cosigned).toHaveLength(1);
    const { hspMandateFromWire } = await import("@payminto/protocol");
    expect(await isHspMandateSignedBy(31337, HUB, hspMandateFromWire(honest.typedData.message), w.cosigned[0]!.signerProof, AGENT.address)).toBe(true);
    // The same receipts cannot justify a second mandate for the batch: running total is enforced.
    expect(a.checkCosign(item(1n, setup.calls) as never)).toMatchObject({ ok: false });
  });

  it("refuses mandates not addressed to the agent, unknown receipts, forged ids and unbound batches", async () => {
    const { a, calls } = await agentWithReceipts({});
    expect(a.checkCosign(item(100n, calls, { payer: PAYEE_2 }) as never)).toMatchObject({ ok: false, reason: "not addressed to this agent" });
    expect(a.checkCosign(item(100n, [{ callId: keccak256(toBytes("not-mine")), amount: "999999" }]) as never)).toMatchObject({ ok: false });
    expect(a.checkCosign(item(100n, calls, { badId: true }) as never)).toMatchObject({ ok: false, reason: "hspPaymentId does not match the mandate" });
    expect(a.checkCosign(item(100n, calls, { batchId: keccak256(toBytes("other")) }) as never)).toMatchObject({ ok: false, reason: "settlementBinding is not the batch id" });
    const wrongVc = item(100n, calls);
    wrongVc.typedData.domain.verifyingContract = PAYEE_2;
    expect(a.checkCosign(wrongVc as never)).toMatchObject({ ok: false, reason: "unexpected verifying contract" });
    expect(a.checkCosign(item(6000n, calls) as never)).toMatchObject({ ok: true, justified: 6000n });
  });
});

describe("KeyedMutex", () => {
  it("orders same-key tasks and survives failures", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    const slow = m.run("k", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
      throw new Error("x");
    });
    const fast = m.run("k", async () => {
      order.push("b");
    });
    const other = m.run("other", async () => {
      order.push("c");
    });
    await expect(slow).rejects.toThrow("x");
    await fast;
    await other;
    expect(order).toEqual(["c", "a", "b"]);
  });
});
