import { defineChain, type Address, type Chain } from "viem";

export type TokenInfo = {
  address: Address;
  symbol: string;
  decimals: number;
  /** EIP-712 domain of the token itself, needed for EIP-2612 permit and EIP-3009. */
  eip712: { name: string; version: string };
};

export type NetworkConfig = {
  chain: Chain;
  /** CAIP-2 id used in x402 payment requirements. */
  caip2: `eip155:${number}`;
  explorer: string;
  /** Default settlement stablecoin. */
  token: TokenInfo;
  /** Deployed ClearingHub, when known at build time. Nodes may override via config. */
  clearingHub?: Address;
};

export const hashkeyMainnet: Chain = defineChain({
  id: 177,
  name: "HashKey Chain",
  nativeCurrency: { name: "HashKey Platform Token", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://hsk.blockscout.com" } },
});

export const hashkeyTestnet: Chain = defineChain({
  id: 133,
  name: "HashKey Chain Testnet",
  nativeCurrency: { name: "HashKey Platform Token", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://testnet-explorer.hsk.xyz" } },
  testnet: true,
});

export const localAnvil: Chain = defineChain({
  id: 31337,
  name: "Local (anvil)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

export const networks: Record<number, NetworkConfig> = {
  177: {
    chain: hashkeyMainnet,
    caip2: "eip155:177",
    explorer: "https://hsk.blockscout.com",
    // Verified live: supports EIP-2612 and EIP-3009; domain name is "Bridged USDC".
    token: {
      address: "0x054ed45810DbBAb8B27668922D110669c9D88D0a",
      symbol: "USDC.e",
      decimals: 6,
      eip712: { name: "Bridged USDC", version: "2" },
    },
  },
  133: {
    chain: hashkeyTestnet,
    caip2: "eip155:133",
    explorer: "https://testnet-explorer.hsk.xyz",
    token: {
      address: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USD Coin", version: "2" },
    },
  },
  31337: {
    chain: localAnvil,
    caip2: "eip155:31337",
    explorer: "",
    // Address is filled from contracts/deployments/31337.json at runtime.
    token: {
      address: "0x0000000000000000000000000000000000000000",
      symbol: "USDC",
      decimals: 6,
      eip712: { name: "USD Coin", version: "1" },
    },
  },
};

export function networkFor(chainId: number): NetworkConfig {
  const n = networks[chainId];
  if (!n) throw new Error(`Unsupported chain ${chainId}. Supported: ${Object.keys(networks).join(", ")}`);
  return n;
}

export function explorerTx(chainId: number, hash: string): string | null {
  const base = networks[chainId]?.explorer;
  return base ? `${base}/tx/${hash}` : null;
}

export function explorerAddress(chainId: number, address: string): string | null {
  const base = networks[chainId]?.explorer;
  return base ? `${base}/address/${address}` : null;
}
