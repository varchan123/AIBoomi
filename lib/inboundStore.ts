import type { ReplyClassification } from "./agentTypes";
import { getSupabaseAdmin } from "./supabase";

export async function beginInboundMessage(args: {
  messageSid: string;
  sender: string;
  body?: string;
  mediaType?: string;
}) {
  const db = getSupabaseAdmin();
  const { error } = await db.from("inbound_messages").insert({
    message_sid: args.messageSid, sender: args.sender, body: args.body || null,
    media_type: args.mediaType || null, processing_status: "processing",
  });
  if (!error) return { shouldProcess: true, duplicate: false };
  if (error.code !== "23505") throw error;
  const { data: existing, error: lookupError } = await db.from("inbound_messages").select("processing_status")
    .eq("message_sid", args.messageSid).single();
  if (lookupError) throw lookupError;
  if (existing.processing_status === "failed") {
    const { error: retryError } = await db.from("inbound_messages").update({ processing_status: "processing", review_reason: null })
      .eq("message_sid", args.messageSid).eq("sender", args.sender);
    if (retryError) throw retryError;
    return { shouldProcess: true, duplicate: true };
  }
  return { shouldProcess: false, duplicate: true };
}

export async function getActiveConversation(sender: string) {
  const { data, error } = await getSupabaseAdmin().from("external_conversations")
    .select("conversation_id,run_id,external_user,contact_id,incident_id,work_order_id,status,bounded_status_updates")
    .eq("channel", "whatsapp").eq("external_user", sender).eq("status", "active").maybeSingle();
  if (error) throw error;
  return data;
}

export async function attachInboundContext(args: {
  messageSid: string;
  conversation: Record<string, any>;
  transcript?: string;
}) {
  const { error } = await getSupabaseAdmin().from("inbound_messages").update({
    conversation_id: args.conversation.conversation_id,
    incident_id: args.conversation.incident_id,
    work_order_id: args.conversation.work_order_id,
    voice_transcript: args.transcript || null,
  }).eq("message_sid", args.messageSid);
  if (error) throw error;
}

export async function getWorkOrderContext(workOrderId: string) {
  const { data, error } = await getSupabaseAdmin().from("maintenance_actions")
    .select("work_order_id,incident_id,machine_id,maintenance_type,action_taken,status")
    .eq("work_order_id", workOrderId).single();
  if (error) throw error;
  return data;
}

export async function stageInboundMessage(args: {
  messageSid: string;
  reason: string;
  classification?: ReplyClassification;
  transcript?: string;
}) {
  const { error } = await getSupabaseAdmin().from("inbound_messages").update({
    processing_status: "staged", review_reason: args.reason,
    classification_json: args.classification || null,
    voice_transcript: args.transcript || undefined,
    processed_at: new Date().toISOString(),
  }).eq("message_sid", args.messageSid);
  if (error) throw error;
}

export async function failInboundMessage(messageSid: string, reason: string) {
  await getSupabaseAdmin().from("inbound_messages").update({
    processing_status: "failed", review_reason: reason.slice(0, 1000), processed_at: new Date().toISOString(),
  }).eq("message_sid", messageSid);
}

export async function applyBoundedReply(args: {
  messageSid: string;
  sender: string;
  workOrderId: string;
  classification: ReplyClassification;
}) {
  if (!args.classification.status_update) throw new Error("Reply has no permitted status update");
  const { data, error } = await getSupabaseAdmin().rpc("apply_bounded_work_order_reply", {
    p_message_sid: args.messageSid,
    p_sender: args.sender,
    p_work_order_id: args.workOrderId,
    p_status: args.classification.status_update,
    p_technician_update: args.classification.technician_update,
    p_root_cause_claim: args.classification.root_cause_claim,
    p_fix_claim: args.classification.fix_claim,
    p_classification: args.classification,
  });
  if (error) throw error;
  return data;
}

