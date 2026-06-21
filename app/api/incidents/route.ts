import { NextResponse } from "next/server";
import { embedText } from "@/lib/embeddings";
import { getSupabaseAdmin } from "@/lib/supabase";
import { incidentInput } from "@/lib/validation";

export const runtime = "nodejs";

async function nextId(table: string, column: string, prefix: string) {
  const { data, error } = await getSupabaseAdmin().from(table).select("*").order(column, { ascending: false }).limit(1);
  if (error) throw error;
  const row = data?.[0] as unknown as Record<string, unknown> | undefined;
  const current = Number(String(row?.[column] || "0").replace(/\D/g, "")) || 0;
  return `${prefix}${String(current + 1).padStart(4, "0")}`;
}

export async function POST(request: Request) {
  const db = getSupabaseAdmin();
  try {
    const input = incidentInput.parse(await request.json());
    const [{ data: machine, error: machineError }, incidentId, rcaId] = await Promise.all([
      db.from("machines").select("*").eq("machine_id", input.machine_id).single(),
      nextId("incidents", "incident_id", "INC"),
      nextId("rca_documents", "rca_id", "RCA"),
    ]);
    if (machineError) throw machineError;
    const incident = {
      incident_id: incidentId, start_time: new Date().toISOString(),
      machine_id: input.machine_id, machine_name: machine.machine_name,
      tep_fault_number: input.tep_fault_number || null, rca_category: input.rca_category || null,
      operator_description: input.what_actually_happened, severity: input.severity,
      downtime_minutes: input.downtime_minutes, status: input.status, rca_id: null,
    };
    const { error: incidentError } = await db.from("incidents").insert(incident);
    if (incidentError) throw incidentError;

    const rcaText = `Issue: ${input.what_actually_happened}\nRoot cause: ${input.root_cause_confirmed}\n` +
      `Fix: ${input.fix_applied}\nPreventive action: ${input.preventive_action}`;
    const rca = {
      rca_id: rcaId, incident_id: incidentId, machine_id: input.machine_id,
      machine_name: machine.machine_name, tep_fault_number: input.tep_fault_number || null,
      rca_category: input.rca_category || null, problem_statement: input.what_actually_happened,
      symptoms: [input.what_actually_happened], suspected_root_cause: input.root_cause_confirmed,
      confirmed_root_cause: input.root_cause_confirmed, fix_applied: input.fix_applied,
      preventive_action: input.preventive_action, downtime_minutes: input.downtime_minutes,
      handled_by_operator: input.operator_or_engineer, recurrence: "Not yet known",
      status: input.status, rca_text: rcaText,
    };
    const { error: rcaError } = await db.from("rca_documents").insert(rca);
    if (rcaError) throw rcaError;
    const { error: linkError } = await db.from("incidents").update({ rca_id: rcaId }).eq("incident_id", incidentId);
    if (linkError) throw linkError;

    const embedding = await embedText(rcaText);
    const { error: documentError } = await db.from("documents").insert({
      doc_id: rcaId, doc_type: "rca_document",
      title: `${machine.machine_name} - ${input.what_actually_happened}`, text: rcaText,
      source_table: "rca_documents", source_id: rcaId, machine_id: input.machine_id,
      tep_fault_number: input.tep_fault_number || null, rca_category: input.rca_category || null,
      metadata: { incident_id: incidentId, status: input.status, downtime_minutes: input.downtime_minutes },
      embedding,
    });
    if (documentError) throw documentError;
    return NextResponse.json({ incident_id: incidentId, rca_id: rcaId, embedded_document_id: rcaId, status: "created" });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Incident creation failed" }, { status: 400 });
  }
}
