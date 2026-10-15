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
const HUBS = ['linktr.ee', 'beacons.ai', 'stan.store', 'linkin.bio', 'lnk.bio', 'bio.link', 'tap.bio', 'campsite.bio', 'hoo.be', 'koji.to', 'msha.ke', 'withkoji.com', 'carrd.co', 'solo.to', 'snipfeed.co'];
const SOCIAL = /(instagram|tiktok|youtube|youtu\.be|facebook|twitter|x\.com|pinterest|threads|spotify|apple\.com|amazon|amzn)/i;

function pick(text: string): string | null {
  const all = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.replace(/[.,;:]+$/, '')))].filter((e) => !JUNK.test(e));
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

export async function findBusinessEmail(input: {
  bio: string | null;
  externalUrls: string[];
  youtubeTexts?: string[];
}): Promise<FoundEmail | null> {
  const fromBio = pick(input.bio ?? '');
  if (fromBio) return { email: fromBio, source: 'bio' };

  const linkUrl = pickLinkInBioUrl([...input.externalUrls, ...extractUrls(input.bio ?? '')]);
  if (linkUrl) {
    try {
      const page = await fetchPage(linkUrl, 15_000);
      const mailtos = page.links.filter((l) => /^mailto:/i.test(l)).map((l) => l.replace(/^mailto:/i, '').split('?')[0]!);
      const found = pick([...mailtos, page.text ?? ''].join('\n'));
      if (found) return { email: found, source: `link-in-bio ${linkUrl}` };

      // A link hub: follow the creator's own site (first non-social outbound link), and its /contact page.
      if (HUBS.some((h) => host(linkUrl) === h || host(linkUrl).endsWith(`.${h}`))) {
        const site = page.links.find((l) => /^https?:/i.test(l) && !SOCIAL.test(l) && !HUBS.some((h) => host(l).endsWith(h)));
        if (site) {
          for (const url of [site, new URL('/contact', site).toString()]) {
            try {
              const sp = await fetchPage(url, 15_000);
              const m = sp.links.filter((l) => /^mailto:/i.test(l)).map((l) => l.replace(/^mailto:/i, '').split('?')[0]!);
              const e = pick([...m, sp.text ?? ''].join('\n'));
              if (e) return { email: e, source: `personal site ${url} (via ${linkUrl})` };
            } catch {
              // try the next one
            }
          }
        }
      }
    } catch (error) {
      log.debug(`link-in-bio ${linkUrl} unreadable: ${(error as Error).message}`);
    }
  }

  for (const t of input.youtubeTexts ?? []) {
    const e = pick(t);
    if (e) return { email: e, source: 'youtube channel/video description' };
  }
  return null;
}
