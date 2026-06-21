import { NextResponse } from "next/server";
import { normalizeCitations } from "@/lib/citations";
import { chatModel, getOpenAI } from "@/lib/openai";
import { triageSystemPrompt } from "@/lib/prompts";
import { getIncidentDetails, getMachineContext, retrieveEvidence } from "@/lib/retrieval";
import { triageInput } from "@/lib/validation";
import { getSopForMachine, machineAsset } from "@/lib/machineData";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = triageInput.parse(await request.json());
    const [retrieval, context] = await Promise.all([
      retrieveEvidence(input.query, input.machine_id, 7),
      getMachineContext(input.machine_id),
    ]);
    const evidence = retrieval.documents.map((doc) => ({
      source_id: doc.source_id, source_type: doc.doc_type, title: doc.title,
      machine_id: doc.machine_id, similarity: doc.similarity, text: doc.text, metadata: doc.metadata,
    }));
    const candidateIncidentIds = [...new Set([
      ...retrieval.documents.flatMap((doc) => [
        doc.metadata?.incident_id,
        ...(Array.isArray(doc.metadata?.linked_incident_ids) ? doc.metadata.linked_incident_ids : []),
      ]),
      ...(context.recent_incidents || []).map((incident: any) => incident.incident_id),
    ].filter(Boolean).map(String))].slice(0, 8);
    const incidentDetails = await getIncidentDetails(candidateIncidentIds);
    const response = await getOpenAI().chat.completions.create({
      model: chatModel,
      response_format: { type: "json_object" },
      temperature: 0.1,
      messages: [
        { role: "system", content: triageSystemPrompt },
        { role: "user", content: JSON.stringify({
          task: `Return likely_fault, likely_category, confidence, confidence_reason, issue_summary,
            first_checks (2-4 objects with check, why. Provide highly detailed instructions and step-by-step reasoning), previous_action_summaries
            (objects with incident_id, summary. Write detailed paragraphs explaining exactly what was done and the result), and warning. Keep checks practical.
            Write every previous action summary in past tense. Do not reproduce full RCA text.`,
          operator_report: input.query, selected_machine: input.machine_id, evidence, structured_context: context,
          incident_records: incidentDetails.map((detail) => ({
            incident_id: detail.incident_id,
            machine_id: detail.machine_id,
            corrective_action: detail.corrective_action,
            maintenance_actions: detail.maintenance_actions,
            status: detail.status,
          })),
          retrieval_is_weak: retrieval.weak,
        }) },
      ],
    });
    const result = JSON.parse(response.choices[0].message.content || "{}");
    const normalizeItems = (items: any) => (Array.isArray(items) ? items : []).map((item) => ({
      ...item, citations: normalizeCitations(item.citations, retrieval.citations),
    }));
    const machineIds = [...new Set([
      input.machine_id,
      ...retrieval.documents.map((doc) => doc.machine_id),
      ...incidentDetails.map((detail) => detail.machine_id),
    ].filter(Boolean).map(String))];
    const affectedEquipment = await Promise.all(machineIds.map(async (machineId) => {
      const base = machineAsset(machineId);
      return {
        ...base,
        sop: await getSopForMachine(machineId),
        related_incident_ids: incidentDetails
          .filter((detail) => detail.machine_id === machineId)
          .map((detail) => detail.incident_id),
      };
    }));
    const whoHandledIt = incidentDetails
      .filter((detail) => detail.handled_by?.length)
      .map((detail) => ({
        incident_id: detail.incident_id,
        people: detail.handled_by,
      }));
    return NextResponse.json({
      likely_fault: result.likely_fault || "No reliable match",
      likely_category: result.likely_category || "Unclassified",
      issue_summary: result.issue_summary || input.query,
      confidence: retrieval.weak ? "low" : (result.confidence || "medium"),
      confidence_reason: result.confidence_reason || "Based on retrieved plant records.",
      first_checks: normalizeItems(result.first_checks),
      what_was_done_last_time: normalizeItems(result.previous_action_summaries),
      who_handled_it: whoHandledIt,
      affected_equipment: affectedEquipment,
      similar_incidents: incidentDetails.map((detail) => ({
        incident_id: detail.incident_id,
        title: `${detail.machine_name || detail.machine_id} — ${detail.rca_category || "Incident"}`,
        machine_id: detail.machine_id,
        status: detail.status,
      })),
      incident_details: incidentDetails,
      citations: retrieval.citations,
      matched_documents: retrieval.documents,
      warning: retrieval.weak ? (result.warning || "The retrieved evidence is weak; verify conditions before acting.") : result.warning || null,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Triage failed" }, { status: 400 });
  }
}
