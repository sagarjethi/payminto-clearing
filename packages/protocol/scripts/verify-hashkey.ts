// Re-checks the HashKey Chain registry against the live chains (read-only RPC calls, no keys).
// Usage: pnpm --filter @payminto/protocol verify:hashkey
import { createPublicClient, encodeAbiParameters, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { hashkeyContracts, hashkeyMainnet, hashkeyTestnet, networks } from "../src/index.ts";

const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

function flatten(prefix: string, value: unknown, out: [string, Address][]) {
  if (typeof value === "string") out.push([prefix, value as Address]);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, v, out);
}

for (const chain of [hashkeyMainnet, hashkeyTestnet]) {
  const id = chain.id as 177 | 133;
  const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
  console.log(`\n${chain.name} (${id})`);
  check((await client.getChainId()) === id, `chain id ${id}`);

  const entries: [string, Address][] = [];
  flatten("", hashkeyContracts[id], entries);
  for (const [label, address] of entries) {
    const code = await client.getCode({ address });
    check(!!code && code !== "0x", `${label} has code at ${address}`);
  }

  // The settlement token's EIP-712 domain must match what chains.ts declares, or permits and EIP-3009 signatures fail.
  const token = networks[id]!.token;
  const [decimals, separator] = await Promise.all([
    client.readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token.address, abi: erc20Abi, functionName: "DOMAIN_SEPARATOR" }),
  ]);
  check(decimals === token.decimals, `${token.symbol} decimals ${token.decimals}`);
  const expected = domainSeparator(token.eip712.name, token.eip712.version, id, token.address);
  check(separator === expected, `${token.symbol} EIP-712 domain is ("${token.eip712.name}", "${token.eip712.version}")`);
}

function domainSeparator(name: string, version: string, chainId: number, verifyingContract: Address): Hex {
  const typeHash = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [typeHash, keccak256(toBytes(name)), keccak256(toBytes(version)), BigInt(chainId), verifyingContract],
    ),
  );
}

console.log(failures === 0 ? "\nall HashKey Chain facts verified" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
