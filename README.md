# ChemieGenie

ChemieGenie is an AI-assisted plant-memory and root-cause-analysis copilot for chemical-process operations. It helps floor workers identify practical first checks from historical evidence, captures completed resolutions as new plant knowledge, and gives managers a SQL-backed view of incidents, repeat failures, and downtime.

## Problem statement

Plant troubleshooting knowledge is often scattered across RCA reports, maintenance logs, SOPs, alarm records, sensor snapshots, and the experience of individual operators. During a breakdown, teams lose time searching these sources and may repeat previously solved failures.

ChemieGenie turns this fragmented history into a searchable, evidence-grounded operational memory while preserving the original structured records as the source of truth.

## Users & context

- **Floor workers and operators:** describe a breakdown in natural language, review cited first checks, inspect related equipment and SOPs, and record the final resolution.
- **Maintenance and reliability engineers:** review previous corrective actions, handlers, alarms, process variables, spare parts, and detailed incident history.
- **Plant managers:** monitor open incidents, trends, repeat failures, top problem machines, and downtime using SQL-derived metrics.

The current application is a hackathon/demo system based on supplied and synthetic plant-memory data. It is not connected to a live historian, SCADA, DCS, CMMS, or safety system.

## Solution overview

```text
Operator breakdown description
            |
            v
OpenAI query embedding
            |
            v
Supabase pgvector retrieval
  - TEP fault signatures
  - RCA documents
  - maintenance actions
  - SOP documents
            |
            v
Structured plant context
  - incidents and employees
  - alarms and sensor snapshots
  - machines and spare parts
            |
            v
Grounded OpenAI synthesis with citations
            |
            +--> first checks and previous actions
            +--> equipment schematics and SOPs
            +--> worker resolution capture
                       |
                       v
             New incident + RCA + embedding
```

ChemieGenie provides:

- A worker breakdown-triage workflow with confidence and citations.
- A manager reliability dashboard calculated through predefined SQL.
- Structured plant Q&A through fixed, auditable intents.
- Knowledge Q&A through retrieval-augmented generation.
- Equipment schematic and SOP views.
- A closed learning loop that embeds newly recorded RCAs.

## Setup & run

### 1. Configure the environment

Copy `.env.example` to `.env.local` and provide:

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=
OPENAI_API_KEY=
OPENAI_CHAT_MODEL=gpt-4o-mini
```

Never commit `.env.local` or expose service-role/OpenAI keys in browser code.

### 2. Install dependencies

```bash
npm install
```

On Windows PowerShell systems that block script wrappers, use `npm.cmd`.

### 3. Create and populate the database

```bash
npm run db:schema
npm run db:import
npm run db:embed
```

Optional clean reload:

```bash
npm run db:reset
```

### 4. Run locally

```bash
npm run dev
```

Open `http://localhost:3000`.

Demo query:

> Reactor temperature is rising and cooling water flow seems low

### Application routes

- `/` — worker/manager role picker
- `/worker` — breakdown triage and resolution capture
- `/manager` — reliability dashboard
- `/api/triage` — grounded RCA triage
- `/api/incidents` — incident/RCA close-out
- `/api/dashboard` — SQL dashboard metrics
- `/api/ask` — structured or knowledge Q&A

## Models & data

### Models

- **OpenAI `text-embedding-3-small`:** 1,536-dimensional query and document embeddings.
- **OpenAI chat model:** configured through `OPENAI_CHAT_MODEL`; the default example is `gpt-4o-mini`.
- The LLM performs evidence-grounded synthesis and fixed-intent classification. It does not generate SQL.

OpenAI model usage is subject to the [OpenAI terms and policies](https://openai.com/policies/).

### Data sources

- Synthetic machines, employees, incidents, RCAs, alarms, sensor snapshots, maintenance actions, spare parts, and SOP documents under `data/synthetic/`.
- TEP variable and fault mappings under `data/mappings/`.
- Prebuilt Tennessee Eastman Process fault summaries and signatures under `data/processed/`.
- Equipment schematics under `public/machines/`.

The large raw TEP CSV files are reference/debugging inputs and are not required by the application runtime. The app does not derive new fault signatures from them.

### Licenses and redistribution

- No standalone software license has currently been added to this repository; all rights remain with the project author unless a license is added.
- The plant-memory records are synthetic demo data created for this project.
- Tennessee Eastman Process-derived material should be attributed to its original benchmark/source. Confirm the terms of the exact dataset distributor before redistributing raw TEP files.
- OpenAI services and Supabase are governed by their respective service terms.

## Evaluation & guardrails

### Evaluation

- Sample operator queries provide expected TEP retrieval targets.
- The demo cooling-water query is checked against known RCA and maintenance records.
- TypeScript validation and `next build` are used as implementation checks.
- The embedding script compares derived documents with source tables and refreshes changed content.
- Dashboard aggregates are produced by SQL rather than estimated by the LLM.

### Hallucination and bias mitigations

- Answers are generated only from retrieved plant evidence and structured database context.
- Recommendations and knowledge answers include source citations.
- Weak retrieval produces a low-confidence result and explicit warning.
- The model is instructed not to claim an unconfirmed root cause as confirmed.
- Safety interlocks and protection systems must never be bypassed.
- Structured Q&A is limited to predefined intents and parameterized SQL functions.
- The LLM cannot generate or execute arbitrary SQL.
- RCA display content is hydrated from source tables, preventing stale vector copies from becoming the displayed source of truth.
- Machine IDs, employee IDs, incident IDs, and RCA IDs come from structured records rather than model generation.

Synthetic data can still encode unrealistic patterns or simplify real operational behavior. Recommendations therefore require human verification by qualified plant personnel.

## Known limitations & risks

- This is a demo, not a certified process-safety or decision-control system.
- It has no live historian, SCADA, DCS, SAP, Maximo, permit-to-work, or EHS integration.
- Retrieval quality depends on document coverage, embedding quality, and operator wording.
- Similar historical incidents do not prove that the current incident has the same root cause.
- Some equipment may not have a schematic or SOP available.
- The generated “first checks” are advisory and must be validated against site procedures and operating limits.
- There is no authentication or role-based access control.
- New incident ID generation is demo-oriented and is not designed for high-concurrency production use.
- API availability, cost, latency, and rate limits depend on OpenAI and Supabase.
- Synthetic records and TEP-derived signatures are not substitutes for site-specific engineering data.

## Team

**Varun Chandar — Solo developer**

Designed and implemented the complete product, frontend, backend, database schema, data pipeline, retrieval system, AI integration, evaluation workflow, and UI.

- Mobile: +91 9840466376
- Email: [varunchandar.nitt@gmail.com](mailto:varunchandar.nitt@gmail.com)
