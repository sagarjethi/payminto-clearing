"use client";

import type { ReactNode } from "react";
import { DENIAL_RULES } from "@payminto/protocol";
import { cn } from "@/lib/utils";
import type { BatchStatus, HspStatus, MandateStatus } from "@/lib/schemas";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Tone = "positive" | "warning" | "negative" | "info" | "neutral";

const toneClass: Record<Tone, string> = {
  positive: "bg-positive-soft text-positive",
  warning: "bg-warning-soft text-warning",
  negative: "bg-negative-soft text-negative",
  info: "bg-info-soft text-primary",
  neutral: "bg-muted text-muted-foreground",
};

export function Chip({ tone, children, className, dot = true }: { tone: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-[1.375rem] shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap", toneClass[tone], className)}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

function Explained({ chip, text }: { chip: ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-full">
          {chip}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left">{text}</TooltipContent>
    </Tooltip>
  );
}

export const HSP_EXPLAIN: Record<HspStatus, { tone: Tone; label: string; text: string }> = {
  ACCEPT: {
    tone: "positive",
    label: "ACCEPT",
    text: "HSP verifier accepted: settlement observed and bound to this batch.",
  },
  SETTLED: {
    tone: "positive",
    label: "SETTLED",
    text: "The HSP Coordinator observed the transaction and marked the payment settled.",
  },
  UNSIGNED: {
    tone: "warning",
    label: "UNSIGNED",
    text: "Settled on chain from agent-signed vouchers. The payer agent did not co-sign the HSP mandate within the window.",
  },
  REJECT: {
    tone: "negative",
    label: "REJECT",
    text: "The HSP verifier found a required capability that the receipt does not satisfy. The on-chain transfer happened, but HSP does not attest to it.",
  },
  PENDING: { tone: "neutral", label: "PENDING", text: "Waiting for the debtor agent to co-sign the HSP mandate." },
  COSIGNED: { tone: "info", label: "COSIGNED", text: "The debtor agent co-signed; the HSP payment is waiting for the settlement transaction." },
  SUBMITTED: { tone: "info", label: "SUBMITTED", text: "Submitted to the HSP Coordinator; waiting for it to observe the transaction." },
  FAILED: { tone: "negative", label: "FAILED", text: "The HSP step failed and will be retried. The clearing ledger is not affected." },
};

export function HspChip({ status }: { status: HspStatus | null | undefined }) {
  if (!status) return <Chip tone="neutral">No HSP record</Chip>;
  const e = HSP_EXPLAIN[status];
  return <Explained chip={<Chip tone={e.tone}>{e.label}</Chip>} text={e.text} />;
}

const BATCH: Record<BatchStatus, { tone: Tone; label: string }> = {
  building: { tone: "neutral", label: "Building" },
  cosigning: { tone: "info", label: "Co-signing" },
  submitted: { tone: "info", label: "Submitted" },
  confirmed: { tone: "positive", label: "Confirmed" },
  failed: { tone: "negative", label: "Failed" },
};

export function BatchStatusChip({ status }: { status: BatchStatus }) {
  const b = BATCH[status];
  return <Chip tone={b.tone}>{b.label}</Chip>;
}

const MANDATE: Record<MandateStatus, { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "Opening" },
  open: { tone: "positive", label: "Open" },
  revoked: { tone: "neutral", label: "Revoked" },
  expired: { tone: "neutral", label: "Expired" },
  failed: { tone: "negative", label: "Failed" },
};

export function MandateStatusChip({ status }: { status: MandateStatus }) {
  const m = MANDATE[status];
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

export function CallStatusChip({ status }: { status: string }) {
  if (status === "settled") return <Chip tone="positive">Settled</Chip>;
  if (status === "settling") return <Chip tone="info">Settling</Chip>;
  return <Chip tone="warning">Awaiting netting</Chip>;
}

export function RuleChip({ rule }: { rule: keyof typeof DENIAL_RULES }) {
  return <Explained chip={<Chip tone="negative" className="hash text-[0.6875rem]">{rule}</Chip>} text={DENIAL_RULES[rule]} />;
}
