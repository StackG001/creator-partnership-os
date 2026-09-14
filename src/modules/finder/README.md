# finder

Discovers micro-creator candidates and upserts them as `Creator` rows with
status `FOUND`.

```bash
npm run finder -- --platform ig  --queries "credit repair tips,credit score tips" --limit 60
npm run finder -- --platform yt  --queries "notion templates" --minFollowers 20000
npm run finder -- --platform csv --csv ./handles.csv --csvPlatform ig
cat handles.csv | npm run finder -- --platform csv --csv -
```

## Backends

| `--platform` | Source | Credential |
| --- | --- | --- |
| `ig` | Apify Instagram actor — hashtag search, then profile details | `APIFY_TOKEN` |
| `yt` | YouTube Data API v3 — channel search, then channel + video stats | `YOUTUBE_API_KEY` (or `YT_API_KEY`) |
| `csv` | A pasted list of handles, enriched through the same backends | whichever platform the rows name |

Each backend normalises to `DiscoveredProfile` (`types.ts`), so qualification,
product detection and persistence are written once.

## What a run does

1. **Search** each query, spreading `--limit` across them so one phrase cannot
   consume the whole run. One `Source` row per query, for attribution.
2. **Fetch** each profile with its last 12 posts — views, likes, comments.
3. **Dedupe by handle**, within the run and against the database.
4. **Qualify**: keep 10k–200k followers. Engagement below the floor is *flagged*
   in the summary, not excluded — that is a scoring judgement, not a discovery one.
5. **Detect an existing product** from the bio and links (`product-signals.ts`).
6. **Upsert** with status `FOUND`, refreshing metrics without dragging a creator
   who is already `AUDITED` or `CONTACTED` back down the pipeline.

## Engagement is measured per platform

`engagementRate` is `(avg likes + avg comments) / followers` and
`engagementPerView` is the same numerator over `avg views`.

The two platforms are judged on different denominators, because they are not
comparable. An Instagram post reaches much of its following, so likes-per-
follower lands in the low percent. A YouTube video reaches a small slice of
subscribers and is mostly watched by non-subscribers, so the same formula lands
two orders of magnitude lower — a healthy channel routinely measures 0.01% per
subscriber. Scoring YouTube against Instagram's 2% floor flags every channel
ever published. YouTube is therefore judged per view, Instagram per follower
(`ENGAGEMENT_FLOORS` in `src/lib/constants.ts`). `--minEngagement` overrides
whichever applies.

## Existing-product detection

The whole thesis is "engaged audience, nothing to sell it yet", so this is the
most consequential filter in the module. A storefront link (`stan.store`,
`gumroad.com`, `whop.com`, …) is treated as near-conclusive. Bio keywords
(`ebook`, `course`, `template`, …) are weaker and need two hits, because plenty
of bios say "guide" and sell nothing. Every hit is stored on
`Creator.productEvidence` with the text that triggered it, so a false positive
can be argued with rather than guessed at.

Creators who already sell something are still recorded — the scorer decides what
to do about them.

## Rate limiting

All traffic goes through `src/lib/http.ts`: a minimum gap between calls (1s for
Apify, 200ms for YouTube), bounded retries with exponential backoff and jitter,
`Retry-After` honoured, and a hard timeout. A 401/403 fails immediately rather
than retrying a rejected credential.
