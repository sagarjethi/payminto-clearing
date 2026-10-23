# Organizer ask - HSP access for the India edition

Draft only.
Do not send from this file; a human posts it.

Where to post, in this order:
1. HashKey Chain Telegram: https://t.me/HashKeyChainHSK
2. HashKey Chain Discord: https://discord.com/invite/V7kypNm9cS (developer or hackathon channel)
3. DoraHacks Q&A tab on https://dorahacks.io/hackathon/hskchainindia/detail
4. Luvon Labs on Telegram (@cmonvivek24), listed as the Mumbai Demo Day contact, only if 1 to 3 get no answer within 24 hours.

Post once per channel.
Do not tag individuals unless an admin is named in the channel as the HSP contact.

---

## Message (Telegram / Discord)

Hi HashKey Chain team, and thanks for running the Horizon Hackathon in Mumbai.

We're building in the Agent Payments & A2A Settlement track (team Payminto Clearing) and want to integrate HSP properly before the Nov 1 deadline.
The HSP developer guide says the SDK repo, Coordinator URL, API key and faucet are shared by the organizers once the sandbox is up.
We couldn't find them for this edition yet:

- `github.com/project-hsp/hsp` returns 404 / "Repository not found" for us, and the `project-hsp` org shows no public repos.
- `hsp-hackathon.hashkeymerchant.com` (last edition's sandbox) no longer resolves in DNS.

Could you share, for the India edition:
1. The HSP SDK repo link (or npm packages) and the version to target
2. The Coordinator URL (testnet and mainnet, if both exist)
3. How teams get an API key (and whether KYC is needed for mainnet)
4. The faucet for gas and test USDC
5. The x402 facilitator URL for HashKey Chain, if there is one
6. The pinned adapter address we should verify receipts against

Two quick rules questions too:
- Is a self-built adapter that follows the HSP wire v1 spec acceptable if the Coordinator isn't available in time?
- Is HSP plus x402 on the wire fine for this track, or do you want HSP-only flows?

Happy to test the sandbox early and report any issues.
Thank you!

Sagar, Payminto Clearing

---

## Shorter version (DoraHacks Q&A, character-limited)

Hi! Team Payminto Clearing (Agent Payments & A2A track).
Where can we get this edition's HSP SDK repo, Coordinator URL, team API key, faucet, x402 facilitator URL and pinned adapter address?
github.com/project-hsp/hsp returns 404 and hsp-hackathon.hashkeymerchant.com no longer resolves.
Also: is a wire-v1-compliant self-built adapter OK if the Coordinator isn't live in time?
Thanks!

---

## Follow-up tracking

| Channel | Posted at | Answered at | Answer summary |
|---|---|---|---|
| Telegram | `<TIME>` | `<TIME>` | `<SUMMARY>` |
| Discord | `<TIME>` | `<TIME>` | `<SUMMARY>` |
| DoraHacks Q&A | `<TIME>` | `<TIME>` | `<SUMMARY>` |

If there is no answer by Oct 28, ship `HSP_MODE=local` on mainnet, state it plainly in the submission, and keep the Coordinator client ready to switch on.
