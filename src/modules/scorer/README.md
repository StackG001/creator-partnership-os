# scorer

Turns a `Creator` into a 0-100 product-fit score plus a breakdown, and moves it to status `SCORED`.

Half the score is arithmetic (follower band, engagement rate, posting cadence); half is an LLM read of niche clarity, product gap and how reachable the creator is.

## Minors are disqualified

Anyone who looks under 18 is `DISQUALIFIED` whatever their score: `minorSignal`
(first-person school signals in bio, niche or recent video titles) or the LLM's
`appearsMinor`, which is shown the recent video titles. University, med school
and teachers/tutors don't count. Outreach's `contactBlock` re-runs
`minorSignal`, so creators scored before this check are still refused.
