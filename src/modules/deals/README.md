# deals

The deal tracker: every creator deal from first find to monthly payout, in one
place. It reads and writes the local database only. It never drafts or sends
outreach, and never calls Whop, Apify or an LLM. Defaults and checks follow
`docs/partnership-terms.md`, mirrored in code as `PARTNERSHIP_TERMS` in
`src/lib/constants.ts`. Change both together.

## Data

- **`Deal`** has one row per creator: stage, next action, agreement, terms
  (share %, fee basis, launch window, promo posts) and stage history.
- **`SplitEntry`** is the ledger, with one row per deal, month (`YYYY-MM`) and
  source (`WHOP_SYNC` | `MANUAL`). Money is integer cents:
  - net = gross − fees − refunds
  - creator = round(base × share / 100), where base is net (AFTER_FEES) or
    gross − refunds (GROSS)
  - iClipmedia = net − creator

  When a month has both a MANUAL and a WHOP_SYNC row, the report uses the
  MANUAL one.

## Auto-sync (`--sync`, `sync.ts`)

- **Who gets a deal:** every qualified creator (`qualifiedLeadWhere`, the same
  filter as the Qualified leads table) and everyone with an outreach message.
  Retired creators who never actually received a message are skipped.
- **Stage from data:**
  - FOUND: DISCOVERED, SCORED or AUDITED
  - PITCHED: any message delivered
  - REPLIED: any reply
  - AGREED: creator status AGREED
  - BUILDING: a product RESEARCHING through APPROVED
  - LAUNCHED: a LIVE launch
  - LOST: DECLINED or DISQUALIFIED (`lostReason` = `disqualifiedFor`)
- **Forward only.** A deal never moves backwards automatically, and LOST is
  only left by hand. A deal set with `--stage` is MANUAL and sync leaves it
  alone until `--auto`.
- **Terms guard:** nothing is built until both sides sign. If the data says
  BUILDING without a SIGNED agreement, the deal is held at AGREED (or lower, if
  the creator never agreed) and `termsFlag` is set. LAUNCHED without a
  signature is flagged too.
- **Do-not-contact creators** keep their deal. They show as "handled by hand —
  no automated outreach", and nothing here can send.
- **Ledger:** this month's WHOP_SYNC row for each deal with a launch, built
  from the Launch totals the publisher module already refreshed. Totals are
  cumulative, so earlier months are subtracted. The Launch has no Whop fee
  data, so fees are recorded as 0 with the note "fees not yet known".
- **`endsAt`** = launch + 12 months, or signing + 12 months until there is a
  launch.

## Commands

```
npm run deals -- --sync [--dry-run]
npm run deals -- --list [--stage REPLIED]
npm run deals -- --show @handle
npm run deals -- --stage @handle AGREED [--note "…"]     # MANUAL; refuses BUILDING without a SIGNED agreement
npm run deals -- --stage @handle --auto                  # back to auto-sync
npm run deals -- --agreement @handle sent|signed|ended [--url …] [--date YYYY-MM-DD]
npm run deals -- --terms @handle [--share 50] [--basis after_fees|gross] [--window YYYY-MM-DD:YYYY-MM-DD] [--posts N]
npm run deals -- --promo @handle --done +1
npm run deals -- --notes @handle "text" [--replace]           # dated note on the deal
npm run deals -- --next @handle "text" --due YYYY-MM-DD
npm run deals -- --ledger @handle --period YYYY-MM --gross 49.00 --fees 3.10 --refunds 0 --sales 2 [--note "…"]
npm run deals -- --report
```

## Report (`--report`, `report.ts`)

- **Funnel:** deals per stage, plus PITCHED → REPLIED → AGREED conversion. A
  deal counts toward every stage it reached, including LOST ones.
- **Deals needing action:**
  - next action overdue
  - AGREED without a signed agreement
  - agreement sent more than 7 days ago and not signed
  - launch window ending within 7 days with promo posts still owed
  - agreement ending within 30 days
  - terms-guard flags
- **Money:** this month and all time, per deal and in total. It shows the fee
  basis in use: AFTER_FEES, confirmed 2026-11-11, because Whop revenue share is
  calculated after Whop's fees. It also lists any one-off GROSS deals.
- **Ends with** the Qualified leads table.

On Mondays the daily summary (`outputs/_pipeline/latest.md`) includes this
report too.

## Screen

`/deals` (`src/app/deals/page.tsx`) is read-only:
- a column per stage with creator cards
- the ledger
- links to the three master documents
