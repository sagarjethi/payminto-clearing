import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpServer } from "./server.ts";
import type { AgentWallet } from "./wallet.ts";

export type McpHttp = { url: string; port: number; close(): Promise<void> };

/**
 * Streamable HTTP transport at POST /mcp, stateless: each request gets a fresh MCP server bound to the one shared
 * wallet, so positions, receipts and the co-sign loop are shared across requests.
 * Binds to loopback by default with DNS-rebinding protection, because the wallet can spend.
 */
export async function startMcpHttp(wallet: AgentWallet, opts: { port: number; host: string }): Promise<McpHttp> {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, agent: wallet.address, mandateId: wallet.mandateId }));
  const loopback = opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1";
  let port = opts.port;
  const allowed = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null }, 405);
    }
    // DNS-rebinding guard: a browser page on another origin must not drive a wallet that can spend.
    if (loopback && !allowed().includes(c.req.header("host") ?? "")) {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host" }, id: null }, 403);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(loopback
        ? { enableDnsRebindingProtection: true, allowedHosts: allowed() }
        : {}),
    });
    const server = createMcpServer(wallet);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => resolve(s as Server));
  });
  port = (srv.address() as AddressInfo).port;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      }),
  };
}
