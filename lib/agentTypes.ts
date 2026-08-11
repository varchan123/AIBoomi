export const severityValues = ["Low", "Medium", "High", "Critical"] as const;
export type Severity = (typeof severityValues)[number];

export const permittedInboundStatuses = [
  "Accepted",
  "In Progress",
  "Needs Help",
  "Resolved - Awaiting Verification",
] as const;
export type PermittedInboundStatus = (typeof permittedInboundStatuses)[number];

export type PublicTraceEvent = {
  tool: string;
  label: string;
  status: "completed" | "needs_clarification" | "failed";
  summary: string;
};

export type PlantCitation = {
  source_id: string;
  source_type: string;
  title: string;
  machine_id: string | null;
  relevance: string;
};

export type CreateIncidentAction = {
  type: "create_open_incident";
  arguments: {
    incident_id: string;
    machine_id: string;
    operator_description: string;
    severity: Severity;
    status: "Open";
  };
};

export type CreateWorkOrderAction = {
  type: "create_maintenance_work_order";
  arguments: {
    work_order_id: string;
    incident_id: string;
    machine_id: string;
    maintenance_type: "Inspection";
    requested_action: string;
    status: "Assigned";
  };
};

export type SendWhatsAppAction = {
  type: "send_whatsapp_escalation";
  arguments: {
    incident_id: string;
    work_order_id: string;
    contact_id: string;
    message_body: string;
  };
};

export type ProposedAction =
  | CreateIncidentAction
  | CreateWorkOrderAction
  | SendWhatsAppAction;

export type InvestigationProposal = {
  run_id: string;
  summary: string;
  spoken_response?: string;
  confidence: "low" | "medium" | "high";
  language_code?: string;
  citations: PlantCitation[];
  trace: PublicTraceEvent[];
  requires_approval: boolean;
  proposed_actions: ProposedAction[];
  approval_token?: string;
  recipient?: { contact_id: string; role: string; display: string };
  clarification_question?: string;
};

export type ReplyClassification = {
  intent:
    | "accepted"
    | "needs_help"
    | "progress_update"
    | "resolution_claim"
    | "unrelated"
    | "ambiguous"
    | "suspicious";
  status_update: PermittedInboundStatus | null;
  technician_update: string | null;
  root_cause_claim: string | null;
  fix_claim: string | null;
  needs_human_review: boolean;
};
