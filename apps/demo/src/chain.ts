import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { localAnvil, mockStablecoinAbi, networkFor } from "@payminto/protocol";
import { REPO_ROOT } from "./config.ts";

const run = promisify(execFile);

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export function portIsFree(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

export type Rpc = {
  rpcUrl: string;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  wallet(key: Hex): WalletClient<Transport, Chain, Account>;
};

export function rpcFor(chainId: number, rpcUrl: string): Rpc {
  const base = chainId === 31337 ? localAnvil : networkFor(chainId).chain;
  const chain = defineChain({ ...base, rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl, { retryCount: 3, timeout: 20_000 });
  const pub = createPublicClient({ chain, transport, pollingInterval: chainId === 31337 ? 100 : 1_000 });
  return { rpcUrl, chain, pub, wallet: (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport }) };
}

export type AnvilProcess = { rpcUrl: string; port: number; stop(): Promise<void> };

/**
 * Starts a fresh anvil on a free port under a shell watchdog: if this process dies for any reason
 * (even SIGKILL), the watchdog notices within a second and stops anvil, so no orphan survives.
 */
export async function startAnvil(opts: { port?: number; blockTime?: number } = {}): Promise<AnvilProcess> {
  const port = opts.port ?? (await freePort());
  const args = ["--port", String(port), "--silent", ...(opts.blockTime ? ["--block-time", String(opts.blockTime)] : [])];
  const script = `anvil ${args.join(" ")} & A=$!; trap 'kill $A 2>/dev/null' EXIT INT TERM; while kill -0 ${process.pid} 2>/dev/null && kill -0 $A 2>/dev/null; do sleep 1; done`;
  const proc: ChildProcess = spawn("sh", ["-c", script], { stdio: "ignore" });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  /** Resolves once the watchdog (and with it anvil) has exited, at most ~3 s. */
  const stop = async () => {
    if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000).unref())]);
  };
  const pub = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  for (let i = 0; ; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      if (proc.exitCode !== null || i > 150) {
        await stop();
        throw new Error(`anvil did not start on port ${port} (is foundry installed? try: anvil --version)`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { rpcUrl, port, stop };
}

const DeploymentFile = join(REPO_ROOT, "contracts", "deployments", "31337.json");

/**
 * Deploys ClearingHub and MockStablecoin with `forge script script/DeployLocal.s.sol` (anvil only).
 * The script writes the shared contracts/deployments/31337.json; other local sessions may rely on it,
 * so its previous content is restored and the fresh deployment is copied into this run's own directory.
 */
export async function forgeDeployLocal(rpcUrl: string, deployerKey: Hex, runDeploymentsDir: string): Promise<{ hub: Address; token: Address; blockNumber: number }> {
  const before = existsSync(DeploymentFile) ? readFileSync(DeploymentFile, "utf8") : null;
  let fresh: string;
  try {
    await run("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--private-key", deployerKey], {
      cwd: join(REPO_ROOT, "contracts"),
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" },
    });
    fresh = readFileSync(DeploymentFile, "utf8");
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`forge DeployLocal failed: ${(e.stderr ?? e.message).split("\n").slice(-6).join("\n")}`);
  } finally {
    if (before !== null) writeFileSync(DeploymentFile, before);
    else rmSync(DeploymentFile, { force: true });
  }
  mkdirSync(runDeploymentsDir, { recursive: true });
  writeFileSync(join(runDeploymentsDir, "31337.json"), fresh);
  const d = JSON.parse(fresh) as { clearingHub: string; token: string; blockNumber: number };
  return { hub: getAddress(d.clearingHub), token: getAddress(d.token), blockNumber: d.blockNumber };
}

export async function mintLocal(rpc: Rpc, minterKey: Hex, token: Address, to: Address, amount: bigint): Promise<void> {
  const hash = await rpc.wallet(minterKey).writeContract({ address: token, abi: mockStablecoinAbi, functionName: "mint", args: [to, amount] });
  const r = await rpc.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`mint reverted in ${hash}`);
}
