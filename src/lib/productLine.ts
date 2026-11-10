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

// --- safety-advice niches ----------------------------------------------------------------------
//
// Products that tell the reader to work on something that can hurt them (mains
// voltage, charged capacitors, live chassis…) are accepted case by case
// (Gerald, 2026-11-10, @emmarepairs). Such a product must:
//   1. put a clear safety warning before any electrical step,
//   2. carry a "work at your own risk / use a qualified technician if unsure"
//      disclaimer (inserted by code at render, not left to the model),
//   3. never include a step that skips a safety precaution,
//   4. have every procedure approved by the creator before it can be published.
// A creator is in this set when their niche says so, or when Gerald marks the
// deal by hand with a note containing "Safety-advice niche".

const SAFETY_NICHE =
  /\b(mains|high[- ]voltage|voltage|capacitors?|electrical|electronics? (repair|restoration)|electro-?mechanical|amp(lifier)? (repair|rebuild|restoration)|tube amps?|valve amps?|power supply repair|soldering)\b/i;

/** How Gerald marks a deal by hand (npm run deals -- --notes @handle "Safety-advice niche …"). */
export const SAFETY_NOTE_MARKER = /safety-advice niche/i;

/** Why this creator's product falls under the safety rule, or null. */
export function safetyNicheReason(input: { niche?: string | null; subNiche?: string | null; dealNotes?: string | null }): string | null {
  if (input.dealNotes && SAFETY_NOTE_MARKER.test(input.dealNotes)) return 'marked as a safety-advice niche on the deal';
  const m = `${input.niche ?? ''} ${input.subNiche ?? ''}`.match(SAFETY_NICHE);
  return m ? `niche mentions "${m[0]}"` : null;
}

/** Text that describes an electrical step — anything after which a warning must already have been given. */
export const ELECTRICAL_STEP =
  /\b(mains|plug(ged)? (it |the \w+ )?in|unplug\w*|power (it |the \w+ )?(on|up)|switch(ed|ing)? (it )?on|capacitors?|filter caps?|electrolytics?|voltages?|volts?|live (wire|circuit|chassis|parts?)|solder\w*|amp(lifier)? (board|chassis)|power supply|fuses?|transformer|ground(ing)? (wire|screw|lug|strap)|power cord|2-prong)\b/i;

const SKIPS_PRECAUTION: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(no need to|don'?t (need|have) to|you can skip|skip(ping)?|don'?t bother( with)?|without) (unplugg\w*|discharg\w*|disconnect\w*|isolat\w*|turning (it )?off)\b/i, label: 'skips unplugging/discharging' },
  { pattern: /\b(bypass\w*|jumper\w*|short\w*( out)?) (the )?(fuse|interlock|safety)\b/i, label: 'bypasses a fuse or interlock' },
  { pattern: /\b(remove|lift|cut|clip|break off|snap off) (the )?(ground|earth)( pin| prong| wire| lead)?\b|\bcheater plug\b|\bground[- ]lift adapter\b/i, label: 'removes the safety ground' },
  { pattern: /\b(replace|swap) (the |a )?(blown )?fuse (with|for) (a )?(higher|bigger|larger)\b|\bhigher[- ]rated fuse\b/i, label: 'over-rated fuse' },
  { pattern: /\bcapacitors? (are|is) (safe|harmless)\b|\bsafe to touch\b.*\b(capacitor|chassis|board)\b/i, label: 'says charged parts are safe to touch' },
];

/** Labels for every way this text skips a safety precaution. */
export function skippedPrecautions(text: string): string[] {
  return SKIPS_PRECAUTION.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/** Matches the label of a callout that counts as a safety warning. */
export const SAFETY_CALLOUT_LABEL = /\b(safety|warning|danger|caution)\b/i;

/** The rule as a prompt line, for outlining and writing a safety-advice product. */
export const SAFETY_PRODUCT_RULE = [
  'SAFETY-ADVICE PRODUCT: this guide tells the reader to work on equipment that can injure or kill them (mains voltage, charged capacitors, live chassis).',
  '- Before the FIRST block in a chapter that describes any electrical step (plugging in, powering up, mains, voltages, capacitors, the amp/power supply, soldering, fuses, the power cord), put a `callout` block whose label starts with "Safety" and that says exactly what to do first: unplug, wait, discharge the capacitors safely, and how to confirm it is safe.',
  '- Never write a step that skips a safety precaution: no "no need to unplug", no bypassing fuses or interlocks, no removing the ground pin or cheater plugs, no over-rated fuses, never call capacitors or the chassis safe to touch.',
  '- When a step is risky for a beginner, say plainly to stop and use a qualified technician.',
  '- The creator approves every procedure before publishing; write each procedure as numbered steps so it can be reviewed one by one.',
].join('\n');

/** Shown on its own page after the cover, and at the top of every chapter with an electrical step. */
export const SAFETY_DISCLAIMER =
  'This guide involves mains voltage and components that can hold a dangerous charge after the instrument is unplugged. You work on your instrument at your own risk. If you are unsure about any step, stop and use a qualified technician. Always unplug the instrument and safely discharge the capacitors before touching anything inside.';
