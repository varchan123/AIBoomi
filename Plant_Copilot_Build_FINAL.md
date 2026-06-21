# Plant Copilot — Build Spec for Codex
### Hackathon demo build — read this fully before writing any code

---

## 0. What this is

This is a complete instruction set for building a deployable demo web app. Build it in the order given. Data will be supplied directly in the table/file structure described below — **do not generate or simulate plant data yourself**; load what's given. The only thing you generate is the application code, schema, and embedding pipeline.

LLM provider for this build: **OpenAI API (ChatGPT models)** — used for both chat completions and embeddings. Do not substitute another provider.

---

## 1. Product Scope

Four surfaces, one shared backend and database.

### 1.0 Landing / Role Picker — `/`
- First screen on load. Two large buttons: **"I'm a Worker"** and **"I'm a Manager."** No password, no account.
- Tapping a role routes to `/worker` or `/manager` and stores the choice (e.g. in a cookie or local storage) so a reload doesn't bounce the person back to the picker mid-demo.
- This is a UI front door, not security — it's there so the right person lands on the right screen by default during the demo, not to restrict access. Either route is still reachable directly by URL.
- The `employees` table's `role` column is used only for attribution, filtering, and dashboard analytics — not for routing or access. For reference, the intended (but unenforced) mapping is:

  | Employee role | Intended view |
  |---|---|
  | Floor Operator | Worker |
  | Maintenance Engineer | Manager |
  | Reliability Engineer | Manager |
  | Plant Manager | Manager |

### 1.1 Worker View — `/worker`
- Free-text input where a floor operator describes a breakdown in natural language (e.g. *"Reactor temperature is rising, cooling water flow looks low, pressure increasing."*).
- System returns:
  - Likely matching fault/category, matched against past incidents, RCA documents, and fault signatures.
  - 2–4 concrete first checks to make.
  - What was done last time this happened (pulled from maintenance actions + RCA documents).
  - An explicit confidence/uncertainty signal — if the match is weak, say so, don't force a confident answer.
  - A citation for every suggestion (which past incident/RCA/SOP/maintenance action it came from).
- A "log what you actually did" form at the end of the flow. Submitting it creates a new incident, a new RCA document, and embeds that document so future queries can retrieve it — see Section 2.4 for the exact insert order. This is what makes the system "learn" over the course of the demo.

### 1.2 Manager View — `/manager`
- High-level, glanceable dashboard, not investigation detail:
  - Currently open incidents, by machine/area.
  - Incident count this week/month, trend vs. prior period.
  - Repeat failures — same machine + same fault category within a defined time window.
  - Top problem machines by incident count.
- Clicking any incident opens a detail panel (timeline, root cause, corrective action, citations) — same detail component used by the worker view's results.
- This view only reads; it doesn't need the LLM for the dashboard numbers themselves, only for incident-detail summaries if asked.

### 1.3 General Plant Q&A — shared chat widget on both views
- One chat box, mounted on `/worker` and `/manager`, that handles two kinds of questions and routes between them:
  - **Structured questions** ("How many incidents on R-101 this month?", "Which machine has the most repeat failures?") → classified by the LLM into one of a fixed set of intents, then answered by a predefined, parameterized SQL query — see Section 2.9. The LLM never writes or returns raw SQL.
  - **Knowledge questions** ("Why does this unit's cleaning interval differ from standard?", "What's the SOP for cooling valve sticking?") → answered via retrieval over the embedded documents, then synthesized by the LLM from only the retrieved text.
- Classification step: a cheap upfront LLM call that returns one of the fixed intent names (Section 2.9) or `knowledge_question` — never free text, never SQL.

**Non-negotiable across all three surfaces:** every LLM-generated answer must be grounded in retrieved evidence and must say what it's based on. The LLM is never asked to answer from its own general knowledge about the plant — only to summarize/explain what was retrieved, or to classify intent. If retrieval comes back empty or weak, the answer should say so rather than improvise.

---

## 2. Data Import & Schema

Data will be provided in the structure already defined in the project's Data Infrastructure doc. Build the schema to match that doc exactly — do not redesign the table shapes.

**Structured / relational tables:**
`machines`, `employees`, `incidents`, `alarm_logs`, `sensor_snapshots`, `maintenance_actions`, `spare_parts`, `tep_variable_map`, `tep_fault_dictionary`, `tep_fault_summary`

**Document source tables (real Postgres tables, not just embedding inputs):**
`rca_documents`, `sop_documents`, `tep_fault_signatures`

**Plus a separate vector table:** `documents` — built from the four sources above, used only for semantic search/RAG, never for structured joins or dashboards.

### 2.1 JSONL File Handling
Files supplied as `.jsonl` (`rca_documents.jsonl`, `sop_documents.jsonl`, `tep_fault_signatures.jsonl`, `vector_documents.jsonl`, `sample_operator_queries.jsonl`) are newline-delimited JSON — **one complete JSON object per line, not one JSON array for the whole file.**

The import script must read line by line, `JSON.parse()` each line individually, validate required fields, and insert. If a row fails validation, log it and continue — never fail the whole import on one bad row, and never silently drop a failed row.

### 2.2 Source Tables vs. Vector Table
The `documents` vector table does **not** replace the source tables. Source tables (`rca_documents`, `sop_documents`, `tep_fault_signatures`, plus `maintenance_actions` which already exists as a structured table) store the real structured data and are what dashboards, citations, and detail views query directly. `documents` exists only so the app can do semantic similarity search; it's a derived/secondary store, not the source of truth.

```text
rca_documents / sop_documents / tep_fault_signatures / maintenance_actions
        ↓
   embedding script
        ↓
   documents (vector table)
```

### 2.3 `rca_documents` Table

```sql
create table rca_documents (
  rca_id text primary key,
  incident_id text references incidents(incident_id),
  machine_id text references machines(machine_id),
  machine_name text,
  tep_fault_number int references tep_fault_dictionary(tep_fault_number),
  rca_category text,
  problem_statement text,
  symptoms jsonb,
  suspected_root_cause text,
  confirmed_root_cause text,
  fix_applied text,
  preventive_action text,
  downtime_minutes int,
  handled_by_operator text,
  handled_by_engineer text,
  recurrence text,
  status text,
  rca_text text,
  created_at timestamptz default now()
);
```

If `rca_category` is missing from a supplied row, enrich it at import time by joining `rca_documents.tep_fault_number → tep_fault_dictionary.tep_fault_number`. A missing `rca_category` is never grounds to fail the import.

### 2.4 Incident → RCA Insert Flow (avoids circular FK problems)
`incidents.rca_id` must be nullable. When a worker logs a resolved issue, insert in this exact order:

1. Insert the new row into `incidents` with `rca_id` left null.
2. Generate and insert the new row into `rca_documents`, using the `incident_id` just created.
3. Update the `incidents` row to set `rca_id` to the newly generated RCA's id.
4. Embed the new RCA's `rca_text`.
5. Insert the embedded result into `documents`.

This is the exact sequence `/api/incidents` (Section 4, build step 8) must implement.

### 2.5 Embedding Sources
Embed all four knowledge sources, not just RCA/SOP:

| Source | `doc_type` |
|---|---|
| `rca_documents` | `rca_document` |
| `sop_documents` | `sop_document` |
| `tep_fault_signatures` | `tep_fault_signature` |
| `maintenance_actions` | `maintenance_action` |

- For RCA documents, embed only `rca_text` (keep the rest as metadata, not embedded text).
- For maintenance actions, generate searchable text before embedding — there's no single free-text column to embed directly. Example construction:

  ```text
  Work order WO0001 for incident INC0001 on machine CW-101. Action taken: check
  cooling water valve, verify exchanger fouling, increase cooling flow.
  Part used: Positioner. Status: Monitoring.
  ```

  This matters specifically because the worker assistant has to answer "what was done last time?" — and that answer often lives in `maintenance_actions`, not just the RCA narrative.

### 2.6 `documents` Vector Table

```sql
create table documents (
  doc_id text primary key,
  embedding vector(1536),
  doc_type text not null,
  title text,
  text text not null,
  source_table text not null,
  source_id text not null,
  machine_id text,
  tep_fault_number int,
  rca_category text,
  metadata jsonb,
  chunk_index int default 0,
  created_at timestamptz default now()
);
```

Field mapping by source:

- **RCA documents** — `doc_id = rca_id`, `doc_type = "rca_document"`, `title = machine_name + " - " + problem_statement`, `text = rca_text`, `source_table = "rca_documents"`, `source_id = rca_id`, plus `machine_id`, `tep_fault_number`, `rca_category`; `metadata` holds `incident_id`, `status`, `recurrence`, `downtime_minutes`, `handled_by_operator`, `handled_by_engineer`.
- **SOP documents** — `doc_id = sop_id`, `doc_type = "sop_document"`, `text = content`, `source_table = "sop_documents"`, `source_id = sop_id`, `machine_id`.
- **TEP fault signatures** — `doc_id = document_id`, `doc_type = "tep_fault_signature"`, `text = embedding_text`, `source_table = "tep_fault_signatures"`, `source_id = document_id`, `machine_id = primary_machine_id`, `tep_fault_number`, `rca_category`.
- **Maintenance actions** — `doc_id = work_order_id`, `doc_type = "maintenance_action"`, `text = ` the generated text from Section 2.5, `source_table = "maintenance_actions"`, `source_id = work_order_id`, `machine_id`; `metadata` holds `incident_id`, `maintenance_type`, `part_used`, `cost_inr`, `owner_employee_id`, `status`.

### 2.7 Machine ID Consistency Rule
Any field ending in `_machine_id` must contain a real value from `machines.machine_id` — never a human-readable label. This applies to `incidents.machine_id`, `alarm_logs.machine_id`, `sensor_snapshots.machine_id`, `maintenance_actions.machine_id`, `sop_documents.machine_id`, `tep_variable_map.mapped_machine_id`, `tep_fault_dictionary.default_machine_id`, and `tep_fault_signatures.primary_machine_id`.

Strings like "Feed Systems" or "Reaction Area" do not belong in an ID field unless they exist as actual `machines` rows — use `machine_name`, `equipment_type`, `area`, or `affected_units` for display labels instead, and validate this at import time per Section 2.1.

### 2.8 TEP Signature Assumption
Assume `tep_fault_signatures.jsonl` and `tep_fault_summary.csv` are supplied pre-generated. Only import, validate, store, and embed them — do not derive fault signatures from raw TEP sensor files for this build. If raw TEP files (`TEP_Faulty_Testing.csv`, `TEP_FaultFree_Testing.csv`) are also supplied, treat them as reference/debugging material only; building a signature-generation pipeline from them is a separate task, not part of this build.

### 2.9 Structured Q&A — Fixed Intents, No Raw SQL
The general Q&A endpoint must never let the LLM generate or return arbitrary SQL. The LLM's only job on the structured path is to classify the question into one of a fixed set of intents and extract parameters (machine ID, time period, severity, employee name). Each intent maps to one predefined, parameterized query already written in code:

- `incident_count_by_machine`
- `open_incidents`
- `top_problem_machines`
- `repeat_failures`
- `downtime_by_machine`
- `maintenance_cost_by_machine`
- `incidents_by_employee`

If a question doesn't match any of these, classify it as `knowledge_question` and route to RAG instead. Do not add new intents beyond this list without it being explicitly requested — keep the surface area fixed and auditable.

---

## 3. Architecture

```
Supplied data files (CSV / JSONL, per Data Infrastructure doc schema)
        │
        ▼
Import script — line-by-line JSONL parsing, validates required fields,
loads into Postgres tables matching the given schema. Logs and skips
(never silently drops) any row that fails validation.
        │
        ▼
Postgres (Supabase) — single database
  ├── Relational tables: machines, employees, incidents, alarm_logs,
  │     sensor_snapshots, maintenance_actions, spare_parts,
  │     tep_variable_map, tep_fault_dictionary, tep_fault_summary
  ├── Document source tables: rca_documents, sop_documents,
  │     tep_fault_signatures (real tables, used for joins/citations)
  └── pgvector-enabled `documents` table — derived, semantic-search only
        │
        ▼
Embedding script — reads rca_documents, sop_documents,
tep_fault_signatures, maintenance_actions, calls OpenAI embeddings
(text-embedding-3-small), writes into `documents` with full metadata
        │
        ▼
Backend API (Next.js API routes)
  ├── /api/triage      → worker view: embed query → vector search +
  │                       structured lookup on matched machine →
  │                       OpenAI chat completion grounded on retrieved
  │                       evidence only
  ├── /api/dashboard    → manager view: SQL aggregates, no LLM call
  ├── /api/ask          → general Q&A: LLM classifies intent →
  │                       predefined SQL template OR RAG → OpenAI
  │                       synthesis (LLM never emits raw SQL)
  ├── /api/incidents    → POST: insert incident (rca_id null) → insert
  │                       rca_documents → update incident.rca_id →
  │                       embed → insert into documents (Section 2.4)
        │
        ▼
Frontend (Next.js + Tailwind, deployed on Vercel)
  ├── /            → role picker (Worker / Manager), no password
  ├── /worker     → triage chat + close-out form
  ├── /manager    → dashboard + incident drill-down
  └── shared <PlantQA /> chat component on both routes
```

One database (Postgres + pgvector) for both relational and vector data — avoids standing up a separate vector store for a demo timeline.

---

## 4. Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router) + Tailwind |
| Backend | Next.js API routes (Node) |
| Database | Supabase (Postgres + pgvector extension) |
| Embeddings | OpenAI `text-embedding-3-small` |
| LLM | OpenAI Chat Completions API (GPT-4 class model) |
| Hosting | Vercel |
| Auth | None — a simple role-picker landing page (no password) routes to `/worker` or `/manager`, not real access control |

---

## 5. Build Steps (do these in order)

1. **Scaffold the app**: `create-next-app` with Tailwind. Set up a Supabase project, enable the `pgvector` extension, add `OPENAI_API_KEY` and Supabase connection details as env vars.

2. **Landing page (`/`)**: two buttons, "I'm a Worker" / "I'm a Manager," routing to `/worker` / `/manager` and storing the choice in a cookie or local storage. This is purely a default-route convenience for the demo — do not wire any access restriction to it.

3. **Build schema**: create all relational tables, the three document source tables (`rca_documents` per Section 2.3, `sop_documents`, `tep_fault_signatures`), and the `documents` vector table per Section 2.6 — matching the Data Infrastructure doc's column definitions and foreign keys exactly.

4. **Import script**: a one-off CLI script that reads supplied CSVs directly and supplied JSONLs line-by-line (Section 2.1), validates required fields and machine-ID consistency (Section 2.7), and inserts into the matching tables. Log and continue past any row that fails validation — never fail the whole run or silently drop a row.

5. **Embedding script**: reads `rca_documents`, `sop_documents`, `tep_fault_signatures`, and `maintenance_actions` (Section 2.5), builds the text to embed for each (including generating maintenance-action text, since there's no single free-text field for that source), calls OpenAI embeddings, and inserts into `documents` with the field mapping in Section 2.6. Make this re-runnable and idempotent (skip rows already embedded) since it'll be re-run after every new incident is logged.

6. **`/api/triage`**: accepts free-text input → embed it → vector similarity search on `documents` (optionally filtered/boosted by machine if one is named in the text) → pull top 3–5 document matches plus structured rows (recent incidents, maintenance actions) for the matched machine → send all of this as context to the OpenAI chat completion with a system prompt that enforces: *only answer from the provided evidence; state confidence; cite the source of each suggestion; if evidence is weak, say so explicitly.*

7. **Worker view UI (`/worker`)**: chat input → render the triage response with inline citations and a visible confidence indicator → "log what actually happened" form below the result, which POSTs to `/api/incidents`.

8. **`/api/incidents` (POST)**: implements the exact insert order from Section 2.4 — incident first (rca_id null) → rca_documents row → update incident.rca_id → embed → insert into `documents`. This closes the loop the worker view promises and avoids the circular foreign-key problem between `incidents` and `rca_documents`.

9. **`/api/dashboard`**: SQL-only aggregate queries — open incident count by machine/area, this-period vs. last-period incident count, repeat-failure detection (same `machine_id` + same `rca_category`/`tep_fault_number` within a configurable time window), top machines by incident count.

10. **Manager view UI (`/manager`)**: render the dashboard data as cards/tables. Each incident row is clickable, opening a detail panel reused from the worker view's result component (timeline, root cause, corrective action, citations).

11. **`/api/ask`**: an upfront LLM call classifies the question into one of the fixed intents in Section 2.9 or `knowledge_question`. Structured intents route to their predefined parameterized SQL template (the LLM only supplies parameters, never SQL text); `knowledge_question` routes to the same retrieval path as `/api/triage`. Synthesize the final answer with OpenAI in either case.

12. **Shared `<PlantQA />` component**: chat widget mounted on both `/worker` and `/manager`, calling `/api/ask`.

13. **Polish pass**: loading states, empty states, and a clearly visible "weak/uncertain match" state — this matters more for the demo than extra features, since it's the proof the system isn't just confidently making things up.

14. **Deploy**: push to Vercel, wire up Supabase + OpenAI env vars there too, and run all three flows end-to-end against the real imported data before presenting.

---

## 6. Demo Script

1. Open `/`, tap "I'm a Worker" → lands on `/worker`. Type a breakdown description matching real data you imported. Show the suggested checks and the cited past incident/RCA.
2. Log a resolution → confirm it creates a new incident.
3. Switch to `/manager` — show the dashboard now reflects that new incident.
4. Use the shared Q&A box for one structured question (count/list — should hit a fixed-intent SQL template) and one knowledge question (why/what-SOP — should hit RAG) — show both resolve correctly through two different code paths, not one LLM guess.

---

## 7. Explicitly Out of Scope for This Build

- Live historian/SCADA/alarm system integration — data is imported from the supplied files, not pulled live.
- SAP/Maximo/PTW/EHS integration.
- Role-based access control or any access tiering.
- Authentication/login, or any real access control. The landing-page role picker (Section 1.0) is a routing convenience, not a security boundary — both `/worker` and `/manager` are reachable by anyone with the URL regardless of which button they tapped.
- OCR pipeline — assume supplied documents are already text.
- Query audit logging.
- Free-form/arbitrary SQL generation by the LLM, on any endpoint — structured Q&A is limited to the fixed intent list in Section 2.9.
- Deriving TEP fault signatures from raw sensor files — assume `tep_fault_signatures.jsonl` is supplied pre-built (Section 2.8).

Do not add any of the above unless explicitly asked — they add build time without changing whether the demo proves the product idea.
