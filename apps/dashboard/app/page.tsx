"use client";

import { TimeAgo, useNow } from "@/components/app/time-ago";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileSignature, Layers, Radio, ShieldBan, ShieldCheck, Waypoints } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBatches, useCalls, useDenials, useDirectory, useMandates, useNettingPreview, useOverview, useProviders, useToken } from "@/lib/queries";
import { formatGas, formatInt, formatMoney, formatRatio } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Batch, Call, Denial } from "@/lib/schemas";
import { axisTick, chartColor } from "@/lib/chart-theme";
import { bucketCalls } from "@/lib/calls-chart";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip, RuleChip } from "@/components/app/status";
import { NoMoneyMoved } from "@/components/app/denial";
import { RULE_INFO, asSentence, ruleTitle } from "@/lib/denials";
import { StatStrip } from "@/components/app/stat-strip";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";
import { Skeleton } from "@/components/ui/skeleton";

export default function OverviewPage() {
  const overview = useOverview();
  const mandates = useMandates();
  const providers = useProviders();

  if (overview.isError) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      </>
    );
  }

  // The guide is for an empty node. A node with mandates already open shows the live dashboard at zero, so the first
  // calls fill it in place instead of swapping the whole page.
  const firstRun = overview.data && overview.data.calls.all === 0 && overview.data.batches === 0 && mandates.data !== undefined && mandates.data.length === 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Agents pay per call with signed vouchers. This node checks every one against its mandate, then clears them in netted on-chain batches."
        actions={
          firstRun ? undefined : (
            <Button asChild>
              <Link href="/netting">
                <Waypoints /> Review netting
              </Link>
            </Button>
          )
        }
      />
      {overview.isPending || (overview.data?.calls.all === 0 && mandates.isPending) ? (
        <Skeleton className="h-[5.75rem] w-full rounded-xl" />
      ) : firstRun ? (
        <FirstRun hasMandates={(mandates.data?.length ?? 0) > 0} hasProviders={(providers.data?.length ?? 0) > 0} />
      ) : (
        <Kpis />
      )}
      {!firstRun && (
        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <CallsChart />
            <LiveStream />
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <PendingCard />
            <BlockedCard />
            <Timeline />
          </div>
        </div>
      )}
    </>
  );
}

function Kpis() {
  const { data } = useOverview();
  const preview = useNettingPreview();
  if (!data) return null;
  // Before the first batch the measured figures are zero; show what the pending calls will net to instead.
  const projected = data.batches === 0 && (preview.data?.calls ?? 0) > 0 ? preview.data!.compression : null;
  return (
    <StatStrip
      stats={[
        { label: "Settled volume", value: <Money atomic={data.volume.settled} maxFraction={2} />, note: <>Pending <Money atomic={data.volume.pending} maxFraction={4} /></> },
        { label: "Calls, last 24h", value: <span className="num">{formatInt(data.calls.last24h)}</span>, note: `${formatInt(data.calls.all)} all time` },
        projected !== null
          ? { label: "Compression", value: <span className="num">{formatRatio(projected)}</span>, note: "projected calls per transfer" }
          : data.batches === 0
            ? { label: "Compression", value: <span className="text-muted-foreground">-</span>, note: "calls per on-chain transfer" }
            : { label: "Compression", value: <span className="num">{formatRatio(data.compressionRatio)}</span>, note: "calls per on-chain transfer" },
        data.batches === 0
          ? { label: "Gas saved", value: <span className="text-muted-foreground">-</span>, note: "measured at settlement" }
          : { label: "Gas saved", value: <span className="num">{formatGas(data.gasSaved.gas)}</span>, note: "vs one transfer per call" },
        {
          label: "Blocked, last 24h",
          value: <span className={cn("num", data.denials24h > 0 && "text-negative")}>{formatInt(data.denials24h)}</span>,
          note: data.denials24h > 0 ? "refused, no money moved" : "every voucher passed",
        },
        { label: "Active mandates", value: <span className="num">{formatInt(data.activeMandates)}</span>, note: `${data.providers} providers` },
      ]}
    />
  );
}

/** Teaches the clearing model on a fresh node, with the next action for each step. */
function FirstRun({ hasMandates, hasProviders }: { hasMandates: boolean; hasProviders: boolean }) {
  const steps = [
    {
      icon: FileSignature,
      title: "An owner signs a mandate",
      body: "One EIP-712 signature gives an agent a bounded budget: total cap, per-call cap, daily cap, rate limit, allowed payees and an expiry.",
      done: hasMandates,
      action: { href: "/mandates/new", label: "Create a mandate" },
    },
    {
      icon: Radio,
      title: "The agent pays per call with vouchers",
      body: "Each paid request carries a gas-free cumulative voucher. This node checks it against the mandate, books it and returns a signed receipt.",
      done: false,
      action: hasProviders ? { href: "/providers", label: "See providers" } : { href: "/providers?register=1", label: "Register a provider" },
    },
    {
      icon: Waypoints,
      title: "Batches settle netted on chain",
      body: "Hundreds of vouchers clear in one settleBatch. The hub verifies every signature and cap, then moves only net amounts wallet to wallet.",
      done: false,
      action: { href: "/netting", label: "Open netting" },
    },
  ];
  return (
    <section aria-labelledby="first-run" className="rounded-xl border bg-card">
      <div className="border-b px-5 py-5 sm:px-6">
        <h2 id="first-run" className="text-lg font-semibold tracking-[-0.01em]">
          No calls cleared yet
        </h2>
        <p className="mt-1 max-w-[64ch] text-sm text-muted-foreground">
          Payminto Clearing works in three steps. Nobody, including this node, ever holds funds: agents pay providers directly when a batch settles.
        </p>
      </div>
      <ol className="grid divide-y md:grid-cols-3 md:divide-x md:divide-y-0">
        {steps.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-3 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="num flex size-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">{i + 1}</span>
              <s.icon className="size-4 text-muted-foreground" />
            </div>
            <h3 className="font-medium">{s.title}</h3>
            <p className="text-sm text-muted-foreground">{s.body}</p>
            <div className="mt-auto pt-1">
              <Button asChild variant={i === 0 && !s.done ? "default" : "outline"} size="sm">
                <Link href={s.action.href}>{s.action.label}</Link>
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CallsChart() {
  const calls = useCalls({ limit: 500 });
  const token = useToken();
  // Re-bucket every 5 s so the window keeps up with the clock without re-rendering the chart every second.
  const tick = Math.floor(useNow() / 5000);
  const { bars: data, unit, hourly } = useMemo(() => bucketCalls(calls.data?.items ?? [], (tick + 1) * 5000), [calls.data, tick]);

  return (
    <Panel title="Cleared calls" description={hourly ? "Accepted vouchers per hour, last 12 hours" : `Accepted vouchers per ${unit}`}>
      {calls.isPending ? (
        <BlockSkeleton className="h-48" />
      ) : calls.isError ? (
        <ErrorState error={calls.error} onRetry={() => void calls.refetch()} />
      ) : (
        <div className="h-48 w-full" role="img" aria-label={`Calls per ${unit}, peak ${Math.max(...data.map((d) => d.calls))}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: -18 }} barCategoryGap={3}>
              <CartesianGrid vertical={false} stroke={chartColor("grid")} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={axisTick} interval="preserveStartEnd" minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} tick={axisTick} allowDecimals={false} width={44} />
              <Tooltip
                cursor={{ fill: chartColor("cursor") }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-sm">
                      <p className="font-medium">{p.label}</p>
                      <p className="num mt-0.5 text-muted-foreground">
                        {p.calls} calls, {formatMoney(p.volume, token.decimals, { maxFraction: 4 })} {token.symbol}
                      </p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="calls" fill={chartColor("bar")} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

type StreamRow = { kind: "call"; at: string; call: Call } | { kind: "denial"; at: string; denial: Denial };

function LiveStream() {
  const calls = useCalls({ limit: 14 });
  const denials = useDenials();
  const dir = useDirectory();
  const rows = useMemo<StreamRow[]>(() => {
    const all: StreamRow[] = [
      ...(calls.data?.items ?? []).map((c) => ({ kind: "call" as const, at: c.createdAt, call: c })),
      ...(denials.data ?? []).slice(0, 6).map((d) => ({ kind: "denial" as const, at: d.createdAt, denial: d })),
    ];
    return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 14);
  }, [calls.data, denials.data]);
  const name = (a: string | null | undefined) => (a ? dir.lookup(a)?.name ?? `${a.slice(0, 8)}…` : "Unknown");
  const fresh = useFreshIds(
    rows.map((r) => (r.kind === "call" ? r.call.id : r.denial.id)),
    Boolean(calls.data && denials.data),
  );

  return (
    <Panel
      title="Live call stream"
      description="Every voucher this node accepted or refused"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/mandates">All mandates</Link>
        </Button>
      }
      bodyClassName="p-0 sm:p-0"
    >
      {calls.isPending ? (
        <RowsSkeleton className="px-5" rows={8} />
      ) : calls.isError ? (
        <ErrorState className="m-4" error={calls.error} onRetry={() => void calls.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Radio className="size-4" />} title="Waiting for the first call">
          Calls appear here the moment an agent pays a provider through this node.
        </EmptyState>
      ) : (
        <ul className="divide-y">
          {rows.map((r) =>
            r.kind === "call" ? (
              <li key={r.call.id} className={cn(fresh.has(r.call.id) && "row-in", "flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5")}>
                <span className="size-1.5 shrink-0 rounded-full bg-positive" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{name(r.call.agent)}</span>
                  <span className="text-subtle"> paid </span>
                  <span className="font-medium">{name(r.call.payee)}</span>
                </span>
                <Link href={`/receipts/${r.call.id}`} className="shrink-0 rounded hover:underline" aria-label="Open receipt proof">
                  <Money atomic={r.call.amount} />
                </Link>
                <TimeAgo iso={r.at} className="num w-16 shrink-0 text-right text-xs text-subtle max-sm:hidden" />
              </li>
            ) : (
              <li key={r.denial.id} className={cn(fresh.has(r.denial.id) && "row-in", "flex items-center gap-3 bg-negative-soft/60 px-4 py-2.5 text-sm sm:px-5")}>
                <ShieldBan className="size-3.5 shrink-0 text-negative" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-negative">Blocked</span>
                  <span className="text-subtle"> </span>
                  <span className="font-medium">{name(r.denial.agent)}</span>
                  <span className="text-subtle"> to </span>
                  <span className="font-medium">{name(r.denial.payee)}</span>
                </span>
                <RuleChip rule={r.denial.rule} />
                <TimeAgo iso={r.at} className="num w-16 shrink-0 text-right text-xs text-subtle max-sm:hidden" />
              </li>
            ),
          )}
        </ul>
      )}
    </Panel>
  );
}

function PendingCard() {
  const preview = useNettingPreview();
  const p = preview.data;
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">Waiting to settle</h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">Accepted calls not yet in a batch</p>
        </div>
        <Waypoints className="size-4 text-subtle" />
      </div>
      {preview.isPending ? (
        <Skeleton className="mt-4 h-16 w-full" />
      ) : !p || (p.calls ?? 0) === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Everything accepted so far is settled.</p>
      ) : (
        <>
          <p className="mt-4 text-[1.75rem] leading-none font-semibold tracking-[-0.02em]">
            <Money atomic={p.grossTotal ?? "0"} maxFraction={4} />
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="num">{formatInt(p.calls ?? 0)}</span> calls net down to <span className="num">{p.net.length}</span> transfers moving{" "}
            <Money atomic={p.netTotal ?? "0"} maxFraction={4} className="text-foreground" />.
          </p>
          <Button asChild className="mt-4 w-full">
            <Link href="/netting">
              Review and settle <ArrowRight />
            </Link>
          </Button>
        </>
      )}
    </section>
  );
}

/** The latest refusal, stated as an outcome: what was tried, which rule stopped it, and that nothing moved. */
function BlockedCard() {
  const denials = useDenials();
  const overview = useOverview();
  const dir = useDirectory();
  // Lead with the most recent attack when there is one; an honest agent hitting a cap is less telling.
  const latest = denials.data?.find((d) => RULE_INFO[d.rule]?.kind === "attack") ?? denials.data?.[0];
  const n24 = overview.data?.denials24h ?? 0;
  const name = (a: string | null | undefined) => (a ? dir.lookup(a)?.name ?? `${a.slice(0, 8)}…` : "an unknown wallet");
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="blocked-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="blocked-title" className="text-[0.9375rem] font-semibold">
            Attacks and overspend blocked
          </h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">Refused by mandate policy before any money moved</p>
        </div>
        <span className={cn("num text-[1.75rem] leading-none font-semibold tracking-[-0.02em]", n24 > 0 ? "text-negative" : "text-muted-foreground")}>
          {formatInt(n24)}
          <span className="sr-only"> blocked in the last 24 hours</span>
        </span>
      </div>
      {denials.isPending ? (
        <Skeleton className="mt-4 h-20 w-full" />
      ) : !latest ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4 text-positive" /> Every voucher so far stayed inside its mandate.
        </p>
      ) : (
        <>
          <div className="mt-4 rounded-lg border border-negative/25 bg-negative-soft/60 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldBan className="size-4 text-negative" aria-hidden />
              <span className="text-sm font-medium">{ruleTitle(latest.rule)}</span>
              <RuleChip rule={latest.rule} />
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              <span className="text-foreground">{name(latest.agent)}</span> tried to pay <span className="text-foreground">{name(latest.payee)}</span>
              {latest.amount ? (
                <>
                  {" "}
                  <Money atomic={latest.amount} className="text-foreground" />
                </>
              ) : null}
              . {asSentence(latest.message)}
            </p>
            <div className="mt-2 flex items-center justify-between gap-3">
              <NoMoneyMoved />
              <TimeAgo iso={latest.createdAt} className="num text-xs text-subtle" />
            </div>
          </div>
          <Button asChild variant="outline" className="mt-3 w-full">
            <Link href="/denials">
              See all blocked calls <ArrowRight />
            </Link>
          </Button>
        </>
      )}
    </section>
  );
}

function Timeline() {
  const batches = useBatches();
  return (
    <Panel
      title="Settlement timeline"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/batches">All batches</Link>
        </Button>
      }
    >
      {batches.isPending ? (
        <RowsSkeleton rows={3} />
      ) : batches.isError ? (
        <ErrorState error={batches.error} onRetry={() => void batches.refetch()} />
      ) : batches.data.length === 0 ? (
        <EmptyState icon={<Layers className="size-4" />} title="No batches yet" className="py-6">
          The first settlement appears here with its transaction and compression.
        </EmptyState>
      ) : (
        <ol className="relative">
          {batches.data.slice(0, 5).map((b, i, arr) => (
            <TimelineItem key={b.id} batch={b} last={i === arr.length - 1} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function TimelineItem({ batch, last }: { batch: Batch; last: boolean }) {
  const ratio = batch.transfers ? batch.calls / batch.transfers : 0;
  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[0.6875rem] w-px bg-border" />}
      <span
        className={cn(
          "relative mt-0.5 flex size-[1.375rem] shrink-0 items-center justify-center rounded-full border-2 bg-card",
          batch.status === "confirmed" ? "border-positive" : batch.status === "failed" ? "border-negative" : "border-primary",
        )}
        aria-hidden
      >
        <span className={cn("size-1.5 rounded-full", batch.status === "confirmed" ? "bg-positive" : batch.status === "failed" ? "bg-negative" : "bg-primary")} />
      </span>
      <Link href={`/batches/${batch.id}`} className="-m-1.5 min-w-0 flex-1 rounded-md p-1.5 hover:bg-muted/60">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Batch #{batch.seq}</span>
          <BatchStatusChip status={batch.status} />
        </div>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          <span className="num">{formatInt(batch.calls)}</span> calls, <Money atomic={batch.gross} maxFraction={4} /> gross, {batch.transfers} transfers
        </p>
        <p className="mt-0.5 text-xs text-subtle">
          <span className="num">{formatRatio(ratio)}</span> calls per transfer, <TimeAgo iso={batch.confirmedAt ?? batch.createdAt} />
        </p>
      </Link>
    </li>
  );
}


/** Ids that arrived after the stream first rendered, so only genuinely new rows get the arrival highlight. */
function useFreshIds(ids: string[], ready: boolean): Set<string> {
  const [initial, setInitial] = useState<Set<string> | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- snapshot of the rows already on screen at first paint
    if (ready && !initial) setInitial(new Set(ids));
  }, [ready, initial, ids]);
  return useMemo(() => (initial ? new Set(ids.filter((id) => !initial.has(id))) : new Set<string>()), [initial, ids]);
}
