import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import {
  buildNetTransferMandate,
  clearingHubAbi,
  hspMandateFromWire,
  hspMandateToWire,
  hspPaymentId,
  hspTypes,
  isHspMandateSignedBy,
  payeeProof,
  receiptsTree,
  type CallReceipt,
  type HspWireMandate,
} from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import { ApiError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { FundsTracker } from "./funds.ts";
import type { HspPort } from "./hsp/port.ts";
import { errMessage } from "./hsp/port.ts";
import { accounts, type Ledger } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import { grossGraph, netDebits, projectNetting, type NetTransfer } from "./netting.ts";
import { batchSummaryJson, nowIso, type BatchRow, type CallRow, type HspRow, type Store } from "./store.ts";

export const MAX_CLAIMS = 64;
const REVOKE_GRACE = 3_600n;
const EXPIRY_GRACE = 3n * 86_400n;
const HSP_DEADLINE_SEC = 3_600n;
const HSP_MAX_ATTEMPTS = 8;

/** One claim candidate: the latest accepted voucher of a (mandate, payee) pair above what is settled. */
export type Candidate = {
  mandateId: Hex;
  agent: Address;
  payee: Address;
  payees: Address[];
  cumulative: bigint;
  settled: bigint;
  delta: bigint;
  agentSig: Hex;
  calls: number;
};

export type SettleResult = { batchIds: Hex[]; batches: ReturnType<typeof batchSummaryJson>[]; dropped: DroppedClaim[] } | { skipped: string };
export type DroppedClaim = { mandateId: Hex; payee: Address; reason: string };

export function batchIdOf(chainId: number, hub: Address, receiptsRoot: Hex, seq: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
      [BigInt(chainId), hub, receiptsRoot, BigInt(seq)],
    ),
  );
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function toReceipt(c: CallRow): CallReceipt {
  return {
    callId: c.call_id,
    mandateId: c.mandate_id,
    payee: c.payee,
    amount: BigInt(c.amount),
    cumulative: BigInt(c.cumulative),
    requestHash: c.request_hash,
    timestamp: BigInt(c.timestamp),
  };
}

function sameTransfers(a: readonly NetTransfer[], b: readonly NetTransfer[]): boolean {
  return a.length === b.length && a.every((t, i) => isAddressEqual(t.from, b[i]!.from) && isAddressEqual(t.to, b[i]!.to) && t.amount === b[i]!.amount);
}

export class SettlementService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #ledger: Ledger;
  readonly #events: EventBus;
  readonly #funds: FundsTracker;
  readonly #hsp: HspPort;
  readonly #log: Logger;
  readonly #cosignTimeoutMs: number;
  #running: Promise<SettleResult> | null = null;
  readonly #cosignWaiters = new Map<number, () => void>();
  #hspRetrying = false;

  constructor(deps: {
    db: Database;
    store: Store;
    chain: ChainClient;
    ledger: Ledger;
    events: EventBus;
    funds: FundsTracker;
    hsp: HspPort;
    log: Logger;
    cosignTimeoutSec: number;
  }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#ledger = deps.ledger;
    this.#events = deps.events;
    this.#funds = deps.funds;
    this.#hsp = deps.hsp;
    this.#log = deps.log.child({ component: "settlement" });
    this.#cosignTimeoutMs = deps.cosignTimeoutSec * 1000;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /** Resolves when the in-flight settlement (if any) finishes. */
  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  /** Latest accepted voucher per (mandate, payee) above the settled position, grouped by agent so netting stays in one chunk. */
  candidates(): Candidate[] {
    const rows = this.#db.all<{
      mandate_id: Hex;
      payee: Address;
      cumulative: string;
      settled: string;
      agent: Address;
      payees: string;
    }>(
      `SELECT p.mandate_id, p.payee, p.cumulative, p.settled, m.agent, m.payees
       FROM positions p JOIN mandates m ON m.id = p.mandate_id
       WHERE m.token = ? AND p.cumulative != p.settled
       ORDER BY m.agent, p.mandate_id, p.payee`,
      this.#chain.token,
    );
    const out: Candidate[] = [];
    for (const r of rows) {
      const last = this.#db.get<{ agent_signature: Hex }>(
        "SELECT agent_signature FROM calls WHERE mandate_id = ? AND payee = ? AND cumulative = ? AND status = 'accepted'",
        r.mandate_id,
        r.payee,
        r.cumulative,
      );
      if (!last) continue; // already in a batch that is being settled
      const calls = this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM calls WHERE mandate_id = ? AND payee = ? AND status = 'accepted'",
        r.mandate_id,
        r.payee,
      )!.n;
      const cumulative = BigInt(r.cumulative);
      const settled = BigInt(r.settled);
      out.push({
        mandateId: r.mandate_id,
        agent: r.agent,
        payee: r.payee,
        payees: JSON.parse(r.payees) as Address[],
        cumulative,
        settled,
        delta: cumulative - settled,
        agentSig: last.agent_signature,
        calls,
      });
    }
    return out;
  }

  /** What settling now would do (GET /v1/netting/preview). Local data only, no chain reads. */
  preview() {
    const cands = this.candidates();
    const chunks = chunk(cands, MAX_CLAIMS).map((cs) => projectNetting(cs.map((c) => ({ agent: c.agent, payee: c.payee, delta: c.delta }))));
    const calls = cands.reduce((n, c) => n + c.calls, 0);
    const transfers = chunks.flatMap((p) => p.transfers);
    const grossTotal = cands.reduce((s, c) => s + c.delta, 0n);
    const netTotal = transfers.reduce((s, t) => s + t.amount, 0n);
    return {
      calls,
      claims: cands.length,
      batches: chunks.length,
      grossTotal: grossTotal.toString(),
      netTotal: netTotal.toString(),
      gross: grossGraph(cands.map((c) => ({ agent: c.agent, payee: c.payee, amount: c.delta, calls: c.calls }))).map((e) => ({
        ...e,
        amount: e.amount.toString(),
      })),
      net: transfers.map((t) => ({ from: t.from, to: t.to, amount: t.amount.toString() })),
      transfers: transfers.length,
      /** Calls per projected on-chain transfer; 0 when there is nothing to settle. */
      compression: transfers.length > 0 ? calls / transfers.length : 0,
      savedTransfers: Math.max(0, calls - transfers.length),
    };
  }

  /** Single-flight settlement of every accepted call. */
  settle(trigger: "manual" | "interval"): Promise<SettleResult> {
    if (this.#running) return Promise.resolve({ skipped: "a settlement is already running" });
    const run = this.#settle(trigger).finally(() => {
      this.#running = null;
    });
    this.#running = run;
    return run;
  }

  async #settle(trigger: "manual" | "interval"): Promise<SettleResult> {
    const chain = this.#chain;
    let cands = this.candidates();
    if (cands.length === 0) return { skipped: "nothing to settle" };
    const dropped: DroppedClaim[] = [];
    const drop = (c: Candidate, reason: string) => {
      dropped.push({ mandateId: c.mandateId, payee: c.payee, reason });
      cands = cands.filter((x) => x !== c);
    };

    // On-chain pre-checks: mandate settleable now, and our settled position equals the hub's.
    const block = await chain.public.getBlock();
    const now = block.timestamp;
    const mandateIds = [...new Set(cands.map((c) => c.mandateId))];
    const onchain = new Map(await Promise.all(mandateIds.map(async (id) => [id, await chain.mandate(id)] as const)));
    const settledOnchain = await Promise.all(cands.map((c) => chain.settledOf(c.mandateId, c.payee)));
    for (const [i, c] of [...cands.entries()]) {
      const m = onchain.get(c.mandateId);
      if (!m) {
        drop(c, "mandate is not open on chain");
        continue;
      }
      const byExpiry = m.validUntil + EXPIRY_GRACE;
      const deadline = m.revokedAt === 0n ? byExpiry : m.revokedAt + REVOKE_GRACE < byExpiry ? m.revokedAt + REVOKE_GRACE : byExpiry;
      if (now < m.validAfter || now > deadline) {
        drop(c, "mandate is outside its on-chain settlement window");
        continue;
      }
      if (!isAddressEqual(m.token, chain.token)) {
        drop(c, "mandate token differs from the settlement token");
        continue;
      }
      if (settledOnchain[i] !== c.settled) {
        drop(c, `on-chain settled ${settledOnchain[i]} differs from node position ${c.settled}`);
      }
    }
    for (const d of dropped) this.#funds.warn({ mandateId: d.mandateId, payee: d.payee, reason: d.reason });

    const batchIds: Hex[] = [];
    for (const group of chunk(cands, MAX_CLAIMS)) {
      const claims = await this.#fundedClaims(group, dropped);
      if (claims.length === 0) continue;
      const batchId = await this.#settleChunk(claims, trigger);
      if (batchId) batchIds.push(batchId);
    }
    if (batchIds.length === 0) return { skipped: dropped.length ? "no claim passed the on-chain pre-checks" : "nothing to settle" };
    return {
      batchIds,
      batches: batchIds.map((id) => batchSummaryJson(this.#store.batch(id)!, chain.chainId)),
      dropped,
    };
  }

  /** Drops every claim of an agent whose wallet cannot pay its projected net debit, until the projection is fundable. */
  async #fundedClaims(group: Candidate[], dropped: DroppedClaim[]): Promise<Candidate[]> {
    let claims = group;
    const checked = new Map<string, { balance: bigint; allowance: bigint }>();
    for (;;) {
      const projection = projectNetting(claims.map((c) => ({ agent: c.agent, payee: c.payee, delta: c.delta })));
      const short: Address[] = [];
      for (const [debtor, debit] of netDebits(projection)) {
        const key = debtor.toLowerCase();
        let f = checked.get(key);
        if (!f) {
          f = await this.#chain.funds(debtor);
          this.#store.setFunds(debtor, this.#chain.token, f.balance, f.allowance);
          checked.set(key, f);
        }
        if (f.balance < debit || f.allowance < debit) {
          short.push(debtor);
          this.#funds.warn({
            agent: debtor,
            reason: f.balance < debit ? "balance" : "allowance",
            required: debit.toString(),
            balance: f.balance.toString(),
            allowance: f.allowance.toString(),
          });
        }
      }
      if (short.length === 0) return claims;
      const isShort = (a: Address) => short.some((s) => isAddressEqual(s, a));
      for (const c of claims.filter((c) => isShort(c.agent))) {
        dropped.push({ mandateId: c.mandateId, payee: c.payee, reason: "agent cannot fund its net debit" });
      }
      claims = claims.filter((c) => !isShort(c.agent));
      if (claims.length === 0) return claims;
    }
  }

  async #settleChunk(claims: Candidate[], trigger: string): Promise<Hex | null> {
    const chain = this.#chain;
    const db = this.#db;
    const projection = projectNetting(claims.map((c) => ({ agent: c.agent, payee: c.payee, delta: c.delta })));

    // 1. Persist the batch: receipts tree over every call it clears, batch id, claims and projected transfers.
    const { seq, batchId, receiptsRoot } = db.tx(() => {
      const createdAt = nowIso();
      const { lastInsertRowid: seq } = db.run(
        "INSERT INTO batches (status, token, trigger, created_at) VALUES ('building', ?, ?, ?)",
        chain.token,
        trigger,
        createdAt,
      );
      const calls: CallRow[] = [];
      const perClaim: number[] = [];
      for (const c of claims) {
        const rows = db.all<CallRow>(
          `SELECT * FROM calls WHERE mandate_id = ? AND payee = ? AND status = 'accepted' ORDER BY seq`,
          c.mandateId,
          c.payee,
        ).filter((r) => BigInt(r.cumulative) <= c.cumulative && BigInt(r.cumulative) > c.settled);
        perClaim.push(rows.length);
        calls.push(...rows);
      }
      calls.sort((a, b) => a.seq - b.seq);
      const tree = receiptsTree(calls.map(toReceipt));
      const receiptsRoot = tree.root as Hex;
      const batchId = batchIdOf(chain.chainId, chain.hub, receiptsRoot, seq).toLowerCase() as Hex;
      this.#store.updateBatch(seq, {
        batch_id: batchId,
        receipts_root: receiptsRoot,
        claims: claims.length,
        calls: calls.length,
        projected_gross: projection.gross.toString(),
        projected_net: projection.net.toString(),
        transfers: projection.transfers.length,
      });
      const proofs = new Map<number, Hex[]>();
      for (const [i] of tree.entries()) proofs.set(i, tree.getProof(i) as Hex[]);
      calls.forEach((c, i) => {
        db.run(
          "UPDATE calls SET status = 'settling', batch_seq = ?, proof = ? WHERE seq = ?",
          seq,
          JSON.stringify(proofs.get(i) ?? []),
          c.seq,
        );
      });
      claims.forEach((c, i) => {
        db.run(
          `INSERT INTO batch_claims (batch_seq, idx, mandate_id, agent, payee, cumulative, previous, delta, calls, agent_signature, payee_proof)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          seq,
          i,
          c.mandateId,
          c.agent,
          c.payee,
          c.cumulative.toString(),
          c.settled.toString(),
          c.delta.toString(),
          perClaim[i]!,
          c.agentSig,
          JSON.stringify(c.payees.length ? payeeProof(c.payees, c.payee) : []),
        );
      });
      projection.transfers.forEach((t, i) => {
        db.run(
          "INSERT INTO net_transfers (batch_seq, idx, from_addr, to_addr, amount) VALUES (?, ?, ?, ?, ?)",
          seq,
          i,
          t.from,
          t.to,
          t.amount.toString(),
        );
      });
      this.#events.emit("batch.started", { batch: batchSummaryJson(this.#store.batch(String(seq))!, chain.chainId) });
      return { seq, batchId, receiptsRoot };
    });
    const log = this.#log.child({ batchId, seq });
    log.info("batch started", { claims: claims.length, transfers: projection.transfers.length });

    try {
      // 2. HSP co-sign phase: one HSP mandate per projected net transfer, bound to the batch id.
      await this.#cosignPhase(seq, batchId, projection.transfers);

      // 3. Simulate, then send.
      const args = [
        batchId,
        receiptsRoot,
        chain.token,
        claims.map((c) => ({
          voucher: { mandateId: c.mandateId, payee: c.payee, cumulative: c.cumulative },
          agentSig: c.agentSig,
          payeeProof: c.payees.length ? payeeProof(c.payees, c.payee) : [],
        })),
      ] as const;
      const txHash = await chain.txQueue.run(async () => {
        const { request } = await chain.public.simulateContract({
          address: chain.hub,
          abi: clearingHubAbi,
          functionName: "settleBatch",
          args,
          account: chain.operator,
        });
        return chain.wallet.writeContract(request);
      });
      db.tx(() => {
        this.#store.updateBatch(seq, { status: "submitted", tx_hash: txHash, submitted_at: nowIso() });
        this.#events.emit("batch.submitted", { batch: batchSummaryJson(this.#store.batch(String(seq))!, chain.chainId) });
      });
      log.info("batch submitted", { txHash });

      const receipt = await chain.waitForReceipt(txHash);
      if (receipt.status !== "success") throw new Error(`settleBatch reverted in ${txHash}`);
      await this.#finalize(seq, receipt);
      return batchId;
    } catch (err) {
      const row = this.#store.batch(String(seq))!;
      if (row.status === "confirmed") throw err;
      this.#fail(seq, errMessage(err));
      log.error("batch failed", { err });
      return batchId;
    }
  }

  async #cosignPhase(seq: number, batchId: Hex, transfers: readonly NetTransfer[]): Promise<void> {
    const chain = this.#chain;
    const db = this.#db;
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + HSP_DEADLINE_SEC;
    db.tx(() => {
      this.#store.updateBatch(seq, { status: "cosigning" });
      transfers.forEach((t, i) => {
        const body = buildNetTransferMandate({
          payer: t.from,
          recipient: t.to,
          token: chain.token,
          amount: t.amount,
          chainId: chain.chainId,
          batchId,
          deadline,
          requiredCapabilities: this.#hsp.requiredCapabilities,
        });
        const id = hspPaymentId(chain.chainId, this.#hsp.verifyingContract, body).toLowerCase() as Hex;
        const calls = db
          .all<CallRow>("SELECT * FROM calls WHERE batch_seq = ? AND agent = ? ORDER BY seq", seq, t.from)
          .map((c) => ({ callId: c.call_id, mandateId: c.mandate_id, payee: c.payee, amount: c.amount, cumulative: c.cumulative }));
        const at = nowIso();
        db.run(
          `INSERT INTO hsp_payments (id, batch_seq, transfer_idx, payer, recipient, token, amount, deadline, body, required_caps, calls,
                                     status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
          id,
          seq,
          i,
          t.from,
          t.to,
          chain.token,
          t.amount.toString(),
          Number(deadline),
          JSON.stringify(hspMandateToWire(body)),
          JSON.stringify(this.#hsp.requiredCapabilities),
          JSON.stringify(calls),
          at,
          at,
        );
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(this.#store.hsp(id)!) });
      });
    });
    if (transfers.length > 0 && this.#cosignTimeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.#cosignTimeoutMs);
        function done() {
          clearTimeout(timer);
          resolve();
        }
        const check = () => {
          const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM hsp_payments WHERE batch_seq = ? AND status = 'PENDING'", seq)!.n;
          if (n === 0) done();
        };
        this.#cosignWaiters.set(seq, check);
        check();
      });
      this.#cosignWaiters.delete(seq);
    }
    db.tx(() => {
      for (const h of this.#store.hspOfBatch(seq).filter((h) => h.status === "PENDING")) {
        const r = this.#store.updateHsp(h.id, { status: "UNSIGNED", error: "debtor did not co-sign before the batch was submitted" });
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      }
    });
  }

  /** Pending HSP mandates for a debtor agent to co-sign (GET /v1/agents/:address/cosign). */
  pendingCosigns(address: Address) {
    const rows = this.#db.all<HspRow>(
      "SELECT * FROM hsp_payments WHERE payer = ? AND status = 'PENDING' ORDER BY created_at",
      getAddress(address),
    );
    return rows.map((r) => {
      const wire = JSON.parse(r.body) as HspWireMandate;
      return {
        hspPaymentId: r.id,
        batchId: this.#store.batchIdOfSeq(r.batch_seq)!,
        payer: r.payer,
        recipient: r.recipient,
        token: r.token,
        amount: r.amount,
        deadline: r.deadline,
        calls: JSON.parse(r.calls) as Array<{ callId: Hex; mandateId: Hex; payee: Address; amount: string; cumulative: string }>,
        typedData: {
          domain: { name: "HSP", version: "1", chainId: this.#chain.chainId, verifyingContract: this.#hsp.verifyingContract },
          types: hspTypes,
          primaryType: "Mandate" as const,
          message: wire,
        },
      };
    });
  }

  async cosign(id: string, signerProof: Hex) {
    const row = this.#store.hsp(id);
    if (!row) throw new ApiError(404, "NOT_FOUND", "HSP payment not found");
    if (row.status !== "PENDING") {
      throw new ApiError(409, "COSIGN_CLOSED", `HSP payment is ${row.status}; co-signing is closed`, { status: row.status });
    }
    const body = hspMandateFromWire(JSON.parse(row.body) as HspWireMandate);
    const ok = await isHspMandateSignedBy(this.#chain.chainId, this.#hsp.verifyingContract, body, signerProof, row.payer);
    if (!ok) throw new ApiError(400, "BAD_COSIGN", "signerProof is not a valid signature by the payer over this HSP mandate");
    const updated = this.#db.tx(() => {
      const fresh = this.#store.hsp(id)!;
      if (fresh.status !== "PENDING") throw new ApiError(409, "COSIGN_CLOSED", `HSP payment is ${fresh.status}`);
      const r = this.#store.updateHsp(row.id, { status: "COSIGNED", signer_proof: signerProof, error: null });
      this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      return r;
    });
    this.#cosignWaiters.get(row.batch_seq)?.();
    return this.#store.hspJsonOf(updated);
  }

  #fail(seq: number, error: string): void {
    this.#db.tx(() => {
      this.#store.updateBatch(seq, { status: "failed", error });
      this.#db.run("UPDATE calls SET status = 'accepted', batch_seq = NULL, proof = NULL WHERE batch_seq = ? AND status = 'settling'", seq);
      for (const h of this.#store.hspOfBatch(seq)) {
        const r = this.#store.updateHsp(h.id, { status: "FAILED", error: "batch failed; nothing was paid", next_attempt_at: null });
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      }
      this.#events.emit("batch.failed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, this.#chain.chainId) });
    });
  }

  /** Decodes the confirmed receipt, reconciles it with the projection, and books everything in one transaction. */
  async #finalize(seq: number, receipt: TransactionReceipt): Promise<void> {
    const chain = this.#chain;
    const db = this.#db;
    const batch = this.#store.batch(String(seq))!;
    const hubLogs = receipt.logs.filter((l) => isAddressEqual(l.address, chain.hub));
    const mine = <T extends { args: { batchId?: unknown } }>(xs: T[]) =>
      xs.filter((l) => String(l.args.batchId).toLowerCase() === batch.batch_id.toLowerCase());
    const vouchers = mine(parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "VoucherSettled" }));
    const nets = mine(parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "NetTransfer" }));
    const settledEv = mine(parseEventLogs({ abi: clearingHubAbi, logs: hubLogs, eventName: "BatchSettled" }))[0];
    if (!settledEv) throw new Error("BatchSettled event missing from receipt");

    const actual: Array<NetTransfer & { logIndex: number }> = nets.map((l) => ({
      from: getAddress(l.args.from as Address),
      to: getAddress(l.args.to as Address),
      amount: l.args.amount as bigint,
      logIndex: Number(l.logIndex),
    }));
    const projected = this.#store.netTransfers(seq).map((t) => ({ from: t.from_addr, to: t.to_addr, amount: BigInt(t.amount) }));
    const reconciled = sameTransfers(projected, actual);
    if (!reconciled) this.#log.error("netting projection does not match chain", { seq, projected, actual });
    const claims = this.#store.batchClaims(seq);
    const agentOf = new Map(claims.map((c) => [c.mandate_id.toLowerCase(), c.agent]));
    const knownAgents = new Set(
      this.#db.all<{ agent: string }>("SELECT DISTINCT agent FROM mandates").map((r) => r.agent.toLowerCase()),
    );
    const walletOf = (a: Address) => (knownAgents.has(a.toLowerCase()) ? accounts.agentWallet(a) : accounts.providerWallet(a));

    db.tx(() => {
      if (!reconciled) {
        db.run("DELETE FROM net_transfers WHERE batch_seq = ?", seq);
        actual.forEach((t, i) =>
          db.run(
            "INSERT INTO net_transfers (batch_seq, idx, from_addr, to_addr, amount, log_index) VALUES (?, ?, ?, ?, ?, ?)",
            seq,
            i,
            t.from,
            t.to,
            t.amount.toString(),
            t.logIndex,
          ),
        );
      } else {
        actual.forEach((t, i) => db.run("UPDATE net_transfers SET log_index = ? WHERE batch_seq = ? AND idx = ?", t.logIndex, seq, i));
      }
      this.#store.updateBatch(seq, {
        status: "confirmed",
        gross: (settledEv.args.gross as bigint).toString(),
        net: (settledEv.args.net as bigint).toString(),
        transfers: Number(settledEv.args.transfers as bigint),
        reconciled: reconciled ? 1 : 0,
        block_number: Number(receipt.blockNumber),
        gas_used: receipt.gasUsed.toString(),
        gas_price: receipt.effectiveGasPrice?.toString() ?? null,
        confirmed_at: nowIso(),
        error: reconciled ? null : "on-chain net transfers differ from the projection; chain values recorded",
      });
      db.run("UPDATE calls SET status = 'settled' WHERE batch_seq = ?", seq);
      for (const c of claims) {
        db.run("UPDATE positions SET settled = ? WHERE mandate_id = ? AND payee = ?", c.cumulative, c.mandate_id, c.payee);
      }
      const postings = [
        ...vouchers.flatMap((v) => {
          const agent = agentOf.get(String(v.args.mandateId).toLowerCase());
          if (!agent) throw new Error(`VoucherSettled for unknown mandate ${String(v.args.mandateId)}`);
          const delta = v.args.delta as bigint;
          return [
            { account: accounts.agentPayable(agent), debit: delta, memo: "voucher settled" },
            { account: accounts.providerReceivable(v.args.payee as Address), credit: delta, memo: "voucher settled" },
          ];
        }),
        ...actual.flatMap((t) => [
          { account: walletOf(t.to), debit: t.amount, memo: "net transfer in" },
          { account: walletOf(t.from), credit: t.amount, memo: "net transfer out" },
        ]),
      ];
      this.#ledger.post("batch.settled", batch.batch_id, `batch ${seq}`, postings);
      for (const h of this.#store.hspOfBatch(seq)) {
        const lg = actual.find((t) => isAddressEqual(t.from, h.payer) && isAddressEqual(t.to, h.recipient) && t.amount === BigInt(h.amount));
        this.#store.updateHsp(h.id, { tx_hash: receipt.transactionHash, log_index: lg?.logIndex ?? null });
      }
      this.#events.emit("batch.confirmed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, chain.chainId) });
    });
    this.#log.info("batch confirmed", {
      seq,
      txHash: receipt.transactionHash,
      transfers: actual.length,
      gasUsed: receipt.gasUsed,
      reconciled,
    });

    // Funds changed for every party; refresh in the background.
    const parties = new Set([...actual.flatMap((t) => [t.from, t.to])]);
    for (const p of parties) this.#funds.refresh(p).catch(() => undefined);

    // HSP step for each net transfer. Failures are recorded and retried; they never touch the clearing ledger.
    await this.#runHsp(this.#store.hspOfBatch(seq).filter((h) => h.status === "COSIGNED" || h.status === "UNSIGNED"));
  }

  async #runHsp(rows: HspRow[]): Promise<void> {
    for (const h of rows) {
      const batch = this.#store.batch(String(h.batch_seq))!;
      if (!batch.tx_hash) continue;
      const outcome = await this.#hsp.settle({
        paymentId: h.id,
        body: hspMandateFromWire(JSON.parse(h.body) as HspWireMandate),
        signerProof: h.signer_proof,
        txHash: batch.tx_hash,
        batchId: batch.batch_id,
        coordinatorId: h.coordinator_id,
      });
      const attempts = h.attempts + 1;
      const retry = !!outcome.retry && attempts < HSP_MAX_ATTEMPTS;
      this.#db.tx(() => {
        const r = this.#store.updateHsp(h.id, {
          status: outcome.status,
          satisfied_caps: outcome.satisfied ? JSON.stringify(outcome.satisfied) : h.satisfied_caps,
          receipt: outcome.receipt ? JSON.stringify(outcome.receipt) : h.receipt,
          coordinator_id: outcome.coordinatorId ?? h.coordinator_id,
          coordinator_status: outcome.coordinatorStatus ?? h.coordinator_status,
          log_index: outcome.logIndex ?? h.log_index,
          error: outcome.error ?? (outcome.status === "UNSIGNED" ? h.error : null),
          attempts,
          next_attempt_at: retry ? Math.floor(Date.now() / 1000) + Math.min(600, 15 * 2 ** (attempts - 1)) : null,
        });
        this.#events.emit("hsp.updated", { hspPayment: this.#store.hspJsonOf(r) });
      });
      if (outcome.status === "REJECT" || outcome.status === "FAILED") {
        this.#log.warn("hsp payment not accepted", { hspPaymentId: h.id, status: outcome.status, error: outcome.error });
      }
    }
  }

  /** Background HSP retry worker: coordinator failures, and COSIGNED records left by a restart. */
  async retryHsp(): Promise<void> {
    if (this.#hspRetrying) return;
    this.#hspRetrying = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const rows = this.#db.all<HspRow>(
        `SELECT h.* FROM hsp_payments h JOIN batches b ON b.seq = h.batch_seq
         WHERE b.status = 'confirmed' AND (
           (h.status IN ('FAILED', 'SUBMITTED') AND h.next_attempt_at IS NOT NULL AND h.next_attempt_at <= ?)
           OR (h.status = 'COSIGNED' AND h.attempts = 0))
         ORDER BY h.created_at LIMIT 50`,
        now,
      );
      if (rows.length) await this.#runHsp(rows);
    } finally {
      this.#hspRetrying = false;
    }
  }

  /** Startup recovery for batches interrupted by a crash or restart. */
  async recover(): Promise<void> {
    const open = this.#db.all<BatchRow>("SELECT * FROM batches WHERE status IN ('building', 'cosigning', 'submitted') ORDER BY seq");
    for (const b of open) {
      if (b.status !== "submitted" || !b.tx_hash) {
        this.#fail(b.seq, "node restarted before the batch was submitted");
        continue;
      }
      try {
        const receipt = await this.#chain.waitForReceipt(b.tx_hash, 30_000);
        if (receipt.status === "success") await this.#finalize(b.seq, receipt);
        else this.#fail(b.seq, `settleBatch reverted in ${b.tx_hash}`);
      } catch (err) {
        const onchain = await this.#chain.onchainBatch(b.batch_id).catch(() => null);
        if (onchain && onchain.settledAt === 0n) this.#fail(b.seq, `transaction ${b.tx_hash} not found after restart`);
        else this.#log.error("could not recover submitted batch; will retry on next start", { seq: b.seq, err });
      }
    }
  }
}
