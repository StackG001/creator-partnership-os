/**
 * Telling an egress proxy's refusal apart from a service's own rejection.
 *
 * Hosted and CI environments (Claude Code on the web among them) route outbound
 * HTTPS through a proxy that answers a host it is not allowed to reach with a
 * 403 of its own. By status alone that is indistinguishable from the service
 * rejecting our credential — and advising someone to regenerate a key that was
 * never actually sent sends them down a long wrong path. So look for the
 * proxy's own fingerprints, and treat a blocked host as an environment limit
 * rather than a broken credential.
 *
 * Lives here rather than in the doctor because every module that talks to a
 * third party (finder → Apify, publisher → Whop) hits the same ambiguity.
 */

/** Set by the agent proxy on a refusal; `host_not_allowed` means egress blocked. */
export const DENY_REASON_HEADER = 'x-deny-reason';

/** Phrases only an egress proxy produces, for proxies that omit the header. */
const BLOCK_PHRASES = [
  /host not in allowlist/i,
  /no rule or allowlist entry allows host/i,
  /connect tunnel failed/i,
  /blocked by (the )?proxy/i,
  /proxy(ing)? (is )?(denied|blocked|refused)/i,
  /network egress/i,
];

/** Does this error text or body read like a proxy refusal rather than an API's? */
export function looksBlocked(text: string): boolean {
  return BLOCK_PHRASES.some((phrase) => phrase.test(text));
}

/**
 * A one-line reason when `response` came from the proxy instead of the service,
 * `undefined` when it is a genuine answer — including a genuine 401/403, which
 * must keep reading as a rejected credential.
 *
 * The deny header is the strong signal. The body is only consulted for a
 * non-JSON 403/407, because every API we probe answers its own errors in JSON;
 * that keeps a service's own 403 from being mistaken for a block.
 *
 * Consumes the body, so pass a clone if the caller still needs it.
 */
export async function proxyBlock(response: Response): Promise<string | undefined> {
  const reason = response.headers.get(DENY_REASON_HEADER)?.trim();
  const contentType = response.headers.get('content-type') ?? '';
  const refusal = response.status === 403 || response.status === 407;

  if (!reason && !(refusal && !contentType.includes('json'))) return undefined;

  const body = await response
    .text()
    .then((text) => text.trim().split('\n')[0] ?? '')
    .catch(() => '');

  if (reason) return body || `proxy refused the request (${reason})`;
  return looksBlocked(body) ? body : undefined;
}

/** What to do about a blocked host — the same advice wherever it is hit. */
export function unblockFix(host: string): string {
  return `${host} is not reachable from here: an egress proxy blocked the connection, so the credential was never sent and is still untested. Add the host to this environment's network/egress allowlist, or run the doctor somewhere with direct access.`;
}
