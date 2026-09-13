# finder

Discovers micro-creator candidates and upserts them as `Creator` rows with status `DISCOVERED`.

Qualification window (see `src/lib/constants.ts`): 10k-200k followers, engagement rate >= 2%, no digital product found.

Inputs: hashtags, platform searches, lookalike seeds, CSV imports — each stored as a `Source` so runs are repeatable and attributable.
