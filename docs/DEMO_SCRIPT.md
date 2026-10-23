# Demo script - Payminto Clearing

Live demo, under 3 minutes, on HashKey Chain mainnet (chain 177).
Built on SPEC section 8 (demo apps) and section 9 (dashboard).
Presenter: Sagar drives the narration.
Operator: a second team member drives the laptop, so Sagar faces the judges.

---

## 1. Setup (done before walking on stage)

Hardware:
- Laptop A (demo): dashboard, terminal, Blockscout tab, fallback video loaded.
- Laptop B (backup): same repo, local anvil mode ready, same fallback video.
- Phone hotspot on a different carrier from venue Wi-Fi.
- HDMI and USB-C adapters, charger.

State at T minus 30 minutes:
1. `CHAIN_ID=177`, `RPC_URL` set to the primary RPC, a second RPC tested and written down.
2. Operator wallet holds enough HSK for `<N_SETTLEMENTS_PLANNED>` batches plus margin (check in Settings page).
3. Treasury Agent and Trading Agent wallets hold USDC.e and have run `approve(hub, cap)` once; allowance visible on the mandate detail page.
4. Both mandates are **open on chain** already (`MandateOpened` visible on Blockscout).
   Signing live costs time and adds a wallet popup risk; we show the signature, not the wait.
5. Three providers running on ports 4101-4103, registered, prices: Market Data 0.002 USDC, Risk Scan 0.01 USDC, Research Writer 0.05 USDC.
6. Clearing Node on `HSP_MODE=<coordinator|local>`, `SETTLE_INTERVAL_SEC=0` (manual settle).
7. Mandate caps are set so the run fits: per-call cap at least 0.05 USDC (Research Writer price) and below the over-cap test call; total cap above the expected gross of the ~500-call run.
   Write the chosen values into `<TOTAL_CAP>` and `<PER_CALL_CAP>` here.
8. Database is a fresh `*.demo.db` file, so the counters start at zero on stage.
9. Dashboard open on **Overview**, dark theme for the projector, browser zoom 125%, notifications off, bookmarks bar hidden.
10. Terminal pre-typed with the demo run command, cursor ready, font size 20.
11. Blockscout tab open on the ClearingHub address.
12. Fallback video open in a paused player at 0:00 in a separate window.

Dry run the full sequence once at T minus 20 minutes on the same network, then reset to a fresh `*.demo.db` (the reset tool refuses anything not ending in `.demo.db` or `.test.db`).

---

## 2. Live demo, click by click (target 2:50)

| Time | Screen | Operator does | Sagar says |
|---|---|---|---|
| 0:00 | Overview | Nothing. KPIs all at zero. | "This is a Clearing Node, the server an API provider runs next to its own API. It's connected to HashKey Chain mainnet." |
| 0:10 | Mandates -> Treasury Agent | Click the mandate row. | "The owner signed one mandate for this agent. <TOTAL_CAP> USDC total. <PER_CALL_CAP> USDC max per call. A daily cap. Three allowed payees. Expires tonight. It's on chain." |
| 0:25 | Blockscout tab | Click the `MandateOpened` event. | "Here's the open on HashKey Chain." |
| 0:32 | Terminal | Run the demo agents command. | "Two agents are now buying from three services. Market data, a risk scan, and a research writer, which is itself an agent that buys from the other two." |
| 0:40 | Overview | Switch back. Live call stream scrolls; calls counter climbs; gas counter stays at 0. | "Each line is a paid call with a signed voucher. Watch this number. Gas: zero." |
| 1:00 | Overview, denial appears in red | Click the denial row when the injection step fires. | "Now the Trading Agent got a prompt injection: pay this wallet for premium data. The wallet isn't on its mandate." |
| 1:08 | Denial detail | Point at the rule. | "Denied. Rule: payee not allowed. Nothing moved, and it's recorded." |
| 1:15 | Denial list | Point at the second denial (per-call cap step). | "And this one tried to pay more than <PER_CALL_CAP> USDC for a single call. Per-call cap. Denied." |
| 1:22 | Netting | Click Netting in the sidebar. | "Calls are done. About five hundred. Left: every obligation between every agent and every service. Right: what will actually move." |
| 1:35 | Netting | Click **Settle now**. | "One transaction." |
| 1:38 | Netting, animated result | Wait for confirmation (2 s blocks). | "Five hundred calls. <N_TRANSFERS> transfers. Compression ratio <RATIO> calls per transfer." |
| 1:50 | Batches -> latest batch | Click the batch. | "Each net transfer is an HSP payment, bound to this batch id. The debtor agent co-signed it after checking the amount against its own receipts." |
| 2:00 | Batch detail, HSP column | Point at ACCEPT on each row. | "HSP verifier: accept, accept, accept." |
| 2:08 | Batch detail -> tx link | Click the Blockscout tx link. | "And here it is on HashKey Chain. NetTransfer events, wallet to wallet. We never held the money." |
| 2:18 | Calls list | Turn to the judges. | "Pick any call. Any number from one to five hundred." |
| 2:25 | Receipt proof | Type the call id the judge says, press Enter. | "This is that call's receipt, and its Merkle path to the root stored in the batch." |
| 2:35 | Receipt proof, on-chain result | Point at `verifyReceipt: true`. | "The contract on mainnet just checked it. True. Every single call is provable." |
| 2:45 | Ledger trial balance (optional, if time) | Click Ledger. | "And the books balance to zero." |
| 2:50 | Back to Overview | Stop. | "That's Payminto Clearing." |

Rules on stage:
- Never type a private key, never show `.env`, never show the `ADMIN_TOKEN` in the URL bar (use the header-auth dashboard session, not `?token=`).
- If a judge picks a call that is not yet in a settled batch (should not happen after Settle now), say "that one lands in the next batch", pick the nearest settled id, and show it.
- Only say numbers that are on screen.

---

## 3. Fallback plan

Decide in under 5 seconds; never debug on stage.

| Failure | Detect | Switch to | Say |
|---|---|---|---|
| Venue Wi-Fi drops | Dashboard SSE shows disconnected badge | Phone hotspot (operator toggles, about 10 s); keep narrating the screen as is | "Let me move us to a hotspot." |
| Primary RPC 403 or slow | Settle now spins more than 10 s | Restart node with the second RPC (one command, pre-typed in a second terminal tab) | "Switching RPC, blocks are two seconds." |
| Mainnet settle fails or reverts | `batch.failed` event in the stream | Play the fallback video from the Settle now timestamp | "This is the same run from this morning, same contract, here's its tx." Then open that real tx on Blockscout. |
| Both networks dead | No Blockscout, no RPC | Laptop B in local anvil mode (`pnpm demo`, about 40 s boot) or the fallback video from 0:00 | "No internet in here, so this is the same code against a local chain. The mainnet transactions are in the submission." |
| Laptop A dies | Obvious | Laptop B, same state, or video | Same as above. |
| Judge-picked proof returns false or errors | Red result | Show the proof for a second call; then the batch root on Blockscout | "Let me pick another one and check the root directly." Write it down and debug after. |

Fallback assets to prepare by Nov 3:
- **Fallback video:** a full screen recording of a real mainnet run from the morning of Nov 4 (or Nov 3 if the morning slot is unsafe), 1080p, no audio, with chapter markers at "run start", "denial", "Settle now", "batch detail", "proof".
- **Local anvil mode:** `pnpm demo` boots anvil, deploys, starts node and providers, creates mandates, runs about 500 calls, settles and checks one proof on chain.
  It is the same code path with `CHAIN_ID=31337`.
- **Screenshot pack:** Overview mid-run, denial detail, netting before and after, batch detail with HSP ACCEPT, proof true, Blockscout tx; put them in the deck appendix.
- **Printed card:** hub address, latest mainnet settle tx hash, and one call id with a known-good proof, so Sagar can read them out if every screen fails.

---

## 4. Two-minute demo video (for DoraHacks)

Format: 1080p, 16:9, voiceover by Sagar, burned-in captions, no music bed louder than -24 dB.
Record the mainnet run first, then the voiceover; cut to the voice.
Upload unlisted to YouTube and paste the link in `docs/SUBMISSION.md`.

| # | Time | Shot | On screen | Voiceover |
|---|---|---|---|---|
| 1 | 0:00-0:08 | Title card | "Payminto Clearing - clearing for AI agents on HashKey Chain" | "Agents are starting to pay each other. Per call, for fractions of a cent." |
| 2 | 0:08-0:20 | Problem card | Two bars: 22.04M gas one-by-one vs 1.91M gas cleared | "Paying every call on chain costs as much gas as the call is worth. So we don't settle calls. We clear them: 11.6x less gas, and zero for the agent." |
| 3 | 0:20-0:32 | Dashboard, mandate detail | Treasury Agent mandate, caps highlighted | "An owner signs one mandate. Total, per call, per day, allowed payees, expiry. It's enforced on chain." |
| 4 | 0:32-0:47 | Overview, live stream | Calls climbing, gas 0 | "Agents pay per call with signed vouchers. Five hundred calls. Zero gas." |
| 5 | 0:47-1:00 | Denial detail, zoom on rule | `PAYEE_NOT_ALLOWED` | "A prompt-injected agent tries to pay a stranger. Denied, with the rule that stopped it." |
| 6 | 1:00-1:18 | Netting, before then after Settle now | Mesh collapsing to a few arrows | "One click. One transaction on HashKey Chain. Hundreds of obligations netted into <N_TRANSFERS> transfers, wallet to wallet." |
| 7 | 1:18-1:32 | Batch detail, HSP column | ACCEPT per transfer | "Each transfer is an HSP payment bound to the batch, co-signed by the payer, verified." |
| 8 | 1:32-1:44 | Receipt proof | Merkle path, `verifyReceipt: true` | "Pick any call. Its Merkle proof checks out on the mainnet contract." |
| 9 | 1:44-1:52 | Blockscout | ClearingHub verified source, settle tx | "Open source. Self-hosted. Non-custodial. Live on HashKey Chain." |
| 10 | 1:52-2:00 | End card | GitHub URL, payminto.io, "Pay per call. Settle the difference." | "Payminto Clearing." |

Video checks before upload:
- Every number in the voiceover matches the screen.
- No private key, `.env`, admin token or personal email visible in any frame.
- Captions have no em dash characters.
