import { DENIAL_RULES, type DenialRule } from "@payminto/protocol";
import type { Denial } from "./schemas";

/**
 * Plain-language names for each policy rule, grouped by what the refused call looked like.
 * "attack" rules catch a voucher that was tampered with or aimed somewhere it should not go;
 * "limit" rules catch an honest agent that ran into its budget; "state" rules catch a mandate
 * that cannot pay right now.
 */
export const RULE_INFO: Record<DenialRule, { title: string; kind: "attack" | "limit" | "state" }> = {
  PAYEE_NOT_ALLOWED: { title: "Payee not on allowlist", kind: "attack" },
  BAD_SIGNATURE: { title: "Forged voucher signature", kind: "attack" },
  STALE_CUMULATIVE: { title: "Replayed voucher", kind: "attack" },
  PRICE_MISMATCH: { title: "Price tampered", kind: "attack" },
  TOKEN_MISMATCH: { title: "Wrong settlement token", kind: "attack" },
  UNKNOWN_MANDATE: { title: "Unknown mandate", kind: "attack" },
  PER_CALL_CAP: { title: "Over per-call cap", kind: "limit" },
  DAILY_CAP: { title: "Over daily cap", kind: "limit" },
  TOTAL_CAP: { title: "Over total budget", kind: "limit" },
  RATE_LIMIT: { title: "Rate limit hit", kind: "limit" },
  MANDATE_NOT_ACTIVE: { title: "Mandate not active", kind: "state" },
  MANDATE_REVOKED: { title: "Mandate revoked", kind: "state" },
  INSUFFICIENT_FUNDS: { title: "Agent underfunded", kind: "state" },
  POSITION_UNVERIFIED: { title: "Inflated position claim", kind: "attack" },
};

export function ruleTitle(rule: DenialRule): string {
  return RULE_INFO[rule]?.title ?? rule;
}

export function ruleDescription(rule: DenialRule): string {
  return DENIAL_RULES[rule] ?? "";
}

export type RuleSummary = {
  rule: DenialRule;
  title: string;
  kind: "attack" | "limit" | "state";
  count: number;
  /** Sum of the amounts the refused vouchers asked for, in atomic units. */
  attempted: bigint;
  /** ISO time of the most recent denial under this rule. */
  last: string;
};

export type DenialSummary = {
  total: number;
  attempted: bigint;
  attacks: number;
  byRule: RuleSummary[];
  latest: Denial | null;
};

/**
 * Totals for the blocked-calls view: how many vouchers were refused, how much they asked for,
 * and one row per rule ordered by count, then by recency.
 */
export function summarizeDenials(denials: readonly Denial[]): DenialSummary {
  const map = new Map<DenialRule, RuleSummary>();
  let attempted = 0n;
  let attacks = 0;
  let latest: Denial | null = null;
  for (const d of denials) {
    const amount = d.amount ? BigInt(d.amount) : 0n;
    attempted += amount;
    const info = RULE_INFO[d.rule] ?? { title: d.rule, kind: "state" as const };
    if (info.kind === "attack") attacks += 1;
    if (!latest || d.createdAt > latest.createdAt) latest = d;
    const row = map.get(d.rule);
    if (row) {
      row.count += 1;
      row.attempted += amount;
      if (d.createdAt > row.last) row.last = d.createdAt;
    } else {
      map.set(d.rule, { rule: d.rule, title: info.title, kind: info.kind, count: 1, attempted: amount, last: d.createdAt });
    }
  }
  const byRule = [...map.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  return { total: denials.length, attempted, attacks, byRule, latest };
}

/** Ends a node message with a full stop unless it already ends in punctuation. */
export function asSentence(message: string): string {
  const m = message.trim();
  if (!m) return m;
  return /[.!?…]$/.test(m) ? m : `${m}.`;
}
