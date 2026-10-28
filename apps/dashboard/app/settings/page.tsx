"use client";

import { useTheme } from "next-themes";
import { LogOut } from "lucide-react";
import { hashkeyContracts, networks, type HashKeyContracts } from "@payminto/protocol";
import { MOCK_MODE, NODE_URL } from "@/lib/config";
import { useSession } from "@/lib/session";
import { useLive } from "@/lib/live";
import { chainIdOf, useHealth, useInfo } from "@/lib/queries";
import { formatInt, formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Address, Field, Fields, PageHeader, Panel } from "@/components/app/primitives";
import { Chip } from "@/components/app/status";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

export default function SettingsPage() {
  const info = useInfo();
  const health = useHealth();
  const live = useLive();
  const { signOut } = useSession();
  const { theme, setTheme } = useTheme();

  if (info.isError) {
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorState error={info.error} onRetry={() => void info.refetch()} />
      </>
    );
  }
  const d = info.data;
  const chainId = chainIdOf(d);
  const net = networks[chainId];
  const native = net?.chain.nativeCurrency;

  return (
    <>
      <PageHeader title="Settings" description="What this clearing node is connected to. Values come from the node; change them in its environment and restart it." />
      {!d ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <BlockSkeleton className="h-64" />
          <BlockSkeleton className="h-64" />
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="Node">
            <Fields>
              <Field label="Endpoint"><span className="hash break-all">{MOCK_MODE ? "mock (in-browser)" : NODE_URL}</span></Field>
              <Field label="Version"><span className="hash">{d.version}</span></Field>
              <Field label="Health">
                {health.data ? <Chip tone={health.data.ok ? "positive" : "negative"}>{health.data.ok ? "Healthy" : "Degraded"}</Chip> : health.isError ? <Chip tone="negative">Unreachable</Chip> : <Chip tone="neutral">Checking</Chip>}
              </Field>
              <Field label="Event stream">
                <Chip tone={live.status === "live" ? "positive" : live.status === "connecting" ? "warning" : "negative"}>
                  {live.status === "live" ? "Connected" : live.status === "connecting" ? "Reconnecting" : "Offline"}
                </Chip>
              </Field>
              <Field label="Auto-settle">
                {d.settleIntervalSec ? `Every ${formatInt(d.settleIntervalSec)} s` : "Manual, from the Netting screen"}
              </Field>
              <Field label="HSP mode">
                <span className="flex flex-col gap-0.5">
                  <span className="hash">{d.hspMode ?? health.data?.hspMode ?? "-"}</span>
                  <span className="text-xs text-muted-foreground">
                    {(d.hspMode ?? health.data?.hspMode) === "coordinator"
                      ? "Net transfers are reported to the HashKey HSP Coordinator."
                      : "The node verifies each net transfer as a built-in HSP adapter."}
                  </span>
                </span>
              </Field>
            </Fields>
          </Panel>
          <Panel title="Network">
            <Fields>
              <Field label="Chain">
                {d.network.name} <span className="text-muted-foreground">({chainId})</span>
              </Field>
              <Field label="Latest block"><span className="num">{health.data?.blockNumber != null ? formatInt(health.data.blockNumber) : "-"}</span></Field>
              <Field label="Explorer">
                {d.explorer ? (
                  <a href={d.explorer} target="_blank" rel="noreferrer" className="hash break-all text-primary hover:underline">
                    {d.explorer.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="text-muted-foreground">None for a local chain</span>
                )}
              </Field>
              <Field label="ClearingHub"><Address address={d.hub} showName={false} /></Field>
              <Field label="Settlement token">
                <span className="flex flex-wrap items-center gap-2">
                  {d.token.symbol} <span className="text-muted-foreground">{d.token.decimals} decimals</span>
                  <Address address={d.token.address} showName={false} />
                </span>
              </Field>
            </Fields>
          </Panel>
          <Panel title="Operator" description="Signs receipts and submits settlement transactions. It pays gas only and never holds user funds.">
            <Fields>
              <Field label="Address"><Address address={d.operator} showName={false} /></Field>
              <Field label="Gas balance">
                {d.operatorGasBalance != null ? (
                  <span className="num">
                    {formatMoney(d.operatorGasBalance, native?.decimals ?? 18, { maxFraction: 4 })}{" "}
                    <span className="text-muted-foreground">{native?.symbol ?? "native"}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not reported by this node</span>
                )}
              </Field>
            </Fields>
          </Panel>
          <Panel title="This browser">
            <Fields>
              <Field label="Theme">
                <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Theme">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button
                      key={t}
                      role="radio"
                      aria-checked={theme === t}
                      onClick={() => setTheme(t)}
                      className={`h-7 rounded px-3 text-sm capitalize ${theme === t ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Session">
                <Button variant="outline" size="sm" onClick={signOut}>
                  <LogOut /> Sign out and forget token
                </Button>
              </Field>
            </Fields>
          </Panel>
          <HashKeyPanel chainId={chainId} />
        </div>
      )}
    </>
  );
}

/** Verified HashKey Chain contracts the hub composes with, so an operator can see what is live where. */
function HashKeyPanel({ chainId }: { chainId: number }) {
  const onHashKey = chainId === 177 || chainId === 133;
  const id = (onHashKey ? chainId : 133) as 177 | 133;
  const c: HashKeyContracts = hashkeyContracts[id];
  const rows: [string, string, string | undefined][] = [
    ["Permit2", "Signature approvals for tokens without EIP-2612", c.permit2],
    ["Multicall3", "Batched reads", c.multicall3],
    ["Safe factory", "Safe v1.4.1, for ERC-1271 mandate owners", c.safe.proxyFactory],
    ["EAS", "Attestations (OP Stack predeploy)", c.eas],
    ["CCIP router", "Cross-chain messaging", c.ccipRouter],
    ["APRO USDC/USD", "Price feed, 8 decimals", c.apro.usdcUsd],
    ["APRO USDT/USD", "Price feed, 8 decimals", c.apro.usdtUsd],
    ["USDT", "Bridged stablecoin", c.usdt],
  ];
  return (
    <Panel
      title="HashKey Chain contracts"
      description={
        onHashKey
          ? "Checked live with eth_getCode; the hub and agents can compose with these."
          : `This node runs on a local chain (${chainId}). On HashKey Chain Testnet the hub composes with these verified contracts.`
      }
      className="lg:col-span-2"
    >
      <Fields className="lg:grid-cols-2">
        {rows
          .filter((r): r is [string, string, string] => Boolean(r[2]))
          .map(([name, hint, address]) => (
            <Field key={name} label={name} hint={hint}>
              <span className="flex flex-col gap-0.5">
                <Address address={address} showName={false} explorer={onHashKey} />
                <span className="text-xs text-muted-foreground">{hint}</span>
              </span>
            </Field>
          ))}
      </Fields>
    </Panel>
  );
}
