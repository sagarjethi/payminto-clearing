import { z } from "zod";
import type { Address } from "viem";
import { hspMandateToWire } from "@payminto/protocol";
import { errMessage, type HspPort, type HspSettleInput, type HspSettleOutcome } from "./port.ts";

const registerResponse = z.object({ paymentId: z.string().min(1), status: z.string().optional() }).loose();
const paymentResponse = z.object({ status: z.string() }).loose();

const TERMINAL_FAIL = new Set(["FAILED", "DISPUTED", "EXPIRED"]);

export type CoordinatorOptions = {
  url: string;
  apiKey: string;
  chainName: string;
  verifyingContract: Address;
  fetch?: typeof fetch;
  /** Backoff schedule for observe (202) and status polling, in ms. */
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * HSP_MODE=coordinator: registers the co-signed mandate with the HashKey HSP Coordinator, asks it to observe the
 * settlement tx (retrying while it answers 202), then polls until SETTLED. Failures are reported with retry=true;
 * the background worker retries them and they never block the clearing ledger.
 */
export class CoordinatorHspAdapter implements HspPort {
  readonly mode = "coordinator" as const;
  readonly verifyingContract: Address;
  readonly requiredCapabilities: readonly string[] = [];
  readonly #o: Required<Omit<CoordinatorOptions, "verifyingContract">>;

  constructor(o: CoordinatorOptions) {
    this.verifyingContract = o.verifyingContract;
    this.#o = {
      url: o.url.replace(/\/+$/, ""),
      apiKey: o.apiKey,
      chainName: o.chainName,
      fetch: o.fetch ?? globalThis.fetch.bind(globalThis),
      backoffMs: o.backoffMs ?? [500, 1_000, 2_000, 4_000, 8_000, 15_000],
      sleep: o.sleep ?? defaultSleep,
    };
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#o.fetch(`${this.#o.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#o.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }

  async settle(input: HspSettleInput): Promise<HspSettleOutcome> {
    if (!input.signerProof) return { status: "UNSIGNED" };
    let coordinatorId = input.coordinatorId ?? null;
    try {
      if (!coordinatorId) {
        const r = await this.#call("POST", "/payments", {
          chain: this.#o.chainName,
          mandate: { body: hspMandateToWire(input.body), signerProof: input.signerProof, requiredCapabilities: [] },
          attestations: [],
        });
        if (r.status >= 300) return { status: "FAILED", error: `register: HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 };
        coordinatorId = registerResponse.parse(r.json).paymentId;
      }
      const id = encodeURIComponent(coordinatorId);

      let observed = false;
      for (const wait of [0, ...this.#o.backoffMs]) {
        if (wait) await this.#o.sleep(wait);
        const r = await this.#call("POST", `/payments/${id}/observe`, { txHash: input.txHash });
        if (r.status === 202) continue;
        if (r.status >= 300) {
          return { status: "FAILED", coordinatorId, error: `observe: HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429 };
        }
        observed = true;
        break;
      }
      if (!observed) return { status: "SUBMITTED", coordinatorId, coordinatorStatus: "OBSERVING", retry: true };

      let last = "UNKNOWN";
      for (const wait of [0, ...this.#o.backoffMs]) {
        if (wait) await this.#o.sleep(wait);
        const r = await this.#call("GET", `/payments/${id}`);
        if (r.status >= 300) continue;
        last = paymentResponse.parse(r.json).status.toUpperCase();
        if (last === "SETTLED") return { status: "SETTLED", coordinatorId, coordinatorStatus: last };
        if (TERMINAL_FAIL.has(last)) return { status: "FAILED", coordinatorId, coordinatorStatus: last, error: `coordinator status ${last}` };
      }
      return { status: "SUBMITTED", coordinatorId, coordinatorStatus: last, retry: true };
    } catch (err) {
      return { status: "FAILED", coordinatorId, error: errMessage(err), retry: true };
    }
  }
}
