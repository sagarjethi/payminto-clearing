import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApi, type NodeServices } from "./api.ts";
import { ChainClient } from "./chain.ts";
import { redactedConfig, type Config } from "./config.ts";
import { Database } from "./db/database.ts";
import { EventBus } from "./events.ts";
import { FundsTracker } from "./funds.ts";
import { CoordinatorHspAdapter } from "./hsp/coordinator.ts";
import { LocalHspAdapter } from "./hsp/local.ts";
import type { HspPort } from "./hsp/port.ts";
import { Ledger } from "./ledger.ts";
import { createLogger, type Logger } from "./logger.ts";
import { MandateService } from "./mandates.ts";
import { Metrics } from "./metrics.ts";
import { TokenBuckets } from "./ratelimit.ts";
import { pruneTable } from "./retention.ts";
import { SettlementService } from "./settlement.ts";
import { Store } from "./store.ts";
import { VoucherService } from "./vouchers.ts";

export type ClearingNode = {
  services: NodeServices;
  app: ReturnType<typeof createApi>;
  /** Base URL once listening. */
  url: string;
  port: number;
  stop(): Promise<void>;
};

export type CreateNodeOptions = {
  logger?: Logger;
  /** Override the HSP port (tests, or the official @hsp/sdk later). */
  hsp?: HspPort;
  /** Run background workers (auto-settle, funds refresh, revocation scan, HSP retry). Default true. */
  workers?: boolean;
  /** Listen on this port instead of config.port (0 = random). */
  port?: number;
};

/** Builds every service, checks the chain and database agree with the config, recovers interrupted batches, and listens. */
export async function startNode(config: Config, opts: CreateNodeOptions = {}): Promise<ClearingNode> {
  const log = opts.logger ?? createLogger({ level: config.logLevel, base: { service: "clearing-node" } });
  const chain = new ChainClient({
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    rpcFallbackUrls: config.rpcFallbackUrls,
    hub: config.hub,
    token: config.token,
    operatorKey: config.operatorKey,
  });

  const rpcChainId = await chain.public.getChainId();
  if (rpcChainId !== config.chainId) throw new Error(`RPC_URL serves chain ${rpcChainId}, expected CHAIN_ID ${config.chainId}`);
  if (!(await chain.isContract(config.hub))) throw new Error(`No contract at HUB_ADDRESS ${config.hub} on chain ${config.chainId}`);
  if (!(await chain.isContract(config.token))) throw new Error(`No contract at TOKEN_ADDRESS ${config.token} on chain ${config.chainId}`);

  const db = new Database(config.dbPath);
  let started = false;
  try {
    const applied = db.migrate();
    const store = new Store(db);
    // A database belongs to exactly one (chain, hub, token); mixing them would corrupt positions.
    for (const [key, value] of [
      ["chain_id", String(config.chainId)],
      ["hub", chain.hub],
      ["token", chain.token],
    ] as const) {
      const existing = store.getMeta(key);
      if (existing === undefined) store.setMeta(key, value);
      else if (existing.toLowerCase() !== value.toLowerCase()) {
        throw new Error(`Database ${config.dbPath} belongs to ${key}=${existing}, not ${value}. Use a different DB_PATH.`);
      }
    }

    const events = new EventBus(db);
    const ledger = new Ledger(db);
    const funds = new FundsTracker(store, chain, events, log.child({ component: "funds" }));
    const hsp: HspPort =
      opts.hsp ??
      (config.hsp.mode === "coordinator"
        ? new CoordinatorHspAdapter({
            url: config.hsp.coordinatorUrl!,
            apiKey: config.hsp.apiKey!,
            chainName: config.hsp.chainName!,
            verifyingContract: config.hsp.verifyingContract,
          })
        : new LocalHspAdapter({
            chainId: config.chainId,
            hub: config.hub,
            verifyingContract: config.hsp.verifyingContract,
            publicClient: chain.public,
            adapterAccount: chain.operator,
          }));
    const vouchers = new VoucherService({
      db,
      store,
      chain,
      ledger,
      events,
      funds,
      log: log.child({ component: "vouchers" }),
      denialDedupSec: config.denials.dedupWindowSec,
    });
    const mandates = new MandateService({ db, store, chain, events, log: log.child({ component: "mandates" }), fromBlock: config.deployBlock });
    const settlement = new SettlementService({
      db,
      store,
      chain,
      ledger,
      events,
      funds,
      hsp,
      log,
      cosignTimeoutSec: config.hsp.cosignTimeoutSec,
    });
    const token = { address: chain.token, ...(await chain.tokenMeta()) };
    const limiters = {
      provider: new TokenBuckets(config.rateLimit.provider),
      ip: new TokenBuckets(config.rateLimit.ip),
    };
    const services: NodeServices = {
      config,
      db,
      store,
      chain,
      ledger,
      events,
      vouchers,
      mandates,
      settlement,
      log,
      token,
      sseClosers: new Set(),
      metrics: new Metrics(),
      limiters,
    };
    const app = createApi(services);

    await settlement.recover();
    const prune = () => {
      const denials = pruneTable(db, "denials", config.denials.maxRows);
      const evts = pruneTable(db, "events", config.eventsMaxRows);
      limiters.provider.prune();
      limiters.ip.prune();
      if (denials || evts) log.info("pruned old rows", { denials, events: evts });
    };
    prune();

    const timers: NodeJS.Timeout[] = [];
    const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
      let busy = false;
      const t = setInterval(() => {
        if (busy) return;
        busy = true;
        fn()
          .catch((err) => log.warn(`${name} failed`, { err }))
          .finally(() => {
            busy = false;
          });
      }, ms);
      t.unref();
      timers.push(t);
    };
    if (opts.workers !== false) {
      every(config.fundsRefreshSec * 1000, "funds refresh", () => funds.sweep());
      every(15_000, "revocation scan", () => mandates.scanRevocations());
      every(15_000, "hsp retry", () => settlement.retryHsp());
      every(60_000, "retention", async () => prune());
      if (config.settleIntervalSec > 0) {
        every(config.settleIntervalSec * 1000, "auto-settle", async () => {
          if (store.unsettledCallCount() >= config.settleMinCalls) await settlement.settle("interval");
        });
      }
    }

    const server = await new Promise<Server>((resolve) => {
      const srv = serve({ fetch: app.fetch, port: opts.port ?? config.port, hostname: config.host }, () => resolve(srv as Server));
    });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}`;
    started = true;
    log.info("clearing node listening", {
      url,
      operator: chain.operator.address,
      migrationsApplied: applied,
      config: redactedConfig(config),
    });

    let stopping: Promise<void> | null = null;
    const stop = () =>
      (stopping ??= (async () => {
        log.info("shutting down");
        for (const t of timers) clearInterval(t);
        for (const close of services.sseClosers) close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          setTimeout(() => server.closeAllConnections?.(), 2_000).unref();
        });
        // Let an in-flight settlement finish booking what the chain already did.
        await Promise.race([settlement.idle(), new Promise((r) => setTimeout(r, 60_000).unref())]);
        db.close();
        log.info("stopped");
      })());

    return { services, app, url, port, stop };
  } finally {
    if (!started) db.close();
  }
}
