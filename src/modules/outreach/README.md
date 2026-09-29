# outreach

Personalised outreach drafted from the audit, never from a template — but
sequences 1-2 follow one fixed structure: the iClipmedia framework (Iman
Gadzhi method). This is the only style used for those two touches, no
exceptions:

1. **HOOK** — one specific, real thing from their content (a comment quote, a
   caption line, a video title). Never generic.
2. **VALUE LINE** — one sentence on what gets built and the split (50%).
3. **ZERO EFFORT LINE** — no filming, writing or design work from them.
4. **PROOF OF WORK** — a line showing something's already been started.
5. **SINGLE ASK** — one yes/no question, nothing else.

Email/YT-about/manual messages carry all five parts, capped at 120 words. DMs
(IG/X) collapse to HOOK + ASK only, capped at 60 words — the offer only comes
out once they reply.

**Sequence 3 onward is a different, deliberately un-pitchy shape**: a short
closing note, under 40 words, that explicitly acknowledges it's a repeat
touch, never re-pitches or introduces new evidence, and leaves the door open
with zero pressure.

Framework messages sign off as:

```
Gerald
Gerald Ebere Ozokwelu | iClipmedia | gerald@iclipmedia.com
```

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
