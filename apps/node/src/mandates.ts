import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  parseEventLogs,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import {
  canonicalPolicy,
  clearingHubAbi,
  isMandateSignedBy,
  mandateId as computeMandateId,
  payeesRoot,
  policyHash,
  type Mandate,
  type Policy,
} from "@payminto/protocol";
import { ApiError } from "./errors.ts";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import { nowIso, type MandateRow, type Store } from "./store.ts";

export type CreateMandateInput = {
  mandate: Mandate;
  ownerSignature: Hex;
  policy: Policy;
  payees: Address[];
  label: string;
};

/** Message an agent or owner signs (EIP-191) to revoke without the admin token. Replays are harmless: revoke is idempotent. */
export function revokeMessage(mandateId: Hex): string {
  return `Payminto Clearing: revoke mandate ${mandateId.toLowerCase()}`;
}

export class MandateService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #events: EventBus;
  readonly #log: Logger;
  #lastScannedBlock: bigint;

  constructor(deps: { db: Database; store: Store; chain: ChainClient; events: EventBus; log: Logger; fromBlock: bigint }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#events = deps.events;
    this.#log = deps.log;
    this.#lastScannedBlock = BigInt(this.#store.getMeta("revocations_scanned_block") ?? deps.fromBlock.toString());
  }

  async create(input: CreateMandateInput): Promise<MandateRow> {
    const { chain } = this;
    const m = input.mandate;
    const id = computeMandateId(chain.chainId, chain.hub, m).toLowerCase() as Hex;
    const payees = [...new Set(input.payees.map((p) => getAddress(p)))].sort();

    if (policyHash(input.policy) !== m.policyHash.toLowerCase()) {
      throw new ApiError(400, "POLICY_HASH_MISMATCH", "policyHash(policy) does not equal mandate.policyHash");
    }
    if (payeesRoot(payees) !== m.payeesRoot.toLowerCase()) {
      throw new ApiError(400, "PAYEES_ROOT_MISMATCH", "payeesRoot(payees) does not equal mandate.payeesRoot");
    }
    if (BigInt(input.policy.perCallCap) > m.totalCap || BigInt(input.policy.dailyCap) <= 0n) {
      throw new ApiError(400, "INVALID_POLICY", "perCallCap must not exceed totalCap and dailyCap must be positive");
    }
    if (m.totalCap <= 0n || m.validUntil <= m.validAfter) {
      throw new ApiError(400, "INVALID_MANDATE", "totalCap must be positive and validUntil after validAfter");
    }
    if (m.validUntil <= BigInt(Math.floor(Date.now() / 1000))) throw new ApiError(400, "INVALID_MANDATE", "mandate already expired");

    const existing = this.#store.mandate(id);
    if (existing && existing.status !== "pending") return existing;

    const eoaOk = await isMandateSignedBy(chain.chainId, chain.hub, m, input.ownerSignature);
    const onchain = await chain.mandate(id);
    if (!eoaOk && !onchain) {
      // Contract owners (for example a Safe): ERC-1271 is checked by the hub itself, so simulate openMandate.
      const isContract = await chain.isContract(m.owner).catch(() => false);
      if (!isContract) throw new ApiError(400, "BAD_OWNER_SIGNATURE", "ownerSignature is not a valid signature by mandate.owner");
      await chain.public
        .simulateContract({
          address: chain.hub,
          abi: clearingHubAbi,
          functionName: "openMandate",
          args: [m, input.ownerSignature],
          account: chain.operator,
        })
        .catch(() => {
          throw new ApiError(400, "BAD_OWNER_SIGNATURE", "openMandate simulation rejected the contract owner signature");
        });
    }

    if (!existing) {
      this.#db.run(
        `INSERT INTO mandates (id, owner, agent, token, total_cap, valid_after, valid_until, payees_root, policy_hash, salt,
                               owner_signature, policy, payees, label, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id,
        getAddress(m.owner),
        getAddress(m.agent),
        getAddress(m.token),
        m.totalCap.toString(),
        Number(m.validAfter),
        Number(m.validUntil),
        m.payeesRoot.toLowerCase(),
        m.policyHash.toLowerCase(),
        m.salt.toLowerCase(),
        input.ownerSignature,
        canonicalPolicy(input.policy),
        JSON.stringify(payees),
        input.label,
        nowIso(),
      );
    }

    let txHash: Hex | null = null;
    if (!onchain) {
      try {
        txHash = await chain.txQueue.run(async () => {
          const { request } = await chain.public.simulateContract({
            address: chain.hub,
            abi: clearingHubAbi,
            functionName: "openMandate",
            args: [m, input.ownerSignature],
            account: chain.operator,
          });
          return chain.wallet.writeContract(request);
        });
        const rcpt = await chain.waitForReceipt(txHash);
        if (rcpt.status !== "success") throw new Error(`openMandate reverted in ${txHash}`);
      } catch (err) {
        // Another submitter may have opened it concurrently; the chain is the source of truth.
        if (!(await chain.mandate(id))) {
          this.#log.error("openMandate failed", { mandateId: id, err });
          throw new ApiError(502, "OPEN_MANDATE_FAILED", "Submitting openMandate on chain failed", {
            reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
          });
        }
      }
    }
    const row = this.#db.tx(() => {
      this.#db.run("UPDATE mandates SET status = 'open', open_tx_hash = ? WHERE id = ? AND status = 'pending'", txHash, id);
      const r = this.#store.mandate(id)!;
      this.#events.emit("mandate.opened", { mandate: this.#store.mandateSummary(r, Math.floor(Date.now() / 1000)) });
      return r;
    });
    this.#log.info("mandate opened", { mandateId: id, agent: row.agent, txHash });
    return row;
  }

  get chain(): ChainClient {
    return this.#chain;
  }

  /** Verifies an agent- or owner-signed revoke request; returns the signer role. */
  async authorizeSignedRevoke(m: MandateRow, signature: Hex): Promise<"agent" | "owner"> {
    let signer: Address;
    try {
      signer = await recoverMessageAddress({ message: revokeMessage(m.id), signature });
    } catch {
      throw new ApiError(401, "BAD_REVOKE_SIGNATURE", "signature does not recover");
    }
    if (isAddressEqual(signer, m.agent)) return "agent";
    if (isAddressEqual(signer, m.owner)) return "owner";
    // ERC-1271 owner wallets.
    const ok = await this.#chain.public
      .verifyMessage({ address: m.owner, message: revokeMessage(m.id), signature })
      .catch(() => false);
    if (ok) return "owner";
    throw new ApiError(403, "BAD_REVOKE_SIGNATURE", "revoke must be signed by the mandate agent or owner");
  }

  /**
   * Stops new vouchers immediately. Submits revokeMandate when the operator key is the owner or agent
   * (the only senders the hub accepts); otherwise returns the call the owner should make.
   */
  async revoke(id: Hex, by: string) {
    const chain = this.#chain;
    const m = this.#store.mandate(id);
    if (!m) throw new ApiError(404, "NOT_FOUND", "mandate not found");
    const first = m.status !== "revoked";
    if (first) {
      this.#db.tx(() => {
        this.#db.run("UPDATE mandates SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?", nowIso(), by, m.id);
        this.#events.emit("mandate.revoked", { mandate: this.#store.mandateSummary(this.#store.mandate(m.id)!, Math.floor(Date.now() / 1000)) });
      });
    }
    const call = {
      to: chain.hub,
      functionName: "revokeMandate",
      args: [m.id],
      data: encodeFunctionData({ abi: clearingHubAbi, functionName: "revokeMandate", args: [m.id] }),
      allowedSenders: [m.owner, m.agent],
    };
    let txHash: Hex | null = m.revoke_tx_hash;
    let submitted = false;
    const onchain = await chain.mandate(m.id).catch(() => null);
    const operatorMay = isAddressEqual(chain.operator.address, m.owner) || isAddressEqual(chain.operator.address, m.agent);
    if (onchain && onchain.revokedAt === 0n && operatorMay) {
      txHash = await chain.txQueue.run(() =>
        chain.wallet.writeContract({ address: chain.hub, abi: clearingHubAbi, functionName: "revokeMandate", args: [m.id] }),
      );
      await chain.waitForReceipt(txHash);
      this.#db.run("UPDATE mandates SET revoke_tx_hash = ? WHERE id = ?", txHash, m.id);
      submitted = true;
    }
    return {
      mandate: this.#store.mandateSummary(this.#store.mandate(m.id)!, Math.floor(Date.now() / 1000)),
      onchain: {
        revoked: !!onchain && (onchain.revokedAt !== 0n || submitted),
        submitted,
        txHash,
        call: submitted || (onchain && onchain.revokedAt !== 0n) ? null : call,
      },
    };
  }

  /** Picks up revocations made directly on chain by owners or agents. */
  async scanRevocations(): Promise<void> {
    const chain = this.#chain;
    const head = await chain.public.getBlockNumber();
    if (head <= this.#lastScannedBlock) return;
    const from = this.#lastScannedBlock + 1n;
    const to = head - from > 5_000n ? from + 5_000n : head;
    const logs = await chain.public.getLogs({
      address: chain.hub,
      event: clearingHubAbi.find((x) => x.type === "event" && x.name === "MandateRevoked") as Extract<
        (typeof clearingHubAbi)[number],
        { type: "event"; name: "MandateRevoked" }
      >,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of parseEventLogs({ abi: clearingHubAbi, logs, eventName: "MandateRevoked" })) {
      const id = (log.args.mandateId as Hex).toLowerCase() as Hex;
      const m = this.#store.mandate(id);
      if (m && m.status !== "revoked") {
        this.#db.tx(() => {
          this.#db.run(
            "UPDATE mandates SET status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_tx_hash = ? WHERE id = ?",
            nowIso(),
            `chain:${getAddress(log.args.by as Address)}`,
            log.transactionHash,
            id,
          );
          this.#events.emit("mandate.revoked", { mandate: this.#store.mandateSummary(this.#store.mandate(id)!, Math.floor(Date.now() / 1000)) });
        });
        this.#log.info("mandate revoked on chain", { mandateId: id });
      }
    }
    this.#lastScannedBlock = to;
    this.#store.setMeta("revocations_scanned_block", to.toString());
  }
}

