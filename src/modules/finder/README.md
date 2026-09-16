# finder

Discovers YouTube micro-creators and records the metrics everything downstream
depends on. **No model is called here** — a finder run is deterministic,
reproducible and costs nothing but YouTube quota.

```bash
npm run finder -- --channel @grantbakes            # 1 known channel (≈3 units)
npm run finder -- --query "sourdough for beginners" --limit 8 --niche baking
npm run finder -- --channel @someone --dry-run     # profile, write nothing
```

## What it writes

A `Creator` row per channel (keyed by handle), a `Source` row for the query, and
`outputs/<handle>/` with its artifact folders.

## Qualification

The window lives in `src/lib/constants.ts` (`QUALIFICATION`): 10k–200k
subscribers, ≥2% engagement, and no digital product already on sale.

Channels outside it are stored as `DISQUALIFIED` with `disqualifiedFor` set,
rather than dropped. "We looked and said no, because X" is worth more later than
a silent omission — and it stops the next run re-profiling the same channel.

Existing-product detection is link-based, not language-based: a gumroad or
stan.store URL in a description is evidence, "link in bio for my course" is
noise. Domains are listed in `PRODUCT_PLATFORM_DOMAINS`. The audit revisits this
properly.

## Quota

The YouTube Data API allows 10,000 units/day. `--channel` costs ~3 units;
`--query` costs **100 units for the search alone**, so keyword discovery is
rationed — roughly 95 searches a day, before any profiling. Each run prints what
it spent.
