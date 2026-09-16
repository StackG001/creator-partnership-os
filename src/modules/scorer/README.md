# scorer

Turns a discovered creator into one 0-100 number, plus the reasoning behind it.

```bash
npm run scorer -- --handle grantbakes
npm run scorer -- --all --limit 5          # everything still at DISCOVERED
npm run scorer -- --handle grantbakes --dry-run   # arithmetic only, no model
```

## How the score is built

Six weighted dimensions (`SCORE_WEIGHTS` in `src/lib/constants.ts`, summing to
100). They are not all produced the same way:

| Dimension | Weight | Source |
| --- | --- | --- |
| reach | 15% | computed from subscribers |
| engagement | 25% | computed from the metrics sample |
| nicheClarity | 15% | model judgement |
| productGap | 25% | model judgement |
| monetisability | 12% | model judgement |
| reachability | 8% | model judgement |

**Reach and engagement are arithmetic, not opinion.** A model asked to "score
reach out of 100" is guessing at something we can compute exactly.

Reach peaks at the *geometric middle* of the qualification window (~45k), not at
the top of it: a 45k channel is a better partner than a 199k one, which is
closer to having an agent and no need for us. It is log-scaled, and the window
edges floor at 40 rather than 0 — they still qualify.

Engagement scores 50 at the 2% floor and maxes at twice the floor.

The four judged dimensions each require a one-sentence reason citing specific
evidence; those reasons are stored in `scoreBreakdown` and printed by the CLI.

`--dry-run` computes the arithmetic, leaves the judged dimensions at 50 and
skips the model entirely.

Scoring never re-qualifies a creator the finder disqualified.
