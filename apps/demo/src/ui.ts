import { createInterface } from "node:readline";
import { formatAmount } from "@payminto/protocol";
import type { Summary } from "./scenario.ts";
import { txLink } from "./scenario.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

export const usdc = (atomic: bigint | string) => `${formatAmount(atomic, 6)} USDC`;
export const short = (h: string) => (h.length > 14 ? `${h.slice(0, 6)}..${h.slice(-4)}` : h);
const int = (n: number | bigint) => n.toLocaleString("en-US");

export function banner(title: string, sub: string): string {
  const w = Math.max(visible(title), visible(sub)) + 4;
  const line = "-".repeat(w);
  return [c.cyan(`+${line}+`), c.cyan("|") + "  " + pad(c.bold(title), w - 2) + c.cyan("|"), c.cyan("|") + "  " + pad(c.dim(sub), w - 2) + c.cyan("|"), c.cyan(`+${line}+`)].join("\n");
}

export function section(title: string): string {
  return `\n${c.bold(c.blue(`== ${title} `))}${c.blue("=".repeat(Math.max(4, 64 - title.length)))}`;
}

function kv(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${c.dim(k.padEnd(w))}  ${v}`).join("\n");
}

export function progressBar(done: number, total: number, width = 32): string {
  const f = total > 0 ? Math.min(1, done / total) : 0;
  const n = Math.round(f * width);
  return `[${c.green("#".repeat(n))}${c.dim(".".repeat(width - n))}] ${String(done).padStart(String(total).length)}/${total}`;
}

const hspColor = (s: string) => (s === "ACCEPT" || s === "SETTLED" ? c.green(s) : s === "UNSIGNED" ? c.yellow(s) : c.red(s));

export function renderSummary(s: Summary): string {
  const out: string[] = [];
  const net = s.network.live ? (s.network.chainId === 177 ? "HashKey Chain mainnet (177)" : "HashKey Chain testnet (133)") : "local anvil (31337)";
  out.push(section("Payminto Clearing - run summary"));
  out.push(
    kv([
      ["network", `${net}  ${c.dim(s.network.rpc)}`],
      ["hub", s.network.hub],
      ["token", s.network.token],
    ]),
  );
  out.push(section("Clearing"));
  const failed = s.failedCalls ? c.red(`  (${s.failedCalls} failed)`) : "";
  out.push(
    kv([
      ["paid calls", `${c.bold(int(s.calls))}${failed}  ${c.dim(`${s.callsPerSec.toFixed(0)} calls/s, zero gas for agents`)}`],
      ["gross", c.bold(usdc(s.gross))],
      ["net moved", `${c.bold(usdc(s.net))}  ${c.dim(`${s.gross > 0n ? ((Number(s.net) / Number(s.gross)) * 100).toFixed(1) : "0"}% of gross`)}`],
      ["batches", `${s.batches.length}  ${c.dim(`settled in ${(s.settleMs / 1000).toFixed(1)} s`)}`],
      ["on-chain transfers", `${c.bold(String(s.transfersOnchain))}  ${c.dim("NetTransfer events decoded from tx receipts")}`],
      ["compression", c.bold(c.green(`${s.compression.toFixed(1)} calls per on-chain transfer`))],
      ["market data source", c.dim(s.marketDataSource)],
    ]),
  );
  out.push(section("Gas (from tx receipts)"));
  out.push(
    kv([
      ["settlement gas used", `${c.bold(int(s.gas.used))} gas`],
      ["naive, one transfer per call", `${int(s.gas.naive)} gas  ${c.dim(`= ${int(s.calls)} x ${int(s.gas.naivePerCall)} (eth_estimateGas of one ERC-20 transfer)`)}`],
      ["saved", c.bold(c.green(`${int(s.gas.saved)} gas (${s.gas.savedPct.toFixed(1)}%)`))],
    ]),
  );
  out.push(section("Settlement transactions"));
  for (const b of s.batches) {
    const ok = b.status === "confirmed" ? c.green(b.status) : c.red(b.status);
    out.push(`  ${c.dim("batch")} ${short(b.id)}  ${ok}  ${b.calls} calls, ${b.claims} claims, ${b.transfers} transfers, reconciled ${b.reconciled ? c.green("yes") : c.red(String(b.reconciled))}`);
    out.push(`  ${c.dim("tx")}    ${txLink(s.network.chainId, b.txHash)}`);
  }
  if (s.dropped.length) for (const d of s.dropped) out.push(`  ${c.yellow("dropped")} ${short(d.mandateId)} -> ${short(d.payee)}: ${d.reason}`);
  out.push(section("Net transfers and HSP"));
  const who = (a: string) => pad(s.names[a.toLowerCase()] ?? short(a), 16);
  for (const h of s.hsp) {
    out.push(`  #${h.index}  ${who(h.from)} -> ${who(h.to)} ${pad(usdc(h.amount), 14)}  HSP ${pad(hspColor(h.status), 8)} ${h.cosigned ? c.dim("co-signed by debtor") : c.yellow("not co-signed")}`);
  }
  out.push(section("Denials (recorded by the node)"));
  if (s.denials.length === 0) out.push(c.dim("  none"));
  for (const d of s.denials) out.push(`  ${c.red(d.rule.padEnd(18))} x${d.count}  ${d.ruleText}`);
  for (const a of s.attacks) {
    const l1 = a.agentRule ? c.red(`agent refused ${a.agentRule}`) : c.red("agent SIGNED");
    const l2 = a.nodeRule
      ? c.red(`node denied ${a.nodeRule}`)
      : a.compromisedLocalRule
        ? c.yellow(`never reached the node (refused locally ${a.compromisedLocalRule})`)
        : c.red("node ACCEPTED");
    out.push(`  ${c.dim("attack")} ${a.agent} via ${a.via.toUpperCase()}: ${a.name} -> ${l1}, compromised runtime -> ${l2}`);
    if (a.toolText) out.push(`         ${c.dim(`MCP tool error: "${a.toolText.slice(0, 150)}${a.toolText.length > 150 ? "..." : ""}"`)}`);
  }
  out.push(section("Proof and books"));
  if (s.proof) {
    const v = s.proof.verifiedOnchain ? c.green("true") : c.red("false");
    out.push(kv([["call #" + s.proof.seq, `${short(s.proof.callId)} in batch ${short(s.proof.batchId)}, ${s.proof.proofLength}-step Merkle path, ClearingHub.verifyReceipt = ${c.bold(v)}`]]));
  } else out.push(c.red("  no settled call to prove"));
  if (s.mcpProof) out.push(kv([["MCP prove_receipt", `${short(s.mcpProof.callId)} -> verified on chain: ${s.mcpProof.verified ? c.green("true") : c.red(String(s.mcpProof.verified))}`]]));
  out.push(
    kv([
      ["trial balance", s.trialBalance.balanced && s.trialBalance.balance === "0" ? c.green(`balanced, ${s.trialBalance.journals} journals, balance 0`) : c.red(`UNBALANCED ${s.trialBalance.balance}`)],
      ["hub token balance", s.hubBalance === 0n ? c.green("0 (non-custodial: wallet to wallet)") : c.red(usdc(s.hubBalance))],
      [
        "gasless onboarding",
        s.gasless.transactions === 0
          ? c.green(`${s.gasless.label}: EIP-2612 permit, agent sent 0 transactions`)
          : c.red(`${s.gasless.label}: agent sent ${s.gasless.transactions} transactions`),
      ],
    ]),
  );
  out.push(section("Dashboard"));
  out.push(kv([["node", s.dashboard.nodeUrl], ["dashboard", `${s.dashboard.url}  ${c.dim(`(NEXT_PUBLIC_NODE_URL=${s.dashboard.nodeUrl} pnpm --filter dashboard dev)`)}`]]));
  out.push(c.dim(`\n  total run time ${(s.runMs / 1000).toFixed(1)} s`));
  return out.join("\n");
}

/** Stage mode: waits for Enter (or returns at once when stdin is not a terminal). */
export function waitEnter(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(`${prompt}\n`);
    return Promise.resolve("");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Waits for Enter, or resolves early when `poll` returns true (checked every `everyMs`). */
export function waitEnterOr(prompt: string, poll: () => Promise<boolean>, everyMs = 500): Promise<"enter" | "poll"> {
  return new Promise((resolve) => {
    let finished = false;
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    const finish = (how: "enter" | "poll") => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      rl?.close();
      if (how === "poll") process.stdout.write("\n");
      resolve(how);
    };
    const timer = setInterval(() => {
      poll().then((ok) => ok && finish("poll"), () => {});
    }, everyMs);
    if (rl) rl.question(prompt, () => finish("enter"));
    else {
      process.stdout.write(`${prompt}\n`);
      finish("enter");
    }
  });
}
