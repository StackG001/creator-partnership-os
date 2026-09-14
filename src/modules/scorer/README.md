# scorer

Scores `FOUND` creators 0–100 on product-fit, then writes `Creator.score`,
`Creator.scoreJson` and status `SCORED`.

```bash
npm run scorer -- --all
npm run scorer -- --handle thecreditrepairshop
npm run scorer -- --all --limit 50 --rescore
npm run scorer -- --all --offline     # metrics only, no API key needed
```

## Weights

| Component | Weight | Source |
| --- | ---: | --- |
| Niche specificity & educational content | 25 | model |
| Engagement rate + comment buying-intent | 20 | metrics (70%) + comment text (30%) |
| Monetisation gap (no product, low sponsor load) | 20 | metrics |
| Audience spending power | 15 | model, anchored by `data/niche-cpc.json` |
| Consistency / cadence | 10 | metrics |
| Reachability (public email, replies) | 10 | metrics |

The weights live in `SCORE_WEIGHTS` (`src/lib/constants.ts`) and `metrics.ts`
throws at load time if they stop summing to 100 — a score that silently topped
out at 95 would corrupt every shortlist quietly.

All weighted arithmetic is in `metrics.ts` as pure functions, so it is tested
without a model and a creator always scores the same twice.

## The model's part

`llm.ts` asks for exactly the brief's schema — `score`, `reasons[3]`,
`redFlags[]`, `recommendedProductType`, `priceBand`, `verdict` — plus the two
0–1 ratings the weighted score needs as inputs (`nicheSpecificity`,
`spendingPower`). Without those two the 25- and 15-point components would have
nothing to multiply.

`Creator.score` is the **weighted** score and is what the shortlist sorts on.
The model's own holistic `score` is kept alongside it as `llmScore`. The model's
`verdict` is used as-is, except that it cannot promote a creator whose weighted
score lands in `NO` territory.

## Comment intent

"How do I fix my utilisation?" is someone telling you they would pay for the
answer; "🔥🔥" is not. `commentIntentScore` matches question and intent patterns
over sampled comments.

When no comments were sampled the engagement component falls back to the rate
alone, rather than scoring the creator zero for data we failed to collect.

## `--offline`

Runs the deterministic half only, so the CLI works without an Anthropic key.
Qualitative ratings fall back to conservative proxies (a CPC hint still anchors
spending power). The score is real but weaker, and `scoreJson.llm` is `false`
so nobody mistakes one for the other — the shortlist labels these
`metrics-only`.

## CPC hints

`data/niche-cpc.json` maps a niche to an average cost-per-click. What an
advertiser pays for a click is the cheapest available proxy for what an audience
is worth — an insurance lead costs 20× a fitness one, and that gap reappears in
what each audience pays for a product. Optional: an unmatched niche just leaves
the model to estimate unaided. Longest matching key wins, so `credit repair`
beats a bare `credit` entry.
