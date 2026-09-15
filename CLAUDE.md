# Creator Partnership OS — working notes for Claude

> **Status:** this file was written from Gerald's kickoff brief because the
> blueprint paste had not landed when the repo was scaffolded. When the
> blueprint arrives, replace or extend the sections below with it — the
> conventions section reflects what the code actually does today, so keep it in
> sync with any change.

## What the system does

An internal tool for Gerald. End to end:

1. **Find** micro-creators on Instagram/YouTube (10k-200k followers) with an
   engaged niche audience and no digital product.
2. **Score** and **audit** them — audience, pain points, product gap.
3. Write **personalised outreach**.
4. Build a **35-50 page research-backed PDF** branded in the creator's voice
   and visual style.
5. Generate a **sales funnel**: sales page + order bump + upsell.
6. **Publish on Whop** with revenue share, and **log the results**.

## Stack constraints (non-negotiable)

- Next.js, TypeScript, App Router.
- SQLite via Prisma for now. Everything is written so the move to Supabase
  (Postgres) is a datasource change, not a rewrite.
- Anthropic API for **all** LLM work — no other model provider.
- Playwright for HTML→PDF.
- All secrets come from `.env`; `.env.example` documents every one of them.

## Conventions

**CLI-first.** Every module runs as `npm run <module> -- --args` before it gets
any UI. A module is not done until its CLI works. `src/lib/cli.ts` gives each
one flag parsing, generated `--help`, env validation and exit codes — use
`runCli(spec, handler)`, don't hand-roll argv parsing.

**Module layout.** `src/modules/{finder,scorer,audit,outreach,product,brand,funnel,publisher}/`
with `cli.ts` (entry point + flags), `index.ts` (the typed functions, no argv
knowledge) and `README.md`. CLI parses, `index.ts` does the work.

**All LLM calls go through `src/lib/llm.ts`.** Use `completeJSON` with a zod
schema whenever the output has a shape — it forces a tool call built from the
schema, validates the result, and re-prompts the model with its own validation
errors. Never `JSON.parse` a model response by hand. `completeText` is for
prose only. Tiers (`fast` / `default` / `heavy`) resolve through `.env` so
models can be re-pointed globally.

**Artifacts.** Everything generated lands under `outputs/<creator-handle>/`
(`audit/ brand/ product/ research/ funnel/ outreach/ launch/`). Use the helpers
in `src/lib/paths.ts`; store the path in the database alongside the data.
`outputs/` is gitignored.

**Database.** SQLite has no enums, so status fields are `String` columns whose
allowed values live in `src/lib/constants.ts` — change one, change the other.
Money is always integer cents. LLM-shaped output goes in a `Json` column plus a
file on disk.

**Nothing external happens implicitly.** Outreach messages stay `DRAFT` until a
human approves them; the publisher supports `--dry-run` and prints its payload.

## MCP

`.mcp.json` carries the project's MCP servers. `apify`
(`@apify/actors-mcp-server`, stdio) is there for Actor discovery and runs — the
same Apify account the finder scrapes Instagram through, authenticated with the
same `APIFY_TOKEN`, which must be exported in the shell (Claude Code does not
read `.env`). Running an Actor costs credits, so it falls under "nothing
external happens implicitly" — confirm first.

## Commands

`npm run doctor` first — it checks every env var, the database, Chromium and
every API connection. See README.md for the full command list.
