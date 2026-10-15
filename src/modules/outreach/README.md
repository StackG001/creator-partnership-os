# outreach

Personalised outreach drafted from the audit, never from a template, in a
fixed three-message sequence (full design in CLAUDE.md, "Outreach sequence
design"):

1. **Seq 1 — the goal, plainly.** A sourced audience comment word for word +
   the BRIDGE line (it speaks for the whole audience) → we build the whole
   thing (research, writing, design, sales page, setup) → they only make
   content to promote it and keep 50% of every sale → one yes/no question.
2. **Seq 2 — something new.** A second sourced quote (only quotes seq 1
   didn't use) and/or a concrete product idea (title + 3-4 things it would
   cover), plus a short answer to the likeliest objection. One yes/no question.
3. **Seq 3 — the close.** Honest cost of waiting, "Reply 'yes' and I'll send
   the outline", plainly the last message. Quotes no one.

Greeting: the creator's real first name from their display name — never from
a handle — or "Hi there," when there isn't one. In health/medical/mental-health/
finance niches the product is always pitched as a lifestyle/experience guide
(`src/lib/productLine.ts`); a message that crosses into treatment/advice is held.

Emails ≤120/130/60 words; DMs (IG/X) the same beats in ≤75/75/45 words.
Honesty is enforced (`DISHONEST`): no fake deadlines, invented scarcity,
invented social proof or guilt.

`--preview` drafts the whole sequence for a creator without saving anything:

```
npm run outreach -- --handle chefagathe --channel email --preview --variants 1
```

`--check <id>` runs every auto-send check on a message (`sendChecks`):
sourced word-for-word quotes, real first name from the display name, correct
note count, sign-off present, honesty, no claims of existing work, recipient
present, due, and drafted under the current design.

Framework messages sign off as:

```
Gerald
Gerald Ebere Ozokwelu | iClipmedia | gerald@iclipmedia.com
```

For every non-DM channel the sign-off is appended in code (`withSignOff`),
not left to the model — any sign-off the model writes anyway is stripped
first, so it never appears twice. DMs keep the model-written sign-off.

Every draft body is also checked for claims that work already exists
("already drafted/sketched", "I've put together", "send it over", "send the
outline"…, see `BANNED_CLAIMS`). A hit fails schema validation, so
`completeJSON` sends the draft back to the model to rewrite, up to
`LLM_MAX_RETRIES` times, then the run errors instead of saving it.

Quotes come only from the creator's sourced `Quote` rows (see CLAUDE.md,
"Quote sourcing"). If any of their quotes has no source URL/author/date,
drafting, `--approve` and `--send` all refuse and flag the creator for review
— run `npm run quotes` to see and fix them. Anything a draft puts in quotation
marks must be word for word from a sourced quote, with "…" for a cut.

Every message stays `DRAFT` until a human approves it — sending is a separate,
deliberate step. Artifacts land in `outputs/<handle>/outreach/`.

## Approving and sending

Drafting never sends anything. To actually deliver an EMAIL message:

```
npm run outreach -- --approve <messageId>   # DRAFT -> APPROVED, local only
npm run outreach -- --send <messageId> --dry-run   # prints the Resend payload, sends nothing
npm run outreach -- --send <messageId>             # sends via Resend, marks SENT
```

`--send` refuses anything that isn't `APPROVED`, and refuses non-EMAIL
channels outright — IG/X DMs and YouTube About messages have no send API
here and go out by hand. Sending requires `RESEND_API_KEY`; drafting and
approving never do. All outbound email is sent from
`gerald@iclipmedia.com` (`OUTREACH_SENDER` in `src/lib/constants.ts`).

Add `--test-to <email>` to `--send` to deliver a copy to a different address
first — subject gets a `[TEST]` prefix, and the message is **not** marked
SENT, so the real send is still pending afterward.

## Logging replies

Nothing marks `repliedAt` automatically — a human has to say a reply
happened:

```
npm run outreach -- --replied <handle> --status interested   # -> Creator REPLIED
npm run outreach -- --replied <handle> --status declined     # -> Creator DECLINED
npm run outreach -- --replied <handle> --status agreed       # -> Creator AGREED
```

This sets `repliedAt` on the creator's latest `SENT` message and moves
`Creator.status` to match. "interested" maps to the schema's `REPLIED` value
— there's no separate `INTERESTED` status, to avoid two fields meaning the
same thing.

## Follow-up due report

```
npm run outreach -- --due
```

Lists every creator with a `SENT` message and no logged reply, whose latest
send is `FOLLOW_UP.businessDays` (`src/lib/constants.ts`, default 3) or more
in the past. Excludes `DECLINED` and `AGREED` creators outright, anyone
with a `repliedAt` already logged, and anyone whose last send was the
sequence-3 closing note (`FOLLOW_UP.finalSequence`) — that's the final touch,
so no sequence 4 is ever suggested. Read-only — it never drafts or sends
anything, just reports.
