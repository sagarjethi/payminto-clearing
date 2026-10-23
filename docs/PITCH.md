# Pitch - Payminto Clearing

Presenter: Sagar Jethi, founder, in person in Mumbai.
Format: live pitch plus Q&A on Demo Day, Nov 4, at ATLAS SkillTech University.
Three judges are in the room and two HashKey Chain judges are remote, so every slide must read on a shared screen and every claim must survive a Blockscout click.

Voice: there is no `~/VOICE.md` yet, so this script follows the payminto.io voice.
Short declarative sentences.
"You" and "your".
Confident, no hype, candid about what is built and what is not.
If Sagar has his own phrasing for a line, his phrasing wins.

---

## 1. Strategy in five lines

1. The two HashKey judges score HSP depth and mainnet; the three room judges score "does it work, is it clear, is it a company".
   Hit both in the first 30 seconds.
2. Our one-line wedge: per-call settlement is uneconomic on HashKey Chain, netting fixes it, HSP proves it.
3. The demo is the pitch.
   Every claim on a slide is shown live in the demo or on Blockscout.
4. Show the denial.
   A prompt-injected agent failing to pay a stranger is the moment the room remembers.
5. End with the company and the ask, because the real prize is HashKey Capital incubation, not 2,500 USDT.

### What makes us top 3

- Mainnet, live, verified, with HSP on every transfer.
  Most teams will show testnet or a slide.
- A mechanism nobody else has: multilateral netting with a per-call Merkle proof inside an HSP payment.
- A judge does the verifying.
  Letting a judge pick any call and watching `verifyReceipt` return `true` turns us from "a demo" into "a protocol".
- Past winners solved a named business workflow.
  Ours is "an API provider charging agents per call", stated in the first minute.
- A real company behind it: Payminto already exists as an open-source gateway, and this is its agent rail.

### What to cut if time runs short (in this order)

1. Streamable HTTP transport on the MCP server (stdio is enough for the demo).
2. Ledger and Settings dashboard pages (show the trial balance in the batch detail instead).
3. Live price source for Market Data (use the deterministic fallback).
4. Auto-settle interval worker (manual "Settle now" is the demo).
5. Coordinator mode, only if the organizer never issues credentials (ship `local` mode and say so honestly).
6. Safe-owned mandate in the wizard (keep ERC-1271 support in the contract, show an EOA owner).

Never cut: mainnet ClearingHub, the denial, the Netting view with Settle now, the judge-picked proof, HSP status per transfer.

---

## 2. Three-minute script (timed)

Total: 3:00.
The live demo inside the pitch is the compressed 70-second version.
If the slot allows a separate demo, run the full `docs/DEMO_SCRIPT.md` instead and shorten section C to a single sentence.

### A. Hook (0:00 - 0:25) - slides 1 and 2

> On HashKey Chain, one stablecoin transfer costs about 34 thousand gas.
> An AI agent buying a market quote pays two tenths of a cent.
> Settle every call on chain and the gas rivals the price of the call itself.
> That is why nobody prices an agent call at a fraction of a cent.
> And that is the whole agent economy HashKey is betting on.
> I'm Sagar, I build Payminto, an open-source payment gateway you run on your own servers.
> Today I'll show you Payminto Clearing.

### B. Insight (0:25 - 0:45) - slide 3

> Banks solved this fifty years ago.
> You don't settle every card swipe.
> You clear them, you net them, and you move only the difference.
> We built that for agents, with one change: nobody in the middle holds the money, and every single call is provable on chain.

### C. Product (0:45 - 1:05) - slide 4

> It's three things.
> An owner signs one mandate: this agent may spend this much, per call, per day, only with these payees, until this date.
> The agent pays per call with a signed voucher.
> No gas.
> Standard x402.
> And a Clearing Node, which the API provider runs next to its own API, nets hundreds of vouchers into a few transfers on HashKey Chain, each one an HSP payment.

### D. Live demo (1:05 - 2:15) - slide 5, then screen share

> Here's the dashboard, connected to HashKey Chain mainnet.
> This mandate was signed by the owner: <TOTAL_CAP> USDC total, <PER_CALL_CAP> USDC max per call, three payees.
> [Start run] Two agents are now making about five hundred paid calls to three services.
> Watch the gas counter.
> Zero.
> [Injection fires] Now the agent gets prompt-injected and tries to pay a wallet that is not on its list.
> Denied.
> Payee not allowed.
> Nothing moved.
> [Netting view] Left side: every obligation between every agent and every provider.
> Right side: what actually moves.
> [Settle now] One transaction on HashKey Chain.
> Five hundred calls, <N_TRANSFERS> transfers.
> [Batch detail] Each transfer is an HSP payment, and each one says ACCEPT.
> [Turn to judges] Pick any call.
> Any number.
> [Paste it] This is its Merkle proof, checked by the contract on mainnet.
> True.

### E. Why HSP and HashKey (2:15 - 2:30) - slide 7

> HashKey's whitepaper says stablecoins become the cash settlement layer for agent-to-agent commerce.
> HSP makes every payment verifiable.
> We make every call inside that payment verifiable, and we make it cheap enough to exist.

### F. Company and ask (2:30 - 3:00) - slides 8, 9, 10

> The node is open source and free, and we take zero percent of the money.
> We earn on enterprise licences, managed nodes, and later a clearing network priced per batch, not per call.
> Our first customers are Indian API and MCP tool builders selling to agents abroad, a cross-border gap UPI doesn't cover.
> We're asking for HashKey Capital incubation, introductions to HSP's licensed partners for compliance and off-ramp, and ten design partners from this room.
> Payminto Clearing.
> Pay per call.
> Settle the difference.
> Thank you.

Delivery notes:
- Say numbers slowly.
  "Five hundred calls. Three transfers." Then pause.
- Never read the slide.
  The slide is the number; the voice is the story.
- If the demo stalls for more than 5 seconds, say "this is mainnet, blocks are two seconds", and switch to the fallback video at the same timestamp (see `docs/DEMO_SCRIPT.md`).
- Replace `<N_TRANSFERS>` with the number from the rehearsal run, and only say a number you have seen on screen that morning.

---

## 3. Ten-slide deck

Design bar: calm, institutional fintech, matching the dashboard.
Off-white background (dark variant for the room projector), one accent color, one typeface, large numerals.
No coins, no rockets, no neon gradients.
Every number has a unit.
Every address is truncated with a Blockscout link in the PDF version.

### Slide 1 - Title

Copy:
- **Payminto Clearing**
- Clearing for AI agents on HashKey Chain.
- Sagar Jethi - Payminto - Agent Payments & A2A Settlement track

Visual:
the netting graph from the dashboard, many thin edges collapsing into three bold arrows, in the accent color.

### Slide 2 - Problem

Copy:
- **One agent call: 0.002 USDC.**
- **Settling it on chain: about 34,000 gas, 0.017 HSK at 500 gwei.**
- Per-call settlement costs more than the thing being bought.
- And nobody hands an autonomous agent an open wallet.

Visual:
two bars side by side: "640 calls, one transfer each: 22.04M gas" and "640 calls, cleared in one batch: 1.91M gas".
Footnote: "Measured with our ClearingHub, see docs/GAS.md; base fee 500 gwei observed 2026-10-24."

### Slide 3 - Insight

Copy:
- **Don't settle calls.
  Clear them.**
- Card networks and interbank clearing net millions of obligations into a few transfers.
- Agents need the same thing, without a custodian in the middle.

Visual:
left, a dense mesh of arrows between six nodes labelled "agents" and "APIs"; right, the same nodes with three arrows.

### Slide 4 - Product

Copy:
- **1.
  Mandate.** The owner signs a budget once: total, per call, per day, payees, expiry.
- **2.
  Voucher.** The agent pays per call with a signed cumulative voucher.
  Gas-free. x402 v2.
- **3.
  Clearing.** The provider's own node nets hundreds of vouchers into a few HSP payments on HashKey Chain.
- Non-custodial.
  Self-hosted.
  Open source.

Visual:
three columns with one icon each (key, receipt, scale), and the dashboard Overview screenshot underneath.

### Slide 5 - Live demo

Copy:
- **Live on HashKey Chain mainnet**
- ClearingHub `<HUB_ADDRESS_SHORT>`
- ~500 calls.
  1 injected payment denied.
  1 transaction.
  `<N_TRANSFERS>` HSP payments.
  1 proof you pick.

Visual:
a QR code to the ClearingHub on hsk.blockscout.com, so remote judges can follow on their own screen.

### Slide 6 - How it works

Copy:
- Owner signs Mandate (EIP-712) -> `openMandate` on chain
- Agent -> 402 -> signed Voucher -> provider -> Clearing Node checks 13 rules atomically -> signed receipt
- `settleBatch`: hub re-verifies every signature and cap, nets, moves net amounts wallet to wallet
- Merkle root of every call on chain -> `verifyReceipt` for any single call
- Each net transfer = HSP Mandate, `settlementBinding = batchId`, debtor co-signs -> HSP Receipt -> `ACCEPT`

Visual:
sequence diagram with four lanes (Owner, Agent, Provider + Node, HashKey Chain) and the HSP verifier as a fifth box on the right.

### Slide 7 - Why HSP and HashKey

Copy:
- **HSP proves the payment.
  We prove every call inside it.**
- Zero-custody and wallet-settling, like HSP.
- AP2-style mandates, enforced on chain.
- Built on: HSP wire v1 `<or @hsp/sdk>`, canonical USDC.e, Safe (ERC-1271 owners), HashKey Chain mainnet, Blockscout-verified source.

Visual:
the batch detail screen, cropped to the HSP column showing ACCEPT on each transfer, next to the HashKey Chain and HSP marks (only if brand use is allowed by the organizer; otherwise text labels).

### Slide 8 - Market and traction

Copy:
- **Who pays:** API, data and MCP tool providers; agent builders; enterprises running fleets of agents.
- Agentic commerce forecasts run from hundreds of billions to trillions of dollars by 2030.
  Real agent payment volume today is still tiny.
  We are building the rail before the traffic.
- **Traction (honest):** built in `<N_DAYS>` days; `<N_MAINNET_CALLS>` mainnet calls and `<N_MAINNET_BATCHES>` batches, all from our own demo agents; `<N_DESIGN_PARTNERS>` design partner conversations started.

Visual:
a simple three-segment diagram (providers, agent builders, enterprises) with India called out: "Indian API and AI startups selling to agents abroad".
No hockey stick.

### Slide 9 - Business model

Copy:
- **0% of the money.
  Always.**
- Free, MIT-licensed node, SDK, MCP server and contracts.
- Paid: enterprise licence, managed nodes, compliance and off-ramp connectors.
- Later: a neutral clearing network, priced per batch.

Visual:
a four-row table (Free / Enterprise / Managed / Network) with what each includes; no prices yet, or "pricing in design partner phase".

### Slide 10 - Ask

Copy:
- **HashKey Capital incubation.**
- Introductions to HSP licensed partners for KYC, sanctions attestations and fiat off-ramp.
- Ten Indian design partners: API providers, MCP tool builders, agent startups.
- **Payminto Clearing.
  Pay per call.
  Settle the difference.**
- `<GITHUB_URL>` - payminto.io - `<CONTACT>`

Visual:
the title-slide netting graph again, with the GitHub QR code.

---

## 4. Rehearsal checklist

- Two full timed runs on Nov 3 with a stopwatch; the pitch never goes over 3:00.
- One run with Wi-Fi off, using the fallback path, so the switch is muscle memory.
- Every placeholder on slides 5, 7 and 8 is filled from the rehearsal run of that morning.
- Projector check: the netting graph must be readable from the back row; increase stroke width if not.
- Remote check: share the screen into a test call and confirm the HashKey judges can read the Blockscout tab.
