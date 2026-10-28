import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  fallback,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
  type TransactionReceipt,
} from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { clearingHubAbi, networkFor } from "@payminto/protocol";

export type OnchainMandate = {
  owner: Address;
  agent: Address;
  token: Address;
  validAfter: bigint;
  validUntil: bigint;
  revokedAt: bigint;
  totalCap: bigint;
  spent: bigint;
  payeesRoot: Hex;
};

/** Serializes async work: operator transactions must not race on nonces. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class ChainClient {
  readonly chainId: number;
  readonly chain: Chain;
  readonly hub: Address;
  readonly token: Address;
  readonly operator: PrivateKeyAccount;
  readonly public: PublicClient<Transport, Chain>;
  readonly wallet: WalletClient<Transport, Chain, Account>;
  readonly txQueue = new SerialQueue();

  constructor(opts: { chainId: number; rpcUrl: string; rpcFallbackUrls?: readonly string[]; hub: Address; token: Address; operatorKey: Hex }) {
    const net = networkFor(opts.chainId);
    this.chainId = opts.chainId;
    this.chain = defineChain({ ...net.chain, rpcUrls: { default: { http: [opts.rpcUrl] } } });
    this.hub = getAddress(opts.hub);
    this.token = getAddress(opts.token);
    this.operator = privateKeyToAccount(opts.operatorKey, { nonceManager });
    const urls = [opts.rpcUrl, ...(opts.rpcFallbackUrls ?? []).filter((u) => u !== opts.rpcUrl)];
    const transports = urls.map((u) => http(u, { retryCount: urls.length > 1 ? 1 : 3, timeout: 20_000 }));
    // Fallback keeps RPC_URL first and moves to the next endpoint only when a request fails.
    const transport: Transport = transports.length > 1 ? fallback(transports) : transports[0]!;
    this.public = createPublicClient({ chain: this.chain, transport, pollingInterval: 250 });
    this.wallet = createWalletClient({ chain: this.chain, transport, account: this.operator });
  }

  async tokenMeta(): Promise<{ symbol: string; decimals: number }> {
    const net = networkFor(this.chainId);
    try {
      const [symbol, decimals] = await Promise.all([
        this.public.readContract({ address: this.token, abi: erc20Abi, functionName: "symbol" }),
        this.public.readContract({ address: this.token, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { symbol, decimals };
    } catch {
      return { symbol: net.token.symbol, decimals: net.token.decimals };
    }
  }

  async funds(address: Address, token = this.token): Promise<{ balance: bigint; allowance: bigint }> {
    const [balance, allowance] = await Promise.all([
      this.public.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      this.public.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, this.hub] }),
    ]);
    return { balance, allowance };
  }

  async mandate(id: Hex): Promise<OnchainMandate | null> {
    const r = await this.public.readContract({ address: this.hub, abi: clearingHubAbi, functionName: "mandates", args: [id] });
    const [owner, agent, token, validAfter, validUntil, revokedAt, totalCap, spent, payeesRoot] = r as readonly [
      Address,
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      Hex,
    ];
    if (owner === "0x0000000000000000000000000000000000000000") return null;
    return { owner, agent, token, validAfter, validUntil, revokedAt, totalCap, spent, payeesRoot };
  }

  async settledOf(id: Hex, payee: Address): Promise<bigint> {
    return (await this.public.readContract({
      address: this.hub,
      abi: clearingHubAbi,
      functionName: "settled",
      args: [id, payee],
    })) as bigint;
  }

  async settleDeadline(id: Hex): Promise<bigint> {
    return BigInt(
      (await this.public.readContract({ address: this.hub, abi: clearingHubAbi, functionName: "settleDeadline", args: [id] })) as
        | bigint
        | number,
    );
  }

  async onchainBatch(batchId: Hex): Promise<{ receiptsRoot: Hex; token: Address; settledAt: bigint; gross: bigint; net: bigint }> {
    const r = (await this.public.readContract({
      address: this.hub,
      abi: clearingHubAbi,
      functionName: "batches",
      args: [batchId],
    })) as readonly [Hex, Address, Address, bigint | number, bigint, bigint];
    return { receiptsRoot: r[0], token: r[1], settledAt: BigInt(r[3]), gross: r[4], net: r[5] };
  }

  async isContract(address: Address): Promise<boolean> {
    const code = await this.public.getCode({ address });
    return !!code && code !== "0x";
  }

  async waitForReceipt(hash: Hex, timeoutMs = 120_000): Promise<TransactionReceipt> {
    return this.public.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 250 });
  }
}
