# Strategy - HashKey Chain Horizon Hackathon, Mumbai edition

This is the decision record for what we build and why.
Sources are the three research reports in `research/`.

## 1. The hackathon in facts

- Event: HashKey Chain Horizon Hackathon, India / Mumbai edition, on DoraHacks (https://dorahacks.io/hackathon/hskchainindia/detail).
- Prize pool: 10,000 USDT, 5,000 per track, split 2,500 / 1,500 / 1,000.
- Tracks: AI Agent Trading, and Agent Payments & A2A Settlement.
- Deadline: November 1, 2026, 21:30 IST. Pitch list: November 3. Demo Day: November 4 in Mumbai. Winners: November 5.
- Hard rules: original work built during the event, built on HashKey Chain, contracts deployed on HashKey Chain mainnet (otherwise no demo slot), HSP required for the payments track.
- Soft rules: officially recommended products earn extra points, in-person Mumbai demos get priority.
- Panel: five judges, three from ecosystem partners and two from HashKey Chain; three in the room, HashKey judges remote.
- Upside beyond prizes: HashKey Capital investment conversations, engineering and compliance support for strong projects, winners or not.

## 2. What the judges reward (inferred, see research/02)

| Criterion | Weight (est.) | What it means for us |
|---|---|---|
| Completeness and technical maturity | 25% | A working product, not slides: contract on mainnet, node, SDK, dashboard, tests. |
| Ecosystem fit and HSP depth | 20% + bonus | HSP is load-bearing, not a logo. Use USDC.e, Safe, Blockscout, official tooling. |
| Innovation | 20% | Something x402, AP2 and Skyfire do not already do. |
| Business value | 20% | A real customer, a fee model, a reason to exist after the event. |
| Compliance and controls | 10% | HashKey is a licensed group: mandates, limits, revocation, audit trail. |
| Pitch and Q&A | 5% | Calm, honest, live. |

Past HashKey payment winners solved a business workflow (B2B invoicing, payroll on HSP, a unified agent payment gateway with AML).
Plain payment links, natural-language wallets and simple spend-limit wallets lost.

## 3. Ideas we evaluated

We scored each idea 1-5 on judge appeal, buildability by November 1, and real product-market fit.

| Idea | Track | Appeal | Build | PMF | Total | Verdict |
|---|---|---|---|---|---|---|
| A. Payminto gateway on HashKey Chain (payment links, invoices, checkout for merchants, now on HSK) | Payments | 2 | 5 | 3 | 10 | Rejected as the lead: it is the "payment link" pattern that lost before, and it is not agent-native. Its strengths live on inside idea C (self-hosting, ledger, webhooks, MCP). |
| B. Agent-to-agent payments with escrow per task (pay on verified delivery) | Payments | 4 | 3 | 4 | 11 | Strong, but verification of "delivery" is subjective and slow to demo. Kept as roadmap: escrow becomes a mandate type. |
| C. Payminto Clearing: mandate-bound budgets, gas-free vouchers over x402, multilateral netting, HSP-wrapped settlement, Merkle-provable calls | Payments | 5 | 4 | 5 | 14 | Chosen. |
| D. Signal marketplace for trading agents: providers paid per signal, part escrowed and released on realized PnL | Trading | 4 | 3 | 3 | 10 | Best fit for the trading track and reuses about 70% of C. Build only if C is finished early. |

## 4. Why idea C wins

- It answers the market gap the research found: x402 moves single payments, AP2 proves consent, ERC-8004 proves identity, but nobody owns the middle layer that meters, caps, nets and proves agent spend, and nobody offers it self-hosted.
- It makes HSP load-bearing: every net transfer is an HSP payment bound to the batch it clears through `settlementBinding`, and the node is an HSP adapter.
- It fits HashKey's compliance identity: owner-signed mandates, per-call, daily and total caps, payee allowlists, revocation with a grace window, a double-entry ledger, and a Merkle proof for every single call.
- It has a clear "wow" moment: hundreds of calls, zero gas, a prompt-injected payment refused with the rule cited, then one click clears everything into a handful of on-chain transfers.
- It turns Payminto from "a gateway" into "the clearing layer for the agent economy", which is an investable story for HashKey Capital.

## 5. Team roles

| Role | Owns |
|---|---|
| Principal engineer | Architecture, `ClearingHub` contract, protocol package, security review, integration. |
| Backend engineer | Clearing Node, SDK, settlement worker, HSP adapter, ledger. |
| Frontend engineer and UI/UX lead | Operator dashboard and its design system. |
| Agent engineer | MCP server and the live demo agents and providers. |
| Marketing lead | Submission text, launch posts, design-partner list. |
| Hackathon strategist (serial winner) | Pitch, demo script, judge Q&A, scope cuts. |

## 6. Risks and what we do about them

| Risk | Mitigation |
|---|---|
| HSP SDK repo is 404 and the hackathon Coordinator is offline. | Built against HSP wire v1 behind an `HspPort` with a local adapter and verifier; coordinator adapter ready for the keys. Ask organizers on day one (`docs/ORGANIZER_ASK.md`). |
| Mainnet deployment needs real HSK for gas. | The founder deploys with his own key using `docs/DEPLOY.md`; it costs cents at HashKey Chain gas prices. |
| Live RPC or Wi-Fi fails on stage. | Local anvil mode runs the full demo offline; pre-recorded video as a last resort. |
| Judges see "just x402". | Lead with what x402 cannot do: budgets across many providers, netting, per-call proofs, self-hosted. |

## 7. What changes versus the earlier Payminto hackathon stack

The earlier `payminto/hackathon/` stack paired Payminto with Kuberopay card rails and Chainlink CRE for a different event.
For HashKey we built a separate product in this folder with its own git repository.
The fiat and card money movement (Kuberopay, Payvang, BitGo) is deliberately out of scope here: everything settles in stablecoins on HashKey Chain, non-custodially.
