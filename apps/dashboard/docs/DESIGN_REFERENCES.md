# Design references

Real-world patterns from Mobbin that shaped the v2 dashboard.
Each line names the app and screen, what we borrowed, and why it fits a clearing console.

## Navigation and overview

- [Whop, business home](https://mobbin.com/screens/db402b81-a03c-414f-b51a-ec6914cb35d3): a sidebar grouped into labelled sections, so we split navigation into Clearing, Controls and Audit instead of one flat list.
- [Airwallex, payments dashboard](https://mobbin.com/screens/f0165978-3117-45a7-88f0-1a8a97007275): grouped money products in the rail with one quiet accent, which kept our calm cobalt-on-paper palette instead of a crypto look.
- [Deel, home](https://mobbin.com/screens/520a8cef-49aa-4139-a150-4a6482faebb9): a "needs your attention" card next to the totals, which became the Overview "Waiting to settle" and "Attacks blocked" cards that lead straight to an action.
- [Mercury iOS, home](https://mobbin.com/screens/82e8f14d-9bf6-4956-bb4d-8d9306d167d3): failed and pending states as inline pills on each transaction row, which is how blocked calls now read in the live stream.
- [Revolut Business iOS, home](https://mobbin.com/screens/41c74abd-3820-4130-b6b9-b08b7a5a77f4): a bottom tab bar for the four most used areas, which replaced the hamburger-only navigation at phone width.

## Mandates as spend controls

- [Revolut Business, card spend controls](https://mobbin.com/screens/f3bc2b86-b6c6-47d6-a2db-640502c359a9): a list of controls where each row has an icon, a name and its current setting, which is the model for the mandate "Spend controls" panel.
- [Airwallex, card details](https://mobbin.com/screens/68dac915-4d2f-4239-9c04-f10cb5a85b90): "Card controls" with a used-of-limit bar and the reset rule beside it, which we use for the daily cap row.
- [Wise, card limits](https://mobbin.com/screens/63f79444-67f7-4c71-a964-cfee71cad090): each limit stated as a sentence with "remaining" under its bar, so every cap reads in plain words.
- [Navan, budget detail](https://mobbin.com/screens/bfe4fd2e-f11f-4088-960e-eb24ace86ab4): one large spent versus left bar above the analysis, which became the mandate budget hero with settled, pending and remaining segments.
- [Cursor, spending limit](https://mobbin.com/screens/32551509-499c-4cdb-9002-a850b00bca24): a single "used / limit" figure pinned to the right of the bar, which we copy for every cap.

## Create mandate wizard

- [Mercury, send money review](https://mobbin.com/screens/cd2dc4bc-de9e-447e-93bf-c12e92c2f2dc): a named step list and a final label/value review before the irreversible action, which our three-step wizard keeps.
- [Navan, set your limits](https://mobbin.com/screens/1835b7cc-8f00-499d-bd95-d6bf5b30da2a): a live preview of the resulting policy beside the inputs, which is why the wizard shows a plain-language policy summary while you type.
- [Airwallex, creating a card flow](https://mobbin.com/flows/d805374d-0c1a-478f-beac-40b4e01813b6): a success toast and the new card's used-of-limit bar right after creation, which is where the wizard lands you.

## Netting and settle

- [Gusto, pay contractors review](https://mobbin.com/screens/eeeecee8-9984-410b-844c-006585e5a934): a summary row of totals and payment count above the line items before submit, which became the before versus after netting hero.
- [Wise, transfer review](https://mobbin.com/screens/ced7c24f-5381-4d74-8c7c-313b54f94540): one huge figure and one primary button, which is why "Settle now" sits in the hero next to the numbers it changes.
- [Deel, payment confirmed](https://mobbin.com/screens/eb392439-083f-4863-b60b-baa13493780b): a green status panel with completed steps and a tracking link, which is the settled state with the transaction hash.

## Transaction detail and receipts

- [Stripe, payment detail](https://mobbin.com/screens/464dcf70-a0d4-4ba9-b23d-ca6ba18e60f5): amount and status badge as the page title, a timeline, then details, which shapes batch and receipt detail headers.
- [Wise, transaction updates](https://mobbin.com/screens/ea2fde3e-8b3e-4ef8-92d9-ea5dc9e51fda): a checked step timeline that ends on the final state, used for the settle progress.
- [Wise, account details match](https://mobbin.com/screens/00a2b34b-0695-4310-9f20-54799eb858bc): a single headline verdict above a list of individually ticked checks, which is the receipt "Verified on chain" moment.
- [Coinbase, you're all set](https://mobbin.com/screens/33903eac-a797-410b-8f40-1328fa2db23f): one solid circular check as the verified mark, kept restrained rather than celebratory.

## Denials and attacks

- [Stripe Radar, block rules](https://mobbin.com/screens/1453565d-f739-47e9-870b-a3b22d47f054): blocked count and blocked volume above a table of rules with a per-rule blocked count, which is the new Blocked calls page.
- [Whop, declined resolution](https://mobbin.com/screens/5694166b-f5c5-4837-9a34-26786ef1d75a): a banner that says "No funds have been moved" in so many words, which every denial now states next to its rule.
- [Vercel, firewall traffic](https://mobbin.com/screens/ad2026a6-3dc6-40d6-8350-4e0af017f6d3): a "Firewall is active" shield card beside the denied counts, which became the "Policy engine active" status on the blocked page.

## Providers, ledger, settings and sign-in

- [Midday, apps](https://mobbin.com/screens/03313f42-04ef-4481-80db-96429e4a63c7): a card grid with an installed badge and two equal actions, which is the providers catalog layout.
- [YNAB, account register](https://mobbin.com/screens/fd551b69-3a52-4ef6-9eba-6a6199694f41): the "cleared + uncleared = working balance" equation over the register, which is the ledger "debits = credits" balance statement.
- [Mercury, journal entries](https://mobbin.com/screens/48a96e2c-7c93-46a5-ac20-ccff5a21f216): debit and credit accounts as columns with the amount on the right, which keeps journal rows scannable.
- [Twingate, generate token](https://mobbin.com/screens/6cd98656-1006-4a51-be6e-807770b3838d): a centred card with one labelled token field and helper text, which is the admin token sign-in.
- [Revolut Business, requesting a card flow](https://mobbin.com/flows/131f05ae-3964-442d-8992-a665c389f7ff): a single icon, one line and one action for empty lists, which every empty state follows.
