# Plant Copilot

Full-stack hackathon MVP for evidence-grounded plant breakdown triage, RCA capture, reliability dashboards, and plant Q&A.

## Stack

- Next.js App Router + Tailwind CSS
- Supabase Postgres + pgvector
- OpenAI `text-embedding-3-small`
- OpenAI chat completion for grounded synthesis and fixed-intent classification

## Setup

1. Copy `.env.example` to `.env.local` and fill in the Supabase and OpenAI values.
2. In Supabase, use a direct or session-pooler Postgres URL for `SUPABASE_DB_URL`.
3. Install and load:

```bash
npm install
npm run db:schema
npm run db:import
npm run db:embed
```

4. Start the app:

```bash
npm run dev
```

On Windows PowerShell systems that block `.ps1` command wrappers, use `npm.cmd` instead of `npm`.

## Routes

- `/` — role picker
- `/worker` — breakdown triage and resolution capture
- `/manager` — SQL-backed reliability dashboard
- `/api/triage`
- `/api/incidents`
- `/api/dashboard`
- `/api/ask`

## Demo

Use machine `CW-101` and:

> Reactor temperature is rising and cooling water flow seems low

The response retrieves pgvector evidence from TEP signatures, past RCAs, maintenance actions, and SOPs. Saving the final resolution creates a new incident and RCA, then embeds that RCA into plant memory.

The importer uses only `data/synthetic`, `data/mappings`, and prebuilt files in `data/processed`. It does not import the local FAISS store or derive signatures from raw TEP files.
