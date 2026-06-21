import { citationFromDocument } from "./citations";
import { embedText } from "./embeddings";
import { getSupabaseAdmin } from "./supabase";

export type MatchedDocument = {
  doc_id: string;
  doc_type: string;
  title: string | null;
  text: string;
  source_id: string;
  machine_id: string | null;
  tep_fault_number: number | null;
  rca_category: string | null;
  metadata: Record<string, any> | null;
  similarity: number;
};

export async function retrieveEvidence(query: string, machineId?: string, limit = 6) {
  const db = getSupabaseAdmin();
  const embedding = await embedText(query);
  const calls = [
    db.rpc("match_documents", {
      query_embedding: embedding,
      match_count: 14,
      filter_machine_id: null,
    }),
  ];
  if (machineId) {
    calls.push(db.rpc("match_documents", {
      query_embedding: embedding,
      match_count: 8,
      filter_machine_id: machineId,
    }));
  }
  const responses = await Promise.all(calls);
  for (const response of responses) if (response.error) throw response.error;
  const unique = new Map<string, MatchedDocument>();
  responses.flatMap((response) => response.data || []).forEach((doc) => {
    const existing = unique.get(doc.doc_id);
    if (!existing || doc.similarity > existing.similarity) unique.set(doc.doc_id, doc);
  });

  const ranked = [...unique.values()].sort((a, b) => b.similarity - a.similarity);
  const selected: MatchedDocument[] = [];
  for (const type of ["tep_fault_signature", "rca_document", "maintenance_action", "sop_document"]) {
    const match = ranked.find((doc) => doc.doc_type === type && !selected.some((s) => s.doc_id === doc.doc_id));
    if (match) selected.push(match);
  }
  for (const doc of ranked) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.doc_id === doc.doc_id)) selected.push(doc);
  }
  selected.sort((a, b) => b.similarity - a.similarity);
  const rcaIds = selected
    .filter((doc) => doc.doc_type === "rca_document")
    .map((doc) => doc.source_id);
  if (rcaIds.length) {
    const { data: sourceRcas, error } = await db
      .from("rca_documents")
      .select("*")
      .in("rca_id", rcaIds);
    if (error) throw error;
    const sourceById = new Map((sourceRcas || []).map((row) => [row.rca_id, row]));
    selected.forEach((doc) => {
      if (doc.doc_type !== "rca_document") return;
      const source = sourceById.get(doc.source_id);
      if (!source) return;
      doc.title = `${source.machine_name} - ${source.problem_statement}`;
      doc.text = source.rca_text;
      doc.machine_id = source.machine_id;
      doc.tep_fault_number = source.tep_fault_number;
      doc.rca_category = source.rca_category;
      doc.metadata = {
        ...doc.metadata,
        incident_id: source.incident_id,
        status: source.status,
        recurrence: source.recurrence,
        downtime_minutes: source.downtime_minutes,
        handled_by_operator: source.handled_by_operator,
        handled_by_engineer: source.handled_by_engineer,
      };
    });
  }
  const strongest = selected[0]?.similarity ?? 0;
  return {
    documents: selected,
    citations: selected.map((doc) => citationFromDocument(doc)),
    weak: strongest < 0.52 || selected.length < 2,
    strongestSimilarity: strongest,
  };
}

export async function getMachineContext(machineId: string) {
  const db = getSupabaseAdmin();
  const [incidents, maintenance, rcas, alarms] = await Promise.all([
    db.from("incidents").select("*").eq("machine_id", machineId).order("start_time", { ascending: false }).limit(6),
    db.from("maintenance_actions").select("*").eq("machine_id", machineId).order("completion_time", { ascending: false }).limit(6),
    db.from("rca_documents").select("*").eq("machine_id", machineId).order("created_at", { ascending: false }).limit(6),
    db.from("alarm_logs").select("*").eq("machine_id", machineId).order("timestamp", { ascending: false }).limit(10),
  ]);
  for (const result of [incidents, maintenance, rcas, alarms]) if (result.error) throw result.error;
  return {
    recent_incidents: incidents.data,
    maintenance_actions: maintenance.data,
    rca_documents: rcas.data,
    alarm_logs: alarms.data,
  };
}

export async function getIncidentDetails(incidentIds: string[]) {
  if (!incidentIds.length) return [];
  const db = getSupabaseAdmin();
  const [incidents, rcas, maintenance, alarms, sensors, employees, spareParts] = await Promise.all([
    db.from("incidents").select("*").in("incident_id", incidentIds),
    db.from("rca_documents").select("*").in("incident_id", incidentIds),
    db.from("maintenance_actions").select("*").in("incident_id", incidentIds),
    db.from("alarm_logs").select("*").in("incident_id", incidentIds).order("timestamp"),
    db.from("sensor_snapshots").select("*").in("incident_id", incidentIds).order("timestamp"),
    db.from("employees").select("*"),
    db.from("spare_parts").select("*"),
  ]);
  for (const result of [incidents, rcas, maintenance, alarms, sensors, employees, spareParts]) {
    if (result.error) throw result.error;
  }
  const employeeById = new Map((employees.data || []).map((row) => [row.employee_id, row]));
  const incidentById = new Map((incidents.data || []).map((row) => [row.incident_id, row]));
  const rcaByIncident = new Map((rcas.data || []).map((row) => [row.incident_id, row]));
  const related = <T extends Record<string, any>>(rows: T[] | null, id: string) =>
    (rows || []).filter((row) => row.incident_id === id);

  return incidentIds.map((incidentId) => {
    const incident = incidentById.get(incidentId) || {};
    const rca = rcaByIncident.get(incidentId) || {};
    const actions = related(maintenance.data, incidentId);
    const people = [
      incident.operator_id && { ...employeeById.get(incident.operator_id), employee_id: incident.operator_id, involvement: "Operator" },
      incident.engineer_id && { ...employeeById.get(incident.engineer_id), employee_id: incident.engineer_id, involvement: "Engineer" },
      ...actions.map((action) => action.owner_employee_id && ({
        ...employeeById.get(action.owner_employee_id),
        employee_id: action.owner_employee_id,
        involvement: "Maintenance owner",
      })),
    ].filter(Boolean);
    const uniquePeople = [...new Map(people.map((person: any) => [person.employee_id, person])).values()];
    const usedNames = actions.map((action) => String(action.part_used || "").toLowerCase()).filter(Boolean);
    const matchedParts = (spareParts.data || []).filter((part) =>
      usedNames.some((used) => used.includes(String(part.part_name).toLowerCase()) ||
        String(part.part_name).toLowerCase().includes(used)),
    );
    return {
      ...incident,
      ...rca,
      incident_id: incidentId,
      rca_id: rca.rca_id || incident.rca_id || null,
      root_cause: rca.confirmed_root_cause || rca.suspected_root_cause || null,
      corrective_action: rca.fix_applied || null,
      alarm_data: related(alarms.data, incidentId),
      process_variables: related(sensors.data, incidentId),
      maintenance_actions: actions,
      spare_parts_used: matchedParts.length ? matchedParts : actions.map((action) => action.part_used).filter(Boolean),
      handled_by: uniquePeople,
      timestamp: incident.start_time || rca.created_at || null,
    };
  });
}
