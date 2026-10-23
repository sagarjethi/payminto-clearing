"use client";

import Link from "next/link";
import { FileSignature, Plus } from "lucide-react";
import { useMandates } from "@/lib/queries";
import { formatDate, percentOf } from "@/lib/format";
import type { MandateRecord } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Address, Meter, Money, PageHeader, Panel } from "@/components/app/primitives";
import { MandateStatusChip } from "@/components/app/status";
import { EmptyState, ErrorState, RowsSkeleton } from "@/components/app/states";

export default function MandatesPage() {
  const mandates = useMandates();
  return (
    <>
      <PageHeader
        title="Mandates"
        description="Each mandate is one owner signature that bounds what an agent may spend: caps, rate, payees and expiry. The node enforces it on every call and the hub enforces it again on chain."
        actions={
          <Button asChild>
            <Link href="/mandates/new">
              <Plus /> Create mandate
            </Link>
          </Button>
        }
      />
      <Panel bodyClassName="p-0 sm:p-0">
        {mandates.isPending ? (
          <RowsSkeleton className="px-5" rows={4} />
        ) : mandates.isError ? (
          <ErrorState className="m-4" error={mandates.error} onRetry={() => void mandates.refetch()} />
        ) : mandates.data.length === 0 ? (
          <EmptyState
            icon={<FileSignature className="size-4" />}
            title="No mandates yet"
            action={
              <Button asChild>
                <Link href="/mandates/new">Create the first mandate</Link>
              </Button>
            }
          >
            An agent cannot pay anyone until an owner signs a mandate for it.
          </EmptyState>
        ) : (
          <>
            <div className="hidden grid-cols-[minmax(0,2.2fr)_6.5rem_minmax(0,2fr)_minmax(0,1fr)_7rem] gap-4 border-b px-5 py-2.5 text-xs text-muted-foreground md:grid">
              <span>Mandate</span>
              <span>Status</span>
              <span>Spend against total cap</span>
              <span className="text-right">Today / daily cap</span>
              <span className="text-right">Expires</span>
            </div>
            <ul className="divide-y">
              {mandates.data.map((m) => (
                <MandateRow key={m.id} m={m} />
              ))}
            </ul>
          </>
        )}
      </Panel>
    </>
  );
}

function MandateRow({ m }: { m: MandateRecord }) {
  const used = BigInt(m.spend.settled) + BigInt(m.spend.pending);
  const pct = percentOf(used, m.mandate.totalCap);
  const daily = percentOf(m.spend.today, m.policy.dailyCap);
  return (
    <li className="relative grid gap-3 px-4 py-4 transition-colors hover:bg-muted/40 sm:px-5 md:grid-cols-[minmax(0,2.2fr)_6.5rem_minmax(0,2fr)_minmax(0,1fr)_7rem] md:items-center md:gap-4">
      <div className="min-w-0">
        <Link href={`/mandates/${m.id}`} className="font-medium after:absolute after:inset-0 hover:underline">
          {m.label}
        </Link>
        <div className="relative z-10 mt-0.5 text-xs text-muted-foreground">
          Agent <Address address={m.mandate.agent} showName={false} />
        </div>
      </div>
      <div className="flex items-center justify-between md:block">
        <MandateStatusChip status={m.status} />
        <span className="text-xs text-muted-foreground md:hidden">Expires {formatDate(Number(m.mandate.validUntil))}</span>
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
          <Money atomic={used} maxFraction={4} className="font-medium" />
          <span className="text-xs text-muted-foreground">
            of <Money atomic={m.mandate.totalCap} maxFraction={2} />
          </span>
        </div>
        <Meter value={pct} tone={pct > 90 ? "negative" : pct > 75 ? "warning" : "primary"} label={`${m.label} spend`} />
      </div>
      <div className="flex items-baseline justify-between text-sm md:block md:text-right">
        <span className="text-xs text-muted-foreground md:hidden">Today</span>
        <span>
          <Money atomic={m.spend.today} maxFraction={4} className={daily > 90 ? "text-negative" : undefined} />
          <span className="block text-xs text-muted-foreground max-md:inline max-md:ml-1">
            of <Money atomic={m.policy.dailyCap} maxFraction={2} />
          </span>
        </span>
      </div>
      <span className="num hidden text-right text-sm text-muted-foreground md:block">{formatDate(Number(m.mandate.validUntil))}</span>
    </li>
  );
}
