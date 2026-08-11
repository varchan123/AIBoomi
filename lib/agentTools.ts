import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getSopForMachine } from "./machineData";
import { retrieveEvidence } from "./retrieval";
import { getSupabaseAdmin } from "./supabase";
import { severityValues, type PublicTraceEvent } from "./agentTypes";

const resolveMachineInput = z.object({
  operator_report: z.string().trim().min(3).max(2000),
  selected_machine_id: z.string().trim().min(1).optional(),
}).strict();
const machineInput = z.object({ machine_id: z.string().trim().min(1).max(40) }).strict();
const searchInput = z.object({
  query: z.string().trim().min(3).max(1000),
  machine_id: z.string().trim().min(1).max(40),
}).strict();
const contactInput = z.object({
  machine_id: z.string().trim().min(1).max(40),
  severity: z.enum(severityValues),
  required_role: z.literal("Maintenance Lead"),
}).strict();

export const investigationSubmissionSchema = z.object({
  summary: z.string().trim().min(8).max(1000),
  operator_response: z.string().trim().min(3).max(500),
  confidence: z.enum(["low", "medium", "high"]),
  severity: z.enum(severityValues),
  should_escalate: z.boolean(),
  requested_action: z.string().trim().min(5).max(600),
  citation_source_ids: z.array(z.string().trim().min(1)).max(8),
  concise_rationale: z.string().trim().min(5).max(600),
  clarification_question: z.string().trim().min(3).max(300).nullish(),
}).strict();

export const investigationSubmissionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 8, maxLength: 1000 },
    operator_response: { type: "string", minLength: 3, maxLength: 500 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    severity: { type: "string", enum: severityValues },
    should_escalate: { type: "boolean" },
    requested_action: { type: "string", minLength: 5, maxLength: 600 },
    citation_source_ids: { type: "array", items: { type: "string" }, maxItems: 8 },
    concise_rationale: { type: "string", minLength: 5, maxLength: 600 },
    clarification_question: { anyOf: [{ type: "string", minLength: 3, maxLength: 300 }, { type: "null" }] },
  },
  required: [
    "summary", "operator_response", "confidence", "severity", "should_escalate",
    "requested_action", "citation_source_ids", "concise_rationale", "clarification_question",
  ],
} as const;

export type ToolExecution = {
  name: string;
  result: unknown;
  trace: PublicTraceEvent;
};

export const readOnlyToolDefinitions = [
  {
    type: "function",
    function: {
      name: "resolve_machine",
      description: "Resolve one real machine from the report. Return ambiguity instead of guessing.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          operator_report: { type: "string" },
          selected_machine_id: { type: "string" },
        }, required: ["operator_report"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_machine_state",
      description: "Read compact latest-available alarms, sensor snapshots, open incidents, and maintenance history for a real machine.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { machine_id: { type: "string" } }, required: ["machine_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_plant_memory",
      description: "Search existing OpenAI-embedded plant memory for up to four grounded records.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { query: { type: "string" }, machine_id: { type: "string" } },
        required: ["query", "machine_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_machine_sop",
      description: "Load the existing SOP for a real machine, if one exists.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { machine_id: { type: "string" } }, required: ["machine_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_escalation_contact",
      description: "Resolve the approved Maintenance Lead contact. The application, never the model, controls the phone number.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          machine_id: { type: "string" }, severity: { type: "string", enum: severityValues },
          required_role: { type: "string", enum: ["Maintenance Lead"] },
        }, required: ["machine_id", "severity", "required_role"],
      },
    },
  },
] as const;

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs = 8000): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        handle = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

function normalizeMachineText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function resolveMachine(raw: unknown) {
  const input = resolveMachineInput.parse(raw);
  const { data, error } = await getSupabaseAdmin()
    .from("machines")
    .select("machine_id,machine_name,equipment_type,area")
    .order("machine_id");
  if (error) throw error;
  const machines = data || [];
  const byId = new Map(machines.map((machine) => [machine.machine_id.toUpperCase(), machine]));
  const explicitIds = [...new Set((input.operator_report.toUpperCase().match(/\b[A-Z]{1,4}-\d{2,4}\b/g) || []))];
  const explicitMatches = explicitIds.map((id) => byId.get(id)).filter(Boolean);
  const selected = input.selected_machine_id ? byId.get(input.selected_machine_id.toUpperCase()) : undefined;
  if (explicitMatches.length === 1 && selected && explicitMatches[0]?.machine_id !== selected.machine_id) {
    return { machine_id: null, machine_name: null, resolution_source: "conflict", ambiguous: true,
      candidates: [explicitMatches[0], selected].map((item) => ({ machine_id: item?.machine_id, machine_name: item?.machine_name })) };
  }
  const direct = explicitMatches.length === 1 ? explicitMatches[0] : selected;
  if (direct) return { machine_id: direct.machine_id, machine_name: direct.machine_name,
    resolution_source: explicitMatches.length === 1 ? "explicit_id" : "selected_machine", ambiguous: false };
  const report = normalizeMachineText(input.operator_report);
  const named = machines.filter((machine) => {
    const names = [machine.machine_name, machine.equipment_type].filter(Boolean).map(normalizeMachineText);
    return names.some((name) => name.length >= 4 && report.includes(name));
  });
  if (named.length === 1) return { machine_id: named[0].machine_id, machine_name: named[0].machine_name,
    resolution_source: "matched_name", ambiguous: false };
  return { machine_id: null, machine_name: null, resolution_source: "ambiguous", ambiguous: true,
    candidates: named.slice(0, 5).map(({ machine_id, machine_name }) => ({ machine_id, machine_name })) };
}

async function getMachineState(raw: unknown) {
  const { machine_id } = machineInput.parse(raw);
  const db = getSupabaseAdmin();
  const [machine, incidents, maintenance, alarms, sensors] = await Promise.all([
    db.from("machines").select("machine_id,machine_name,equipment_type,area,criticality,normal_operating_note").eq("machine_id", machine_id).maybeSingle(),
    db.from("incidents").select("incident_id,start_time,operator_description,severity,status,rca_category").eq("machine_id", machine_id).order("start_time", { ascending: false }).limit(6),
    db.from("maintenance_actions").select("work_order_id,incident_id,maintenance_type,action_taken,status,completion_time").eq("machine_id", machine_id).order("completion_time", { ascending: false }).limit(6),
    db.from("alarm_logs").select("alarm_id,incident_id,timestamp,tep_tag,alarm_type,severity,alarm_message").eq("machine_id", machine_id).order("timestamp", { ascending: false }).limit(8),
    db.from("sensor_snapshots").select("incident_id,timestamp,tep_tag,phase,synthetic_value,z_score_vs_normal,status").eq("machine_id", machine_id).order("timestamp", { ascending: false }).limit(8),
  ]);
  for (const response of [machine, incidents, maintenance, alarms, sensors]) if (response.error) throw response.error;
  if (!machine.data) throw new Error(`Unknown machine_id: ${machine_id}`);
  return {
    machine: machine.data,
    open_incidents: (incidents.data || []).filter((item) => !["resolved", "closed"].includes(String(item.status).toLowerCase())),
    recent_incidents: incidents.data || [], maintenance_actions: maintenance.data || [],
    latest_available_alarms: alarms.data || [], latest_available_sensor_snapshots: sensors.data || [],
    data_freshness_note: "Historical demo records; not live historian data.",
  };
}

async function searchPlantMemory(raw: unknown) {
  const input = searchInput.parse(raw);
  const retrieval = await retrieveEvidence(input.query, input.machine_id, 4);
  return {
    weak: retrieval.weak,
    strongest_similarity: retrieval.strongestSimilarity,
    documents: retrieval.documents.map((doc) => ({
      source_id: doc.source_id, source_type: doc.doc_type, title: doc.title,
      machine_id: doc.machine_id, similarity: doc.similarity,
      excerpt: doc.text.slice(0, 1200),
    })),
    citations: retrieval.citations,
  };
}

async function getMachineSop(raw: unknown) {
  const { machine_id } = machineInput.parse(raw);
  const sop = await getSopForMachine(machine_id);
  if (!sop) return { machine_id, found: false };
  return { machine_id, found: true, title: sop.title, content: sop.content.slice(0, 1200),
    steps: sop.steps.slice(0, 8), safety_notes: sop.safety_notes.slice(0, 6) };
}

function maskedRecipient(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `WhatsApp ending ${digits.slice(-4)}` : "Approved WhatsApp contact";
}

export function getApprovedContact(contactId = "maintenance_primary") {
  if (contactId !== "maintenance_primary") throw new Error("Unknown approved contact");
  const phone = process.env.MAINTENANCE_WHATSAPP_TO;
  if (!phone?.startsWith("whatsapp:+")) throw new Error("MAINTENANCE_WHATSAPP_TO is not configured");
  return { contact_id: contactId, role: "Maintenance Lead" as const, phone, display: maskedRecipient(phone) };
}

async function getEscalationContact(raw: unknown) {
  const input = contactInput.parse(raw);
  const { data, error } = await getSupabaseAdmin().from("machines").select("machine_id").eq("machine_id", input.machine_id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Unknown machine_id: ${input.machine_id}`);
  const contact = getApprovedContact();
  return { contact_id: contact.contact_id, role: contact.role, display: contact.display,
    authorization_scope: "status-only replies for the approved work order" };
}

function traceFor(name: string, result: any): PublicTraceEvent {
  if (name === "resolve_machine") return { tool: name, label: "Machine resolution",
    status: result.ambiguous ? "needs_clarification" : "completed",
    summary: result.ambiguous ? "Machine needs clarification" : `Identified ${result.machine_id} - ${result.machine_name}` };
  if (name === "get_machine_state") return { tool: name, label: "Machine evidence", status: "completed",
    summary: `Inspected ${result.latest_available_alarms.length} alarms and ${result.latest_available_sensor_snapshots.length} sensor snapshots` };
  if (name === "search_plant_memory") return { tool: name, label: "Plant memory", status: "completed",
    summary: `Retrieved ${result.documents.length} plant-memory records` };
  if (name === "get_machine_sop") return { tool: name, label: "SOP", status: "completed",
    summary: result.found ? `Loaded ${result.title}` : "No SOP found" };
  return { tool: name, label: "Escalation contact", status: "completed", summary: `Resolved ${result.role} - ${result.display}` };
}

export async function executeReadOnlyTool(name: string, rawArguments: unknown): Promise<ToolExecution> {
  const operations: Record<string, () => Promise<unknown>> = {
    resolve_machine: () => resolveMachine(rawArguments),
    get_machine_state: () => getMachineState(rawArguments),
    search_plant_memory: () => searchPlantMemory(rawArguments),
    get_machine_sop: () => getMachineSop(rawArguments),
    get_escalation_contact: () => getEscalationContact(rawArguments),
  };
  const operation = operations[name];
  if (!operation) throw new Error(`Unsupported read-only tool: ${name}`);
  const result = await withTimeout(name, operation());
  return { name, result, trace: traceFor(name, result) };
}

export function createAgentId(prefix: "RUN" | "INC-AGENT" | "WO-AGENT") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = randomBytes(10);
  const suffix = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  return `${prefix}-${suffix}`;
}
