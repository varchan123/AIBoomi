import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { embedBatch } from "../lib/embeddings";
import { getSupabaseAdmin } from "../lib/supabase";

function maintenanceText(row: Record<string, any>) {
  return (
    `Work order ${row.work_order_id} for incident ${row.incident_id} on machine ${row.machine_id}. ` +
    `Action taken: ${row.action_taken}. Part used: ${
      row.part_used || "None recorded"
    }. Status: ${row.status}.`
  );
}

async function main() {
  const db = getSupabaseAdmin();

  const [rcas, sops, signatures, maintenance, existing] = await Promise.all([
    db.from("rca_documents").select("*"),
    db.from("sop_documents").select("*"),
    db.from("tep_fault_signatures").select("*"),
    db.from("maintenance_actions").select("*"),
    db.from("documents").select(
      "doc_id,doc_type,title,text,source_table,source_id,machine_id,tep_fault_number,rca_category,metadata,chunk_index",
    ),
  ]);

  for (const result of [rcas, sops, signatures, maintenance, existing]) {
    if (result.error) throw result.error;
  }

  const sourceDocs = [
    ...(rcas.data || []).map((row) => ({
      doc_id: row.rca_id,
      doc_type: "rca_document",
      title: `${row.machine_name} - ${row.problem_statement}`,
      text: row.rca_text,
      source_table: "rca_documents",
      source_id: row.rca_id,
      machine_id: row.machine_id,
      tep_fault_number: row.tep_fault_number,
      rca_category: row.rca_category,
      metadata: {
        incident_id: row.incident_id,
        status: row.status,
        recurrence: row.recurrence,
        downtime_minutes: row.downtime_minutes,
        handled_by_operator: row.handled_by_operator,
        handled_by_engineer: row.handled_by_engineer,
      },
    })),

    ...(sops.data || []).map((row) => ({
      doc_id: row.sop_id,
      doc_type: "sop_document",
      title: row.title,
      text: row.content,
      source_table: "sop_documents",
      source_id: row.sop_id,
      machine_id: row.machine_id,
      tep_fault_number: null,
      rca_category: null,
      metadata: {},
    })),

    ...(signatures.data || []).map((row) => ({
      doc_id: row.document_id,
      doc_type: "tep_fault_signature",
      title: `TEP Fault ${row.tep_fault_number}: ${row.tep_fault_name}`,
      text: row.embedding_text,
      source_table: "tep_fault_signatures",
      source_id: row.document_id,
      machine_id: row.primary_machine_id,
      tep_fault_number: row.tep_fault_number,
      rca_category: row.rca_category,
      metadata: {
        affected_units: row.affected_units,
        linked_incident_ids: row.linked_incident_ids,
        top_anomalies: row.top_anomalies,
      },
    })),

    ...(maintenance.data || []).map((row) => ({
      doc_id: row.work_order_id,
      doc_type: "maintenance_action",
      title: `Work order ${row.work_order_id} - ${row.machine_id}`,
      text: maintenanceText(row),
      source_table: "maintenance_actions",
      source_id: row.work_order_id,
      machine_id: row.machine_id,
      tep_fault_number: null,
      rca_category: null,
      metadata: {
        incident_id: row.incident_id,
        maintenance_type: row.maintenance_type,
        part_used: row.part_used,
        cost_inr: row.cost_inr,
        owner_employee_id: row.owner_employee_id,
        status: row.status,
      },
    })),
  ];

  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };

  const comparable = (doc: Record<string, any>) => ({
    doc_id: doc.doc_id,
    doc_type: doc.doc_type,
    title: doc.title,
    text: doc.text,
    source_table: doc.source_table,
    source_id: doc.source_id,
    machine_id: doc.machine_id,
    tep_fault_number: doc.tep_fault_number,
    rca_category: doc.rca_category,
    metadata: doc.metadata || {},
    chunk_index: doc.chunk_index || 0,
  });

  const existingById = new Map(
    (existing.data || []).map((row) => [row.doc_id, row]),
  );
  const docs = sourceDocs.filter((doc) => {
    const current = existingById.get(doc.doc_id);
    return !current || stable(comparable(current)) !== stable(comparable(doc));
  });

  for (let i = 0; i < docs.length; i += 50) {
    const batch = docs.slice(i, i + 50);

    const vectors = await embedBatch(batch.map((doc) => doc.text));

    const rows = batch.map((doc, index) => ({
      ...doc,
      embedding: vectors[index],
    }));

    const { error } = await db.from("documents").upsert(rows, {
      onConflict: "doc_id",
    });

    if (error) throw error;

    console.log(`Embedded ${Math.min(i + batch.length, docs.length)}/${docs.length}`);
  }

  console.log(
    docs.length
      ? `Embedding sync complete. Refreshed ${docs.length} changed documents.`
      : "All documents are already synchronized."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
