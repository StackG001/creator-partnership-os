# pipeline

The daily automated loop, in two parts (see CLAUDE.md, "Daily automation"):

```
npm run pipeline -- --dry-run                 # Apify plan, run size, projected spend, first week of searches, email finder, library — nothing scraped, drafted or sent
npm run pipeline -- --daily --part youtube    # cron 09:00 — weekly niche generation + YouTube (free)
npm run pipeline -- --daily --part instagram  # cron 10:00 — Instagram inside the Apify budget
npm run pipeline -- --daily --part instagram --force   # run a part again today
npm run pipeline -- --summary                 # print today's summary from the database
```

Each part: searches picked from the niche library (`src/modules/niches`,
~70% producers / ~30% exploring, each term at most weekly) → score → find a
business email for everyone who passed scoring → audit → draft seq 1 (email
when found, else DM) → retire stale drafts → draft due seq 2/3 → auto-send
(only while `AUTO_SEND.enabled`) → rewrite `outputs/_pipeline/latest.md`.

Instagram run size: the run's ceiling is what's left of 80% of the plan ÷
Instagram run days left; audits = ceiling ÷ cost per qualified creator
(estimate until 3 measured `PipelineRun`s, then measured). Discovery may only
spend what the audits don't need; audits may use the rest of the ceiling.
Unspent budget raises tomorrow's ceiling.

Each part runs once per day (`outputs/_pipeline/state.json`); later calls exit
unless `--force`.
