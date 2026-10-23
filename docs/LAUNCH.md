# Launch plan - Payminto Clearing

Short go-to-market plan for the hackathon window and the 30 days after.
Nothing here is posted automatically; Sagar posts from his own accounts.
Do not post before the mainnet contract is verified and the demo video is live, so every claim has a link.

Timing:
- **Nov 1, after submission:** X thread, LinkedIn post, Telegram blurb.
- **Nov 3, if selected for the pitch:** quote-post the thread with "pitching in Mumbai tomorrow".
- **Nov 4 evening:** one post with a photo from Demo Day and the result, whatever it is.
- **Nov 1 to Nov 7:** India Blockchain Week (Nov 1-2) and ETHGlobal Mumbai (reported Nov 5-7) put Indian builders and VCs in the same city; book design partner meetings there.

Honesty rules for every post:
- "Live on HashKey Chain mainnet" only with a Blockscout link.
- No user, partner or volume claims; mainnet volume is from our own demo agents.
- Numbers come from the actual mainnet run.

---

## 1. X / Twitter thread (6 posts)

**1/**
AI agents are starting to pay each other per call.
A market quote.
A risk score.
A tool call.
Fractions of a cent each.
Settle each one on chain and the gas costs more than the call.

We built Payminto Clearing to fix that, on <@HASHKEY_CHAIN_X_HANDLE>.
`<DEMO_VIDEO_URL>`

**2/**
The idea is 50 years old.
Card networks don't settle every swipe.
They clear, net, and move only the difference.

Payminto Clearing does that for agents.
With no custodian in the middle.

**3/**
How it works:
- An owner signs one mandate: total, per call, per day, allowed payees, expiry
- The agent pays per call with a gas-free signed voucher, over x402
- The provider's own node nets hundreds of vouchers into a few transfers on HashKey Chain

**4/**
Every net transfer is an HSP payment bound to the batch.
Every single call is provable with a Merkle proof checked by the contract on mainnet.

`<N_CALLS>` calls.
`<N_TRANSFERS>` transfers.
1 transaction.
`https://hsk.blockscout.com/tx/<SETTLE_TX_MAINNET>`

**5/**
And the part we care about most:
a prompt-injected agent tried to pay a wallet that wasn't on its mandate.
Denied.
Rule cited.
Nothing moved.

The key is not the budget.
The mandate is.

**6/**
Open source.
Self-hosted.
Non-custodial.
0% of the money.
Built for the HashKey Chain Horizon Hackathon, Mumbai.

If you sell an API or MCP tool to agents, especially from India, I want to talk.
`<GITHUB_URL>`

---

## 2. LinkedIn post

AI agents are about to become customers.
They'll buy a market quote, a risk check or a research brief from another agent, thousands of times a day, for fractions of a cent each.

The problem is that putting each of those payments on a blockchain costs more than the payment.
And no finance team will hand an autonomous agent an open wallet.

This week we built Payminto Clearing for the HashKey Chain Horizon Hackathon in Mumbai.

An owner signs one mandate that sets the agent's budget: total, per call, per day, who it may pay, and until when.
The agent pays per call with a signed voucher that costs no gas.
The API provider runs its own Clearing Node, which nets hundreds of calls into a few transfers on HashKey Chain, each one a verifiable HSP payment.
Any single call can be proven against the batch on chain.
Nobody, including us, ever holds the money.

It's open source and self-hosted, like the Payminto gateway it extends.

I'm looking for ten design partners in India: API and data providers, MCP tool builders, and AI agent startups who want to charge, or pay, per call across borders.
If that's you, comment or message me.

Demo: `<DEMO_VIDEO_URL>`
Code: `<GITHUB_URL>`

#AIAgents #Stablecoins #HashKeyChain #Payments #BuildInIndia

---

## 3. Telegram blurb (HashKey Chain community, builder groups)

Payminto Clearing: clearing for AI agents on HashKey Chain.
Agents pay APIs, MCP tools and other agents per call with gas-free signed vouchers under an owner-signed mandate.
The provider's self-hosted node nets hundreds of calls into a few HSP payments on mainnet, and every call is provable on chain.
Open source, non-custodial.
Demo: `<DEMO_VIDEO_URL>` - Code: `<GITHUB_URL>` - Contract: `https://hsk.blockscout.com/address/<HUB_ADDRESS_MAINNET>`
Feedback very welcome, especially from teams building agents.

---

## 4. First 10 design partners (India)

Goal: ten teams running a Clearing Node or the SDK against testnet within 30 days, and two on mainnet with real counterparties within 90 days.
None of the examples below has been contacted; they are prospects, and the right person must be found before outreach.

### Who we want

| Segment | Why they need us | What they test | Target count |
|---|---|---|---|
| API and data providers selling abroad | Per-call pricing to agents without card fees or SWIFT | `paywall` middleware in front of one paid endpoint | 4 |
| MCP tool builders | Monetize tools per call; no billing system of their own | MCP server plus provider registration | 3 |
| AI agent startups | Need budgets, caps and receipts so customers trust their agents with money | `AgentClient` with a mandate per customer | 3 |

### Example prospects to research (not contacted)

- Indic LLM, speech and translation API companies that sell per request (for example Sarvam AI, Smallest.ai, Gnani.ai).
- Agent tool and integration platforms with Indian founding teams (for example Composio).
- Indian crypto market data and analytics providers whose quotes agents would buy (exchange data APIs, on-chain analytics teams).
- Agent startups from Indian accelerator cohorts and the Apna Coding and ATLAS SkillTech networks at Demo Day.
- Hackathon teams from this edition building agents that need to pay or get paid; offer the SDK to them first.

### Outreach

- Channel: warm intros first (HashKey ecosystem, Demo Day judges and hosts, India Blockchain Week contacts), then a short personal DM.
- Offer: we set up the node with them in one 45-minute call, free, and give their endpoint a slot in the public demo catalog.
- What we ask back: one paid endpoint live on testnet, weekly feedback for four weeks, and permission to name them only if they agree in writing.
- Track in a simple table: name, segment, contact, status (researched, contacted, call booked, integrating, live), next step, date.

### DM template

Hi `<NAME>`, I'm Sagar from Payminto.
We just shipped Payminto Clearing: AI agents pay your API per call with gas-free vouchers under a spending mandate, and settle net on HashKey Chain.
Open source, self-hosted, we take 0%.
Would you try it on one endpoint?
I'll set it up with you in 45 minutes.
Demo: `<DEMO_VIDEO_URL>`
