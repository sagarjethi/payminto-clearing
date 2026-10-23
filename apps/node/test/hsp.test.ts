import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildNetTransferMandate,
  CAPABILITIES,
  clearingHubAbi,
  hspPaymentId,
  hspTypedData,
  requiredCapabilitiesHash,
} from "@payminto/protocol";
import { CoordinatorHspAdapter } from "../src/hsp/coordinator.ts";
import { LOCAL_REQUIRED_CAPABILITIES, decodeAddressPayload, hspReceiptTypes, observeSettlement, verifyLocalReceipt, type LocalHspReceipt } from "../src/hsp/local.ts";
import { ANVIL_KEYS } from "./helpers.ts";

const PAYER = privateKeyToAccount(ANVIL_KEYS[2]);
const ADAPTER = privateKeyToAccount(ANVIL_KEYS[9]);
const IMPOSTOR = privateKeyToAccount(ANVIL_KEYS[8]);
const RECIPIENT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const HUB = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const TOKEN = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const BATCH = keccak256(toBytes("batch-7"));
const TX = keccak256(toBytes("tx-7"));

const body = (required: readonly string[] = LOCAL_REQUIRED_CAPABILITIES) =>
  buildNetTransferMandate({ payer: PAYER.address, recipient: RECIPIENT, token: TOKEN, amount: 350_000n, chainId: 31337, batchId: BATCH, deadline: 1_900_000_000n, requiredCapabilities: required });

describe("coordinator HSP adapter", () => {
  function fakeCoordinator(script: { register?: number; observe202?: number; statuses?: string[] }) {
    const seen: Array<{ method: string; path: string; auth: string | undefined; body: unknown }> = [];
    let observeCalls = 0;
    let getCalls = 0;
    const app = new Hono();
    app.use("*", async (c, next) => {
      const text = c.req.method === "POST" ? await c.req.raw.clone().text() : "";
      seen.push({ method: c.req.method, path: c.req.path, auth: c.req.header("authorization"), body: text ? JSON.parse(text) : null });
      await next();
    });
    app.post("/payments", (c) => (script.register && script.register >= 300 ? c.json({ error: "x" }, script.register as 500) : c.json({ paymentId: "pay_1", status: "PROPOSED" }, 201)));
    app.post("/payments/:id/observe", (c) => (++observeCalls <= (script.observe202 ?? 0) ? c.json({ status: "pending" }, 202) : c.json({ ok: true })));
    app.get("/payments/:id", (c) => {
      const s = script.statuses ?? ["SETTLED"];
      return c.json({ status: s[Math.min(getCalls++, s.length - 1)] });
    });
    const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
    return {
      seen,
      adapter: new CoordinatorHspAdapter({
        url: "https://coordinator.example",
        apiKey: "hsp-test-key",
        chainName: "hashkey-testnet",
        verifyingContract: HUB,
        fetch: fetchFn,
        backoffMs: [1, 1, 1],
        sleep: async () => {},
      }),
    };
  }

  it("registers, observes through 202s, and polls until SETTLED", async () => {
    const { adapter, seen } = fakeCoordinator({ observe202: 2, statuses: ["ATTEMPTED", "SETTLED"] });
    const b = body([]);
    const out = await adapter.settle({ paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x1234", txHash: TX, batchId: BATCH });
    expect(out).toMatchObject({ status: "SETTLED", coordinatorId: "pay_1", coordinatorStatus: "SETTLED" });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /payments",
      "POST /payments/pay_1/observe",
      "POST /payments/pay_1/observe",
      "POST /payments/pay_1/observe",
      "GET /payments/pay_1",
      "GET /payments/pay_1",
    ]);
    expect(seen.every((s) => s.auth === "Bearer hsp-test-key")).toBe(true);
    expect(seen[0]!.body).toEqual({
      chain: "hashkey-testnet",
      mandate: {
        body: { ...b, amount: "350000", chainId: "31337", deadline: "1900000000" },
        signerProof: "0x1234",
        requiredCapabilities: [],
      },
      attestations: [],
    });
    expect(seen[1]!.body).toEqual({ txHash: TX });
  });

  it("resumes an earlier registration instead of registering twice", async () => {
    const { adapter, seen } = fakeCoordinator({});
    const b = body([]);
    const out = await adapter.settle({ paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x12", txHash: TX, batchId: BATCH, coordinatorId: "pay_1" });
    expect(out.status).toBe("SETTLED");
    expect(seen.some((s) => s.path === "/payments")).toBe(false);
  });

  it("reports retryable failures and terminal statuses, and never submits without a co-signature", async () => {
    const b = body([]);
    const input = { paymentId: hspPaymentId(31337, HUB, b), body: b, signerProof: "0x12" as Hex, txHash: TX, batchId: BATCH };
    expect(await fakeCoordinator({ register: 503 }).adapter.settle(input)).toMatchObject({ status: "FAILED", retry: true });
    expect(await fakeCoordinator({ register: 400 }).adapter.settle(input)).toMatchObject({ status: "FAILED", retry: false });
    expect(await fakeCoordinator({ statuses: ["DISPUTED"] }).adapter.settle(input)).toMatchObject({ status: "FAILED", coordinatorStatus: "DISPUTED" });
    expect(await fakeCoordinator({ observe202: 99 }).adapter.settle(input)).toMatchObject({ status: "SUBMITTED", retry: true });
    expect(await fakeCoordinator({ statuses: ["ATTEMPTED"] }).adapter.settle(input)).toMatchObject({ status: "SUBMITTED", retry: true });
    const { adapter, seen } = fakeCoordinator({});
    expect(await adapter.settle({ ...input, signerProof: null })).toEqual({ status: "UNSIGNED" });
    expect(seen).toHaveLength(0);
  });
});

describe("local HSP adapter and verifier", () => {
  function log(address: Address, topics: Hex[], data: Hex, logIndex: number): Log {
    return { address, topics: topics as [Hex, ...Hex[]], data, logIndex, blockHash: TX, blockNumber: 1n, transactionHash: TX, transactionIndex: 0, removed: false };
  }
  function receipt(opts: { amount?: bigint; status?: "success" | "reverted"; withTransfer?: boolean } = {}): TransactionReceipt {
    const amount = opts.amount ?? 350_000n;
    const logs: Log[] = [
      log(TOKEN, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER.address, to: RECIPIENT } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [amount]), 3),
      log(HUB, encodeEventTopics({ abi: clearingHubAbi, eventName: "NetTransfer", args: { batchId: BATCH, from: PAYER.address, to: RECIPIENT } }) as Hex[], encodeAbiParameters([{ type: "uint256" }], [amount]), 4),
    ];
    return { status: opts.status ?? "success", logs: opts.withTransfer === false ? logs.slice(1) : logs } as unknown as TransactionReceipt;
  }
  const onchainBatch = { token: TOKEN, settledAt: 1_800_000_000n };

  it("observes a matching NetTransfer plus token Transfer in a successful tx", () => {
    expect(observeSettlement(receipt(), body(), HUB, onchainBatch)).toMatchObject({ settlementVerified: true, nettingBatch: true, logIndex: 4 });
    expect(observeSettlement(receipt({ amount: 1n }), body(), HUB, onchainBatch).settlementVerified).toBe(false);
    expect(observeSettlement(receipt({ withTransfer: false }), body(), HUB, onchainBatch).settlementVerified).toBe(false);
    expect(observeSettlement(receipt({ status: "reverted" }), body(), HUB, onchainBatch).settlementVerified).toBe(false);
    expect(observeSettlement(receipt(), body(), HUB, { token: TOKEN, settledAt: 0n }).nettingBatch).toBe(false);
    expect(decodeAddressPayload(body().signer.payload).toLowerCase()).toBe(PAYER.address.toLowerCase());
  });

  async function signedReceipt(signer: typeof ADAPTER, satisfied: string[], b = body()): Promise<LocalHspReceipt> {
    const paymentId = hspPaymentId(31337, HUB, b);
    const signature = await signer.signTypedData({
      domain: { name: "HSP", version: "1", chainId: 31337, verifyingContract: HUB },
      types: hspReceiptTypes,
      primaryType: "Receipt",
      message: { paymentId, txHash: TX, logIndex: 4n, satisfiedCapabilitiesHash: requiredCapabilitiesHash(satisfied) },
    });
    return { paymentId, txHash: TX, logIndex: 4, satisfiedCapabilities: satisfied, adapter: signer.address, signature };
  }

  it("ACCEPTs only a pinned-adapter receipt that satisfies every required capability", async () => {
    const all = [CAPABILITIES.settlementVerified, CAPABILITIES.mandateBound, CAPABILITIES.nettingBatch];
    const args = { chainId: 31337, verifyingContract: HUB, body: body(), required: LOCAL_REQUIRED_CAPABILITIES, pinnedAdapter: ADAPTER.address };
    expect(await verifyLocalReceipt({ ...args, receipt: await signedReceipt(ADAPTER, all) })).toBe("ACCEPT");
    expect(await verifyLocalReceipt({ ...args, receipt: await signedReceipt(ADAPTER, all.slice(0, 2)) })).toBe("REJECT");
    expect(await verifyLocalReceipt({ ...args, receipt: await signedReceipt(IMPOSTOR, all) })).toBe("REJECT");
    // Tampering with the satisfied set after signing breaks the signature.
    const tampered = await signedReceipt(ADAPTER, all.slice(0, 2));
    expect(await verifyLocalReceipt({ ...args, receipt: { ...tampered, satisfiedCapabilities: all } })).toBe("REJECT");
    // A receipt for another mandate is rejected.
    const other = await signedReceipt(ADAPTER, all, { ...body(), amount: 1n });
    expect(await verifyLocalReceipt({ ...args, receipt: other })).toBe("REJECT");
    // The mandate must commit to the same required set the verifier applies.
    expect(await verifyLocalReceipt({ ...args, body: body([]), receipt: await signedReceipt(ADAPTER, all, body([])) })).toBe("REJECT");
  });

  it("the debtor co-signature is a valid HSP signature over the batch-bound mandate", async () => {
    const b = body();
    const sig = await PAYER.signTypedData(hspTypedData(31337, HUB, b));
    const { isHspMandateSignedBy } = await import("@payminto/protocol");
    expect(await isHspMandateSignedBy(31337, HUB, b, sig, PAYER.address)).toBe(true);
    expect(b.settlementBinding).toBe(BATCH);
  });
});
