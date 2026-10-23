# Judge Q&A - Payminto Clearing

The 20 hardest questions we expect, with answers grounded in `docs/SPEC.md` and the research files.
Answer in 20 to 40 seconds.
Lead with the direct answer, then one fact, then stop.
If the honest answer is "not yet", say "not yet", then say what exists and when the rest lands.
Never claim users, audits, partnerships or mainnet numbers that are not true on the day.

Rule for every answer that involves a number: say the number from the morning rehearsal, or say "about" and the order of magnitude.

---

## HSP and HashKey fit

### 1. Is this real HSP, or your own imitation of it?

It is the HSP wire v1 format: the same EIP-712 Mandate, the same `signerProof`, the same capability-based verifier rule, "ACCEPT iff required is a subset of satisfied".
Each net transfer is an HSP Mandate with `settlementBinding` set to our batch id, co-signed by the paying agent.
The official SDK repo `project-hsp/hsp` was not public when we built, and last edition's Coordinator host no longer resolves, so we built behind one `HspPort` interface with two adapters: a built-in local adapter, and a Coordinator client that follows the documented REST flow.
`<IF COORDINATOR CREDENTIALS ARRIVED: "Our mainnet batch went through the official Coordinator; here is the payment id.">`
`<IF NOT: "Our mainnet batch used the local adapter. The swap to the official SDK is one adapter, and we asked the organizers for credentials on <DATE>.">`

### 2. What does HSP actually add here, if your contract already verifies everything?

The contract proves the batch was honest.
HSP makes each resulting transfer a standard, portable payment object that any relying party, a licensed node, an auditor or a counterparty, can verify without understanding our contract.
It also gives us the compliance hook: the same mandate can require `attests:kyc` and `attests:sanctions` capabilities from an HSP issuer.
Our contribution is the layer below: HSP proves the payment, our Merkle root proves every call inside it.

### 3. HSP is wallet-settling, but your hub moves the funds: does that break HSP?

The hub calls `transferFrom(debtor, creditor)`, so the ERC-20 `Transfer` event has `from` equal to the debtor, who is the HSP mandate signer.
The money goes wallet to wallet; the hub is the caller, never a holder.
Our local adapter checks exactly that log, plus payer, recipient, token, amount and batch id.
Whether the official `evm-transfer` adapter also requires the transaction sender to be the payer is something we have asked the organizers; if it does, the fix is a registered custom adapter via `@hsp/devkit`, which HSP explicitly supports.

### 4. Why HashKey Chain and not Base, where most x402 traffic is?

Because HashKey is building the compliant agent-economy stack we want to sit on: HSP, licensed verification, and off-ramp partners like ONERWAY.
Netting matters more on a chain with a real fee floor, and HashKey Chain's base fee was 500 gwei when we measured it.
The contract and node are EVM-generic, so Base is a config change later, but HashKey is where the settlement and compliance layer is native.

---

## Compliance and regulation

### 5. HashKey is a licensed group: how does a compliance team get comfortable with agents paying each other?

Four controls exist today.
An owner-signed mandate with a payee allowlist, so an agent can only pay counterparties a human approved.
Hard caps enforced twice, by the node per call and by the contract at settlement.
A full audit trail: every call, every denial with its rule, every journal, anchored by a Merkle root on chain.
Instant off-chain revocation.
What is not built yet: requiring `attests:kyc` and `attests:sanctions` from an HSP issuer on each net transfer.
The mandate already carries `requiredCapabilities`, so that is configuration plus an issuer, and it is first on our roadmap.

### 6. Doesn't netting hide the gross flows from regulators?

No.
Netting reduces transfers, not records.
Every gross call is in the operator's double-entry ledger and committed in the batch Merkle root on chain, so any single call can be proven to an auditor.
The net transfer is what moves money; the gross record is what you report.

### 7. How does this work under Indian rules: 1% TDS, the 30% tax, RBI's stance?

We do not pitch crypto against UPI, and we do not give tax advice.
Stablecoins are treated as virtual digital assets in India, so transfers can carry 1% TDS under Section 194S and gains are taxed at 30%.
What we provide is the evidence: per-call, per-batch and per-transfer records with on-chain anchors, exportable for whoever files.
Our first India customers are exporters of API and agent services paid from abroad, where the alternative is SWIFT or PayPal; they will need an Indian tax adviser and a licensed off-ramp, which is why we are asking for HSP's licensed partner introductions.

---

## Trust, custody and security

### 8. Agents approve your hub to spend their tokens, so isn't the hub a honeypot?

The hub holds no balance at any time; it only moves funds between wallets inside `settleBatch`.
It can only move what a valid agent-signed voucher authorizes, up to the mandate's total cap, to payees in the mandate's allowlist root.
So the worst case for an agent is bounded by the mandate it signed, and the SDK approves the cap, not unlimited.
The contract is not audited yet; we say so, and an independent audit is on the 90-day roadmap before real volume.

### 9. What if the Clearing Node lies?

It cannot forge a payment: vouchers are signed by the agent and the contract re-verifies every signature and cap on chain.
It cannot inflate a net transfer: the agent's co-sign loop refuses any HSP mandate larger than its own accepted receipts justify, and the contract recomputes the netting.
It cannot hide a call: the Merkle root is on chain and the agent holds its own signed receipts.
What a node can do is refuse service or delay settlement; `settleBatch` is permissionless, so a provider holding the latest voucher can settle without that node.

### 10. What stops voucher replay, forgery, or a stolen agent key?

Replay: vouchers are cumulative, and the hub pays only `cumulative - settled[mandate][payee]`, so an old voucher pays zero.
Forgery: EIP-712 signatures bound to the chain id and the hub address, checked on chain.
A stolen agent key is bounded by the mandate: the thief can only pay allowlisted payees, within per-call, daily and total caps, before the owner revokes.
That is the point of a mandate: the key is not the budget.

### 11. How fast is revocation, and what happens to vouchers already in flight?

Off chain it is instant: the node stops accepting vouchers for that mandate the moment `revoke` is called.
On chain, `revokeMandate` gives a one-hour grace period during which already-issued vouchers can still settle.
That grace is deliberate: a provider who already served a call should not be stiffed by a revocation that lands after the service.

### 12. The provider serves before it gets paid, so what if the agent drains its wallet first?

That is real credit risk, and we bound it rather than hide it.
Before accepting each voucher the node checks the agent's outstanding unsettled total plus this call against the minimum of its balance and its allowance, and denies with `INSUFFICIENT_FUNDS`.
Balance and allowance refresh every 30 seconds while calls are unsettled, and the settle interval sets the exposure window.
At settlement, debtors that can no longer pay are dropped from the batch, their calls stay outstanding, and a warning is raised.
For larger tickets, the roadmap has escrowed vouchers that lock funds until delivery.

### 13. Is the contract audited?

No.
It has Foundry tests and an end-to-end test against a live deployment; the policy engine has a unit test for every denial rule.
We would not route production volume through it before an independent audit, which is on the roadmap.

---

## Economics and scale

### 14. Do the gas economics actually work on HashKey Chain?

We measured it (docs/GAS.md): one ERC-20 transfer is about 34,000 gas, so 640 calls paid one by one need 22.04M gas.
One netted settleBatch cleared the same 640 calls for about 1.91M gas, 11.6x less, about 3,000 gas per call.
At the 500 gwei base fee we observed, a per-call transfer costs about 0.017 HSK, which rivals a 0.002 USDC call price.
Our mainnet batch settled `<N_CALLS>` calls with `<SETTLE_GAS_USED>` gas, about `<GAS_PER_CALL>` gas per call, and moved money in `<N_TRANSFERS>` transfers.
Gas is paid by the node operator, not the agent, so every voucher is gas-free.

### 15. A batch is capped at 64 claims, so how does this scale?

A claim is not a call.
A claim is the latest cumulative voucher per (mandate, payee) pair, so one claim can cover ten calls or a million.
64 claims is 64 agent-payee relationships per transaction.
Beyond that, the node splits into chunks of 64 in the same settlement run; netting is computed within each chunk.
Next steps are netting across chunks and peered nodes that net across operators.

### 16. Why not just use x402, now that it has upto and batch-settlement schemes?

We use x402 on the wire; any x402 client sees a normal 402.
x402 answers "how does a request ask for money"; it has no portable mandate across calls, no multilateral netting between many agents, and no per-call proof inside a settled batch.
`upto` is single-use per authorization by its own spec.
We are the clearing layer behind the 402, not a replacement for it.

---

## Business and defensibility

### 17. If you take 0% of payments, how do you make money?

Same model as the Payminto gateway: an open-source core, and paid enterprise licences, managed nodes and connectors.
Later, a hosted clearing network that nets across many operators, priced per settled batch, not per call.
Staying out of the money path is the product; charging a percentage would put us back in it.

### 18. What stops Coinbase, Circle or Skyfire from doing this next quarter?

Circle Nanopayments validates the architecture, but it is Circle-operated and USDC-only, and we found no source putting it on HashKey Chain.
Skyfire and Nevermined are hosted platforms; providers who want their own keys, data and ledger will not move there.
Our moat is being the neutral, self-hosted operator layer with the HSP integration done properly, and owning the developer relationships while volume is small.
Honestly, a big player could copy the mechanism; the bet is on neutrality, compliance fit and speed.

### 19. Who is your first paying customer, and do you have any traction?

No external users yet; all mainnet volume is from our own demo agents and providers.
Our first ten design partner targets are Indian API, data and MCP tool builders who sell to agents abroad, and Indian agent startups that need budgets for their agents.
`<N_DESIGN_PARTNERS>` conversations are started as of `<DATE>`.
The ask today includes introductions to ten more.

### 20. Is this built during the hackathon, or is it an existing product rebranded?

The contracts, node, SDK, MCP server and dashboard were all written during the hackathon, from the first commit on `<FIRST_COMMIT_DATE>`.
Payminto, the parent open-source gateway, existed before; we reused its design ideas, double-entry ledger, idempotent claims and self-hosting, not its code.
The git history is public in the repo.

---

## Questions to deflect gracefully

- "What's your token?" There is no token.
  Settlement is in USDC.e.
- "What's your valuation?" We're here for incubation and design partners; we'll raise when partners are live.
- "Can I see the admin panel?" Yes, read-only; never share the admin token on screen.
