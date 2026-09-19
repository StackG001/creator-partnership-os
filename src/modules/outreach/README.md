# outreach

Personalised outreach drafted from the audit, never from a template — but every
message follows one fixed structure: the iClipmedia framework (Iman Gadzhi
method). This is the only style used, no exceptions:

1. **HOOK** — one specific, real thing from their content (a comment quote, a
   caption line, a video title). Never generic.
2. **VALUE LINE** — one sentence on what gets built and the split (50%).
3. **ZERO EFFORT LINE** — no filming, writing or design work from them.
4. **PROOF OF WORK** — a line showing something's already been started.
5. **SINGLE ASK** — one yes/no question, nothing else.

Email/YT-about/manual messages carry all five parts, capped at 120 words. DMs
(IG/X) collapse to HOOK + ASK only, capped at 60 words — the offer only comes
out once they reply. Every message signs off as:

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
