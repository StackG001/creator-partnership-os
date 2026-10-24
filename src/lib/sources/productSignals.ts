/**
 * Deterministic, best-effort read of whether a creator already sells
 * something — the qualification thesis is "engaged niche audience, no
 * digital product yet". No API calls: just keyword/host matching over text
 * and links the finder already fetched (bio + a handful of captions).
 */

export interface MonetizationSignals {
  sponsorships: boolean;
  affiliate: boolean;
  merch: boolean;
  coaching: boolean;
  patreon: boolean;
}

export interface ProductSignalResult {
  hasDigitalProduct: boolean;
  evidence: string[];
  monetization: MonetizationSignals;
}

const PRODUCT_HOSTS = [
  'gumroad.com',
  'payhip.com',
  'teachable.com',
  'kajabi.com',
  'mykajabi.com',
  'kartra.com',
  'samcart.com',
  'thrivecart.com',
  'learnworlds.com',
  'mighty.co',
  'mightynetworks.com',
  'thinkific.com',
  'podia.com',
  'stan.store',
  'whop.com',
  'sellfy.com',
  'systeme.io',
  'skool.com',
  'circle.so',
  'shopify.com',
  'myshopify.com',
];

// Any course/ebook/training/program offer in a bio counts, however it's phrased
// ("microgreens course", "free training", "join my program") — a free training is
// almost always the front of a paid funnel.
const PRODUCT_KEYWORDS =
  /\b(my (course|ebook|e-book|guide|template|masterclass|program|academy|membership)|(?!(?:of|main|golf|race|obstacle|first|second|third|last|due|par|water|in|a|the|this|that)\b)[\w-]+ course\b|e-?books?|online course|digital (product|guide|download)s?|template pack|notion template|masterclass|(free|paid|online|video) (?:[\w-]+ ){0,2}(training|workshop|webinar|class)|join my (?:[\w-]+ ){0,2}(training|program|academy|membership|community|course|challenge)|academy|membership|the [\w-]+ (program|programme|method|system|protocol)|coaching program|1:1 coaching|group coaching|mentorship|preorder|pre-order|now available|link in bio to (shop|buy)|shop my|buy my)\b/i;

const SPONSOR_RE = /\b(sponsored|paid partnership|in partnership with|#ad\b)\b/i;
const AFFILIATE_RE = /\b(affiliate|use code|discount code|promo code|my code)\b/i;
const MERCH_RE = /\bmerch\b/i;
const COACHING_RE = /\b(coach(ing)?|book a (call|session|consult\w*)|1:1 (sessions?|calls?|support)|consultations?|work with me|accepting (new )?clients|services? (menu|available)|dm (me )?for (services|rates|pricing))\b/i;
const PATREON_RE = /\bpatreon\b/i;

function matchingHosts(urls: string[]): string[] {
  const hits: string[] = [];
  for (const raw of urls) {
    try {
      const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
      if (PRODUCT_HOSTS.some((p) => host === p || host.endsWith(`.${p}`))) hits.push(raw);
    } catch {
      // not a URL, skip
    }
  }
  return hits;
}

export function analyzeMonetization(bio: string, urls: string[]): ProductSignalResult {
  const text = bio ?? '';
  const evidence: string[] = [];

  const hostHits = matchingHosts(urls);
  evidence.push(...hostHits);

  const keywordMatch = PRODUCT_KEYWORDS.exec(text);
  if (keywordMatch) evidence.push(`bio: "${keywordMatch[0]}"`);

  const monetization: MonetizationSignals = {
    sponsorships: SPONSOR_RE.test(text),
    affiliate: AFFILIATE_RE.test(text),
    merch: MERCH_RE.test(text),
    coaching: COACHING_RE.test(text),
    patreon: PATREON_RE.test(text) || urls.some((u) => /patreon\.com/i.test(u)),
  };

  const hasDigitalProduct = hostHits.length > 0 || Boolean(keywordMatch) || monetization.coaching;

  return { hasDigitalProduct, evidence, monetization };
}

// Video descriptions are noisier than a bio ("the braking system", "shop my
// favorites" affiliate storefronts, "buy my ingredients"), so only an explicit
// claim of the creator's own product counts there, or a link to a store/course
// platform. Members-only downloads (scripts, PDFs) count as a product. Etsy is
// left out: description links to Etsy are mostly other people's shops.
// Tested 2026-10-24 on 122 YouTube creators: 9 real sellers, no false positives.
const VIDEO_OWN_PRODUCT =
  /\b(my (new |latest |first |free |full |online )?(book|e-?book|cookbook|workbook|course|masterclass|program|programme|guide|templates?|presets|planner|academy|bootcamp)s?\b|digital downloads?|(?:buy|get|grab|download) (?:my|the|our) (?:[\w-]+ ){0,2}(?:book|e-?book|guide|course|templates?|planner|presets|pdf)\b|join my (?:[\w-]+ ){0,2}(?:program|course|academy|bootcamp|challenge)|members?(?:hip)? (?:only )?(?:[\w-]+ ){0,4}(?:pdf|download|worksheet)s?)/i;
const VIDEO_STORE_LINK =
  /(gumroad\.com|payhip\.com|teachable\.com|kajabi\.com|mykajabi\.com|thinkific\.com|podia\.com|stan\.store|whop\.com|sellfy\.com|systeme\.io|skool\.com|learnworlds\.com|samcart\.com|thrivecart\.com|ko-fi\.com\/s\/)/i;

/** Evidence that a YouTube creator's video descriptions sell their own product ("My book: …", "Digital Downloads"), else null. */
export function videoDescriptionProduct(descriptions: string[]): string | null {
  for (const d of descriptions) {
    const m = VIDEO_OWN_PRODUCT.exec(d) ?? VIDEO_STORE_LINK.exec(d);
    if (m) {
      const around = d.slice(Math.max(0, m.index - 40), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim();
      return `video description: "${around}"`;
    }
  }
  return null;
}
