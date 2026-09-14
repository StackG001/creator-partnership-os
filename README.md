# Creator Partnership OS

Internal tool: find micro-creators with engaged niche audiences and no digital
product, audit them, build a research-backed PDF in their voice, wrap it in a
funnel, publish it on Whop with a revenue share, and log what happens.

CLI-first — every module runs from the terminal before it gets any UI.

---

## Setup

```bash
git clone <repo> && cd creator-partnership-os
npm install

cp .env.example .env          # then add your ANTHROPIC_API_KEY
npx playwright install chromium   # HTML -> PDF rendering

npm run db:generate           # generate the Prisma client
npm run db:push               # create prisma/dev.db from the schema

npm run key                   # store your Anthropic key via a hidden prompt (nothing echoed)
npm run doctor                # verify everything before you run a module
```

`npm run doctor` is the source of truth for "is this machine ready?". It checks
the Node version, `.env`, every environment variable, the SQLite database and
its tables, the `outputs/` directory, Chromium's ability to render a PDF, and
every API you hold a key for (all three Anthropic models, YouTube, Apify,
Brave/Serper, Whop). It exits non-zero if anything required is broken and
prints the exact fix under **next steps**.

### Adding your API keys

Never paste a key into a chat, a commit, or a shell command (it lands in your
shell history). Two safe ways in:

```bash
npm run key                          # hidden prompt for ANTHROPIC_API_KEY
npm run key -- --name WHOP_API_KEY   # any other credential
npm run key -- --list                # what's set, masked
```

`npm run key` never echoes what you type, never takes the value as an argument,
and prints back only a masked fingerprint. It writes to `.env` and sets the file
to owner-only permissions.

Or edit `.env` by hand in your editor: put the value straight after the `=`, no
quotes, no spaces (`ANTHROPIC_API_KEY=sk-ant-...`).

Running in a Claude Code cloud session instead of locally? Set the variables on
the environment (claude.ai/code → the cloud icon above the message box → hover
your environment → settings icon → **Environment variables**, in `.env` format).
Sessions copy them in at startup, so `.env` is not needed at all — `npm run
doctor` accepts either. Note that anyone using that environment, Claude
included, can read those values.

```bash
npm run doctor                      # full check
npm run doctor -- --skip-network    # local checks only, no API calls
npm run doctor -- --skip-browser    # skip the Chromium/PDF check
npm run doctor -- --json            # machine-readable output
```

---

## Pipeline commands

Modules are scaffolded with their full flag contracts; the bodies come next.
Each one exits `2` with its help text until it is implemented. Add `--help` to
any of them.

```bash
# 1. discover candidates (10k-200k followers, engaged, no product yet)
npm run finder -- --platform instagram --niche "home barista" --limit 50
npm run finder -- --platform youtube --query "notion templates" --min-engagement 0.03
npm run finder -- --source src_abc123 --limit 25

# 2. score product-fit and reachability, 0-100
npm run scorer -- --handle jamesclearcoffee
npm run scorer -- --all --limit 50
npm run scorer -- --all --rescore

# 3. audit the audience: pillars, pains, monetisation gaps, product angles
npm run audit -- --handle jamesclearcoffee
npm run audit -- --handle jamesclearcoffee --posts 40 --refresh

# 4. capture the creator's voice, palette and typography
npm run brand -- --handle jamesclearcoffee
npm run brand -- --handle jamesclearcoffee --refresh

# 5. draft personalised outreach (stays DRAFT — nothing is ever auto-sent)
npm run outreach -- --handle jamesclearcoffee --channel email
npm run outreach -- --handle jamesclearcoffee --channel ig_dm --variants 3
npm run outreach -- --handle jamesclearcoffee --sequence 2

# 6. research, write and render the 35-50 page PDF
npm run product -- --handle jamesclearcoffee --angle 1
npm run product -- --handle jamesclearcoffee --pages 42 --stage outline
npm run product -- --handle jamesclearcoffee --resume

# 7. sales page + order bump + upsell
npm run funnel -- --handle jamesclearcoffee
npm run funnel -- --handle jamesclearcoffee --price 3700 --bump-price 1700 --upsell-price 9700

# 8. publish on Whop with revenue share, then sync results
npm run publisher -- --handle jamesclearcoffee --rev-share 50
npm run publisher -- --handle jamesclearcoffee --dry-run
npm run publisher -- --sync-stats
```

Two flags work everywhere: `--dry-run` (no database writes, no paid API calls)
and `--json` (machine-readable stdout).

## Database and app commands

```bash
npm run db:generate    # regenerate the Prisma client after a schema change
npm run db:push        # sync the schema to SQLite without a migration
npm run db:migrate     # create a named migration (use before the Supabase move)
npm run db:studio      # browse the data at localhost:5555

npm run typecheck      # tsc --noEmit
npm run build          # next build
npm run dev            # next dev — placeholder UI for now
```

---

## How it is put together

```
src/
  lib/
    llm.ts         Anthropic client + completeText / completeJSON (zod-validated)
    env.ts         every env var, validated with zod, in one object
    db.ts          Prisma client singleton
    paths.ts       outputs/<creator-handle>/ artifact helpers
    cli.ts         flag parsing, --help, env checks, exit codes
    constants.ts   status values + qualification thresholds
    logger.ts      levelled, scoped logging
  modules/
    finder/ scorer/ audit/ brand/ outreach/ product/ funnel/ publisher/
      cli.ts       entry point and flags
      index.ts     the typed functions the CLI calls
      README.md    what this module owns
  scripts/
    doctor.ts      the environment check
  app/             Next.js shell (UI comes after the CLIs work)
prisma/
  schema.prisma    Creator, Audit, Product, OutreachMessage, Launch, Source
outputs/
  <creator-handle>/{audit,brand,product,research,funnel,outreach,launch}/
```

### The LLM helper

Every model call goes through `src/lib/llm.ts`. For anything with a shape, use
`completeJSON`: it converts your zod schema to a tool definition, forces the
model to call it, validates the result, and on a validation failure re-prompts
the model with its own errors (up to `LLM_MAX_RETRIES`). What comes back is
typed and guaranteed to match.

```ts
import { z } from 'zod';
import { completeJSON } from '@/lib/llm.js';

const { data, usage } = await completeJSON({
  system: 'You audit creator audiences. Be specific and cite the evidence.',
  prompt: `Analyse these posts:\n${JSON.stringify(posts)}`,
  schema: z.object({
    painPoints: z.array(z.object({ pain: z.string(), evidence: z.string() })).min(3),
    productAngles: z.array(z.object({ title: z.string(), confidence: z.number() })),
  }),
  schemaName: 'audit_audience',
  tier: 'heavy',   // 'fast' | 'default' | 'heavy' — all resolved from .env
});
```

Set `LLM_TRACE=true` to write every prompt and response to `outputs/_llm/`.

### Data model

| Model | What it holds |
| --- | --- |
| `Source` | Where creators come from — hashtag, search, lookalike, CSV. Tracks run counts so discovery is repeatable. |
| `Creator` | The prospect: metrics, niche, contact route, score + breakdown, brand profile, pipeline status. |
| `Audit` | The research read: pillars, audience, pain points, monetisation gaps, product angles, evidence. |
| `Product` | The PDF: outline, cited research, chapters, brand theme, pricing, funnel copy, file paths. |
| `OutreachMessage` | Every message and follow-up, its hooks, and the reply. |
| `Launch` | The published funnel: Whop ids, prices, revenue share, and the results. |

SQLite has no enums, so status columns are strings validated against
`src/lib/constants.ts`. Money is always integer cents. The schema is written to
move to Supabase by changing the datasource block.

---

## Notes

- `.env` is never committed. `.env.example` lists every variable, what it does
  and where to get it. Only `ANTHROPIC_API_KEY` and `DATABASE_URL` are required
  to start; the rest unlock modules as they are built.
- `outputs/` is gitignored — generated PDFs, funnels and traces stay local.
- Outreach messages are never sent automatically. They are written, saved as
  `DRAFT`, and wait for a human.
