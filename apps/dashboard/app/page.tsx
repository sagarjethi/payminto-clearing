"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, Ban, FileSignature, Layers, Radio, Waypoints } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useBatches, useCalls, useDenials, useDirectory, useMandates, useNettingPreview, useOverview, useProviders, useToken } from "@/lib/queries";
import { formatGas, formatInt, formatMoney, formatRatio, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Batch, Call, Denial } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip, RuleChip } from "@/components/app/status";
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

  const firstRun = overview.data && overview.data.calls.all === 0 && overview.data.batches === 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Agents pay per call with signed vouchers. This node checks every one against its mandate, then clears them in netted on-chain batches."
        actions={
          <Button asChild>
            <Link href="/netting">
              <Waypoints /> Review netting
            </Link>
          </Button>
        }
      />
      {overview.isPending ? (
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
            <Timeline />
          </div>
        </div>
      )}
    </>
  );
}

function Kpis() {
  const { data } = useOverview();
  if (!data) return null;
  return (
    <StatStrip
      stats={[
        { label: "Settled volume", value: <Money atomic={data.volume.settled} maxFraction={2} />, note: <>Pending <Money atomic={data.volume.pending} maxFraction={4} /></> },
        { label: "Calls, last 24h", value: <span className="num">{formatInt(data.calls.last24h)}</span>, note: `${formatInt(data.calls.all)} all time` },
        {
          label: "Compression",
          value: <span className="num">{formatRatio(data.compressionRatio)}</span>,
          note: "calls per on-chain transfer",
        },
        { label: "Gas saved", value: <span className="num">{formatGas(data.gasSaved.gas)}</span>, note: "vs one transfer per call" },
        {
          label: "Denials, last 24h",
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
  const data = useMemo(() => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const hours = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getTime() - (11 - i) * 3_600_000);
      return { t: d.getTime(), label: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), calls: 0, volume: 0n };
    });
    for (const c of calls.data?.items ?? []) {
      const t = new Date(c.createdAt).getTime();
      const idx = hours.findIndex((h) => t >= h.t && t < h.t + 3_600_000);
      if (idx >= 0) {
        hours[idx]!.calls += 1;
        hours[idx]!.volume += BigInt(c.amount);
      }
    }
    return hours.map((h) => ({ ...h, volume: h.volume.toString() }));
  }, [calls.data]);

  return (
    <Panel title="Cleared calls per hour" description="Last 12 hours, accepted vouchers">
      {calls.isPending ? (
        <BlockSkeleton className="h-48" />
      ) : calls.isError ? (
        <ErrorState error={calls.error} onRetry={() => void calls.refetch()} />
      ) : (
        <div className="h-48 w-full" role="img" aria-label={`Calls per hour over the last 12 hours, peak ${Math.max(...data.map((d) => d.calls))}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: -18 }} barCategoryGap={3}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} interval="preserveStartEnd" minTickGap={18} />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} allowDecimals={false} width={44} />
              <Tooltip
                cursor={{ fill: "var(--muted)" }}
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
              <Bar dataKey="calls" fill="var(--primary)" radius={[4, 4, 0, 0]} maxBarSize={28} />
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
              <li key={r.call.id} className="row-in flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                <span className="size-1.5 shrink-0 rounded-full bg-positive" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{name(r.call.agent)}</span>
                  <span className="text-subtle"> paid </span>
                  <span className="font-medium">{name(r.call.payee)}</span>
                </span>
                <Link href={`/receipts/${r.call.id}`} className="shrink-0 rounded hover:underline" aria-label="Open receipt proof">
                  <Money atomic={r.call.amount} />
                </Link>
                <time className="num w-16 shrink-0 text-right text-xs text-subtle max-sm:hidden" dateTime={r.at}>
                  {timeAgo(r.at)}
                </time>
              </li>
            ) : (
              <li key={r.denial.id} className="row-in flex items-center gap-3 bg-negative-soft/50 px-4 py-2.5 text-sm sm:px-5">
                <Ban className="size-3.5 shrink-0 text-negative" aria-label="Denied" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{name(r.denial.agent)}</span>
                  <span className="text-subtle"> refused paying </span>
                  <span className="font-medium">{name(r.denial.payee)}</span>
                </span>
                <RuleChip rule={r.denial.rule} />
                <time className="num w-16 shrink-0 text-right text-xs text-subtle max-sm:hidden" dateTime={r.at}>
                  {timeAgo(r.at)}
                </time>
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
          <span className="num">{formatRatio(ratio)}</span> calls per transfer, {timeAgo(batch.confirmedAt ?? batch.createdAt)}
        </p>
      </Link>
    </li>
  );
}

