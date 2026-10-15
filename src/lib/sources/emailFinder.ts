import { extractUrls, fetchPage, pickLinkInBioUrl } from './linkInBio.js';
import { createLogger } from '../logger.js';

/**
 * Looks for a business email for a creator who passed scoring — free page
 * fetches only, no paid calls. Order: bio → link-in-bio page (Linktree,
 * Beacons, Stan, personal site, incl. mailto: links) → the personal site that
 * a link hub points to → YouTube channel/video descriptions. Returns where it
 * was found so the source is stored next to the address.
 */

const log = createLogger('sources:email');
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const BUSINESS_HINT = /business|contact|hello|hey|hi@|partner|collab|press|management|inquir|enquir|booking|work|team|info/i;
const JUNK = /\.(png|jpe?g|gif|webp|svg)$|@(example|sentry|wixpress|domain)\.|^(no-?reply|noreply)@/i;

/**
 * Addresses that belong to a platform, not the creator — link hubs, social
 * networks, app stores, site builders. Never a creator's business email.
 */
const PLATFORM_EMAIL_DOMAINS = /@(?:[\w-]+\.)*(linktr\.ee|linktree\.com|beacons\.ai|stan\.store|linkin\.bio|lnk\.bio|bio\.link|tap\.bio|campsite\.bio|hoo\.be|koji\.to|withkoji\.com|carrd\.co|solo\.to|snipfeed\.co|instagram\.com|facebook\.com|meta\.com|fb\.com|tiktok\.com|youtube\.com|google\.com|apple\.com|amazon\.com|shopify\.com|squarespace\.com|wix\.com|wordpress\.com|godaddy\.com|mailchimp\.com|kit\.com|convertkit\.com|patreon\.com|gumroad\.com|teachable\.com|kajabi\.com|etsy\.com|substack\.com|bitly\.com|bit\.ly|tinyurl\.com|rebrandly\.com|cutt\.ly|lnkd\.in)$/i;

/** Whether the address's domain can receive mail at all (has MX records). Unknown DNS errors count as "can". */
export async function domainAcceptsMail(email: string): Promise<boolean> {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) return false;
  try {
    const { resolveMx } = await import('node:dns/promises');
    return (await resolveMx(domain)).length > 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return !(code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN');
  }
}

export function isPlatformEmail(email: string): boolean {
  return PLATFORM_EMAIL_DOMAINS.test(email.trim());
}
const HUBS = ['linktr.ee', 'beacons.ai', 'stan.store', 'linkin.bio', 'lnk.bio', 'bio.link', 'tap.bio', 'campsite.bio', 'hoo.be', 'koji.to', 'msha.ke', 'withkoji.com', 'carrd.co', 'solo.to', 'snipfeed.co'];
// Outbound links that are never the creator's own site: socials, stores, app stores, the hub itself.
const SOCIAL = /(instagram|tiktok|youtube|youtu\.be|facebook|twitter|x\.com|pinterest|threads|spotify|apple\.com|amazon|amzn|play\.google|google\.com|linktr|linktree|onelink|app\.link|bit\.ly|bitly\.com|tinyurl\.com|rebrandly)/i;

function pick(text: string): string | null {
  const all = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.replace(/[.,;:]+$/, '')))].filter((e) => !JUNK.test(e) && !isPlatformEmail(e));
  if (!all.length) return null;
  return all.find((e) => BUSINESS_HINT.test(e)) ?? all[0]!;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export interface FoundEmail {
  email: string;
  source: string;
}

const PERSONAL_MAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|zoho|fastmail|hey)\.[a-z.]+$/i;

const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|ow\.ly|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|is\.gd|rb\.gy|tiny\.cc|lnkd\.in|goo\.gl)$/i;
const SITE_PAGES = ['/', '/contact', '/contact-us', '/pages/contact', '/about', '/about-us'];

function rootDomain(h: string): string {
  const parts = h.split('.');
  return parts.slice(-2).join('.');
}

/** Follow a short link (bit.ly …) to where it really goes. */
async function resolveShort(url: string): Promise<string> {
  if (!SHORTENERS.test(host(url))) return url;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return res.url || url;
  } catch {
    return url;
  }
}

/** Creator-owned site candidates: not a social network, link hub, store, app store or shortener. */
async function ownSites(urls: string[]): Promise<string[]> {
  const out = new Map<string, string>();
  for (const raw of urls) {
    if (!/^https?:/i.test(raw)) continue;
    // A bare shortener ("https://bit.ly") is a placeholder, not a link to anything.
    if (SHORTENERS.test(host(raw)) && new URL(raw).pathname.replace(/\/+$/, '') === '') continue;
    const u = await resolveShort(raw);
    const h = host(u);
    if (!h || SOCIAL.test(u) || SHORTENERS.test(h) || HUBS.some((x) => h === x || h.endsWith(`.${x}`))) continue;
    const root = rootDomain(h);
    if (!out.has(root)) out.set(root, `https://${h}`);
    if (out.size >= 3) break;
  }
  return [...out.values()];
}

function emailsOnPage(page: { text: string | null; links: string[] }): string[] {
  const mailtos = page.links.filter((l) => /^mailto:/i.test(l)).map((l) => l.replace(/^mailto:/i, '').split('?')[0]!);
  const text = [...mailtos, page.text ?? ''].join('\n');
  return [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.replace(/[.,;:]+$/, '').toLowerCase()))].filter(
    (e) => !JUNK.test(e) && !isPlatformEmail(e),
  );
}

/**
 * The creator's own website: home, contact and about pages. An address on the
 * site's own domain wins (contact@princetonmicrogreens.com on princetonmicrogreens.com);
 * any other non-platform address found there is only a fallback.
 */
async function emailFromOwnSite(site: string): Promise<{ sameDomain: FoundEmail | null; other: FoundEmail | null }> {
  const root = rootDomain(host(site));
  let other: FoundEmail | null = null;
  for (const path of SITE_PAGES) {
    const url = new URL(path, site).toString();
    try {
      const found = emailsOnPage(await fetchPage(url, 15_000));
      const same = found.find((e) => rootDomain(e.split('@')[1] ?? '') === root);
      if (same) return { sameDomain: { email: same, source: `own website ${url}` }, other };
      // Off-domain addresses on a site are usually the web host's or a theme's
      // (support@o2switch.fr) — only a personal mailbox counts as the creator's.
      const personal = found.filter((e) => PERSONAL_MAIL.test(e));
      if (!other && personal.length) other = { email: personal[0]!, source: `own website ${url}` };
    } catch {
      // page missing — try the next one
    }
  }
  return { sameDomain: null, other };
}

export async function findBusinessEmail(input: {
  bio: string | null;
  externalUrls: string[];
  youtubeTexts?: string[];
}): Promise<FoundEmail | null> {
  const fromBio = pick(input.bio ?? '');
  if (fromBio) return { email: fromBio, source: 'bio' };

  const youtubeUrls = (input.youtubeTexts ?? []).flatMap((t) => extractUrls(t));
  const allUrls = [...input.externalUrls, ...extractUrls(input.bio ?? ''), ...youtubeUrls];
  let fallback: FoundEmail | null = null;

  // 1. The link-in-bio page itself, and — for a link hub — the sites it links out to.
  const linkUrl = pickLinkInBioUrl([...input.externalUrls, ...extractUrls(input.bio ?? '')]);
  const hubLinks: string[] = [];
  if (linkUrl) {
    try {
      const page = await fetchPage(linkUrl, 15_000);
      const found = emailsOnPage(page);
      if (found.length) fallback = { email: found.find((e) => BUSINESS_HINT.test(e)) ?? found[0]!, source: `link-in-bio ${linkUrl}` };
      if (HUBS.some((h) => host(linkUrl) === h || host(linkUrl).endsWith(`.${h}`))) hubLinks.push(...page.links);
    } catch (error) {
      log.debug(`link-in-bio ${linkUrl} unreadable: ${(error as Error).message}`);
    }
  }

  // 2. The creator's own website(s): an address on their own domain beats everything else.
  for (const site of await ownSites([...allUrls, ...hubLinks])) {
    const { sameDomain, other } = await emailFromOwnSite(site);
    if (sameDomain && (await domainAcceptsMail(sameDomain.email))) return sameDomain;
    fallback ??= other;
  }
  if (fallback && (await domainAcceptsMail(fallback.email))) return fallback;

  // 3. YouTube channel / video descriptions.
  for (const t of input.youtubeTexts ?? []) {
    const e = pick(t);
    if (e) return { email: e, source: 'youtube channel/video description' };
  }
  return null;
}
