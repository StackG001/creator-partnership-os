# publisher

Pushes the finished funnel to Whop, records the revenue split, and syncs sales back into `Launch` so results are logged per creator.

`--dry-run` prints the exact API payload without creating anything.

## How the creator is paid

The creator is paid through **Whop revenue share**, not an affiliate link. They
get 50% of every sale of their product, set per product and calculated after
all Whop fees (see `docs/partnership-terms.md`).

**The publisher does not set the revenue share yet.** Whop documents the
override only as SDK calls (`affiliates.overrides.create` with
`override_type: "rev_share"`), with no REST path, so it hasn't been wired in.

What happens instead:
- **`--dry-run`** prints the planned override next to the checkout payload.
- **A live publish** marks the Launch `REV SHARE NOT SET IN WHOP` and prints
  the dashboard steps.
- **`npm run deals -- --report`** flags that launch until the share is set.

See the `TODO(rev-share)` comment in `index.ts`.
