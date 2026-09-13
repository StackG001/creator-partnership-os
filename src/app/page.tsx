/**
 * Placeholder shell. The system is CLI-first: every module ships as
 * `npm run <module>` before it gets a screen here.
 */

const PIPELINE = [
  ['finder', 'Discover 10k-200k creators with engaged, niche audiences'],
  ['scorer', 'Score product-fit and reachability, 0-100'],
  ['audit', 'Research the audience, its pains and the product gap'],
  ['brand', "Capture the creator's voice and visual identity"],
  ['outreach', 'Draft personalised first touches and follow-ups'],
  ['product', 'Write and render the 35-50 page branded PDF'],
  ['funnel', 'Sales page, order bump, upsell'],
  ['publisher', 'Publish on Whop with revenue share, log results'],
] as const;

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Creator Partnership OS</h1>
      <p style={{ color: '#a1a1aa', marginTop: 0 }}>
        CLI-first. Run <code>npm run doctor</code> to check the environment, then any
        module with <code>--help</code>.
      </p>
      <ol style={{ lineHeight: 1.9, paddingLeft: 20 }}>
        {PIPELINE.map(([name, description]) => (
          <li key={name}>
            <code>npm run {name}</code> — {description}
          </li>
        ))}
      </ol>
    </main>
  );
}
