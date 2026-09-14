# audit

Deep research on one creator. Produces `outputs/<handle>/audit/audit.json` and
`audit.md`, and moves the creator to `AUDITED`.

```bash
npm run audit -- --handle https://www.youtube.com/channel/UCayPoownnKRANe9i1WoFQRA
npm run audit -- --handle creditqueen --posts 60 --topPosts 15
npm run audit -- --handle creditqueen --collect-only   # evidence only, no model calls
```

`--handle` takes an Instagram handle, or a YouTube **channel-id** URL / bare
`UC...` id. A `/@vanity` URL is rejected rather than resolved, because
resolving one costs a search call and can return the wrong channel. The
shortlist CSV's `profile_url` column is already in the right form.

## What it collects

| | Source | Notes |
| --- | --- | --- |
| 50–100 posts | finder fetchers, `postLimit` raised | YouTube titles **and** descriptions — that is where the selling happens |
| Comments on the 20 best posts | `commentThreads` / Apify | Ranked by relevance, so the questions people actually ask |
| Pinned posts | post payload | Best effort; YouTube does not reliably expose this |
| Bio | profile | |
| Link-in-bio page text | direct fetch (`src/lib/page-text.ts`) | The densest statement of what they already sell |
| Dominant colours | real post images via Chromium (`src/lib/palette.ts`) | Hex values are **measured**, never guessed |

Collection is best-effort. A blocked page or a video with comments disabled is
recorded in `summary.gaps` and printed near the top of `audit.md`, so the report
says what it could not see instead of letting a model fill the hole.

## Two passes

**Extraction** (`default` tier, chunked ~10 posts per call) pulls verbatim
quotes and voice signals only — no judgement. Chunking keeps each call small
enough to attend to every comment rather than skim a 100-post dump. One failed
chunk is recorded and the rest continue; all chunks failing is an error, because
synthesising from nothing is worse than stopping.

**Synthesis** (`heavy` tier, one call) sees only the extracted signals and makes
the calls that need the strongest model: which pains matter, the voice guide,
the five product opportunities, the hooks, the pitch angle.

Both are validated with zod (`schema.ts`). `auditSchema` enforces exactly 10
pains, 10 hook lines, 5 opportunities and **exactly one** marked `recommended`.

## The profitable-pocket rule

Every opportunity must name a `specificPerson` and a
`problemTheyAreAlreadyFixing`. "People who want better credit" is a category and
fails. "Someone 60 days from a mortgage application with two collections they
have already disputed once" is a pocket. The recommended one is the tightest
pocket, not the largest audience.

## What the audit corrects

The audit reads things discovery cannot, and writes them back:

- **Creator replies to comments** → `monetization.repliesToComments`, which the
  scorer's reachability component uses and could not otherwise see.
- **Creator sells in their own comments** → `hasDigitalProduct` is corrected to
  `true` with evidence. Discovery only reads the bio, and creators routinely
  promote a storefront from a pinned comment or a video description while the
  bio stays clean. Re-run the scorer after an audit that reports this.

Comments marked `[CREATOR]` are given to the extraction model as voice evidence
and explicitly excluded from audience pains — a creator's own promo is not a
customer problem.
