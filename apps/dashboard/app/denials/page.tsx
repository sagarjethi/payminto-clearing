"use client";

import { useMemo } from "react";
import { ShieldBan, ShieldCheck } from "lucide-react";
import { useDenials, useToken } from "@/lib/queries";
import { ruleDescription, summarizeDenials, type RuleSummary } from "@/lib/denials";
import { formatInt, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Money, PageHeader, Panel } from "@/components/app/primitives";
import { Chip, RuleChip } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { DenialItem } from "@/components/app/denial";
import { BlockSkeleton, EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

const KIND: Record<RuleSummary["kind"], { label: string; tone: "negative" | "warning" | "neutral" }> = {
  attack: { label: "Attack", tone: "negative" },
  limit: { label: "Limit", tone: "warning" },
  state: { label: "Mandate state", tone: "neutral" },
};

export default function DenialsPage() {
  const denials = useDenials();
  const token = useToken();
  const summary = useMemo(() => summarizeDenials(denials.data ?? []), [denials.data]);

  return (
    <>
      <PageHeader
        title="Blocked calls"
        description="Every voucher the policy engine refused. A refused call is never booked or settled, so no money moves."
      />

      <section className="mb-5 flex flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-positive-soft text-positive" aria-hidden>
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">Policy engine active</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The node checks each voucher against its signed mandate before it books anything. ClearingHub checks the same caps again on chain when a batch settles.
          </p>
        </div>
      </section>

      {denials.isPending ? (
        <BlockSkeleton className="h-[5.75rem]" />
      ) : denials.isError ? (
        <ErrorState error={denials.error} onRetry={() => void denials.refetch()} />
      ) : (
        <StatStrip
          stats={[
            { label: "Blocked calls", value: <span className={cn("num", summary.total > 0 && "text-negative")}>{formatInt(summary.total)}</span>, note: "latest 100 refusals" },
            { label: "Attacks stopped", value: <span className="num">{formatInt(summary.attacks)}</span>, note: "forged, replayed or misdirected" },
            { label: "Value refused", value: <Money atomic={summary.attempted} maxFraction={4} />, note: "asked for by refused vouchers" },
            {
              label: "Money moved",
              value: (
                <span className="num text-positive">
                  0.00<span className="ml-1 text-[0.82em] font-normal">{token.symbol}</span>
                </span>
              ),
              note: "a refused call never settles",
              tone: "positive",
            },
          ]}
        />
      )}

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Panel title="Rules that fired" description="Grouped by the policy rule that refused the voucher" bodyClassName="p-0 sm:p-0">
          {denials.isPending ? (
            <RowsSkeleton className="px-5" rows={4} />
          ) : summary.byRule.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-4" />} title="Nothing blocked yet">
              Every voucher so far stayed inside its mandate.
            </EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2.5 pr-3 pl-4 font-normal sm:pl-5">Rule</th>
                  <th className="px-3 py-2.5 font-normal max-sm:hidden">Type</th>
                  <th className="px-3 py-2.5 text-right font-normal">Blocked</th>
                  <th className="py-2.5 pr-4 pl-3 text-right font-normal sm:pr-5">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {summary.byRule.map((r) => (
                  <tr key={r.rule} className="align-top">
                    <td className="py-3 pr-3 pl-4 sm:pl-5">
                      <span className="block font-medium">{r.title}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <RuleChip rule={r.rule} />
                        <span className="sm:hidden">
                          <Chip tone={KIND[r.kind].tone} dot={false}>
                            {KIND[r.kind].label}
                          </Chip>
                        </span>
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">{ruleDescription(r.rule)}</span>
                    </td>
                    <td className="px-3 py-3 max-sm:hidden">
                      <Chip tone={KIND[r.kind].tone} dot={false}>
                        {KIND[r.kind].label}
                      </Chip>
                    </td>
                    <td className="num px-3 py-3 text-right font-medium">{formatInt(r.count)}</td>
                    <td className="num py-3 pr-4 pl-3 text-right text-xs whitespace-nowrap text-muted-foreground sm:pr-5">{timeAgo(r.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Recent blocks" description="Newest first" bodyClassName="p-0 sm:p-0">
          {denials.isPending ? (
            <RowsSkeleton className="px-5" rows={6} />
          ) : (denials.data?.length ?? 0) === 0 ? (
            <EmptyState icon={<ShieldBan className="size-4" />} title="No refusals">
              Try the demo attacks: an unlisted payee, a price above the per-call cap or a replayed voucher all appear here.
            </EmptyState>
          ) : (
            <ul className="divide-y">
              {denials.data!.slice(0, 30).map((d) => (
                <DenialItem key={d.id} denial={d} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
