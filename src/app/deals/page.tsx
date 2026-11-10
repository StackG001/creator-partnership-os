import { prisma } from '../../lib/db';
import { DEAL_STAGES, PARTNERSHIP_TERMS } from '../../lib/constants';

/**
 * Read-only deal board. Everything is changed from the CLI
 * (`npm run deals -- --help`); this page only shows it.
 */

export const dynamic = 'force-dynamic';

const usd = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date | null) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

const DOCS = [
  ['One-Page Offer', PARTNERSHIP_TERMS.docs.onePageOffer],
  ['Creator Partnership Agreement (template)', PARTNERSHIP_TERMS.docs.agreementTemplate],
  ['Services Quote Template', PARTNERSHIP_TERMS.docs.servicesQuote],
] as const;

const muted = { color: '#a1a1aa' } as const;
const link = { color: '#93c5fd' } as const;

export default async function Deals() {
  const deals = await prisma.deal.findMany({
    include: { creator: true, ledger: { orderBy: { period: 'desc' } } },
    orderBy: { updatedAt: 'desc' },
  });
  const ledger = deals
    .flatMap((d) => d.ledger.map((e) => ({ ...e, handle: d.creator.handle })))
    .sort((a, b) => b.period.localeCompare(a.period));

  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '48px 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Deals</h1>
      <p style={{ ...muted, marginTop: 0 }}>
        Read-only. Change anything with <code>npm run deals -- --help</code>. Terms:{' '}
        {DOCS.map(([name, url], i) => (
          <span key={url}>
            {i ? ' · ' : ''}
            <a href={url} style={link}>{name}</a>
          </span>
        ))}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${DEAL_STAGES.length}, minmax(170px, 1fr))`, gap: 12, overflowX: 'auto' }}>
        {DEAL_STAGES.map((stage) => {
          const inStage = deals.filter((d) => d.stage === stage);
          return (
            <section key={stage} style={{ background: '#18181b', borderRadius: 8, padding: 12 }}>
              <h2 style={{ fontSize: 13, letterSpacing: 1, margin: '0 0 10px' }}>
                {stage} <span style={muted}>{inStage.length}</span>
              </h2>
              {inStage.map((d) => {
                const c = d.creator;
                const profile = c.platform === 'INSTAGRAM' ? `https://instagram.com/${c.handle}` : (c.profileUrl ?? `https://youtube.com/@${c.handle}`);
                const badge = d.agreementStatus === 'NONE' ? 'no agreement' : d.agreementStatus.toLowerCase();
                return (
                  <article key={d.id} style={{ background: '#27272a', borderRadius: 6, padding: 10, marginBottom: 8, fontSize: 13, lineHeight: 1.45 }}>
                    <a href={profile} style={{ ...link, fontWeight: 600 }}>@{c.handle}</a>
                    <div style={muted}>{c.niche?.slice(0, 60) ?? '—'} · {c.score ?? '—'}</div>
                    <div>
                      {d.agreementUrl ? <a href={d.agreementUrl} style={link}>{badge}</a> : <span>{badge}</span>}
                      {d.stageSource === 'MANUAL' ? <span style={muted}> · manual</span> : null}
                    </div>
                    {d.termsFlag ? <div style={{ color: '#fbbf24' }}>⚠ {d.termsFlag}</div> : null}
                    {c.doNotContact ? <div style={muted}>handled by hand</div> : null}
                    {d.nextAction ? <div>→ {d.nextAction}{d.nextActionDue ? ` (${day(d.nextActionDue)})` : ''}</div> : null}
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>

      <h2 style={{ fontSize: 20, marginTop: 40 }}>Ledger</h2>
      {ledger.length ? (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', ...muted }}>
              {['Deal', 'Period', 'Source', 'Sales', 'Gross', 'Fees', 'Refunds', 'Net', 'Creator', 'iClipmedia', 'Notes'].map((h) => (
                <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid #3f3f46' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ledger.map((e) => (
              <tr key={e.id}>
                {[`@${e.handle}`, e.period, e.source, String(e.sales), usd(e.grossCents), usd(e.whopFeeCents), usd(e.refundCents), usd(e.netCents), usd(e.creatorCents), usd(e.iclipCents), e.notes ?? ''].map((v, i) => (
                  <td key={i} style={{ padding: '6px 8px', borderBottom: '1px solid #27272a' }}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style={muted}>No sales recorded yet.</p>
      )}
    </main>
  );
}
