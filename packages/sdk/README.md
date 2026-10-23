# @payminto/sdk

Client side of Payminto Clearing: `OwnerClient` (mandates), `AgentClient` (paying agents) and `paywall()` (providers).
The full API is in `docs/SPEC.md` section 6; this file explains how spending is bounded.

## Policy is enforced twice, and the hard limits a third time

Policy is enforced twice: by the agent before signing and by the node before accepting; total cap, allowlist and expiry a third time on chain.

| Layer | Where | Rules |
|---|---|---|
| Agent, before signing | `AgentClient` (`src/policy-guard.ts`) | MANDATE_NOT_ACTIVE, TOKEN_MISMATCH, PAYEE_NOT_ALLOWED, PER_CALL_CAP, RATE_LIMIT, DAILY_CAP, TOTAL_CAP |
| Node, before accepting | Clearing Node policy engine, one `BEGIN IMMEDIATE` transaction | the full SPEC 5.4 order, including BAD_SIGNATURE, STALE_CUMULATIVE and INSUFFICIENT_FUNDS |
| Chain, at settlement | `ClearingHub.settleBatch` | owner signature, agent signature, total cap, payee allowlist, validity window |

Why the agent layer matters: a voucher is a signed claim that any provider can settle on chain itself, and the hub only checks the total cap, the allowlist and the validity window.
If the agent signed a call that breaks its daily or per-call cap, the node would deny it, but the provider would still hold a settleable signature.
So `AgentClient` checks the mandate policy before it signs, and a refused call never produces a signature.

How the agent gets a policy it can trust:
- It takes `policy: { mandate, policy, payees }` in the constructor, or fetches it from the public `GET /v1/mandates/:id/policy`.
- Either way it verifies that the mandate hashes to its `mandateId`, that `policyHash(policy) === mandate.policyHash` and that `payeesRoot(payees) === mandate.payeesRoot`, so a lying node cannot loosen it.
- If the policy cannot be fetched or does not verify, the agent fails closed: `POLICY_UNAVAILABLE` or `POLICY_MISMATCH`, and nothing is signed.

A refusal emits `denied` with the same `DenialRule` code the node would use (with `details.enforcedBy = "agent"`), and `fetch()` returns a `402` whose body is `{ x402Version: 2, error: { code, message, details } }`.
Caps count this client's accepted spend plus vouchers it is signing right now, so parallel calls to different payees cannot jointly overspend.
The agent can only count what it has seen, so spend by other processes on the same mandate is caught by the node and the hub instead.
`enforcePolicy: false` turns the agent layer off and leaves enforcement to the node and the hub.

## Tests

```sh
pnpm --filter @payminto/sdk test
```
