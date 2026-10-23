/**
 * Netting math and the flow-graph layout behind the Netting screen.
 * `netTransfers` mirrors ClearingHub._payNet exactly (greedy two-pointer over parties in first-seen order),
 * so the projection the dashboard draws is the same set of transfers the hub will emit.
 */
import { getAddress } from "viem";

export type Obligation = { from: string; to: string; amount: string; calls?: number };
export type Transfer = { from: string; to: string; amount: string };

/** Net position per party (positive = creditor), in first-seen order like the contract's party array. */
export function netPositions(obligations: readonly Obligation[]): { party: string; balance: bigint }[] {
  const order: string[] = [];
  const bal = new Map<string, bigint>();
  const touch = (who: string, delta: bigint) => {
    const k = getAddress(who);
    if (!bal.has(k)) {
      order.push(k);
      bal.set(k, 0n);
    }
    bal.set(k, (bal.get(k) ?? 0n) + delta);
  };
  for (const o of obligations) {
    const amt = BigInt(o.amount);
    if (amt === 0n) continue;
    touch(o.from, -amt);
    touch(o.to, amt);
  }
  return order.map((party) => ({ party, balance: bal.get(party) ?? 0n }));
}

export function netTransfers(obligations: readonly Obligation[]): Transfer[] {
  const pos = netPositions(obligations);
  const parties = pos.map((p) => p.party);
  const balances = pos.map((p) => p.balance);
  const count = parties.length;
  const out: Transfer[] = [];
  let d = 0;
  let c = 0;
  for (;;) {
    while (d < count && (balances[d] ?? 0n) >= 0n) d++;
    while (c < count && (balances[c] ?? 0n) <= 0n) c++;
    if (d === count || c === count) break;
    const owed = -(balances[d] ?? 0n);
    const due = balances[c] ?? 0n;
    const amount = owed < due ? owed : due;
    out.push({ from: parties[d]!, to: parties[c]!, amount: amount.toString() });
    balances[d] = (balances[d] ?? 0n) + amount;
    balances[c] = (balances[c] ?? 0n) - amount;
  }
  return out;
}

export function sumAmounts(rows: readonly { amount: string }[]): bigint {
  return rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

/** Collapses many per-call obligations into one edge per (from, to), summing amounts and call counts. */
export function aggregateObligations(rows: readonly Obligation[]): Required<Obligation>[] {
  const map = new Map<string, Required<Obligation>>();
  for (const r of rows) {
    const from = getAddress(r.from);
    const to = getAddress(r.to);
    const key = `${from}>${to}`;
    const prev = map.get(key);
    if (prev) {
      prev.amount = (BigInt(prev.amount) + BigInt(r.amount)).toString();
      prev.calls += r.calls ?? 1;
    } else {
      map.set(key, { from, to, amount: r.amount, calls: r.calls ?? 1 });
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Flow graph layout
// ---------------------------------------------------------------------------

export type FlowNode = {
  id: string; // `${side}:${address}`
  address: string;
  side: "payer" | "payee";
  total: bigint;
  x: number;
  y: number;
  height: number;
  /** True when the same wallet appears on both sides (it both buys and sells), which is what netting cancels. */
  dual: boolean;
};

export type FlowLink = {
  id: string;
  from: string;
  to: string;
  amount: bigint;
  calls: number;
  /** Ribbon thickness and its vertical span at each end. */
  width: number;
  sy: number; // centre y at source
  ty: number; // centre y at target
  path: string; // closed ribbon path
};

export type FlowLayout = {
  width: number;
  height: number;
  nodes: FlowNode[];
  links: FlowLink[];
  nodeWidth: number;
};

export type FlowLayoutOptions = {
  width?: number;
  height?: number;
  nodeWidth?: number;
  gap?: number;
  minBand?: number;
  padY?: number;
};

/**
 * A two-column Sankey: payers on the left, payees on the right, ribbon width proportional to amount.
 * Node height is proportional to the node's total flow with a floor so small parties stay legible.
 * Ribbons are stacked inside each node in the order of the opposite node, which keeps them from crossing more than necessary.
 */
export function layoutFlow(obligations: readonly Obligation[], opts: FlowLayoutOptions = {}): FlowLayout {
  const width = opts.width ?? 560;
  const nodeWidth = opts.nodeWidth ?? 10;
  const gap = opts.gap ?? 18;
  const minBand = opts.minBand ?? 2;
  const padY = opts.padY ?? 8;
  const edges = aggregateObligations(obligations).filter((e) => BigInt(e.amount) > 0n);

  const payerTotals = new Map<string, bigint>();
  const payeeTotals = new Map<string, bigint>();
  for (const e of edges) {
    payerTotals.set(e.from, (payerTotals.get(e.from) ?? 0n) + BigInt(e.amount));
    payeeTotals.set(e.to, (payeeTotals.get(e.to) ?? 0n) + BigInt(e.amount));
  }
  const byTotalDesc = (m: Map<string, bigint>) =>
    [...m.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0])));
  const payers = byTotalDesc(payerTotals);
  const payees = byTotalDesc(payeeTotals);

  const grand = [...payerTotals.values()].reduce((a, b) => a + b, 0n);
  const maxCount = Math.max(payers.length, payees.length, 1);
  const height = opts.height ?? Math.max(260, maxCount * 92 + padY * 2);
  const usable = height - padY * 2 - gap * (maxCount - 1);
  const scale = grand > 0n ? usable / Number(grand) : 0;
  const minNode = 14;

  const place = (list: [string, bigint][], side: "payer" | "payee"): FlowNode[] => {
    const heights = list.map(([, t]) => Math.max(minNode, Number(t) * scale));
    const total = heights.reduce((a, b) => a + b, 0) + gap * Math.max(0, list.length - 1);
    let y = padY + Math.max(0, (height - padY * 2 - total) / 2);
    return list.map(([address, t], i) => {
      const h = heights[i] ?? minNode;
      const node: FlowNode = {
        id: `${side}:${address}`,
        address,
        side,
        total: t,
        x: side === "payer" ? 0 : width - nodeWidth,
        y,
        height: h,
        dual: side === "payer" ? payeeTotals.has(address) : payerTotals.has(address),
      };
      y += h + gap;
      return node;
    });
  };

  const left = place(payers, "payer");
  const right = place(payees, "payee");
  const nodeById = new Map([...left, ...right].map((n) => [n.id, n]));
  const indexOf = (list: FlowNode[], address: string) => list.findIndex((n) => n.address === address);

  // Each node hands out vertical space to its links proportional to their share of the node total.
  const srcOffset = new Map<string, number>();
  const dstOffset = new Map<string, number>();
  const sortedForSource = [...edges].sort((a, b) => indexOf(right, a.to) - indexOf(right, b.to));
  const sPos = new Map<string, { y: number; w: number }>();
  for (const e of sortedForSource) {
    const n = nodeById.get(`payer:${e.from}`)!;
    const w = Math.max(minBand, (Number(BigInt(e.amount)) / Number(n.total)) * n.height);
    const off = srcOffset.get(n.id) ?? 0;
    sPos.set(`${e.from}>${e.to}`, { y: n.y + off + w / 2, w });
    srcOffset.set(n.id, off + w);
  }
  const sortedForTarget = [...edges].sort((a, b) => indexOf(left, a.from) - indexOf(left, b.from));
  const tPos = new Map<string, { y: number; w: number }>();
  for (const e of sortedForTarget) {
    const n = nodeById.get(`payee:${e.to}`)!;
    const w = Math.max(minBand, (Number(BigInt(e.amount)) / Number(n.total)) * n.height);
    const off = dstOffset.get(n.id) ?? 0;
    tPos.set(`${e.from}>${e.to}`, { y: n.y + off + w / 2, w });
    dstOffset.set(n.id, off + w);
  }

  const x0 = nodeWidth;
  const x1 = width - nodeWidth;
  const mid = (x0 + x1) / 2;
  const links: FlowLink[] = edges.map((e) => {
    const key = `${e.from}>${e.to}`;
    const s = sPos.get(key)!;
    const t = tPos.get(key)!;
    const path = [
      `M${x0},${round(s.y - s.w / 2)}`,
      `C${mid},${round(s.y - s.w / 2)} ${mid},${round(t.y - t.w / 2)} ${x1},${round(t.y - t.w / 2)}`,
      `L${x1},${round(t.y + t.w / 2)}`,
      `C${mid},${round(t.y + t.w / 2)} ${mid},${round(s.y + s.w / 2)} ${x0},${round(s.y + s.w / 2)}`,
      "Z",
    ].join(" ");
    return { id: key, from: e.from, to: e.to, amount: BigInt(e.amount), calls: e.calls, width: Math.max(s.w, t.w), sy: s.y, ty: t.y, path };
  });

  return { width, height, nodes: [...left, ...right], links, nodeWidth };
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
