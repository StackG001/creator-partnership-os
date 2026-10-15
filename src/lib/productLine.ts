/**
 * The product line for sensitive niches. Health, medical, mental-health and
 * finance creators are welcome, but what we build with them is a lifestyle or
 * experience guide from the creator's own routines ("my flare-day meal plan",
 * "how I budget on one income") — never treatment, cures, diagnosis,
 * investment or debt advice. These checks flag anything that crosses the line;
 * a flagged idea or message is held for Gerald, never sent automatically.
 */

const SENSITIVE_NICHE =
  /\b(health|medical|medicine|condition|chronic|illness|disease|disorder|syndrome|diagnos\w*|symptom\w*|eczema|psoriasis|tsw|steroid|arthritis|inflammat\w*|autoimmune|graves|thyroid|diabet\w*|pcos|endometriosis|ibs|crohn|celiac|coeliac|allerg\w*|asthma|migraine|cancer|fertility|pregnan\w*|postpartum|menopaus\w*|adhd|autism|anxiety|depress\w*|mental|trauma|ptsd|ocd|bipolar|eating disorder|grief|therapy|sobriety|addiction|weight loss|hair loss|thinning hair|acne|finance|financial|money|budget\w*|debt|invest\w*|saving|savings|credit|retire\w*|income|frugal)\b/i;

/** Whether a niche/sub-niche description falls in the sensitive set. */
export function isSensitiveNiche(text: string | null | undefined): boolean {
  return Boolean(text && SENSITIVE_NICHE.test(text));
}

const CROSSES_LINE: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(cure[sd]?|curing|heal(s|ed|ing)? (your|the|my)|treat(s|ment|ing)? (your|the|for)|reverse[sd]? (your|the)|remed(y|ies) for|eliminate (pain|symptoms|flares?)|get rid of (your )?(eczema|acne|anxiety|depression|pain))\b/i, label: 'treatment/cure claim' },
  { pattern: /\b(diagnos\w*|self-diagnos\w*|prescri\w*|dosage|dose[sd]?|clinical protocol|medical protocol|detox protocol)\b/i, label: 'diagnosis/prescribing' },
  { pattern: /\b(instead of|replace|replaces|replacing|ditch|stop taking) (your )?(medication|meds|medicine|doctor|therapist|therapy|steroids?|supplements?|prescriptions?)\b/i, label: 'replacing medical care' },
  { pattern: /\b(invest(ing|ment)? (advice|strategy|plan|guide|tips)|stock picks?|crypto|day trading|trading strategy|portfolio|guaranteed returns?|passive income system)\b/i, label: 'investment advice' },
  { pattern: /\b(debt (relief|consolidation|settlement|advice|elimination plan)|credit repair|fix your credit|get out of debt fast|tax advice|financial advice)\b/i, label: 'debt/financial advice' },
];

/** Labels for every way this text crosses from a lifestyle guide into advice we never sell. */
export function productLineFlags(text: string): string[] {
  return CROSSES_LINE.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/** The rule as a prompt line, for audit synthesis and outreach drafting. */
export const SENSITIVE_PRODUCT_RULE =
  'This is a health/medical/mental-health/finance niche. Every product idea must be a lifestyle or experience guide built on the creator\'s OWN routines and lived experience (e.g. "my flare-day meal plan", "how I budget on one income", "my calm-morning routine") — never treatment, cures, symptom relief claims, diagnosis, replacing medication or professional care, investment advice or debt advice.';
