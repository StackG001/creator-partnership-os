# dm-queue

DMs are never sent automatically. `npm run dm-queue` serves a page for phone
and laptop (URL with token printed on start; also in every daily summary):

- **Ready to send** — approved, unsent DMs, oldest first: handle, message
  number, full text. **Copy & open** copies the text and opens the DM
  (Instagram `https://ig.me/m/<handle>`, YouTube About page, X profile).
  **Sent** marks it SENT now, so the follow-up is scheduled
  (`FOLLOW_UP.businessDays`). **Skip** leaves it queued.
- **Drafts** — pick one variant with **Approve** (the others are superseded).

`npm run dm-queue -- --list` prints the queue instead. Port: `DM_QUEUE_PORT`
(default 4317).
