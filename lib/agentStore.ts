import { createHash } from "node:crypto";
import type { ApprovalPayload } from "./approvalTokens";
import type { ProposedAction } from "./agentTypes";
import { getApprovedContact } from "./agentTools";
import { getSupabaseAdmin } from "./supabase";
import { assertWhatsAppConfigured, sendWhatsAppMessage } from "./whatsapp";

type SendFunction = typeof sendWhatsAppMessage;
type AgentDatabase = ReturnType<typeof getSupabaseAdmin>;

let testDatabase: AgentDatabase | undefined;

function agentDatabase() {
  return testDatabase || getSupabaseAdmin();
}

export function setAgentStoreDatabaseForTests(database?: AgentDatabase) {
  testDatabase = database;
}

export class ActiveConversationConflictError extends Error {
  readonly code = "ACTIVE_CONVERSATION_CONFLICT";
  readonly statusCode = 409;

  constructor(readonly existingWorkOrderId: string) {
    super(`Approved contact already has active work-order conversation ${existingWorkOrderId}`);
    this.name = "ActiveConversationConflictError";
  }
}

function nonceHash(nonce: string) {
  return createHash("sha256").update(nonce).digest("base64url");
}

async function claimRun(args: {
  runId: string;
  payload: ApprovalPayload;
  actions: ProposedAction[];
  sender: string;
}) {
  const db = agentDatabase();
  const contactId = (args.actions[2] as Extract<ProposedAction, { type: "send_whatsapp_escalation" }>).arguments.contact_id;
  const { data, error } = await db.from("agent_runs").insert({
    run_id: args.runId, approval_nonce_hash: nonceHash(args.payload.nonce),
    action_hash: args.payload.action_hash, status: "executing", contact_id: contactId,
    approved_sender: args.sender, proposal_json: args.actions,
  }).select("*").single();
  if (!error) return { row: data, newlyClaimed: true };
  if (error.code !== "23505") throw error;
  const { data: existing, error: existingError } = await db.from("agent_runs").select("*").eq("run_id", args.runId).single();
  if (existingError) throw existingError;
  if (existing.action_hash !== args.payload.action_hash || existing.approval_nonce_hash !== nonceHash(args.payload.nonce)) {
    throw new Error("Approval token was already used for a different execution");
  }
  return { row: existing, newlyClaimed: false };
}

async function existingAction(runId: string, actionIndex: number) {
  const { data, error } = await agentDatabase().from("agent_actions").select("*")
    .eq("run_id", runId).eq("action_index", actionIndex).maybeSingle();
  if (error) throw error;
  return data;
}

async function recordCompletedAction(args: {
  runId: string;
  actionIndex: number;
  action: ProposedAction;
  incidentId?: string;
  workOrderId?: string;
  output: unknown;
}) {
  const { error } = await agentDatabase().from("agent_actions").upsert({
    run_id: args.runId, action_index: args.actionIndex, action_type: args.action.type,
    tool_name: args.action.type, input_json: args.action.arguments, output_json: args.output,
    incident_id: args.incidentId || null, work_order_id: args.workOrderId || null,
    status: "completed", updated_at: new Date().toISOString(),
  }, { onConflict: "run_id,action_index" });
  if (error) throw error;
}

async function ensureIncident(runId: string, action: Extract<ProposedAction, { type: "create_open_incident" }>) {
  const prior = await existingAction(runId, 0);
  if (prior?.status === "completed") return prior.output_json;
  const db = agentDatabase();
  const { data: existing, error: lookupError } = await db.from("incidents").select("*")
    .eq("incident_id", action.arguments.incident_id).maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    if (existing.machine_id !== action.arguments.machine_id || existing.operator_description !== action.arguments.operator_description) {
      throw new Error("Reserved incident ID already belongs to different data");
    }
  } else {
    const { data: machine, error: machineError } = await db.from("machines").select("machine_name")
      .eq("machine_id", action.arguments.machine_id).single();
    if (machineError) throw machineError;
    const { error } = await db.from("incidents").insert({
      incident_id: action.arguments.incident_id, start_time: new Date().toISOString(),
      machine_id: action.arguments.machine_id, machine_name: machine.machine_name,
      operator_description: action.arguments.operator_description, severity: action.arguments.severity,
      downtime_minutes: 0, status: "Open", rca_id: null,
    });
    if (error) throw error;
  }
  const output = { incident_id: action.arguments.incident_id, status: "Open" };
  await recordCompletedAction({ runId, actionIndex: 0, action, incidentId: action.arguments.incident_id, output });
  return output;
}

async function ensureWorkOrder(runId: string, action: Extract<ProposedAction, { type: "create_maintenance_work_order" }>) {
  const prior = await existingAction(runId, 1);
  if (prior?.status === "completed") return prior.output_json;
  const db = agentDatabase();
  const { data: existing, error: lookupError } = await db.from("maintenance_actions").select("*")
    .eq("work_order_id", action.arguments.work_order_id).maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    if (existing.incident_id !== action.arguments.incident_id || existing.machine_id !== action.arguments.machine_id) {
      throw new Error("Reserved work-order ID already belongs to different data");
    }
  } else {
    const { error } = await db.from("maintenance_actions").insert({
      work_order_id: action.arguments.work_order_id, incident_id: action.arguments.incident_id,
      machine_id: action.arguments.machine_id, maintenance_type: "Inspection",
      action_taken: action.arguments.requested_action, status: "Assigned",
    });
    if (error) throw error;
  }
  const output = { work_order_id: action.arguments.work_order_id, status: "Assigned" };
  await recordCompletedAction({ runId, actionIndex: 1, action, incidentId: action.arguments.incident_id,
    workOrderId: action.arguments.work_order_id, output });
  return output;
}

async function assertConversationAvailable(args: {
  sender: string;
  workOrderId: string;
}) {
  const { data: active, error: activeError } = await agentDatabase().from("external_conversations")
    .select("conversation_id,work_order_id,status,created_at")
    .eq("channel", "whatsapp").eq("external_user", args.sender).in("status", ["pending_send", "active"]).maybeSingle();
  if (activeError) throw activeError;
  if (active && active.work_order_id !== args.workOrderId) {
    throw new ActiveConversationConflictError(String(active.work_order_id));
  }
  return active;
}

async function ensureConversation(args: {
  runId: string;
  sender: string;
  contactId: string;
  incidentId: string;
  workOrderId: string;
}) {
  const db = agentDatabase();
  await assertConversationAvailable({ sender: args.sender, workOrderId: args.workOrderId });
  const { error } = await db.from("external_conversations").upsert({
    run_id: args.runId, channel: "whatsapp", external_user: args.sender, contact_id: args.contactId,
    incident_id: args.incidentId, work_order_id: args.workOrderId, status: "pending_send",
    bounded_status_updates: true, updated_at: new Date().toISOString(),
  }, { onConflict: "channel,work_order_id" });
  if (error) throw error;
}

async function ensureWhatsApp(args: {
  runId: string;
  action: Extract<ProposedAction, { type: "send_whatsapp_escalation" }>;
  sender: string;
  send: SendFunction;
}) {
  const db = agentDatabase();
  const prior = await existingAction(args.runId, 2);
  if (prior?.status === "completed") return prior.output_json;
  if (prior) throw new Error("A previous WhatsApp send was attempted; refusing to risk a duplicate message");
  await ensureConversation({ runId: args.runId, sender: args.sender, contactId: args.action.arguments.contact_id,
    incidentId: args.action.arguments.incident_id, workOrderId: args.action.arguments.work_order_id });
  const { error: attemptError } = await db.from("agent_actions").insert({
    run_id: args.runId, action_index: 2, action_type: args.action.type, tool_name: args.action.type,
    input_json: args.action.arguments, incident_id: args.action.arguments.incident_id,
    work_order_id: args.action.arguments.work_order_id, status: "attempting",
  });
  if (attemptError) throw attemptError;
  try {
    const output = await args.send({ to: args.sender, body: args.action.arguments.message_body });
    const now = new Date().toISOString();
    const [{ error: actionError }, { error: conversationError }] = await Promise.all([
      db.from("agent_actions").update({ status: "completed", output_json: output,
        external_message_sid: output.message_sid, updated_at: now })
        .eq("run_id", args.runId).eq("action_index", 2),
      db.from("external_conversations").update({ status: "active", latest_external_message_sid: output.message_sid, updated_at: now })
        .eq("channel", "whatsapp").eq("work_order_id", args.action.arguments.work_order_id),
    ]);
    if (actionError) throw actionError;
    if (conversationError) throw conversationError;
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp send failed";
    await Promise.all([
      db.from("agent_actions").update({ status: "outcome_unknown", output_json: { error: message }, updated_at: new Date().toISOString() })
        .eq("run_id", args.runId).eq("action_index", 2),
      db.from("agent_runs").update({ status: "send_outcome_unknown", error_message: message, updated_at: new Date().toISOString() })
        .eq("run_id", args.runId),
    ]);
    throw error;
  }
}

export async function executeApprovedProposal(args: {
  runId: string;
  payload: ApprovalPayload;
  actions: ProposedAction[];
  send?: SendFunction;
}) {
  if (args.payload.run_id !== args.runId) throw new Error("Approval token belongs to a different run");
  assertWhatsAppConfigured();
  const whatsappProposal = args.actions[2] as Extract<ProposedAction, { type: "send_whatsapp_escalation" }>;
  const contact = getApprovedContact(whatsappProposal.arguments.contact_id);
  await assertConversationAvailable({
    sender: contact.phone,
    workOrderId: whatsappProposal.arguments.work_order_id,
  });
  const claim = await claimRun({ runId: args.runId, payload: args.payload, actions: args.actions, sender: contact.phone });
  if (claim.row.status === "completed") {
    return { status: "completed", incident_id: claim.row.incident_id, work_order_id: claim.row.work_order_id,
      message: (await existingAction(args.runId, 2))?.output_json };
  }
  if (claim.row.status === "send_outcome_unknown") {
    throw new Error("Previous WhatsApp send outcome is unknown; manual reconciliation is required");
  }
  const incidentAction = args.actions[0] as Extract<ProposedAction, { type: "create_open_incident" }>;
  const workOrderAction = args.actions[1] as Extract<ProposedAction, { type: "create_maintenance_work_order" }>;
  const whatsappAction = args.actions[2] as Extract<ProposedAction, { type: "send_whatsapp_escalation" }>;
  const incident = await ensureIncident(args.runId, incidentAction);
  const workOrder = await ensureWorkOrder(args.runId, workOrderAction);
  const message = await ensureWhatsApp({ runId: args.runId, action: whatsappAction,
    sender: contact.phone, send: args.send || sendWhatsAppMessage });
  const { error } = await agentDatabase().from("agent_runs").update({
    status: "completed", incident_id: incidentAction.arguments.incident_id,
    work_order_id: workOrderAction.arguments.work_order_id, completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("run_id", args.runId);
  if (error) throw error;
  return { status: "completed", incident_id: (incident as any).incident_id,
    work_order_id: (workOrder as any).work_order_id, message };
}
