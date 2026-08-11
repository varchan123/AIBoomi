# ChemieGenie

ChemieGenie is an AI-assisted plant-memory and root-cause-analysis copilot for chemical-process operations. It helps floor workers identify practical first checks from historical evidence, captures completed resolutions as new plant knowledge, and gives managers a SQL-backed view of incidents, repeat failures, and downtime.

Vercel App Link: https://ai-boomi.vercel.app/worker

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

## Incident Escalation Agent

OpenAI continues to power ChemieGenie’s existing RAG copilot, including `/api/ask`, `/api/triage`, intent classification, evidence synthesis, and all embeddings. Sarvam powers only the new action-taking workflow:

- **Sarvam-105B:** bounded investigation, read-tool selection, proposal generation, escalation decisions, and WhatsApp-reply interpretation.
- **Saaras v3:** code-mixed operator recording and inbound WhatsApp voice-note transcription.
- **Bulbul v3:** short spoken responses generated only when the operator presses **Play response**.
- **Twilio WhatsApp Sandbox:** approved outbound escalation and authenticated inbound replies.

The agent can inspect existing machines, alarms, historical sensor snapshots, incidents, maintenance records, vector-retrieved evidence, and SOPs. It cannot control equipment, generate SQL, select arbitrary recipients, bypass safety systems, or verify root causes.

Investigation is read-only. The exact incident, work order, approved contact ID, and WhatsApp preview are bound into a signed ten-minute approval token. Writes and the outbound message occur only after **Approve and escalate**. That approval grants bounded advance permission for the approved WhatsApp contact to update only the mapped work order to `Accepted`, `In Progress`, `Needs Help`, or `Resolved - Awaiting Verification`.

Root-cause and fix descriptions received from WhatsApp remain unverified technician claims requiring human review. Unrelated, ambiguous, suspicious, wrongly addressed, or unauthenticated messages are staged and do not change a work order.

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
SARVAM_API_KEY=
SARVAM_CHAT_MODEL=sarvam-105b
ENABLE_SARVAM_TTS=false
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=whatsapp:+<sandbox-number>
MAINTENANCE_WHATSAPP_TO=whatsapp:+91<approved-test-number>
APP_BASE_URL=https://<public-deployment-domain>
AGENT_APPROVAL_SECRET=<at-least-32-random-characters>
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
npm run db:agent-schema
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

Configure the Twilio Sandbox inbound webhook to `https://<deployment-domain>/api/whatsapp/inbound`. `APP_BASE_URL` must exactly match that public origin for signature validation. Keep `ENABLE_SARVAM_TTS=false` while developing the text workflow and enable it only for deliberate playback tests or the demo.

Automated tests mock all paid provider calls:

```bash
npm run test:agent
npm run build
```

### Application routes

- `/` — worker/manager role picker
- `/worker` — breakdown triage and resolution capture
- `/manager` — reliability dashboard
- `/api/triage` — grounded RCA triage
- `/api/incidents` — incident/RCA close-out
- `/api/dashboard` — SQL dashboard metrics
- `/api/ask` — structured or knowledge Q&A
- `/api/agent/investigate` — Sarvam-105B read-only investigation and signed proposal
- `/api/agent/execute` — approved incident/work-order creation and WhatsApp escalation
- `/api/speech/transcribe` — Saaras v3 REST transcription
- `/api/speech/synthesize` — user-triggered Bulbul v3 speech
- `/api/whatsapp/inbound` — authenticated text/voice reply processing

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
