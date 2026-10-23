import { randomBytes } from "node:crypto";
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import {
  isVoucherSignedBy,
  receiptLeaf,
  voucherTypedData,
  type ClearingReceipt,
  type DenialRule,
  type Policy,
} from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./events.ts";
import type { FundsTracker } from "./funds.ts";
import { accounts, type Ledger } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import { evaluateVoucher, type Decision } from "./policy-engine.ts";
import { callJson, denialJson, nowIso, type CallRow, type DenialRow, type MandateRow, type ProviderRow, type Store } from "./store.ts";

export type VoucherInput = {
  mandateId: Hex;
  payee: Address;
  amount: bigint;
  cumulative: bigint;
  signature: Hex;
  requestHash: Hex;
};

export type PositionJson = { mandateId: Hex; payee: Address; cumulative: string; settled: string };

export type AcceptResult =
  | { ok: true; receipt: ClearingReceipt; position: PositionJson }
  | { ok: false; rule: DenialRule; message: string; details: Record<string, unknown>; position: PositionJson };

/** Deterministic call id: unique per (mandate, payee, cumulative) because cumulative strictly increases. */
export function callIdOf(v: { mandateId: Hex; payee: Address; cumulative: bigint; requestHash: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [v.mandateId, v.payee, v.cumulative, v.requestHash],
    ),
  );
}

/** Funds snapshots older than this are re-read from chain before an INSUFFICIENT_FUNDS denial is final. */
const FUNDS_STALE_MS = 2_000;

export class VoucherService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #ledger: Ledger;
  readonly #events: EventBus;
  readonly #funds: FundsTracker;
  readonly #log: Logger;
  readonly #clock: () => number;
  readonly #contractAgents = new Map<string, boolean>();

  constructor(deps: {
    db: Database;
    store: Store;
    chain: ChainClient;
    ledger: Ledger;
    events: EventBus;
    funds: FundsTracker;
    log: Logger;
    clock?: () => number;
  }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#ledger = deps.ledger;
    this.#events = deps.events;
    this.#funds = deps.funds;
    this.#log = deps.log;
    this.#clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  positionJson(mandateId: Hex, payee: Address): PositionJson {
    const p = this.#store.position(mandateId, payee);
    return { mandateId, payee, cumulative: p.cumulative.toString(), settled: p.settled.toString() };
  }

  async #signatureValid(m: MandateRow, v: VoucherInput): Promise<boolean> {
    const voucher = { mandateId: m.id, payee: v.payee, cumulative: v.cumulative };
    if (await isVoucherSignedBy(this.#chain.chainId, this.#chain.hub, voucher, v.signature, m.agent)) return true;
    // Smart-wallet agents: the hub accepts ERC-1271 signatures, so the node must too.
    const key = m.agent.toLowerCase();
    let isContract = this.#contractAgents.get(key);
    if (isContract === undefined) {
      isContract = await this.#chain.isContract(m.agent).catch(() => false);
      this.#contractAgents.set(key, isContract);
    }
    if (!isContract) return false;
    return this.#chain.public
      .verifyTypedData({ address: m.agent, ...voucherTypedData(this.#chain.chainId, this.#chain.hub, voucher), signature: v.signature })
      .catch(() => false);
  }

  async accept(provider: ProviderRow, v: VoucherInput): Promise<AcceptResult> {
    const mandateId = v.mandateId.toLowerCase() as Hex;
    const payee = getAddress(v.payee);
    const now = this.#clock();
    const m0 = this.#store.mandate(mandateId);
    const signatureValid = m0 ? await this.#signatureValid(m0, { ...v, payee }) : false;
    if (m0) await this.#funds.ensure(m0.agent).catch((err) => this.#log.warn("funds read failed", { agent: m0.agent, err }));

    const receiptBase = { callId: callIdOf({ mandateId, payee, cumulative: v.cumulative, requestHash: v.requestHash }), mandateId, payee };
    const leaf = receiptLeaf({ ...receiptBase, amount: v.amount, cumulative: v.cumulative, requestHash: v.requestHash, timestamp: BigInt(now) });
    const nodeSignature = await this.#chain.operator.signMessage({ message: { raw: leaf } });

    const input = { ...v, mandateId, payee };
    let result = this.#decide(provider, input, now, signatureValid, leaf, nodeSignature, false);
    if ("retryable" in result && m0) {
      await this.#funds.refresh(m0.agent).catch((err) => this.#log.warn("funds refresh failed", { agent: m0.agent, err }));
      result = this.#decide(provider, input, now, signatureValid, leaf, nodeSignature, true);
    }
    if ("retryable" in result) throw new Error("funds decision deferred twice");
    return result;
  }

  /** The atomic part: load state, evaluate every rule in order, and record the call or the denial in one BEGIN IMMEDIATE. */
  #decide(
    provider: ProviderRow,
    v: VoucherInput,
    now: number,
    signatureValid: boolean,
    leaf: Hex,
    nodeSignature: Hex,
    isRetry: boolean,
  ): AcceptResult | { ok: false; rule: DenialRule; message: string; details: Record<string, unknown>; position: PositionJson; retryable: true } {
    const db = this.#db;
    const token = this.#chain.token;
    // A first INSUFFICIENT_FUNDS verdict on a stale snapshot is not recorded; the caller refreshes and decides again.
    let deferred: Decision | null = null;
    const out = db.tx((): AcceptResult | null => {
      const m = this.#store.mandate(v.mandateId);
      const position = m ? this.#store.position(m.id, v.payee) : { cumulative: 0n, settled: 0n };
      const decision = evaluateVoucher({
        now,
        nodeToken: token,
        provider: { payee: provider.payee, priceAtomic: BigInt(provider.price_atomic) },
        voucher: v,
        signatureValid,
        mandate: m
          ? {
              status: m.status,
              token: m.token,
              totalCap: BigInt(m.total_cap),
              validAfter: m.valid_after,
              validUntil: m.valid_until,
              payees: JSON.parse(m.payees) as Address[],
              policy: JSON.parse(m.policy) as Policy,
            }
          : null,
        position: position.cumulative,
        callsLastMinute: m
          ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE mandate_id = ? AND timestamp > ?", m.id, now - 60)!.n
          : 0,
        spentLast24h: m
          ? BigInt(db.get<{ s: string }>("SELECT bigsum(amount) AS s FROM calls WHERE mandate_id = ? AND timestamp > ?", m.id, now - 86_400)!.s)
          : 0n,
        spentTotal: m
          ? BigInt(db.get<{ s: string }>("SELECT bigsum(cumulative) AS s FROM positions WHERE mandate_id = ?", m.id)!.s)
          : 0n,
        agentOutstanding: m ? this.#store.agentOutstanding(m.agent, token) : 0n,
        funds: m ? this.#store.funds(m.agent, token) : null,
      });

      const positionAfter = (cumulative: bigint): PositionJson => ({
        mandateId: v.mandateId,
        payee: v.payee,
        cumulative: cumulative.toString(),
        settled: position.settled.toString(),
      });

      if (!decision.ok) {
        if (decision.rule === "INSUFFICIENT_FUNDS" && !isRetry) {
          const snap = m ? this.#store.funds(m.agent, token) : null;
          if (!snap || Date.now() - snap.refreshedAt > FUNDS_STALE_MS) {
            deferred = decision;
            return null;
          }
        }
        const details: Record<string, unknown> = { ...decision.details, position: positionAfter(position.cumulative) };
        const row: DenialRow = {
          seq: 0,
          id: `dny_${randomBytes(8).toString("hex")}`,
          rule: decision.rule,
          message: decision.message,
          mandate_id: v.mandateId,
          agent: m?.agent ?? null,
          payee: v.payee,
          provider_id: provider.id,
          amount: v.amount.toString(),
          cumulative: v.cumulative.toString(),
          request_hash: v.requestHash,
          details: JSON.stringify(details),
          timestamp: now,
          at: nowIso(),
        };
        const { lastInsertRowid } = db.run(
          `INSERT INTO denials (id, rule, message, mandate_id, agent, payee, provider_id, amount, cumulative, request_hash, details, timestamp, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.rule,
          row.message,
          row.mandate_id,
          row.agent,
          row.payee,
          row.provider_id,
          row.amount,
          row.cumulative,
          row.request_hash,
          row.details,
          row.timestamp,
          row.at,
        );
        this.#events.emit("call.denied", { denial: denialJson({ ...row, seq: lastInsertRowid }) });
        return { ok: false, rule: decision.rule, message: decision.message, details, position: positionAfter(position.cumulative) };
      }

      const mandate = m!;
      const callId = callIdOf(v);
      const acceptedAt = nowIso();
      const { lastInsertRowid: seq } = db.run(
        `INSERT INTO calls (call_id, mandate_id, agent, payee, provider_id, amount, cumulative, request_hash, agent_signature,
                            timestamp, leaf, node_signature, status, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        callId,
        mandate.id,
        mandate.agent,
        v.payee,
        provider.id,
        v.amount.toString(),
        v.cumulative.toString(),
        v.requestHash,
        v.signature,
        now,
        leaf,
        nodeSignature,
        acceptedAt,
      );
      db.run(
        `INSERT INTO positions (mandate_id, payee, cumulative, settled) VALUES (?, ?, ?, '0')
         ON CONFLICT (mandate_id, payee) DO UPDATE SET cumulative = excluded.cumulative`,
        mandate.id,
        v.payee,
        v.cumulative.toString(),
      );
      this.#ledger.post("call.accepted", callId, `call ${provider.name}`, [
        { account: accounts.providerReceivable(v.payee), debit: v.amount },
        { account: accounts.agentPayable(mandate.agent), credit: v.amount },
      ]);
      const row = db.get<CallRow>("SELECT * FROM calls WHERE seq = ?", seq)!;
      this.#events.emit("call.accepted", { call: callJson(row) });
      const receipt: ClearingReceipt = {
        callId,
        mandateId: mandate.id,
        payee: v.payee,
        amount: v.amount.toString(),
        cumulative: v.cumulative.toString(),
        requestHash: v.requestHash,
        timestamp: now,
        leaf,
        nodeSignature,
        node: this.#chain.operator.address,
      };
      return { ok: true, receipt, position: positionAfter(v.cumulative) };
    });
    if (out) return out;
    const d = deferred as Decision | null;
    if (!d || d.ok) throw new Error("unreachable");
    return { ok: false, rule: d.rule, message: d.message, details: d.details, position: this.positionJson(v.mandateId, v.payee), retryable: true };
  }
}
