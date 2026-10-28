/**
 * pnpm demo        one command: chain, deploy, node, providers, mandates, ~500 paid calls, settle, summary, stop.
 * pnpm demo:stage  the live pitch: same stack, paced and step by step (Enter advances), left running for the dashboard.
 */
import { z } from "zod";
import { formatAmount } from "@payminto/protocol";
import { DemoConfigError, loadDemoConfig, REPO_ROOT, type DemoConfig } from "./config.ts";
import { checkSummary } from "./checks.ts";
import { collectSummary, proveCall, runTraffic, settle, type AttackResult, type SettleOutcome, type Summary, type TrafficResult } from "./scenario.ts";
import { dashboardPort, startStack, type Stack } from "./stack.ts";
import { banner, c, progressBar, renderSummary, section, short, usdc, waitEnter, waitEnterOr } from "./ui.ts";

const mode = process.argv[2] === "stage" ? "stage" : "run";
const out = (s = "") => process.stdout.write(s + "\n");
const say = (s: string) => out(`  ${c.dim(">")} ${s}`);

let stack: Stack | null = null;
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  if (stack) {
    out(c.dim("\n  stopping node, providers and anvil..."));
    await Promise.race([stack.stop(), new Promise((r) => setTimeout(r, 8_000))]);
  }
  process.exit(code);
}
let sigints = 0;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (++sigints > 1) process.exit(130); // the anvil watchdog still stops anvil within a second
    void shutdown(130);
  });
}

function printPlan(cfg: DemoConfig) {
  const p = cfg.plan;
  out(section("Plan"));
  out(`  ${cfg.calls} paid calls at concurrency ${cfg.concurrency}${mode === "stage" ? ", paced for the stage" : ""}`);
  out(`  Treasury Agent (SDK): ${p.treasuryMarket} quotes, ${p.treasuryRisk} risk scans, ${p.briefs} research briefs`);
  out(`  Research Writer (agent and provider): buys ${p.briefQuotes} quotes + ${p.briefScans} scan per brief = ${p.briefs * (p.briefQuotes + p.briefScans)} calls`);
  out(`  Trading Agent (MCP tools): ${p.tradingMarket} quotes (one is a poisoned feed), ${p.tradingRisk} risk scans`);
  out(`  attacks: prompt-injected payment to an unlisted wallet, and a call above the per-call cap`);
  const pr = cfg.prices;
  out(`  prices: Market Data ${usdc(pr.market)}, Risk Scan ${usdc(pr.risk)}, Research Writer ${usdc(pr.writer)}`);
  out(`  planned spend (upper bound): ${c.bold(usdc(cfg.spend.total))}  ${c.dim(`treasury ${formatAmount(cfg.spend.treasury)}, trading ${formatAmount(cfg.spend.trading)}, writer ${formatAmount(cfg.spend.writer)}`)}`);
  if (cfg.live) out(`  ${c.yellow(`LIVE NETWORK ${cfg.chainId}: spend cap ${usdc(cfg.maxSpend)} (DEMO_MAX_SPEND_USDC), confirmed by DEMO_LIVE_NETWORK_CONFIRM=yes`)}`);
}

function narrateAttack(a: AttackResult) {
  out(`\n  ${c.red("!")} ${a.agent} ${c.dim(`(${a.via})`)}: ${a.name}`);
  if (a.toolText) out(`    ${c.dim(`MCP tool error: ${a.toolText.slice(0, 150)}`)}`);
  out(`    layer 1, agent SDK before signing:   ${a.agentRule ? c.red(c.bold(`REFUSED ${a.agentRule}`)) : c.red(c.bold("SIGNED"))}`);
  const l2 = a.nodeRule
    ? c.red(c.bold(`DENIED  ${a.nodeRule}`))
    : a.compromisedLocalRule
      ? c.yellow(c.bold(`NOT REACHED - the compromised client refused locally with ${a.compromisedLocalRule}`))
      : c.red(c.bold(`ACCEPTED - this should never happen (${a.message})`));
  out(`    layer 2, clearing node (recorded):  ${l2}  ${a.ruleText ?? ""}`);
}

function trafficProgress() {
  const tty = process.stdout.isTTY;
  let last = -1;
  return (p: { done: number; total: number; ok: number; failed: number }) => {
    const line = `  ${progressBar(p.done, p.total)}  ${c.green(`${p.ok} paid`)}${p.failed ? c.red(`  ${p.failed} failed`) : ""}`;
    if (tty) process.stdout.write(`\r${line}`);
    else if (Math.floor((p.done / p.total) * 10) !== last) {
      last = Math.floor((p.done / p.total) * 10);
      out(line);
    }
  };
}

async function runMode(cfg: DemoConfig) {
  const t0 = Date.now();
  out(section("Boot"));
  stack = await startStack(cfg, { say });
  out(section(`Traffic: ${cfg.calls} paid calls`));
  const pending: AttackResult[] = [];
  const traffic = await runTraffic(stack, { onProgress: trafficProgress(), onAttack: (a) => pending.push(a) });
  out("");
  for (const a of pending) narrateAttack(a);
  out(section("Settle"));
  say("POST /v1/settlements: net every obligation into one settleBatch, debtors co-sign HSP mandates");
  const s = await settle(stack);
  if (s.skipped) throw new Error(`settlement skipped: ${s.skipped}`);
  const summary = await collectSummary(stack, traffic, s, t0);
  out(renderSummary(summary));
  return finish(summary, traffic);
}

function finish(summary: Summary, traffic: TrafficResult): number {
  const problems = checkSummary(summary, { expectedCalls: stack!.cfg.calls });
  if (traffic.failed.length) problems.push(`${traffic.failed.length} calls failed: ${JSON.stringify(traffic.failed.slice(0, 3))}`);
  out(section("Checks"));
  if (problems.length === 0) out(c.green("  all checks passed: denials with rules, transfers < calls, books at zero, proof verified on chain"));
  else for (const p of problems) out(c.red(`  FAIL ${p}`));
  out(c.dim(`  node log: ${stack!.logFile}`));
  return problems.length ? 1 : 0;
}

const batchList = z.array(z.object({ id: z.string(), status: z.string(), calls: z.number() }).loose());
const previewSchema = z.object({ calls: z.number(), claims: z.number(), transfers: z.number(), compression: z.number(), grossTotal: z.string(), netTotal: z.string(), gross: z.array(z.object({ from: z.string(), to: z.string(), amount: z.string(), calls: z.number() }).loose()), net: z.array(z.object({ from: z.string(), to: z.string(), amount: z.string() }).loose()) }).loose();

async function stageMode(cfg: DemoConfig) {
  const t0 = Date.now();
  out(section("Boot (before walking on stage)"));
  stack = await startStack(cfg, { say });
  const st = stack;
  const names = new Map<string, string>([
    [st.addresses.treasury.toLowerCase(), "Treasury Agent"],
    [st.addresses.trading.toLowerCase(), "Trading Agent"],
    [st.addresses.writer.toLowerCase(), "Research Writer"],
    [st.addresses.market.toLowerCase(), "Market Data"],
    [st.addresses.risk.toLowerCase(), "Risk Scan"],
  ]);
  const who = (a: string) => names.get(a.toLowerCase()) ?? short(a);
  out(section("Dashboard"));
  out(`  start it in another terminal:  ${c.bold(`NEXT_PUBLIC_NODE_URL=${st.nodeUrl} pnpm --filter dashboard dev`)}`);
  out(`  open http://localhost:${dashboardPort()}, sign in with the local admin token, stay on Overview (all zero)`);
  if (!cfg.live) {
    // Local anvil dev key only; live keys are never printed.
    out(section("Optional: let Claude spend from the Trading Agent mandate"));
    out(
      c.dim(
        `  claude mcp add payminto-trading -e NODE_URL=${st.nodeUrl} -e CHAIN_ID=31337 -e RPC_URL=${st.rpc.rpcUrl} -e HUB_ADDRESS=${st.hub} ` +
          `-e AGENT_KEY=${cfg.keys.trading} -e MANDATE_ID=${st.mandates.trading} -e RECEIPT_STORE_PATH=${st.receiptStores.trading} ` +
          `-- node ${REPO_ROOT}/apps/mcp/src/main.ts`,
      ),
    );
  }
  await waitEnter(c.cyan("\n  [Enter] step 1: the Treasury Agent mandate "));

  out(section("Step 1 - Mandate"));
  const p = st.policies.treasury;
  out(`  Treasury Agent ${st.addresses.treasury}`);
  out(`  mandate ${st.mandates.treasury}`);
  out(`  total cap ${c.bold(usdc(st.caps.treasury))}, per call ${c.bold(usdc(p.perCallCap))}, daily ${usdc(p.dailyCap)}, ${p.maxCallsPerMinute} calls/min`);
  out(`  allowed payees: Market Data, Risk Scan, Research Writer; expires in 12 h; open tx ${st.mandateTx.treasury ?? "-"}`);
  await waitEnter(c.cyan("\n  [Enter] step 2: run the agents "));

  out(section(`Step 2 - Agents buying (${cfg.calls} calls, paced)`));
  const pending: AttackResult[] = [];
  const progress = trafficProgress();
  const traffic = await runTraffic(st, {
    pacePerSec: Number(process.env.DEMO_STAGE_PACE ?? 14),
    onProgress: progress,
    onAttack: (a) => {
      out("");
      narrateAttack(a);
      pending.push(a);
    },
  });
  out("");
  await waitEnter(c.cyan("\n  [Enter] step 3: netting preview "));

  out(section("Step 3 - Netting"));
  const pv = await st.admin.get("/v1/netting/preview", previewSchema);
  out(`  ${pv.calls} calls, ${pv.claims} claims, gross ${usdc(pv.grossTotal)} across ${pv.gross.length} obligations`);
  for (const g of pv.gross) out(`    ${c.dim("owes")} ${who(g.from).padEnd(16)} -> ${who(g.to).padEnd(16)} ${usdc(g.amount).padStart(14)}  ${c.dim(`${g.calls} calls`)}`);
  out(`  nets to ${c.bold(String(pv.transfers))} transfers, ${usdc(pv.netTotal)}:`);
  for (const n of pv.net) out(`    ${c.green("pays")} ${who(n.from).padEnd(16)} -> ${who(n.to).padEnd(16)} ${usdc(n.amount).padStart(14)}`);
  out(`  compression ${c.bold(`${pv.compression.toFixed(1)} calls per transfer`)}`);

  out(section("Step 4 - Settle"));
  const confirmed = async () => (await st.admin.get("/v1/batches", batchList)).some((b) => b.status === "confirmed");
  const how = await waitEnterOr(c.cyan("  click Settle now in the dashboard, or press [Enter] to settle from here "), confirmed);
  let s: SettleOutcome;
  if (how === "enter") {
    s = await settle(st);
    if (s.skipped) {
      say(`settlement already running (${s.skipped}); waiting for it`);
      while (!(await confirmed())) await new Promise((r) => setTimeout(r, 500));
    }
  } else say("settled from the dashboard");
  const batches = (await st.admin.get("/v1/batches", batchList)).filter((b) => b.status === "confirmed");
  s = { batchIds: batches.map((b) => b.id as `0x${string}`), dropped: [], ms: 0 };
  const summary = await collectSummary(st, traffic, s, t0);
  out(`  ${summary.calls} calls -> ${c.bold(String(summary.transfersOnchain))} on-chain transfers, compression ${c.bold(c.green(summary.compression.toFixed(1)))}`);
  await waitEnter(c.cyan("\n  [Enter] step 5: batch detail and HSP "));

  out(section("Step 5 - Batch and HSP"));
  for (const b of summary.batches) out(`  batch ${short(b.id)} tx ${b.txHash}`);
  for (const h of summary.hsp) out(`    #${h.index} ${who(h.from).padEnd(16)} -> ${who(h.to).padEnd(16)} ${usdc(h.amount).padStart(14)}  HSP ${h.status === "ACCEPT" ? c.green(h.status) : c.yellow(h.status)}`);
  for (;;) {
    const answer = await waitEnter(c.cyan(`\n  step 6: judge picks a call number 1-${summary.calls} (type it, [Enter] for random, "q" to finish) `));
    if (answer.toLowerCase() === "q") break;
    const seq = answer ? Number(answer) : undefined;
    const pr = await proveCall(st, Number.isInteger(seq) ? seq : undefined);
    if (!pr) out(c.yellow("  that one lands in the next batch; pick another"));
    else out(`  call #${pr.seq} ${pr.callId}\n  batch ${pr.batchId}, ${pr.proofLength}-step Merkle path, verifyReceipt on chain: ${pr.verifiedOnchain ? c.green(c.bold("true")) : c.red("false")}`);
    if (!process.stdin.isTTY) break;
  }

  out(section("Step 7 - Books"));
  out(`  trial balance: ${summary.trialBalance.balanced ? c.green(`balanced, balance ${summary.trialBalance.balance}`) : c.red("UNBALANCED")}`);
  out(renderSummary(summary));
  const code = finish(summary, traffic);
  // Without a terminal (CI, scripted rehearsal) stage mode exits unless DEMO_STAGE_HOLD=1 keeps the stack up.
  if (process.env.DEMO_STAGE_EXIT === "1" || (!process.stdin.isTTY && process.env.DEMO_STAGE_HOLD !== "1")) return code;
  out(c.bold(`\n  Node and providers keep running for the dashboard (${st.nodeUrl}). Ctrl-C to stop everything.`));
  await new Promise(() => {});
  return code;
}

out(banner("Payminto Clearing", mode === "stage" ? "stage mode - press Enter to advance each step" : "agent-to-agent clearing on HashKey Chain"));
let cfg: DemoConfig;
try {
  cfg = loadDemoConfig(process.env);
} catch (err) {
  if (err instanceof DemoConfigError) {
    process.stderr.write(c.red(`\n${err.message}\n`));
    process.exit(2);
  }
  throw err;
}
printPlan(cfg);
try {
  const code = mode === "stage" ? await stageMode(cfg) : await runMode(cfg);
  await shutdown(code);
} catch (err) {
  process.stderr.write(c.red(`\n  demo failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`));
  const st = stack as Stack | null;
  if (st) process.stderr.write(c.dim(`  node log: ${st.logFile}\n`));
  await shutdown(1);
}
