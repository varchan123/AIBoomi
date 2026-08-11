import { getApprovedContact } from "./agentTools";
import type { AgentActivityEvent, AgentActivityResponse } from "./agentActivityTypes";
import { permittedInboundStatuses } from "./agentTypes";
import { getSupabaseAdmin } from "./supabase";

type ActivityDatabase = ReturnType<typeof getSupabaseAdmin>;
let testDatabase: ActivityDatabase | undefined;

function activityDatabase() {
  return testDatabase || getSupabaseAdmin();
}

export function setAgentActivityDatabaseForTests(database?: ActivityDatabase) {
  testDatabase = database;
}

function maskedParty(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `WhatsApp ending ${digits.slice(-4)}` : "Approved WhatsApp contact";
}

function safeText(value: unknown, maxLength = 2000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeStatus(value: unknown) {
  return typeof value === "string" ? value.slice(0, 100) : null;
}

function interpretedStatus(value: unknown) {
  const status = (value as Record<string, unknown> | null)?.status_update;
  return permittedInboundStatuses.includes(status as any) ? String(status) : null;
}

function deliveryStatus(value: unknown, actionStatus?: unknown) {
  const status = safeStatus((value as Record<string, unknown> | null)?.delivery_status);
  if (status && ["queued", "sent", "delivered", "read", "failed", "undelivered"].includes(status.toLowerCase())) {
    return status.toLowerCase();
  }
  return actionStatus === "attempting" ? "queued" : null;
}

export async function getAgentActivity(workOrderId?: string): Promise<AgentActivityResponse> {
  const db = activityDatabase();
  const contact = getApprovedContact("maintenance_primary");
  let conversationQuery = db.from("external_conversations")
    .select("conversation_id,work_order_id,status,external_user,created_at,updated_at")
    .eq("channel", "whatsapp")
    .eq("contact_id", contact.contact_id)
    .eq("external_user", contact.phone);

  if (workOrderId) {
    conversationQuery = conversationQuery.eq("work_order_id", workOrderId);
  } else {
    conversationQuery = conversationQuery.in("status", ["pending_send", "active"])
      .order("updated_at", { ascending: false }).limit(1);
  }

  const { data: conversation, error: conversationError } = await conversationQuery.maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) {
    if (workOrderId) throw new Error("WhatsApp activity was not found for this approved work order");
    return { work_order_id: null, workflow_status: null, conversation_status: null, delivery_status: null, events: [] };
  }

  const resolvedWorkOrderId = String(conversation.work_order_id);
  const [workOrderResult, outboundResult, inboundResult] = await Promise.all([
    db.from("maintenance_actions")
      .select("work_order_id,status")
      .eq("work_order_id", resolvedWorkOrderId).maybeSingle(),
    db.from("agent_actions")
      .select("action_id,input_json,output_json,status,external_message_sid,created_at,updated_at")
      .eq("work_order_id", resolvedWorkOrderId)
      .eq("action_type", "send_whatsapp_escalation")
      .order("created_at", { ascending: true }),
    db.from("inbound_messages")
      .select("message_sid,sender,body,voice_transcript,classification_json,processing_status,received_at,processed_at")
      .eq("conversation_id", conversation.conversation_id)
      .eq("work_order_id", resolvedWorkOrderId)
      .order("received_at", { ascending: true }),
  ]);
  for (const result of [workOrderResult, outboundResult, inboundResult]) {
    if (result.error) throw result.error;
  }

  const outbound: AgentActivityEvent[] = (outboundResult.data || []).map((row: any) => ({
    message_id: row.external_message_sid || `outbound-action-${row.action_id}`,
    direction: "outbound",
    message: safeText(row.input_json?.message_body, 1600),
    interpreted_status: null,
    delivery_status: deliveryStatus(row.output_json, row.status),
    timestamp: row.created_at || row.updated_at,
    masked_party: maskedParty(conversation.external_user),
  }));
  const inbound: AgentActivityEvent[] = (inboundResult.data || []).map((row: any) => ({
    message_id: String(row.message_sid),
    direction: "inbound",
    message: safeText(row.voice_transcript || row.body),
    interpreted_status: interpretedStatus(row.classification_json),
    delivery_status: null,
    timestamp: row.received_at || row.processed_at,
    masked_party: maskedParty(row.sender),
  }));
  const events = [...outbound, ...inbound]
    .filter((event) => event.message_id && event.timestamp)
    .filter((event, index, all) => all.findIndex((candidate) => candidate.message_id === event.message_id) === index)
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
      || left.message_id.localeCompare(right.message_id));
  const latestOutbound = [...outbound].reverse().find((event) => event.delivery_status);

  return {
    work_order_id: resolvedWorkOrderId,
    workflow_status: safeStatus(workOrderResult.data?.status),
    conversation_status: safeStatus(conversation.status),
    delivery_status: latestOutbound?.delivery_status || null,
    events,
  };
}
