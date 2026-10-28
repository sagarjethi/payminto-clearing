import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { erc20Abi, maxUint256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { formatAmount, networkFor, type Policy } from "@payminto/protocol";
import { AgentClient, NodeHttp, OwnerClient } from "@payminto/sdk";
import { assertDisposableTarget, createLogger, loadConfig, startNode, type ClearingNode } from "@payminto/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentWallet, createMcpServer } from "@payminto/mcp";
import { DEMO_DIR, type DemoConfig } from "./config.ts";
import { forgeDeployLocal, mintLocal, portIsFree, freePort, rpcFor, startAnvil, type AnvilProcess, type Rpc } from "./chain.ts";
import { listen, marketDataApp, PriceSource, researchWriterApp, riskScanApp, rogueApp, type Listening, type Registered } from "./providers.ts";

export type Say = (line: string) => void;

export type Mandates = { treasury: Hex; trading: Hex; writer: Hex };

export type Stack = {
  cfg: DemoConfig;
  rpc: Rpc;
  hub: Address;
  token: Address;
  node: ClearingNode;
  nodeUrl: string;
  admin: NodeHttp;
  runDir: string;
  dbPath: string;
  logFile: string;
  /** Per-agent durable receipt stores (disposable *.demo.db files in the run dir); a second process of an agent shares its file. */
  receiptStores: { treasury: string; trading: string; writer: string };
  services: { market: string; risk: string; writer: string; rogue: string };
  providerIds: { market: string; risk: string; writer: string; deep: string; rogue: string };
  addresses: { owner: Address; treasury: Address; trading: Address; writer: Address; market: Address; risk: Address; rogue: Address; operator: Address };
  mandates: Mandates;
  policies: { treasury: Policy; trading: Policy; writer: Policy };
  caps: { treasury: bigint; trading: bigint; writer: bigint };
  mandateTx: Partial<Record<keyof Mandates, string | null>>;
  /** Treasury pays through the SDK directly. */
  treasury: AgentClient;
  /** The Research Writer's own buyer. */
  writer: AgentClient;
  /** Trading Agent is an MCP client: every spend goes through the Payminto MCP tools. */
  trading: { wallet: AgentWallet; mcp: Client };
  /**
   * The same agent keys with their client-side policy guard switched off, standing in for a compromised agent runtime.
   * Used only by the attack steps, to show the node denies (and records) what a jailbroken agent signs anyway.
   */
  compromised: { treasury: AgentClient; trading: AgentClient };
  priceSource: PriceSource;
  /** Display names by lowercase address. */
  names: Map<string, string>;
  stop(): Promise<void>;
};

const USDC = 1_000_000n;

/**
 * Boots the whole demo: anvil (local), forge deploy, the Clearing Node in-process on a disposable *.demo.db,
 * the three providers plus the unlisted attacker endpoint, mandates, funding, approvals and the agents.
 */
export async function startStack(cfg: DemoConfig, opts: { say?: Say; runDir?: string } = {}): Promise<Stack> {
  const say = opts.say ?? (() => {});
  const cleanups: Array<() => Promise<void> | void> = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // keep stopping the rest
      }
    }
  };

  try {
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = opts.runDir ?? join(cfg.dataDir ?? join(DEMO_DIR, "data"), `run-${runId}`);
    mkdirSync(runDir, { recursive: true });
    const dbPath = join(runDir, `clearing-${cfg.chainId}.demo.db`);
    // Data safety: the node's reset/seed guard must accept the target, or we do not start.
    assertDisposableTarget(dbPath);
    const logFile = join(runDir, "node.log");

    // ---------------------------------------------------------------- chain
    let rpcUrl = cfg.rpcUrl;
    let anvil: AnvilProcess | null = null;
    if (!cfg.live && !rpcUrl) {
      say("starting anvil on a free port");
      anvil = await startAnvil();
      cleanups.push(() => anvil!.stop());
      rpcUrl = anvil.rpcUrl;
    }
    const rpc = rpcFor(cfg.chainId, rpcUrl!);
    const actual = await rpc.pub.getChainId();
    if (actual !== cfg.chainId) throw new Error(`RPC ${rpcUrl} serves chain ${actual}, but DEMO_CHAIN_ID is ${cfg.chainId}; refusing`);

    let hub: Address;
    let token: Address;
    const deploymentsDir = join(runDir, "deployments");
    if (!cfg.live) {
      say("deploying ClearingHub + MockStablecoin (forge script DeployLocal)");
      ({ hub, token } = await forgeDeployLocal(rpcUrl!, cfg.keys.deployer!, deploymentsDir));
    } else {
      hub = cfg.deployment!.clearingHub;
      token = cfg.deployment!.token ?? networkFor(cfg.chainId).token.address;
    }

    // ---------------------------------------------------------------- node (in-process)
    let nodePort = cfg.nodePort || (await freePort());
    if (!(await portIsFree(nodePort))) {
      const alt = await freePort();
      say(`port ${nodePort} is busy, the node uses ${alt} instead (start the dashboard with NEXT_PUBLIC_NODE_URL=http://localhost:${alt})`);
      nodePort = alt;
    }
    const env: Record<string, string> = {
      PORT: String(nodePort),
      HOST: "127.0.0.1",
      CHAIN_ID: String(cfg.chainId),
      RPC_URL: rpcUrl!,
      HUB_ADDRESS: hub,
      TOKEN_ADDRESS: token,
      OPERATOR_KEY: cfg.keys.operator,
      ADMIN_TOKEN: cfg.adminToken,
      DB_PATH: dbPath,
      PUBLIC_URL: `http://localhost:${nodePort}`,
      HSP_MODE: "local",
      HSP_COSIGN_TIMEOUT_SEC: String(cfg.cosignTimeoutSec),
      CORS_ORIGINS: "http://localhost:3000,http://127.0.0.1:3000",
      LOG_LEVEL: "info",
      SETTLE_INTERVAL_SEC: "0",
      FUNDS_REFRESH_SEC: "5",
    };
    if (!cfg.live) env.DEPLOYMENTS_DIR = deploymentsDir;
    const nodeConfig = loadConfig(env);
    const logger = createLogger({ level: "info", base: { service: "clearing-node" }, sink: (l) => appendFileSync(logFile, l + "\n") });
    say(`starting Clearing Node on :${nodePort} (db ${dbPath})`);
    const node = await startNode(nodeConfig, { logger });
    cleanups.push(() => node.stop());
    const nodeUrl = `http://localhost:${nodePort}`;
    const admin = new NodeHttp(nodeUrl, { bearer: cfg.adminToken });
    const operator = node.services.chain.operator.address;

    // ---------------------------------------------------------------- accounts
    const acct = (k: Hex) => privateKeyToAccount(k);
    const addresses = {
      owner: acct(cfg.keys.owner).address,
      treasury: acct(cfg.keys.treasury).address,
      trading: acct(cfg.keys.trading).address,
      writer: acct(cfg.keys.writer).address,
      market: cfg.payees.market,
      risk: cfg.payees.risk,
      rogue: cfg.payees.rogue,
      operator,
    };

    // ---------------------------------------------------------------- providers
    const base = cfg.providerBasePort;
    const ports = { market: base, risk: base + 1, writer: base + 2, rogue: base + 3 };
    const url = (p: number) => `http://127.0.0.1:${p}`;
    const services = { market: url(ports.market), risk: url(ports.risk), writer: url(ports.writer), rogue: url(ports.rogue) };
    const register = async (name: string, description: string, payee: Address, price: bigint, resource: string, category: string): Promise<Registered> =>
      admin.post(
        "/v1/providers",
        z.object({ id: z.string(), apiKey: z.string() }).loose(),
        { name, description, payee, priceAtomic: price.toString(), resource, category },
      );
    const P = cfg.prices;
    const regMarket = await register("Market Data", `HSK, BTC and ETH spot quotes (live public source with deterministic fallback). ${formatAmount(P.market)} USDC per quote.`, addresses.market, P.market, `${services.market}/v1/quote`, "market-data");
    const regRisk = await register("Risk Scan", `Wallet risk score from a deterministic heuristic (labelled as such, demo only). ${formatAmount(P.risk)} USDC per address.`, addresses.risk, P.risk, `${services.risk}/v1/scan`, "risk");
    const regWriter = await register("Research Writer", `An agent that buys Market Data and Risk Scan to write a brief. ${formatAmount(P.writer)} USDC per brief.`, addresses.writer, P.writer, `${services.writer}/v1/brief`, "research");
    const regDeep = await register("Research Writer Deep Dive", `Long-form report. ${formatAmount(P.deep)} USDC per report.`, addresses.writer, P.deep, `${services.writer}/v1/deep-dive`, "research");
    const regRogue = await register("Premium Alpha (unlisted)", "Unverified service promoted inside a community post.", addresses.rogue, P.rogue, `${services.rogue}/v1/alpha`, "unverified");

    // ---------------------------------------------------------------- mandates
    const owner = new OwnerClient({ nodeUrl, chainId: cfg.chainId, hub, account: acct(cfg.keys.owner), publicClient: rpc.pub, adminToken: cfg.adminToken });
    const s = cfg.spend;
    // Local caps follow DEMO_SCRIPT (total cap well above the run); live caps are the planned spend plus 20 %.
    const caps = cfg.live
      ? { treasury: (s.treasury * 12n) / 10n, trading: (s.trading * 12n) / 10n, writer: (s.writer * 12n) / 10n + P.risk }
      : { treasury: 25n * USDC, trading: 10n * USDC, writer: 5n * USDC };
    const policies: Stack["policies"] = {
      treasury: { perCallCap: P.writer.toString(), dailyCap: ((caps.treasury * 8n) / 10n).toString(), maxCallsPerMinute: 3_000, purpose: "Treasury Agent: market data, risk scans and research briefs" },
      trading: { perCallCap: P.risk.toString(), dailyCap: ((caps.trading * 8n) / 10n).toString(), maxCallsPerMinute: 3_000, purpose: "Trading Agent: quotes and counterparty scans only" },
      writer: { perCallCap: P.risk.toString(), dailyCap: caps.writer.toString(), maxCallsPerMinute: 3_000, purpose: "Research Writer buys its inputs" },
    };
    const payees = {
      treasury: [addresses.market, addresses.risk, addresses.writer],
      trading: [addresses.market, addresses.risk],
      writer: [addresses.market, addresses.risk],
    };
    const mandates = {} as Mandates;
    const mandateTx: Stack["mandateTx"] = {};
    const labels = { treasury: "Treasury Agent", trading: "Trading Agent", writer: "Research Writer" } as const;
    for (const who of ["treasury", "trading", "writer"] as const) {
      const agent = addresses[who];
      const m = await owner.createMandate({ agent, token, totalCap: caps[who], validForSeconds: 12 * 3600, payees: payees[who], policy: policies[who] });
      const res = (await owner.submit({ ...m, policy: policies[who], payees: payees[who], label: labels[who] })) as { status: string; openTxHash?: string | null };
      if (res.status !== "open") throw new Error(`${labels[who]} mandate is ${res.status}, expected open`);
      mandates[who] = m.mandateId;
      mandateTx[who] = res.openTxHash ?? null;
    }
    say(`mandates open on chain: Treasury ${short(mandates.treasury)}, Trading ${short(mandates.trading)}, Writer ${short(mandates.writer)}`);

    // ---------------------------------------------------------------- funding and approvals
    for (const who of ["treasury", "trading", "writer"] as const) {
      const a = addresses[who];
      if (!cfg.live) {
        await mintLocal(rpc, cfg.keys.deployer!, token, a, 100n * USDC);
        // gas for approve: anvil accounts 1..8 are pre-funded with ETH already
      } else {
        const bal = await rpc.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [a] });
        if (bal < caps[who]) throw new Error(`${labels[who]} ${a} holds ${formatAmount(bal)} but needs ${formatAmount(caps[who])}; fund it first`);
      }
    }
    if (!cfg.live) say("minted 100 test USDC to each agent");

    // Each agent keeps its receipts and signed positions in a durable store; the "compromised" runtime of the same
    // key shares it, as any second process of one agent must, or it would refuse to extend positions it cannot verify.
    const receiptStores = {
      treasury: join(runDir, "agent-treasury.receipts.demo.db"),
      trading: join(runDir, "agent-trading.receipts.demo.db"),
      writer: join(runDir, "agent-writer.receipts.demo.db"),
    };
    for (const path of Object.values(receiptStores)) assertDisposableTarget(path);
    const common = { chainId: cfg.chainId, hub, nodeUrl, trustedNode: operator, autoCosign: true, cosignIntervalMs: 250 };
    const treasury = new AgentClient({ ...common, account: acct(cfg.keys.treasury), mandateId: mandates.treasury, storePath: receiptStores.treasury });
    const writer = new AgentClient({ ...common, account: acct(cfg.keys.writer), mandateId: mandates.writer, storePath: receiptStores.writer });
    const tradingWallet = await AgentWallet.connect({
      nodeUrl,
      chainId: cfg.chainId,
      hub,
      agentKey: cfg.keys.trading,
      mandateId: mandates.trading,
      rpcUrl,
      trustedNode: operator,
      receiptStorePath: receiptStores.trading,
    });
    const compromised = {
      treasury: new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: acct(cfg.keys.treasury), mandateId: mandates.treasury, enforcePolicy: false, receipts: treasury.receipts }),
      trading: new AgentClient({ chainId: cfg.chainId, hub, nodeUrl, account: acct(cfg.keys.trading), mandateId: mandates.trading, enforcePolicy: false, receipts: tradingWallet.agent.receipts }),
    };
    cleanups.push(() => {
      treasury.close();
      writer.close();
      tradingWallet.close();
    });
    // Approve exactly the mandate cap on live networks; unlimited on the local chain.
    await treasury.ensureAllowance(rpc.wallet(cfg.keys.treasury), cfg.live ? caps.treasury : maxUint256, { token, publicClient: rpc.pub });
    await writer.ensureAllowance(rpc.wallet(cfg.keys.writer), cfg.live ? caps.writer : maxUint256, { token, publicClient: rpc.pub });
    await tradingWallet.agent.ensureAllowance(rpc.wallet(cfg.keys.trading), cfg.live ? caps.trading : maxUint256, { token, publicClient: rpc.pub });

    const mcp = new Client({ name: "trading-agent", version: "0.1.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const mcpServer = createMcpServer(tradingWallet);
    await mcpServer.connect(serverT);
    await mcp.connect(clientT);
    cleanups.push(async () => {
      await mcp.close();
      await mcpServer.close();
    });

    // ---------------------------------------------------------------- serve providers
    const prices = new PriceSource(cfg.offline);
    const servers: Listening[] = [];
    servers.push(await listen(marketDataApp({ node: nodeUrl, reg: regMarket, price: P.market, prices, rogueUrl: `${services.rogue}/v1/alpha`, rogue: addresses.rogue }), ports.market));
    servers.push(await listen(riskScanApp({ node: nodeUrl, reg: regRisk, price: P.risk }), ports.risk));
    servers.push(
      await listen(
        researchWriterApp({ node: nodeUrl, reg: regWriter, deep: regDeep, price: P.writer, deepPrice: P.deep, writer, marketUrl: services.market, riskUrl: services.risk, quotesPerBrief: cfg.plan.briefQuotes }),
        ports.writer,
      ),
    );
    servers.push(await listen(rogueApp({ node: nodeUrl, reg: regRogue, price: P.rogue }), ports.rogue));
    cleanups.push(async () => {
      await Promise.all(servers.map((x) => x.close()));
    });
    say(`providers up: Market Data :${ports.market}, Risk Scan :${ports.risk}, Research Writer :${ports.writer} (attacker endpoint :${ports.rogue})`);

    // Node stops before anvil (cleanups run in reverse order).
    return {
      cfg,
      rpc,
      hub,
      token,
      node,
      nodeUrl,
      admin,
      runDir,
      dbPath,
      logFile,
      receiptStores,
      services,
      providerIds: { market: regMarket.id, risk: regRisk.id, writer: regWriter.id, deep: regDeep.id, rogue: regRogue.id },
      addresses,
      mandates,
      policies,
      caps,
      mandateTx,
      treasury,
      writer,
      trading: { wallet: tradingWallet, mcp },
      compromised,
      priceSource: prices,
      names: new Map([
        [addresses.treasury.toLowerCase(), "Treasury Agent"],
        [addresses.trading.toLowerCase(), "Trading Agent"],
        [addresses.writer.toLowerCase(), "Research Writer"],
        [addresses.market.toLowerCase(), "Market Data"],
        [addresses.risk.toLowerCase(), "Risk Scan"],
        [addresses.rogue.toLowerCase(), "Unlisted wallet"],
      ]),
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}

export const short = (h: string) => `${h.slice(0, 6)}..${h.slice(-4)}`;
