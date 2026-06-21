# RCA Copilot + Tennessee Eastman RAG Architecture

## What this package now contains

This dataset has two layers:

1. **Business/plant memory data**  
   Fake but realistic plant operating data: machines, incidents, alarms, RCA documents, maintenance actions, employees, spare parts, and SOPs.

2. **RAG preprocessing layer for Tennessee Eastman Process (TEP)**  
   TEP fault signatures, embedding-ready documents, sample operator queries, and scripts that can regenerate fault signatures from raw TEP testing files.

## Files

### Core plant data

- `machines.csv` — asset master for reactor, condenser/cooling, separator, stripper, compressor, feed systems.
- `incidents.csv` — incident log linked to `tep_fault_number` and machine IDs.
- `rca_documents.jsonl` — generated RCA documents linked to incidents.
- `alarm_logs.csv` — alarm sequence data linked to incidents.
- `sensor_snapshots.csv` — compact abnormal sensor snapshots linked to incidents and TEP variables.
- `maintenance_actions.csv` — actions taken, duration, technician, outcome.
- `employees.csv` — operators and engineers.
- `spare_parts.csv` — spares used in maintenance.
- `sop_documents.jsonl` — SOP-like troubleshooting documents.

### TEP/RAG data

- `tep_variable_map.csv` — maps TEP tags like `XMEAS(9)` to CSV names like `xmeas_9`, descriptions, units, and equipment.
- `tep_fault_dictionary.csv` — maps TEP fault numbers to fault names, RCA categories, and default machines.
- `tep_fault_summary.csv` — table of top synthetic anomaly fingerprints per TEP fault.
- `tep_fault_signatures.jsonl` — one natural-language fault signature document per TEP fault.
- `vector_documents.jsonl` — final embedding-ready corpus for RAG.
- `sample_operator_queries.jsonl` — example operator inputs and expected retrieval targets.

### Scripts

- `scripts/extract_tep_fault_signatures.py` — use this when you have raw `TEP_Faulty_Testing.csv` and optional `TEP_FaultFree_Testing.csv`.
- `scripts/build_vector_store.py` — builds a local FAISS vector DB from `vector_documents.jsonl`.
- `scripts/retrieve_demo.py` — tests semantic retrieval.

## Important note

The included `tep_fault_signatures.jsonl` and `tep_fault_summary.csv` are **demo-ready synthetic signatures** based on the TEP fault dictionary and variable map.  
For a more rigorous version, run `extract_tep_fault_signatures.py` on the real TEP testing CSVs. That will calculate actual sensor drift before and after sample 160.

## How raw TEP integrates

Use only these raw files for the first RAG MVP:

- `TEP_Faulty_Testing.csv` — crucial because it has the injected faults and sensor anomalies.
- `TEP_FaultFree_Testing.csv` — useful baseline for normal sensor behavior.

You can skip the training files initially because RAG does not need classifier training. The training files become useful later if you want an ML fault classifier.

## RAG pipeline

```text
TEP_Faulty_Testing.csv
        +
TEP_FaultFree_Testing.csv
        |
        v
Fault Signature Extractor
(samples 1-159 = normal window, samples 160-960 = fault window)
        |
        v
tep_fault_signatures.jsonl
        |
        +-------------------------+
                                  |
RCA docs + incidents + SOPs -------+--> vector_documents.jsonl --> embeddings --> FAISS/Chroma/Pinecone
                                  |
Operator live issue ---------------+--> retrieval --> LLM answer
```

## Runtime query flow

1. Operator types:  
   “Reactor temperature is rising, feed flow is unstable, separator pressure is high.”

2. System converts this into a retrieval query.

3. Vector DB retrieves:
   - one or more `tep_fault_signature` documents matching the sensor pattern,
   - previous RCA documents with similar symptoms,
   - maintenance actions that worked before,
   - relevant SOP sections.

4. LLM produces:
   - likely root cause,
   - confidence score,
   - recommended first checks,
   - previous similar incidents,
   - safety/SOP constraints,
   - draft RCA update after resolution.

## Data model integration keys

```text
TEP raw faultNumber       -> incidents.tep_fault_number
TEP xmeas_1...xmeas_41   -> tep_variable_map.csv_column_name
TEP xmv_1...xmv_11       -> tep_variable_map.csv_column_name
incidents.incident_id    -> rca_documents + alarm_logs + maintenance_actions + sensor_snapshots
incidents.machine_id     -> machines.machine_id
maintenance_actions.part_id -> spare_parts.part_id
```

## Why this architecture is strong

Normal RAG over RCA documents only knows what humans wrote.  
This design combines two kinds of knowledge:

1. **Process behavior knowledge** from TEP sensor signatures.
2. **Human repair knowledge** from RCA and maintenance logs.

That means the assistant can say not just “this text sounds similar,” but also “this live sensor fingerprint looks like a known process fault, and this is what fixed it before.”

## Suggested MVP screen logic

### Floor employee screen

Input:
- Natural language issue
- Machine name
- Optional current alarm/sensor values

Output:
- Most similar TEP fault signature
- Similar past incidents
- Suggested root cause
- First checks
- Fix used last time
- Safety warning/SOP link
- Button: “Mark fixed and generate RCA”

### Engineer dashboard

Cards:
- MTTR trend
- Repeat failures
- Top failing machines
- Most common root causes
- Fix success rate
- Downtime by equipment
- Open incidents
- RCA history

## Success criteria

- Reduce MTTR.
- Reduce repeat failures.
- Improve first-time fix rate.
- Reduce time spent searching old RCA docs.
- Improve RCA documentation completeness.
- Increase equipment availability.
- Capture tribal knowledge from senior operators.
