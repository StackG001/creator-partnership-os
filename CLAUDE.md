# Creator Partnership OS — working notes for Claude

> **Status:** this file was written from Gerald's kickoff brief because the
> blueprint paste had not landed when the repo was scaffolded. When the
> blueprint arrives, replace or extend the sections below with it — the
> conventions section reflects what the code actually does today, so keep it in
> sync with any change.

## What the system does

An internal tool for Gerald. End to end:

1. **Find** micro-creators on Instagram/YouTube (10k-200k followers) with an
   engaged niche audience and no digital product.
2. **Score** and **audit** them — audience, pain points, product gap.
3. Write **personalised outreach**.
4. Build a **35-50 page research-backed PDF** branded in the creator's voice
   and visual style.
5. Generate a **sales funnel**: sales page + order bump + upsell.
6. **Publish on Whop** with revenue share, and **log the results**.

## Fresh start — 2026-10-15 (permanent rule)

On 2026-10-15 every creator found before that date (69) was retired
(`status RETIRED`, `retiredReason "pre-fresh-start batch"`, see
`src/scripts/fresh-start.ts`) and all their pending messages were `CANCELLED`.
No rows were deleted — they stay so the finder can dedupe against them.

- **Never re-contact a retired creator who received a message.** Everyone with
  any SENT message (23, including replied conversations Gerald now handles by
  hand, e.g. @therealnicolesvenson) has `doNotContact = true`: drafting,
  approving, sending, auto-send, follow-ups and the DM queue all refuse them
  (`contactBlock` in outreach), and the finder never re-adds them, whatever
  search finds them. Never clear `doNotContact`.
- Retired creators who were **never** sent anything (46) may come back only if
  a new pipeline search rediscovers them; they re-enter at DISCOVERED under the
  new source and need fully sourced quotes like anyone else (old unsourced
  quotes still block drafting).
- The old Claude-in-Chrome quote-verification work for the retired batch was
  dropped (review flags cleared).

## Qualified leads table (permanent rule — every report)

Every run report, daily summary, and every reply to Gerald that mentions
creators **ends with a "Qualified leads" table**: @handle, platform, profile
link (instagram.com/<handle> or youtube.com/@<handle>), niche, score, contact
method (email or DM), and current status (drafted / held / sent / waiting for
me). Include it even with one lead; with none, say "No qualified leads this
run". Generate it with `npm run pipeline -- --leads` (`qualifiedLeads()` /
`renderLeadsTable()` in the pipeline module); the daily summary appends it
automatically. Qualified = score ≥ `QUALIFICATION.minScore`, audited or
further, not retired / do-not-contact.

## Core principle (permanent — every session)

The whole system is built on **mining creators' comment sections for gold**:
find creators in any niche, then go through their audience's comments to pull
out as many real, untapped product opportunities as possible (pain points,
repeated questions, "please teach this", "where's the recipe"…).

- Every opportunity is recorded with **the comment, the post it's on, and the
  creator** (plus who wrote it and when) — that's the `Quote` table, see
  "Quote sourcing" below.
- **The first outreach message, on every channel, always tells the creator the
  opportunity is already there** (their audience is asking for it) **and that
  we have the technical ability to do all the work** — so they never worry
  about it and just focus on creating content to promote the product.
- **Goldmine filter (audit).** Only comments that pass the Goldmine Test are
  extracted (5 signal types, 3 product-opportunity tests — see
  `src/modules/audit/README.md`). 3-8 per creator; fewer than 3 sourced
  signals → low product-fit, `DISQUALIFIED`, no outreach. 3+ different
  commenters with the same underlying problem = one recurring signal; self-blame
  phrasing ("what am I doing wrong") counts as shame. Product scores are capped
  by how many posts/commenters the problem reaches (5+ = a product), except a
  **creator-validated** signal (matches one of their top-performing posts —
  the Grant Bakes 9-to-5 pattern), which is the strongest signal.

## Outreach sequence design (permanent)

Prompts in `src/modules/outreach/index.ts`; every rule below is also checked
in code before anything can send (`sendChecks`, `npm run outreach -- --check <id>`).

- **Seq 1 — state the goal plainly.** Their audience is already asking for a
  product: quote one sourced audience comment word for word (the one that
  most clearly shows demand) + the BRIDGE line ("bet you get some version of
  that every time you post"). We build the whole thing — research, writing,
  design, sales page, setup — and they only make content to promote it,
  keeping 50% of every sale. Ends with one yes/no question.
- **Seq 2 — add something new, never repeat seq 1.** A second sourced audience
  quote (it only gets quotes seq 1 didn't use) and/or a concrete product idea
  specific to their content (working title + the 3-4 things it would cover),
  plus a short answer to the most likely objection ("I don't have time" → you
  don't build anything; "my audience won't pay" → point to the comments
  asking for it). One yes/no question.
- **Seq 3 — the close.** The honest cost of waiting (their audience keeps
  asking; if they don't answer it, someone else may), the easiest possible ask
  ("Reply 'yes' and I'll send the outline"), and the body says plainly it's the
  last message. Quotes no one.
- **Always honest:** no fake deadlines, no invented scarcity, no "other
  creators already said yes" unless true and on record, no guilt-tripping
  (`DISHONEST` rejects these at draft time and at send time).
- **Existing rules still apply:** sourced quotes only, word for word (any
  quote mark — "", “”, «» — counts); never claim work already exists
  (`BANNED_CLAIMS`); count the notes correctly; real first names only, taken
  from the display name's name part, never from a handle; sign-off appended
  in code. Same order and length budget on DMs, just shorter.
- **Names:** `firstNameFromDisplayName` decides in code, from the display name
  only — never a handle, a comment or a guess: "Grow With Jonah" → Jonah,
  "Emily | Mostly Greens" → Emily, "Chef Agathe 🌱 …" → Agathe, "Milo Meloy" →
  Milo; brands ("Princeton Microgreens") → none. The draft is told exactly how
  to open, and the greeting check rejects "Hi there" when a first name exists.
  **No real first name → open with "Hi there,".**
- **Sign-off on every channel, DMs included,** is appended in code; approving,
  sending and marking a DM sent are all refused without it.
- **Disqualified creators** (e.g. already sell a course/training) stay in the
  database so the finder never re-adds them, and drafting to them is refused.
- A comment the creator wrote themself (their own reply) is their words, not
  the audience's — stored as `CREATOR_CAPTION`, never as a follower comment.

## Niches: any skill, never entertainment (permanent)

Any niche in any category — **as long as the audience is learning a skill and
getting stuck.** One test (`NICHE_SKILL_TEST`): "Would a beginner in this niche
search YouTube for help when something goes wrong?" No → rejected. Van life,
travel/couple vlogs, fitness motivation, day-in-my-life, storytime/reaction,
music performance/comedy, dating vlogs and food review channels are
hard-rejected in code (`NICHE_REJECT` in `src/lib/constants.ts`) when niches
are generated and again before any search runs. `NICHE_APPROVED_EXAMPLES` are
directions, not limits. The **niche library**
(`Niche` table, `src/modules/niches`, `npm run niches`) holds every niche and
its search terms (YouTube keyword + "how do I…" phrase, Instagram keyword +
problem hashtag, and a SIMILAR_TO search for every Instagram creator who
qualified).

- **Weekly** the 09:00 run generates `NICHE_LIBRARY.newNichesPerWeek` new
  niches/sub-niches (~⅓ neighbours of what already produced, the rest new
  territory across `NICHE_LIBRARY.categories` and beyond).
- **Every run** splits searches ~70% exploit (niches/terms that produced) /
  ~30% explore (never-run niches first, one term per niche). No term runs more
  than once in `rotationDays` (7).
- **Tracked per niche and per term:** runs, qualified creators, Apify spend
  (micro-dollars), cost per qualified. A niche is **promoted** (PRODUCING) on its
  first qualified creator, a term is **paused** after 2 empty runs, a niche is
  **retired** after 3 empty runs (its terms paused). All reported daily.
- **Sensitive niches** (health, medical, mental health, finance) are allowed,
  but product ideas must be lifestyle/experience guides from the creator's own
  routines ("my flare-day meal plan", "how I budget on one income") — never
  treatment, cures, diagnosis, investment or debt advice. `src/lib/productLine.ts`
  holds the rule (given to the audit and outreach prompts) and the checks:
  ideas that cross the line set `Creator.productFlag`; a message that crosses
  it is held, never auto-sent.

## Stack constraints (non-negotiable)

- Next.js, TypeScript, App Router.
- SQLite via Prisma for now. Everything is written so the move to Supabase
  (Postgres) is a datasource change, not a rewrite.
- Anthropic API for **all** LLM work — no other model provider.
- Playwright for HTML→PDF.
- All secrets come from `.env`; `.env.example` documents every one of them.

## Conventions

**CLI-first.** Every module runs as `npm run <module> -- --args` before it gets
any UI. A module is not done until its CLI works. `src/lib/cli.ts` gives each
one flag parsing, generated `--help`, env validation and exit codes — use
`runCli(spec, handler)`, don't hand-roll argv parsing.

**Module layout.** `src/modules/{finder,scorer,audit,outreach,product,brand,funnel,publisher,pipeline}/`
with `cli.ts` (entry point + flags), `index.ts` (the typed functions, no argv
knowledge) and `README.md`. CLI parses, `index.ts` does the work.

**All LLM calls go through `src/lib/llm.ts`.** Use `completeJSON` with a zod
schema whenever the output has a shape — it forces a tool call built from the
schema, validates the result, and re-prompts the model with its own validation
errors. Never `JSON.parse` a model response by hand. `completeText` is for
prose only. Tiers (`fast` / `default` / `heavy`) resolve through `.env` so
models can be re-pointed globally.

**Artifacts.** Everything generated lands under `outputs/<creator-handle>/`
(`audit/ brand/ product/ research/ funnel/ outreach/ launch/`). Use the helpers
in `src/lib/paths.ts`; store the path in the database alongside the data.
`outputs/` is gitignored.

**Database.** SQLite has no enums, so status fields are `String` columns whose
allowed values live in `src/lib/constants.ts` — change one, change the other.
Money is always integer cents. LLM-shaped output goes in a `Json` column plus a
file on disk.

**Nothing external happens implicitly.** Outreach messages stay `DRAFT` until a
human approves them; the publisher supports `--dry-run` and prints its payload.

## Quote sourcing (permanent rule — every session)

Enforced in code by `src/lib/quotes.ts`; the `quotes` module is the only way
to save, fix or drop a quote (`npm run quotes -- --help`).

- **Every quote saved for a creator stores its source:** the post URL, who
  wrote it (the creator's own caption, or a named follower's comment — their
  handle), and the date it was found. These live on the `Quote` table.
- **No source URL → not usable.** A quote without a URL (or author, or date)
  can't be used in any draft. Drafting, `--approve` and `--send` refuse and
  set `Creator.reviewFlag` instead of writing around it. Never work around a
  refusal — get the link, or drop the quote. The one exception: a seq-3+
  closing note with nothing in quotation marks quotes no one, so it can be
  drafted, approved and sent while the flag stands (it gets no quotes or audit
  evidence, and its schema rejects any quotation).
- **Word for word.** Quotes are copied exactly. A trimmed quote is stored as
  trimmed (`isTrimmed`, with `fullText` when known) and drafts must show the
  cut with "…" — never present an excerpt as the full comment. Drafts may only
  put text in quotation marks if it comes from one of the creator's sourced
  quotes; the draft schema rejects anything else.
- **Applies to every source:** Apify/YouTube audits (quotes are traced to
  their post automatically, untraceable ones are dropped), Claude in Chrome
  research Gerald pastes in (`--origin chrome`), and creators added by hand.
  **If Gerald pastes a quote without a link, ask him for the link before
  saving it** — `quotes --add` refuses without `--url` anyway.
- **Never write placeholder text into a creator's real fields** (bio,
  displayName, niche, emails…) — no "Recent audience comment: …", "[Name]",
  TODO. Analysis/vetting notes go in `contactNotes`; quotes go in `Quote`.
  `npm run quotes` flags any placeholder it finds.
- Run `npm run quotes` (no flags) before any outreach batch: it re-checks
  every creator and lists the ones flagged for review.

## Apify spending (Instagram)

Plan, monthly limit, cycle dates and usage are **read live** from
`GET /v2/users/me/limits` — never ask Gerald, never hard-code them. As of
2026-10-15: Starter, $19/month, cycle resets on the 15th, $0.0023/result for
`apify~instagram-scraper`.

- Instagram may use **80% of the plan's monthly limit**
  (`APIFY.instagramShareOfPlan`), spread evenly over the Instagram run days
  left in the cycle (daily) — each run's share is its **hard ceiling**. No single
  actor run over `APIFY.maxRunUsd` ($1). Real usage is re-checked before every
  paid call. Every actor call goes through `runActorGuarded`
  (`src/lib/sources/apify.ts`); never call Apify any other way.
- **Run size grows, runs don't multiply:** audits per run = ceiling ÷ cost of
  one qualified creator (audit + stage-1 profiles). Unspent budget raises the
  next day's ceiling. Cost basis: the `INSTAGRAM_AUDIT` result count × price until 3 live runs,
  then measured averages (`PipelineRun`). After the 3rd live run the daily
  summary reports real cost per run vs $0.36 and per qualified creator.
- **Two stages.** Stage 1 is profile-only (followers, bio, link-in-bio, latest
  posts; ~1 result per profile) plus a free fetch of the link-in-bio page. Drop
  anyone outside 10k–200k, brands/businesses (`IG_BRAND_CATEGORIES`), coaches
  selling services, and anyone whose bio or link-in-bio already sells a
  course/ebook/guide/paid product. Only survivors get the paid stage-2 audit:
  posts + comments from the **top 8 posts by comment count, 20 comments each**
  (`INSTAGRAM_AUDIT`, ≈ $0.41/audit since 2026-10-16; was 3×20 ≈ $0.18, which
  was too thin to see a problem repeat across posts).
- **YouTube is free:** up to 20 new creators/day (`PIPELINE.dailyNewCreatorCap`)
  across the niche library, same 70/30 split.
- **Discovery = Google first (IG_GOOGLE):** Serper searches `site:instagram.com
  <term> "followers"` (excluding posts/reels), reads the follower count from the
  snippet, keeps ~8k–220k, dedupes against every Creator/SeenHandle, and sends
  only survivors to ONE batched Apify profile lookup. Tested 2026-10-15: 86% of
  survivors confirmed 10k–200k. Hashtag (newest posts only — tiny accounts),
  similar-accounts (actor returns empty lists) and keyword account searches are
  kept in the library but unused (`PIPELINE.instagram.discoveryKinds`).
- **Spread:** at most one search term per niche per run, producers take turns.
- **Emails:** never take an address on a platform domain (Linktree, Instagram,
  Google, app stores, link shorteners…); a send check holds any email to a
  platform address or to a domain with no mail servers (MX). When a creator has
  their own website, its home/contact/about pages are checked and an address on
  the site's own domain wins. Bare shortener links ("https://bit.ly") are ignored.
- **Contact routes:** email first; otherwise an Instagram DM (for YouTube
  creators, the Instagram their channel links to). YouTube has no channel
  messaging, so YT_ABOUT is never drafted; a creator with neither is not drafted.
  Gerald can add an email found by hand (YouTube's "View email address" needs a
  sign-in + captcha) — record the source in `emailSource`.
- **Never re-scrape a handle.** `SeenHandle` + `Creator` are checked before any
  paid call, across every search and niche.
- Before changing Instagram scope or schedule, show Gerald
  `npm run pipeline -- --dry-run` first.

## Daily automation

Cron (after Gerald's OK): **09:00** `npm run pipeline -- --daily --part youtube`
(weekly niche generation, YouTube discovery — free), **10:00**
`npm run pipeline -- --daily --part instagram`. Each part: niche-library
searches → score → **find a business email** for everyone who passed scoring
(bio → link-in-bio page / Linktree / Beacons / Stan / personal site → YouTube
descriptions; free fetches; stored with `emailSource`) → audit → draft seq 1
(**email whenever one exists**, DM otherwise); retire drafts for messages
already sent; draft seq 2/3 for everyone due (switching to email if one has
been found); then — only while `AUTO_SEND.enabled` — send EMAIL drafts that
pass every `sendChecks` check, max 15/day, Resend ids on the message and in
`outputs/_pipeline/sends.jsonl`. Anything failing is held (`heldFor`) with the reason.

**DMs are never sent automatically.** `npm run dm-queue` serves the DM queue
page (phone + laptop, token in the URL): approved unsent DMs oldest first,
"Copy & open" (Instagram `https://ig.me/m/<handle>`, YouTube About page, X
profile), "Sent" (marks SENT now → follow-up clock starts), "Skip". Drafts
needing a variant picked are listed with "Approve".

Daily summary → `outputs/_pipeline/latest.md` (rebuilt from the database
after each part): new creators by niche, Apify today/cycle, cost per qualified
creator, niches promoted/paused/retired, new niches tried, emails sent, held +
why, DMs waiting (queue link), replies logged.

## Commands

`npm run doctor` first — it checks every env var, the database, Chromium and
every API connection. See README.md for the full command list.
