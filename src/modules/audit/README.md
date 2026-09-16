# audit

Produces the evidence pack behind every later decision: content pillars,
audience profile, ranked pain points, monetisation gaps and 3-5 candidate
product angles.

```bash
npm run audit -- --handle grantbakes
npm run audit -- --handle grantbakes --posts 40 --refresh
npm run audit -- --handle grantbakes --dry-run    # fetch + cache, no model
```

Artifacts: `outputs/<handle>/audit/audit.md`, `audit.json` and `source.json`.

## Evidence, not vibes

The audit reads recent uploads and the **top comments** on the most-watched of
them — comments are where audience pain actually surfaces. The schema requires a
verbatim quote for every pain point, and the system prompt tells the model to
lower its confidence rather than invent when evidence is thin.

An audit whose evidence cannot be checked is worse than no audit, because every
downstream module quotes it as fact. So the exact sample the model saw is cached
to `audit/source.json` next to the finished document, and `audit.md` links back
to it.

## Caching

The fetched sample is reused across runs unless `--refresh` is passed. That
saves quota, but the real reason is reproducibility: re-running against an
identical sample is how you tell a prompt change from a data change.

## Rendering

`audit.md` is rendered deterministically from the validated JSON — the model
never writes the document, only fills the schema. The same data always renders
the same file.

## Cost

Roughly 1 quota unit per video plus 1 per commented video (~32 for a 20-video
audit), and one `heavy`-tier model call. `costCents` on the `Audit` row is left
null: this repo holds no price table, and a guessed number in a money column is
worse than an absent one.
