# product

Builds the deliverable: a 35-50 page, research-backed PDF written in the creator's voice.

Stages run independently (`--stage`) so a failed render never costs a rewrite. Research claims are stored with their source URLs and cited in the PDF.

## Safety-advice products

When the creator's niche involves mains voltage, capacitors, electronics/amp
repair or soldering — or their deal has a note containing "Safety-advice
niche" (`npm run deals -- --notes @h "Safety-advice niche …"`) — the build
follows `SAFETY_PRODUCT_RULE` (`src/lib/productLine.ts`).

What the build does:
- **Outline and chapter prompts** carry the rule.
- **Every chapter must pass `chapterSafetyIssues`.** That means a callout
  labelled "Safety…" before the first electrical step, and no step that skips
  a precaution. A chapter that fails goes back to the model.
- **Render refuses to run** if any cached chapter fails the check.
- **The disclaimer is inserted by code**, after the cover and at the top of
  each electrical chapter.
- **`product/safety-review.md`** lists every warning and procedure for the
  creator to tick off.

Approval before publishing:
- The publisher refuses the product until it is APPROVED. After the creator
  signs off, run:

```
npm run product -- --handle emmarepairs --approve --approved-by "Emma"
```

- That step also adds a dated note to the deal.

## Research and chapter requirements are niche-generic

Research queries are written per product from the audit:
- the creator's niche, the chosen product, and the audience persona and pains
  (one `fast` call), plus direct searches for the top 3 pains;
- for safety-advice products, also the correct safety procedures.

Every outline must include:
- at least two reference tables with researched values (`includesTable`);
- a symptom → cause → fix troubleshooting path (`includesTroubleshooting`);
- a start-to-finish step order.

Until 2026-11-10 these were hard-coded for Grant's sourdough guide (sourdough
search queries, timing/freeze requirements). His cached research and outline
under `outputs/grantbakes/` are untouched.
