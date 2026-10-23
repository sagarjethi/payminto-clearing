"use client";

import Link from "next/link";
import { Layers } from "lucide-react";
import { useBatches } from "@/lib/queries";
import { formatDateTime, formatInt, formatRatio, timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BatchStatusChip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

export default function BatchesPage() {
  const batches = useBatches();
  return (
    <>
      <PageHeader
        title="Batches"
        description="Each batch is one settleBatch transaction. It carries the latest voucher per mandate and payee, a Merkle root over every call, and pays only net amounts."
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {batches.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : batches.isError ? (
          <ErrorState className="m-4" error={batches.error} onRetry={() => void batches.refetch()} />
        ) : batches.data.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-4" />}
            title="No batches settled yet"
            action={
              <Button asChild>
                <Link href="/netting">Open netting</Link>
              </Button>
            }
          >
            Settle accepted calls from the Netting screen, or let the node settle on its interval.
          </EmptyState>
        ) : (
          <>
          <ul className="divide-y md:hidden">
            {batches.data.map((b) => (
              <li key={b.id}>
                <Link href={`/batches/${b.id}`} className="block px-4 py-3.5 hover:bg-muted/40">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">Batch #{b.seq}</span>
                    <BatchStatusChip status={b.status} />
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    <span className="num">{formatInt(b.calls)}</span> calls, <Money atomic={b.gross} maxFraction={4} /> gross, <Money atomic={b.net} maxFraction={4} /> moved
                  </p>
                  <p className="mt-0.5 text-xs text-subtle">
                    <span className="num">{formatRatio(b.transfers ? b.calls / b.transfers : 0)}</span> calls per transfer, {timeAgo(b.confirmedAt ?? b.createdAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <div className="overflow-x-auto max-md:hidden">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 font-normal">Batch</th>
                  <th className="px-3 py-2.5 font-normal">Status</th>
                  <th className="px-3 py-2.5 text-right font-normal">Calls</th>
                  <th className="px-3 py-2.5 text-right font-normal">Gross</th>
                  <th className="px-3 py-2.5 text-right font-normal">Moved on chain</th>
                  <th className="px-3 py-2.5 text-right font-normal">Transfers</th>
                  <th className="px-3 py-2.5 text-right font-normal">Calls per transfer</th>
                  <th className="px-3 py-2.5 font-normal">Transaction</th>
                  <th className="px-5 py-2.5 text-right font-normal">Settled</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {batches.data.map((b) => (
                  <tr key={b.id} className="hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <Link href={`/batches/${b.id}`} className="font-medium hover:underline">
                        Batch #{b.seq}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <BatchStatusChip status={b.status} />
                    </td>
                    <td className="num px-3 py-3 text-right">{formatInt(b.calls)}</td>
                    <td className="px-3 py-3 text-right"><Money atomic={b.gross} maxFraction={4} /></td>
                    <td className="px-3 py-3 text-right"><Money atomic={b.net} maxFraction={4} /></td>
                    <td className="num px-3 py-3 text-right">{b.transfers}</td>
                    <td className="num px-3 py-3 text-right font-medium">{formatRatio(b.transfers ? b.calls / b.transfers : 0)}</td>
                    <td className="px-3 py-3"><Hash value={b.txHash} kind="tx" /></td>
                    <td className="num px-5 py-3 text-right text-xs whitespace-nowrap text-muted-foreground" title={formatDateTime(b.confirmedAt ?? b.createdAt)}>
                      {timeAgo(b.confirmedAt ?? b.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>
    </>
  );
}
