"use client";

import { useMemo, useState } from "react";
import { createWalletClient, custom, encodeFunctionData, type Address as Addr, type Hex } from "viem";
import { clearingHubAbi } from "@payminto/protocol";
import { hasInjectedWallet } from "@/lib/sign";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, Radio, Wallet } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { useApi } from "@/lib/session";
import { qk, useInfo, useMandate, useToken } from "@/lib/queries";
import { formatDate, formatDateTime, formatInt, formatMoney, percentOf, timeAgo } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { MandateDetail } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Address, Field, Fields, Hash, Meter, Money, PageHeader, Panel, PartyLine } from "@/components/app/primitives";
import { CallStatusChip, MandateStatusChip, RuleChip } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/app/states";

export default function MandateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useMandate(id);
  const back = { href: "/mandates", label: "Mandates" };

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-72 animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-24" />
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <BlockSkeleton className="h-72" />
          <BlockSkeleton className="h-72" />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Mandate" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const m = q.data;
  const used = BigInt(m.spend.settled) + BigInt(m.spend.pending);
  const pct = percentOf(used, m.mandate.totalCap);

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {m.label} <MandateStatusChip status={m.status} />
          </span>
        }
        description={m.policy.purpose}
        actions={m.status === "open" || m.status === "pending" ? <RevokeButton m={m} /> : null}
      />

      {m.status === "revoked" && <RevokedNotice m={m} />}

      <StatStrip
        stats={[
          {
            label: "Total cap",
            value: <Money atomic={m.mandate.totalCap} maxFraction={2} />,
            note: (
              <span className="flex items-center gap-2">
                <span className="w-16 shrink-0">
                  <Meter value={pct} tone={pct > 90 ? "negative" : pct > 75 ? "warning" : "primary"} label="Total cap used" />
                </span>
                {pct.toFixed(1)}% used
              </span>
            ),
          },
          { label: "Settled", value: <Money atomic={m.spend.settled} maxFraction={4} />, note: "paid on chain" },
          { label: "Awaiting netting", value: <Money atomic={m.spend.pending} maxFraction={4} />, note: "accepted, not yet settled" },
          { label: "Remaining", value: <Money atomic={m.spend.remaining} maxFraction={4} />, note: <>Today <Money atomic={m.spend.today} maxFraction={4} /> of <Money atomic={m.policy.dailyCap} maxFraction={2} /></> },
        ]}
      />

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <SpendChart m={m} />
          <CallsTable m={m} />
          <DenialsList m={m} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Policy" description="Enforced by this node on every call; committed on chain as policyHash">
            <Fields>
              <Field label="Per-call cap"><Money atomic={m.policy.perCallCap} /></Field>
              <Field label="Daily cap"><Money atomic={m.policy.dailyCap} /></Field>
              <Field label="Rate limit">{m.policy.maxCallsPerMinute ? `${formatInt(m.policy.maxCallsPerMinute)} calls per minute` : "No limit"}</Field>
              <Field label="Valid">
                {formatDate(Number(m.mandate.validAfter))} to {formatDate(Number(m.mandate.validUntil))}
              </Field>
              <Field label="Allowed payees">
                {m.payees.length === 0 ? (
                  <span className="text-muted-foreground">Any payee</span>
                ) : (
                  <ul className="space-y-2">
                    {m.payees.map((p) => (
                      <li key={p}>
                        <PartyLine address={p} />
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
            </Fields>
          </Panel>
          <OnChain m={m} />
        </div>
      </div>
    </>
  );
}

function RevokeButton({ m }: { m: MandateDetail }) {
  const api = useApi();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revokeMandate(m.id),
    onSuccess: (res) => {
      const needsOwner = res.onchain && !res.onchain.revoked;
      toast.success("Mandate revoked", {
        description: needsOwner
          ? "This node refuses new vouchers now. The owner or agent should also call revokeMandate on ClearingHub."
          : "New vouchers under this mandate are refused from now on.",
      });
      void qc.invalidateQueries({ queryKey: qk.mandates });
    },
    onError: (e) => toast.error("Revoke failed", { description: e instanceof ApiError ? e.message : String(e) }),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="text-negative hover:text-negative" disabled={revoke.isPending}>
          <Ban /> Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this mandate?</AlertDialogTitle>
          <AlertDialogDescription>
            The node refuses new vouchers from {m.label.split(" - ")[0]} immediately. Calls already accepted stay settleable for one hour, so providers are still paid for work they did.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep mandate</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => revoke.mutate()}>
            Revoke mandate
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RevokedNotice({ m }: { m: MandateDetail }) {
  const info = useInfo();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pendingOnChain = m.onchain?.open === true && m.onchain.revokedAt == null;

  async function revokeOnChain() {
    if (!info.data || !window.ethereum) return;
    setBusy(true);
    try {
      const wallet = createWalletClient({ transport: custom(window.ethereum) });
      const [from] = await wallet.requestAddresses();
      if (!from) throw new Error("The wallet did not share an account.");
      if (![m.mandate.owner, m.mandate.agent].some((a) => a.toLowerCase() === from.toLowerCase())) {
        throw new Error("Only the mandate owner or agent can revoke it on chain. Switch to that account.");
      }
      const data = encodeFunctionData({ abi: clearingHubAbi, functionName: "revokeMandate", args: [m.id as Hex] });
      await wallet.sendTransaction({ account: from, to: info.data.hub as Addr, data, chain: null });
      toast.success("Revoke sent", { description: "The node picks up the on-chain revoke from the MandateRevoked event." });
      void qc.invalidateQueries({ queryKey: qk.mandate(m.id) });
    } catch (e) {
      toast.error("On-chain revoke not sent", { description: e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-lg border bg-muted/60 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <p className="flex-1 text-muted-foreground">
        Revoked {m.revokedAt ? timeAgo(m.revokedAt) : ""}. This node refuses new vouchers. Vouchers already accepted stay settleable on chain for one hour after the revoke.
        {pendingOnChain && " The hub has not recorded the revoke yet; the owner or agent can send it."}
      </p>
      {pendingOnChain && hasInjectedWallet() && (
        <Button variant="outline" size="sm" onClick={() => void revokeOnChain()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Wallet />} Revoke on chain with wallet
        </Button>
      )}
    </div>
  );
}

function OnChain({ m }: { m: MandateDetail }) {
  const info = useInfo();
  const t = useToken();
  return (
    <Panel title="On chain" description="The signed mandate as ClearingHub stores it">
      <Fields>
        <Field label="Mandate id"><Hash value={m.id} /></Field>
        <Field label="Owner"><Address address={m.mandate.owner} showName={false} /></Field>
        <Field label="Agent"><PartyLine address={m.mandate.agent} /></Field>
        <Field label="Token">
          <span className="inline-flex items-center gap-2">
            {t.symbol} <Address address={m.mandate.token} showName={false} />
          </span>
        </Field>
        <Field label="Hub"><Address address={info.data?.hub} showName={false} /></Field>
        <Field label="Opened by tx"><Hash value={m.openTxHash} kind="tx" /></Field>
        <Field label="Payees root"><Hash value={m.mandate.payeesRoot} /></Field>
        <Field label="Policy hash"><Hash value={m.mandate.policyHash} /></Field>
        {m.agentBalance != null && <Field label="Agent balance"><Money atomic={m.agentBalance} /></Field>}
        {m.agentAllowance != null && (
          <Field label="Hub allowance">
            <Money atomic={m.agentAllowance} className={BigInt(m.agentAllowance) < BigInt(m.spend.pending) ? "text-negative" : undefined} />
          </Field>
        )}
      </Fields>
    </Panel>
  );
}

function SpendChart({ m }: { m: MandateDetail }) {
  const t = useToken();
  const data = useMemo(() => {
    const out: { t: string; label: string; value: number; raw: string }[] = [];
    let run = 0n;
    for (const p of m.spendSeries ?? []) {
      run += BigInt(p.amount);
      // Live nodes bucket by day (YYYY-MM-DD); the mock buckets by hour (full ISO time).
      const daily = /^\d{4}-\d{2}-\d{2}$/.test(p.day);
      const d = new Date(daily ? `${p.day}T00:00:00Z` : p.day);
      const label = daily ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      out.push({ t: p.day, label, value: Number(run) / 10 ** t.decimals, raw: run.toString() });
    }
    return out;
  }, [m.spendSeries, t.decimals]);
  return (
    <Panel title="Cumulative spend" description={`${t.symbol}, ${m.spendSeries?.[0] && /^\d{4}-\d{2}-\d{2}$/.test(m.spendSeries[0].day) ? "by day" : "by hour"}`}>
      {data.length < 2 || data[data.length - 1]!.raw === "0" ? (
        <EmptyState className="py-8" title="Nothing spent yet">Spend appears here once the agent has paid for calls under this mandate.</EmptyState>
      ) : (
        <div className="h-52" role="img" aria-label={`Cumulative spend reaching ${formatMoney(data[data.length - 1]!.raw, t.decimals)} ${t.symbol}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} width={48} tickFormatter={(v: number) => v.toFixed(2)} />
              <Tooltip
                cursor={{ stroke: "var(--subtle)", strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-sm">
                      <p className="font-medium">{/^\d{4}-\d{2}-\d{2}$/.test(p.t) ? p.label : formatDateTime(p.t)}</p>
                      <p className="num mt-0.5 text-muted-foreground">
                        {formatMoney(p.raw, t.decimals, { maxFraction: 4 })} {t.symbol} spent
                      </p>
                    </div>
                  );
                }}
              />
              <Area type="monotone" dataKey="value" stroke="var(--primary)" strokeWidth={2} fill="url(#spendFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function CallsTable({ m }: { m: MandateDetail }) {
  return (
    <Panel title="Recent calls" description="Newest first; open one to see its Merkle proof" bodyClassName="p-0 sm:p-0">
      {m.recentCalls.length === 0 ? (
        <EmptyState icon={<Radio className="size-4" />} title="No calls under this mandate yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-5 py-2.5 font-normal">Payee</th>
                <th className="px-3 py-2.5 text-right font-normal">Amount</th>
                <th className="px-3 py-2.5 text-right font-normal">Cumulative</th>
                <th className="px-3 py-2.5 font-normal">Status</th>
                <th className="px-5 py-2.5 text-right font-normal">When</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {m.recentCalls.slice(0, 12).map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-5 py-2.5"><Address address={c.payee} explorer={false} copy={false} /></td>
                  <td className="px-3 py-2.5 text-right">
                    <Link href={`/receipts/${c.id}`} className="hover:underline"><Money atomic={c.amount} /></Link>
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground"><Money atomic={c.cumulative} maxFraction={4} /></td>
                  <td className="px-3 py-2.5"><CallStatusChip status={c.status} /></td>
                  <td className="num px-5 py-2.5 text-right text-xs whitespace-nowrap text-muted-foreground">{timeAgo(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DenialsList({ m }: { m: MandateDetail }) {
  return (
    <Panel title="Denials" description="Calls refused before any money moved" bodyClassName="p-0 sm:p-0">
      {m.denials.length === 0 ? (
        <EmptyState className="py-8" title="No denials">Every voucher under this mandate stayed inside its policy.</EmptyState>
      ) : (
        <ul className="divide-y">
          {m.denials.map((d) => (
            <li key={d.id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
              <RuleChip rule={d.rule} />
              <span className="min-w-0 flex-1 text-sm">
                <span className="block text-foreground">{d.message}</span>
                {d.payee && (
                  <span className="text-xs text-muted-foreground">
                    Payee <Address address={d.payee} showName={false} explorer={false} />
                    {d.amount ? <> for <Money atomic={d.amount} /></> : null}
                  </span>
                )}
              </span>
              <time className="num text-xs whitespace-nowrap text-subtle" dateTime={d.createdAt}>{timeAgo(d.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
