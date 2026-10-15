# niches

The niche library — no niche is off limits. See CLAUDE.md, "Niches: no limits".

```
npm run niches                         # the library: status, qualified, spend, cost per qualified
npm run niches -- --generate           # add new niches + search terms now (the 09:00 run does it weekly)
npm run niches -- --generate --count 10
```

`pickSearches` gives the pipeline its terms (~70% exploit / ~30% explore, each
term at most once a week); `recordSearchOutcome` / `recordNicheRun` /
`chargeAudit` feed results back so niches get promoted, terms paused and dead
niches retired.
