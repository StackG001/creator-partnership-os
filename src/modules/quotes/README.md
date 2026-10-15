# quotes

Word-for-word quotes per creator, each with its source: post URL, who wrote it
(the creator's caption or a named follower's comment) and the date found. The
rules live in `src/lib/quotes.ts` and CLAUDE.md ("Quote sourcing").

```
npm run quotes                                  # re-check every creator, list the flagged ones
npm run quotes -- --list --handle <handle>
npm run quotes -- --add --handle <handle> --text "<exact quote>" --url <post url> --author creator|@follower [--full "<whole comment>"] [--trimmed] [--origin manual|chrome] [--found YYYY-MM-DD]
npm run quotes -- --fix <quoteId> --url <post url> --author creator|@follower
npm run quotes -- --drop <quoteId>
npm run quotes -- --backfill                    # one-time import of pre-rule data (idempotent)
```

`--add` refuses without `--url`. Audits save their own quotes, traced to the
fetched post/comment text; any the model didn't copy word for word are dropped.
A creator with an unusable quote or placeholder text in a real field is
flagged (`Creator.reviewFlag`), and drafting/approving/sending refuse until
it's fixed or dropped.
