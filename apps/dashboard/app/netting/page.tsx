"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, Loader2, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { useApi } from "@/lib/session";
import { useLive } from "@/lib/live";
import { qk, useDirectory, useNettingPreview, useToken } from "@/lib/queries";
import { formatInt, formatMoney, formatRatio } from "@/lib/format";
import { netPositions, sumAmounts } from "@/lib/netting";
import { cn } from "@/lib/utils";
import type { NettingPreview } from "@/lib/schemas";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { FlowGraph } from "@/components/app/flow-graph";
import { Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { StatStrip } from "@/components/app/stat-strip";
import { TransferRow } from "@/components/app/transfer-row";
import { BlockSkeleton, EmptyState, ErrorState } from "@/components/app/states";

type Phase = "idle" | "settling" | "done" | "failed";
const STEPS = [
  { key: "build", label: "Build batch and receipts root" },
  { key: "cosign", label: "Collect HSP co-signatures" },
  { key: "submit", label: "Submit settleBatch" },
  { key: "confirm", label: "Confirm on HashKey Chain" },
] as const;

export default function NettingPage() {
  const api = useApi();
  const qc = useQueryClient();
  const preview = useNettingPreview();
  const dir = useDirectory();
  const token = useToken();
  const live = useLive();

  const [phase, setPhase] = useState<Phase>("idle");
  const [snapshot, setSnapshot] = useState<NettingPreview | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);

  const settle = useMutation({
    mutationFn: () => api.settle(),
    onMutate: () => {
      setStartedAt(Date.now());
      setSnapshot(preview.data ?? null);
      setPhase("settling");
      setError(null);
      setBatchId(null);
    },
    onSuccess: (res) => {
      if ("skipped" in res) {
        setPhase("idle");
        toast.info("Nothing settled", { description: res.skipped });
        return;
      }
      setBatchId(res.batchIds[0] ?? null);
    },
    onError: (e) => {
      setPhase("failed");
      setError(e instanceof ApiError ? e.message : "Settlement failed.");
    },
  });

  // The POST may return before the batch is confirmed on a live node; follow it until it is.
  const result = useQuery({
    queryKey: batchId ? qk.batch(batchId) : ["batch", "none"],
    queryFn: () => api.batch(batchId!),
    enabled: Boolean(batchId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === "confirmed" || q.state.data.status === "failed") ? false : 1500),
  });

  useEffect(() => {
    const s = result.data?.status;
    if (s === "confirmed") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- phase follows the polled batch status
      setPhase("done");
      void qc.invalidateQueries();
    } else if (s === "failed") {
      setPhase("failed");
      setError(result.data?.error ?? "The settlement transaction failed.");
    }
  }, [result.data, qc]);

  const stepIndex = useMemo(() => {
    if (phase === "done") return 4;
    if (phase !== "settling") return -1;
    const mine = live.events.filter((e) => new Date(e.at).getTime() >= startedAt - 500);
    if (result.data?.status === "confirmed" || mine.some((e) => e.type === "batch.confirmed")) return 4;
    if (result.data?.status === "submitted" || mine.some((e) => e.type === "batch.submitted")) return 3;
    if (result.data?.status === "cosigning" || mine.some((e) => e.type === "batch.started")) return 1;
    return 0;
  }, [phase, live.events, result.data, startedAt]);

  const shown = phase === "idle" ? preview.data : snapshot ?? preview.data;
  const nameOf = (a: string) => dir.lookup(a)?.name ?? null;

  return (
    <>
      <PageHeader
        title="Netting"
        description="Every accepted call is an obligation from a payer to a payee. Settling clears them all in one transaction that moves only the net differences, wallet to wallet."
      />

      {preview.isPending && phase === "idle" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <BlockSkeleton className="h-[26rem]" />
          <BlockSkeleton className="h-[26rem]" />
        </div>
      ) : preview.isError && phase === "idle" ? (
        <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
      ) : !shown || (shown.gross.length === 0 && phase === "idle") ? (
        <Panel>
          <EmptyState
            icon={<Waypoints className="size-4" />}
            title="Nothing to net yet"
            action={
              <Button asChild variant="outline">
                <Link href="/batches">See settled batches</Link>
              </Button>
            }
          >
            Calls accepted since the last batch appear here as obligations. Run your agents against a provider, then come back to settle.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <Summary preview={shown} />
          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Panel
              title="Gross obligations"
              description={`${formatInt(shown.calls ?? 0)} calls since the last batch, grouped by payer and payee`}
            >
              <FlowGraph
                obligations={shown.gross}
                nameOf={nameOf}
                symbol={token.symbol}
                decimals={token.decimals}
                collapsed={phase === "settling" || phase === "done"}
              />
              <NetPositions preview={shown} nameOf={nameOf} />
            </Panel>

            <Panel
              title={phase === "done" ? "Settled" : "Net transfers the hub will execute"}
              description={
                phase === "done"
                  ? "One transaction, verified and netted on chain"
                  : `${shown.net.length} direct wallet-to-wallet ${shown.net.length === 1 ? "transfer" : "transfers"}, nothing held by the hub`
              }
              bodyClassName="flex flex-col gap-5"
            >
              {phase === "done" && result.data ? (
                <SettledResult batch={result.data} snapshot={shown} />
              ) : (
                <>
                  <ul className="divide-y rounded-lg border">
                    {shown.net.map((t, i) => (
                      <TransferRow
                        key={`${t.from}-${t.to}`}
                        from={t.from}
                        to={t.to}
                        amount={t.amount}
                        marker={
                          <span className="num flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                            {stepIndex >= 3 ? <Check className="size-3.5 text-positive" /> : i + 1}
                          </span>
                        }
                      />
                    ))}
                  </ul>
                  {(shown.skipped?.length ?? 0) > 0 && (
                    <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                      {shown.skipped!.length} mandate(s) cannot pay right now and will stay pending: {shown.skipped!.map((s) => s.reason).join("; ")}
                    </p>
                  )}

                  {phase === "settling" || phase === "failed" ? (
                    <Progress stepIndex={stepIndex} failed={phase === "failed"} error={error} />
                  ) : null}

                  <div className="mt-auto flex flex-col gap-2">
                    <Button
                      size="lg"
                      className="h-12 w-full text-[0.9375rem]"
                      onClick={() => settle.mutate()}
                      disabled={phase === "settling" || shown.net.length === 0}
                    >
                      {phase === "settling" ? <Loader2 className="animate-spin" /> : null}
                      {phase === "settling" ? "Settling" : phase === "failed" ? "Try settling again" : "Settle now"}
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">
                      Anyone can submit settleBatch; the node pays only gas. Funds move directly between agent and provider wallets.
                    </p>
                  </div>
                </>
              )}
            </Panel>
          </div>
          {phase === "done" && (
            <div className="mt-4 flex justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  setPhase("idle");
                  setSnapshot(null);
                  setBatchId(null);
                }}
              >
                Back to live netting
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Summary({ preview }: { preview: NettingPreview }) {
  const gross = preview.grossTotal ? BigInt(preview.grossTotal) : sumAmounts(preview.gross);
  const net = preview.netTotal ? BigInt(preview.netTotal) : sumAmounts(preview.net);
  const saved = gross > 0n ? Number(((gross - net) * 1000n) / gross) / 10 : 0;
  return (
    <StatStrip
      stats={[
        { label: "Calls waiting", value: <span className="num">{formatInt(preview.calls ?? 0)}</span>, note: "accepted since the last batch" },
        { label: "Gross obligations", value: <Money atomic={gross} maxFraction={4} />, note: `${preview.gross.length} payer-payee pairs` },
        { label: "Moved on chain", value: <Money atomic={net} maxFraction={4} />, note: gross > 0n ? `${saved.toFixed(1)}% less than gross` : undefined, tone: "positive" },
        { label: "Compression", value: <span className="num">{formatRatio(preview.compression)}</span>, note: "calls per on-chain transfer" },
      ]}
    />
  );
}

function NetPositions({ preview, nameOf }: { preview: NettingPreview; nameOf: (a: string) => string | null }) {
  const rows = netPositions(preview.gross);
  const owes = new Map<string, bigint>();
  const owed = new Map<string, bigint>();
  for (const g of preview.gross) {
    owes.set(g.from, (owes.get(g.from) ?? 0n) + BigInt(g.amount));
    owed.set(g.to, (owed.get(g.to) ?? 0n) + BigInt(g.amount));
  }
  return (
    <div className="mt-5 border-t pt-4">
      <h3 className="text-sm font-medium">Net position per wallet</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">What each wallet owes minus what it is owed. Only these differences move.</p>
      <div className="mt-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-normal">Wallet</th>
              <th className="py-2 pr-3 text-right font-normal max-sm:hidden">Owes</th>
              <th className="py-2 pr-3 text-right font-normal max-sm:hidden">Is owed</th>
              <th className="py-2 text-right font-normal">Net</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.party}>
                <td className="py-2 pr-3">
                  <span className="font-medium">{nameOf(r.party) ?? "Wallet"}</span>
                </td>
                <td className="py-2 pr-3 text-right text-muted-foreground max-sm:hidden">
                  <Money atomic={owes.get(r.party) ?? 0n} />
                </td>
                <td className="py-2 pr-3 text-right text-muted-foreground max-sm:hidden">
                  <Money atomic={owed.get(r.party) ?? 0n} />
                </td>
                <td className={cn("py-2 text-right font-medium", r.balance < 0n ? "text-negative" : r.balance > 0n ? "text-positive" : "text-muted-foreground")}>
                  <Money atomic={r.balance} signed unitClassName="text-current opacity-70" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Progress({ stepIndex, failed, error }: { stepIndex: number; failed: boolean; error: string | null }) {
  return (
    <ol className="space-y-2.5 rounded-lg bg-muted/60 p-4" aria-live="polite">
      {STEPS.map((s, i) => {
        const done = i < stepIndex;
        const current = i === stepIndex && !failed;
        return (
          <li key={s.key} className={cn("flex items-center gap-2.5 text-sm", !done && !current && "text-subtle")}>
            {done ? (
              <Check className="size-4 text-positive" />
            ) : current ? (
              <Loader2 className="size-4 animate-spin text-primary" />
            ) : (
              <CircleDashed className="size-4" />
            )}
            {s.label}
          </li>
        );
      })}
      {failed && <li className="pt-1 text-sm text-negative">{error}</li>}
    </ol>
  );
}

function SettledResult({ batch, snapshot }: { batch: import("@/lib/schemas").BatchDetail; snapshot: NettingPreview }) {
  const token = useToken();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // On narrow screens the result sits below the graph; bring it into view once it lands.
    if (window.matchMedia("(max-width: 1279px)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      ref.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
  }, []);
  const ratio = batch.transfers > 0 ? batch.calls / batch.transfers : 0;
  const gross = BigInt(batch.gross);
  const net = BigInt(batch.net);
  return (
    <div ref={ref} className="flex scroll-mt-20 flex-col gap-5 animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
      <div className="rounded-lg bg-positive-soft px-4 py-4">
        <p className="flex items-center gap-2 text-sm font-medium text-positive">
          <Check className="size-4" /> Batch #{batch.seq} confirmed
        </p>
        <p className="mt-3 text-[2.5rem] leading-none font-semibold tracking-[-0.03em] text-foreground">
          <span className="num">{formatRatio(ratio)}</span>
          <span className="ml-2 text-base font-normal tracking-normal text-muted-foreground">calls per on-chain transfer</span>
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="num">{formatInt(batch.calls)}</span> calls and{" "}
          <span className="num">{formatMoney(gross, token.decimals, { maxFraction: 4 })}</span> {token.symbol} of obligations cleared with{" "}
          <span className="num">{batch.transfers}</span> transfers moving{" "}
          <span className="num">{formatMoney(net, token.decimals, { maxFraction: 4 })}</span> {token.symbol}.
        </p>
      </div>
      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Transaction</dt>
          <dd>
            <Hash value={batch.txHash} kind="tx" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Batch id</dt>
          <dd>
            <Hash value={batch.id} href={`/batches/${batch.id}`} />
          </dd>
        </div>
      </dl>
      <ul className="divide-y rounded-lg border">
        {batch.netTransfers.map((t, i) => (
          <TransferRow
            key={`${t.from}-${t.to}`}
            from={t.from}
            to={t.to}
            amount={t.amount}
            status={t.hsp?.status ?? null}
            className="animate-in fade-in-0 fill-mode-both"
            style={{ animationDelay: `${150 + i * 120}ms` }}
          />
        ))}
      </ul>
      <Button asChild variant="outline">
        <Link href={`/batches/${batch.id}`}>Open batch #{batch.seq}</Link>
      </Button>
      <span className="sr-only">{snapshot.calls} calls were in the netting snapshot.</span>
    </div>
  );
}
