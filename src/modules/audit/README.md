# audit

Produces the evidence pack behind every later decision: content pillars, audience profile, 3-8 **goldmine signals** (see below), monetisation gaps and 3-5 candidate product angles.

Artifacts: `outputs/<handle>/audit/audit.md` and `audit.json`.

## The Goldmine filter

Extraction only keeps comments that reveal a hidden problem worth a digital
product — never generic complaints, product questions or one-off frustrations.
Five signal types: recurring unanswered question, "I've tried everything",
transformation request, shame/embarrassment, "I wish someone had told me".
Each must pass all three product-opportunity tests (audience has paid / would
obviously pay; the creator's free content leaves a gap; it can be packaged as a
system, guide, plan or framework). Every signal records type, exact quote, post
reference (plus every post it repeats on), why it passes, and the product format.

- Fewer than 3 signals traced word for word to a post URL → **low product-fit**:
  the creator is set `DISQUALIFIED` (`disqualifiedFor`), so no outreach is drafted.
- A recurring signal is 3+ different commenters with the same underlying
  problem, whatever the wording (`askerCount`). Self-blame phrasing ("what am I
  doing wrong", "sorry if this is obvious") counts as SHAME_OR_EMBARRASSMENT.
- **Creator-validated angle:** a signal matching one of the creator's
  top-performing posts (likes + 3×comments, top 8) is flagged
  `creator_validated` with `validatedBy` — checked in code against that list.
- Product scores are capped by the reach of the signals they solve
  (`repeatScoreCap`, reach = max(posts, askers)): 1 → max 5, 2 → 6.5, 3-4 → 8,
  5+ → 10. A product solving a creator-validated signal is never capped.
- `top10Pains` in `audit.json` is now the goldmine quotes (3-8), kept under that
  name for outreach, product, funnel and quotes.
