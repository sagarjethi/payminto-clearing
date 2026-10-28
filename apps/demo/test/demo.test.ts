/**
 * The full demo scenario, compressed: own anvil, forge deploy, in-process node on a temp *.demo.db, the three providers
 * plus the attacker endpoint on random ports, three agents (SDK, MCP, agent-as-provider), both attacks, settle, proof.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { portIsFree } from "../src/chain.ts";
import { REPO_ROOT } from "../src/config.ts";
import { checkSummary } from "../src/checks.ts";
import { privateKeyToAccount } from "viem/accounts";
import { AgentClient, SqliteReceiptStore } from "@payminto/sdk";
import { loadDemoConfig } from "../src/config.ts";
import { collectSummary, runTraffic, settle, type Summary } from "../src/scenario.ts";
import { startStack, type Stack } from "../src/stack.ts";

async function freeBlock(): Promise<number> {
  for (;;) {
    const base = 20_000 + Math.floor(Math.random() * 30_000);
    const ok = await Promise.all([0, 1, 2, 3].map((i) => portIsFree(base + i, "127.0.0.1")));
    if (ok.every(Boolean)) return base;
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "payminto-demo-"));
let stack: Stack;
let summary: Summary;
let trafficFailed: unknown[];

beforeAll(async () => {
  const cfg = loadDemoConfig({
    DEMO_CALLS: "60",
    DEMO_CONCURRENCY: "8",
    DEMO_NODE_PORT: "0",
    DEMO_PROVIDER_BASE_PORT: String(await freeBlock()),
    DEMO_OFFLINE: "1",
    DEMO_DATA_DIR: dataDir,
    DEMO_HSP_COSIGN_TIMEOUT_SEC: "10",
  });
  const t0 = Date.now();
  stack = await startStack(cfg);
  const traffic = await runTraffic(stack);
  trafficFailed = traffic.failed;
  const s = await settle(stack);
  summary = await collectSummary(stack, traffic, s, t0);
});

afterAll(async () => {
  await stack?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("pnpm demo scenario (compressed)", () => {
  it("passes every demo check", () => {
    expect(trafficFailed).toEqual([]);
    expect(checkSummary(summary, { expectedCalls: 60 })).toEqual([]);
  });

  it("clears every call in one netted batch with fewer transfers than calls", () => {
    expect(summary.calls).toBe(60);
    expect(summary.batches).toHaveLength(1);
    expect(summary.batches[0]).toMatchObject({ status: "confirmed", reconciled: true, calls: 60 });
    expect(summary.transfersOnchain).toBeGreaterThan(0);
    expect(summary.transfersOnchain).toBeLessThan(summary.calls);
    expect(summary.compression).toBeCloseTo(60 / summary.transfersOnchain);
    expect(summary.net).toBeLessThanOrEqual(summary.gross);
    expect(summary.gas.used).toBeGreaterThan(0n);
    expect(summary.gas.used).toBeLessThan(summary.gas.naive);
  });

  it("gross equals the planned mix at SPEC prices", () => {
    const p = stack.cfg.plan;
    const pr = stack.cfg.prices;
    const quotes = BigInt(p.treasuryMarket + p.tradingMarket + p.briefs * p.briefQuotes);
    const scans = BigInt(p.treasuryRisk + p.tradingRisk + p.briefs * p.briefScans);
    expect(summary.gross).toBe(quotes * pr.market + scans * pr.risk + BigInt(p.briefs) * pr.writer);
  });

  it("denies both attacks twice: in the agent before signing, and at the node with the rule recorded", () => {
    expect(summary.denials.map((d) => d.rule).sort()).toEqual(["PAYEE_NOT_ALLOWED", "PER_CALL_CAP"]);
    expect(summary.denials.find((d) => d.rule === "PAYEE_NOT_ALLOWED")?.ruleText).toBe("Payee is not on the mandate allowlist");
    const injection = summary.attacks.find((a) => a.via === "mcp")!;
    expect(injection).toMatchObject({ agent: "Trading Agent", agentRule: "PAYEE_NOT_ALLOWED", nodeRule: "PAYEE_NOT_ALLOWED", compromisedLocalRule: null });
    expect(injection.toolText).toMatch(/^Payment denied by mandate rule PAYEE_NOT_ALLOWED/);
    expect(summary.attacks.find((a) => a.via === "sdk")).toMatchObject({ agent: "Treasury Agent", agentRule: "PER_CALL_CAP", nodeRule: "PER_CALL_CAP", compromisedLocalRule: null });
  });

  // Regression for "FAIL no PER_CALL_CAP denial recorded" / "ACCEPTED - this should never happen": a second runtime of the
  // Treasury key that does not share its receipt store refuses locally (POSITION_UNVERIFIED, the Writer payee already has
  // a position), never reaches the node, and must be reported as such rather than as accepted.
  it("reports a compromised runtime that refused locally as untested, never as accepted", async () => {
    const isolated = new AgentClient({
      chainId: stack.cfg.chainId,
      hub: stack.hub,
      nodeUrl: stack.nodeUrl,
      account: privateKeyToAccount(stack.cfg.keys.treasury),
      mandateId: stack.mandates.treasury,
      enforcePolicy: false,
    });
    const res = await isolated.fetch(`${stack.services.writer}/v1/deep-dive`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string; details: { enforcedBy: string } } }).error).toMatchObject({
      code: "POSITION_UNVERIFIED",
      details: { enforcedBy: "agent" },
    });
    const overCap = summary.attacks.find((a) => a.via === "sdk")!;
    const problems = checkSummary({ ...summary, attacks: summary.attacks.map((a) => (a === overCap ? { ...a, nodeRule: null, compromisedLocalRule: "POSITION_UNVERIFIED" } : a)) }, { expectedCalls: 60 });
    expect(problems).toEqual(["over the per-call cap: the compromised client refused locally with POSITION_UNVERIFIED, so the node was never tested"]);
  });

  it("wraps every net transfer as an accepted, co-signed HSP payment", () => {
    expect(summary.hsp).toHaveLength(summary.transfersOnchain);
    for (const h of summary.hsp) expect(h).toMatchObject({ status: "ACCEPT", cosigned: true });
  });

  it("keeps the books at zero, the hub empty, and proves a call on chain", () => {
    expect(summary.trialBalance).toMatchObject({ balanced: true, balance: "0" });
    expect(summary.hubBalance).toBe(0n);
    expect(summary.proof?.verifiedOnchain).toBe(true);
    expect(summary.mcpProof?.verified).toBe(true);
    expect(summary.marketDataSource).toMatch(/deterministic fallback/);
  });

  it("onboards the Research Writer with an EIP-2612 permit: the agent sends no transaction at all", async () => {
    expect(summary.gasless).toMatchObject({ label: "Research Writer", transactions: 0 });
    expect(await stack.rpc.pub.getTransactionCount({ address: stack.addresses.writer })).toBe(stack.gasless.txBefore);
  });

  it("uses a disposable database", () => {
    expect(stack.dbPath).toMatch(/\.demo\.db$/);
    expect(stack.dbPath.startsWith(dataDir)).toBe(true);
  });

  it("keeps every agent's receipts and signed positions in a durable, disposable store", () => {
    for (const path of Object.values(stack.receiptStores)) {
      expect(path).toMatch(/\.receipts\.demo\.db$/);
      expect(path.startsWith(dataDir)).toBe(true);
    }
    expect(stack.treasury.receipts.all().length).toBeGreaterThan(0);
    const reopened = new SqliteReceiptStore(stack.receiptStores.treasury);
    try {
      expect(reopened.all().length).toBe(stack.treasury.receipts.all().length);
      const signed = [...reopened.signedPositions(stack.mandates.treasury).values()];
      expect(signed.length).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  });
});

describe("MCP server over stdio (the Claude Desktop / Claude Code path)", () => {
  it("boots from env, reads the budget and proves a settled call", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO_ROOT, "apps", "mcp", "src", "main.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        NODE_URL: stack.nodeUrl,
        CHAIN_ID: "31337",
        RPC_URL: stack.rpc.rpcUrl,
        HUB_ADDRESS: stack.hub,
        AGENT_KEY: stack.cfg.keys.trading,
        MANDATE_ID: stack.mandates.trading,
        // A second process of the Trading Agent: it shares the in-process wallet's receipt store.
        RECEIPT_STORE_PATH: stack.receiptStores.trading,
      },
      stderr: "ignore",
    });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    try {
      const budget = (await client.callTool({ name: "get_budget", arguments: {} })) as { content: Array<{ text: string }> };
      expect(budget.content[0]!.text).toMatch(/^Mandate 0x[0-9a-f]{64}\. Spent \d+\.\d+ USDC\. Remaining /);
      const proof = (await client.callTool({ name: "prove_receipt", arguments: { callId: summary.proof!.callId } })) as { content: Array<{ text: string }> };
      expect(proof.content[0]!.text).toMatch(/Proven on chain \(settled by the clearing node, node-signed, verifyReceipt\): true/);
    } finally {
      await client.close();
    }
  });
});
