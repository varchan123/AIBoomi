import { z } from "zod";

export const triageInput = z.object({
  query: z.string().trim().min(8).max(2000),
  machine_id: z.string().trim().min(1),
});

export const askInput = z.object({
  question: z.string().trim().min(3).max(2000),
});

export const agentInvestigateInput = z.object({
  report: z.string().trim().min(8).max(2000),
  selected_machine_id: z.string().trim().min(1).max(40).optional(),
  language_code: z.string().trim().min(2).max(20).optional(),
}).strict();

const agentIncidentAction = z.object({
  type: z.literal("create_open_incident"),
  arguments: z.object({
    incident_id: z.string().regex(/^INC-AGENT-[A-Z]+$/), machine_id: z.string().min(1).max(40),
    operator_description: z.string().min(8).max(2000),
    severity: z.enum(["Low", "Medium", "High", "Critical"]), status: z.literal("Open"),
  }).strict(),
}).strict();

const agentWorkOrderAction = z.object({
  type: z.literal("create_maintenance_work_order"),
  arguments: z.object({
    work_order_id: z.string().regex(/^WO-AGENT-[A-Z]+$/), incident_id: z.string().regex(/^INC-AGENT-[A-Z]+$/),
    machine_id: z.string().min(1).max(40), maintenance_type: z.literal("Inspection"),
    requested_action: z.string().min(5).max(600), status: z.literal("Assigned"),
  }).strict(),
}).strict();

const agentWhatsAppAction = z.object({
  type: z.literal("send_whatsapp_escalation"),
  arguments: z.object({
    incident_id: z.string().regex(/^INC-AGENT-[A-Z]+$/), work_order_id: z.string().regex(/^WO-AGENT-[A-Z]+$/),
    contact_id: z.literal("maintenance_primary"), message_body: z.string().min(20).max(1600),
  }).strict(),
}).strict();

export const proposedActionsSchema = z.tuple([agentIncidentAction, agentWorkOrderAction, agentWhatsAppAction])
  .superRefine(([incident, workOrder, message], context) => {
    if (incident.arguments.incident_id !== workOrder.arguments.incident_id ||
        incident.arguments.incident_id !== message.arguments.incident_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Incident IDs must match across approved actions" });
    }
    if (workOrder.arguments.work_order_id !== message.arguments.work_order_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Work-order IDs must match across approved actions" });
    }
    if (incident.arguments.machine_id !== workOrder.arguments.machine_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Machine IDs must match across approved actions" });
    }
  });

export const agentExecuteInput = z.object({
  run_id: z.string().regex(/^RUN-[A-Z]+$/),
  approval_token: z.string().min(20),
  proposed_actions: proposedActionsSchema,
}).strict();

export const replyClassificationSchema = z.object({
  intent: z.enum(["accepted", "needs_help", "progress_update", "resolution_claim", "unrelated", "ambiguous", "suspicious"]),
  status_update: z.enum(["Accepted", "In Progress", "Needs Help", "Resolved - Awaiting Verification"]).nullable(),
  technician_update: z.string().trim().max(1000).nullable(),
  root_cause_claim: z.string().trim().max(1000).nullable(),
  fix_claim: z.string().trim().max(1000).nullable(),
  needs_human_review: z.boolean(),
}).strict();

export const speechSynthesizeInput = z.object({
  text: z.string().trim().min(1).max(500),
  language_code: z.enum(["en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN"]),
}).strict();

export const incidentInput = z.object({
  machine_id: z.string().min(1),
  what_actually_happened: z.string().min(5),
  root_cause_confirmed: z.string().min(3),
  fix_applied: z.string().min(3),
  preventive_action: z.string().min(3),
  downtime_minutes: z.coerce.number().int().min(0),
  operator_or_engineer: z.string().min(2),
  status: z.string().min(2),
  severity: z.string().default("Medium"),
  rca_category: z.string().optional(),
  tep_fault_number: z.coerce.number().int().optional(),
});

export function requireFields(row: Record<string, unknown>, fields: string[]) {
  const missing = fields.filter((field) => row[field] === undefined || row[field] === null || row[field] === "");
  return missing.length ? `missing required fields: ${missing.join(", ")}` : null;
}

export function nullable(value: unknown) {
  return value === "" || value === undefined ? null : value;
}

export function numberOrNull(value: unknown) {
  const n = Number(value);
  return value === "" || value === undefined || Number.isNaN(n) ? null : n;
}
