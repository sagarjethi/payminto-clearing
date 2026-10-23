"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import type { Hex } from "viem";
import { useMandates, useProof } from "@/lib/queries";
import { formatDateTime, shortHash } from "@/lib/format";
import { replayProof } from "@/lib/merkle-path";
import { cn } from "@/lib/utils";
import type { ReceiptProof } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import { Address, CopyButton, Field, Fields, Hash, Money, PageHeader, Panel } from "@/components/app/primitives";
import { BlockSkeleton, ErrorState } from "@/components/app/states";

export default function ProofPage() {
  const { callId } = useParams<{ callId: string }>();
  const q = useProof(callId);
  const mandates = useMandates();
  const back = { href: "/receipts", label: "Receipt proof" };

  if (!/^0x[0-9a-fA-F]{64}$/.test(callId)) {
    return (
      <>
        <PageHeader back={back} title="Receipt proof" />
        <ErrorState error={new Error(`"${callId}" is not a call id. A call id is 0x followed by 64 hex characters.`)} />
      </>
    );
  }
  if (q.isPending) {
    return (
      <>
        <PageHeader back={back} title="Receipt proof" />
        <BlockSkeleton className="h-24" />
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <BlockSkeleton className="h-96" />
          <BlockSkeleton className="h-96" />
        </div>
      </>
    );
  }
  if (q.isError) {
    return (
      <>
        <PageHeader back={back} title="Receipt proof" />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const p = q.data;
  const label = mandates.data?.find((m) => m.id === p.receipt.mandateId)?.label;

  return (
    <>
      <PageHeader back={back} title="Receipt proof" description={<span className="hash break-all text-sm">{callId}</span>} />
      <Verdict p={p} />
      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <Panel title="Receipt" description="Signed by the clearing node when it accepted the voucher">
          <Fields>
            <Field label="Amount"><Money atomic={p.receipt.amount} className="font-medium" /></Field>
            <Field label="Cumulative"><Money atomic={p.receipt.cumulative} /></Field>
            <Field label="Payee"><Address address={p.receipt.payee} /></Field>
            <Field label="Mandate">
              <span className="flex flex-col gap-0.5">
                {label && <span className="font-medium">{label}</span>}
                <Hash value={p.receipt.mandateId} href={`/mandates/${p.receipt.mandateId}`} />
              </span>
            </Field>
            <Field label="Accepted at">{formatDateTime(new Date(p.receipt.timestamp * 1000).toISOString())}</Field>
            <Field label="Request hash"><Hash value={p.receipt.requestHash} /></Field>
            <Field label="Leaf"><Hash value={p.leaf} /></Field>
            <Field label="Node"><Address address={p.receipt.node} /></Field>
            <Field label="Node signature"><Hash value={p.receipt.nodeSignature} /></Field>
            {p.batchId && <Field label="Batch"><Hash value={p.batchId} href={`/batches/${p.batchId}`} /></Field>}
            {p.txHash && <Field label="Settlement tx"><Hash value={p.txHash} kind="tx" /></Field>}
          </Fields>
        </Panel>
        <MerklePath p={p} />
      </div>
    </>
  );
}

function Verdict({ p }: { p: ReceiptProof }) {
  if (!p.batchId) {
    return (
      <div className="flex items-start gap-3 rounded-xl border bg-card px-5 py-4">
        <CircleDashed className="mt-0.5 size-5 shrink-0 text-warning" />
        <div>
          <p className="font-medium">Accepted, not settled yet</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The node accepted and signed this call. It becomes provable on chain once its batch settles.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link href="/netting">Open netting</Link>
          </Button>
        </div>
      </div>
    );
  }
  const ok = p.onchainVerified === true;
  const unknown = p.onchainVerified == null;
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border px-5 py-4", ok ? "border-transparent bg-positive-soft" : unknown ? "bg-card" : "border-transparent bg-negative-soft")}>
      {ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" /> : unknown ? <CircleDashed className="mt-0.5 size-5 shrink-0 text-muted-foreground" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-negative" />}
      <div className="min-w-0">
        <p className={cn("font-medium", ok ? "text-positive" : unknown ? "" : "text-negative")}>
          {ok ? "Verified on chain" : unknown ? "On-chain check unavailable" : "Proof does not verify on chain"}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          <span className="hash text-foreground">ClearingHub.verifyReceipt(batchId, leaf, proof)</span>{" "}
          {ok ? "returned true. This exact call is part of the settled batch." : unknown ? "was not evaluated by the node." : "returned false."}
        </p>
      </div>
    </div>
  );
}

function HashBox({ value, tone, label }: { value: string; tone?: "leaf" | "root" | "sibling" | "node"; label: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-md border px-2.5 py-1.5",
        tone === "leaf" && "border-primary/40 bg-accent",
        tone === "root" && "border-positive/40 bg-positive-soft",
        tone === "sibling" && "border-dashed bg-muted/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[0.6875rem] text-muted-foreground">{label}</p>
        <p className="hash truncate text-xs">{shortHash(value)}</p>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

function MerklePath({ p }: { p: ReceiptProof }) {
  const replay = useMemo(() => replayProof(p.leaf as Hex, p.proof as Hex[]), [p.leaf, p.proof]);
  const matches = p.receiptsRoot ? replay.root.toLowerCase() === p.receiptsRoot.toLowerCase() : null;
  return (
    <Panel
      title="Merkle path"
      description={p.proof.length ? `${p.proof.length} sibling hashes from this call to the batch root` : "No proof until the call is in a settled batch"}
    >
      {p.proof.length === 0 ? (
        <div className="space-y-2">
          <HashBox value={p.leaf} tone="leaf" label="Leaf (this call)" />
          <p className="text-sm text-muted-foreground">The path appears once a batch includes this call.</p>
        </div>
      ) : (
        <ol className="relative space-y-0" aria-label="Proof steps from leaf to root">
          {replay.steps.map((s, i) => (
            <li key={s.level} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
              <div className="flex flex-col items-center">
                <span className="num flex size-7 items-center justify-center rounded-full border bg-card text-xs text-muted-foreground">{i}</span>
                <span aria-hidden className="w-px flex-1 bg-border" />
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 pb-4 sm:grid-cols-2">
                <HashBox value={s.node} tone={i === 0 ? "leaf" : "node"} label={i === 0 ? "Leaf (this call)" : `Level ${i} node`} />
                <HashBox value={s.sibling} tone="sibling" label={`Sibling ${s.siblingOnLeft ? "(left)" : "(right)"}`} />
                <p className="text-[0.6875rem] text-subtle sm:col-span-2">keccak256 of the sorted pair</p>
              </div>
            </li>
          ))}
          <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span className={cn("flex size-7 items-center justify-center rounded-full", matches ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative")}>
              {matches ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            </span>
            <div className="min-w-0 space-y-2">
              <HashBox value={replay.root} tone={matches ? "root" : undefined} label="Computed root" />
              <p className={cn("text-[0.8125rem]", matches ? "text-positive" : "text-negative")}>
                {matches ? "Equals the receiptsRoot stored on chain for this batch." : `Does not equal the stored root ${p.receiptsRoot ? shortHash(p.receiptsRoot) : ""}.`}
              </p>
            </div>
          </li>
        </ol>
      )}
    </Panel>
  );
}
