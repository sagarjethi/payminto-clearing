"use client";

import { useParams } from "next/navigation";
import { useBatch, useMandates } from "@/lib/queries";
import { formatDateTime, formatGas, formatInt, formatRatio } from "@/lib/format";
import type { HspStatus } from "@/lib/schemas";
import { Address, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip, Chip, HSP_EXPLAIN } from "@/components/app/status";
import { StatStrip } from "@/components/app/stat-strip";
import { TransferRow } from "@/components/app/transfer-row";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

const LEGEND: HspStatus[] = ["ACCEPT", "SETTLED", "UNSIGNED", "REJECT"];

export default function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const q = useBatch(id);
  const mandates = useMandates();
  const back = { href: "/batches", label: "Batches" };

  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title={<span className="inline-block h-8 w-48 animate-pulse rounded bg-muted" />} />
        <BlockSkeleton className="h-24" />
        <BlockSkeleton className="mt-5 h-72" />
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Batch" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const b = q.data;
  const labelOf = (mandateId: string) => mandates.data?.find((m) => m.id === mandateId)?.label ?? null;
  const gross = BigInt(b.gross);
  const net = BigInt(b.net);
  const counts = LEGEND.map((s) => ({ s, n: b.netTransfers.filter((t) => t.hsp?.status === s).length }));

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Batch #{b.seq} <BatchStatusChip status={b.status} />
          </span>
        }
        description={b.confirmedAt ? `Confirmed ${formatDateTime(b.confirmedAt)}` : `Started ${formatDateTime(b.createdAt)}`}
      />
      {b.status === "failed" && b.error && <p className="mb-5 rounded-lg bg-negative-soft px-4 py-3 text-sm text-negative">{b.error}</p>}

      <StatStrip
        stats={[
          { label: "Calls cleared", value: <span className="num">{formatInt(b.calls)}</span>, note: `${b.claims} claims, one per mandate and payee` },
          { label: "Gross obligations", value: <Money atomic={b.gross} maxFraction={4} /> },
          {
            label: "Moved on chain",
            value: <Money atomic={b.net} maxFraction={4} />,
            note: gross > 0n ? `${(Number(((gross - net) * 1000n) / gross) / 10).toFixed(1)}% less than gross` : undefined,
            tone: "positive",
          },
          { label: "Compression", value: <span className="num">{formatRatio(b.transfers ? b.calls / b.transfers : 0)}</span>, note: `calls per transfer, ${b.transfers} transfers` },
        ]}
      />

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Net transfers" description="Direct wallet-to-wallet transferFrom, each wrapped as one HSP payment bound to this batch" bodyClassName="p-0 sm:p-0">
            <ul className="divide-y">
              {b.netTransfers.map((t) => (
                <TransferRow key={`${t.from}-${t.to}`} from={t.from} to={t.to} amount={t.amount} status={t.hsp?.status ?? null} className="sm:px-5">
                  {t.hsp?.reason && <p className="mt-2 text-[0.8125rem] text-muted-foreground">{t.hsp.reason}</p>}
                  {t.hsp?.paymentId && (
                    <p className="mt-1.5 text-xs text-subtle">
                      HSP payment <Hash value={t.hsp.paymentId} />
                    </p>
                  )}
                </TransferRow>
              ))}
            </ul>
          </Panel>

          <Panel title="Claims" description="Latest cumulative voucher per mandate and payee; the hub pays the delta over what was already settled" bodyClassName="p-0 sm:p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-5 py-2.5 font-normal">Mandate</th>
                    <th className="px-3 py-2.5 font-normal">Payee</th>
                    <th className="px-3 py-2.5 text-right font-normal">Calls</th>
                    <th className="px-3 py-2.5 text-right font-normal">Cumulative</th>
                    <th className="px-5 py-2.5 text-right font-normal whitespace-nowrap">Paid this batch</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {b.claimList.map((c) => (
                    <tr key={`${c.mandateId}-${c.payee}`}>
                      <td className="px-5 py-2.5">
                        <span className="block font-medium">{labelOf(c.mandateId) ?? "Mandate"}</span>
                        <Hash value={c.mandateId} href={`/mandates/${c.mandateId}`} className="text-xs text-muted-foreground" />
                      </td>
                      <td className="px-3 py-2.5"><Address address={c.payee} explorer={false} copy={false} /></td>
                      <td className="num px-3 py-2.5 text-right">{c.calls ?? "-"}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground"><Money atomic={c.cumulative} maxFraction={4} /></td>
                      <td className="px-5 py-2.5 text-right font-medium"><Money atomic={c.delta} maxFraction={4} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="On chain">
            <Fields>
              <Field label="Transaction"><Hash value={b.txHash} kind="tx" /></Field>
              <Field label="Batch id"><Hash value={b.id} /></Field>
              <Field label="Receipts root"><Hash value={b.receiptsRoot} /></Field>
              <Field label="Token"><Address address={b.token} showName={false} /></Field>
              {b.gasUsed && <Field label="Gas used"><span className="num">{formatGas(b.gasUsed)}</span></Field>}
            </Fields>
          </Panel>
          <Panel title="HSP status" description="What each status on a net transfer means">
            <ul className="space-y-3.5">
              {counts.map(({ s, n }) => (
                <li key={s} className="flex gap-3">
                  <span className="w-[5.75rem] shrink-0">
                    <Chip tone={HSP_EXPLAIN[s].tone}>{s}</Chip>
                  </span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    <span className="num font-medium text-foreground">{n}</span> in this batch. {HSP_EXPLAIN[s].text}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
