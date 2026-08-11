import {
  applyBoundedReply, attachInboundContext, beginInboundMessage, failInboundMessage,
  getActiveConversation, getWorkOrderContext, stageInboundMessage,
} from "@/lib/inboundStore";
import { interpretTechnicianReply } from "@/lib/replyInterpreter";
import { transcribeWithSaaras } from "@/lib/sarvam";
import { downloadTwilioMedia, validateTwilioWebhook } from "@/lib/whatsapp";

export const runtime = "nodejs";
const MAX_VOICE_NOTE_BYTES = 5 * 1024 * 1024;

function twiml(status = 200) {
  return new Response("<Response></Response>", {
    status, headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function referencedWorkOrders(message: string) {
  return [...new Set(message.toUpperCase().match(/\bWO(?:-AGENT-[A-Z]+|\d{4,})\b/g) || [])];
}

export async function POST(request: Request) {
  let messageSid = "";
  try {
    const form = await request.formData();
    const params = Object.fromEntries([...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (!validateTwilioWebhook({ signature: request.headers.get("x-twilio-signature"), params, path: "/api/whatsapp/inbound" })) {
      return twiml(403);
    }
    messageSid = String(params.MessageSid || params.SmsMessageSid || "").trim();
    const sender = String(params.From || "").trim();
    const body = String(params.Body || "").trim();
    const mediaCount = Number(params.NumMedia || 0);
    const mediaType = String(params.MediaContentType0 || "").toLowerCase();
    if (!messageSid || !sender.startsWith("whatsapp:+")) return twiml(400);
    const begun = await beginInboundMessage({ messageSid, sender, body, mediaType });
    if (!begun.shouldProcess) return twiml();

    const conversation = await getActiveConversation(sender);
    if (!conversation || !conversation.bounded_status_updates) {
      await stageInboundMessage({ messageSid, reason: "No active approved conversation for this sender" });
      return twiml();
    }

    let transcript: string | undefined;
    if (mediaCount > 0) {
      if (mediaCount !== 1 || !mediaType.startsWith("audio/") || !params.MediaUrl0) {
        await stageInboundMessage({ messageSid, reason: "Unsupported or ambiguous inbound media" });
        return twiml();
      }
      const media = await downloadTwilioMedia(params.MediaUrl0, MAX_VOICE_NOTE_BYTES);
      if (!media.contentType.toLowerCase().startsWith("audio/")) {
        await stageInboundMessage({ messageSid, reason: "Downloaded media is not audio" });
        return twiml();
      }
      const file = new File([media.bytes], "whatsapp-voice-note", { type: media.contentType });
      transcript = (await transcribeWithSaaras(file)).transcript.trim();
    }
    await attachInboundContext({ messageSid, conversation, transcript });
    const message = transcript || body;
    if (!message) {
      await stageInboundMessage({ messageSid, reason: "Message contained no interpretable text" });
      return twiml();
    }
    const mentioned = referencedWorkOrders(message);
    if (mentioned.some((workOrderId) => workOrderId !== conversation.work_order_id.toUpperCase())) {
      await stageInboundMessage({ messageSid, reason: "Message references a different work order", transcript });
      return twiml();
    }
    const workOrder = await getWorkOrderContext(conversation.work_order_id);
    const classification = await interpretTechnicianReply({ message, workOrder });
    if (!classification.status_update || ["unrelated", "ambiguous", "suspicious"].includes(classification.intent)) {
      await stageInboundMessage({ messageSid, reason: "Reply requires human review", classification, transcript });
      return twiml();
    }
    await applyBoundedReply({ messageSid, sender, workOrderId: conversation.work_order_id, classification });
    return twiml();
  } catch (error) {
    console.error(error);
    if (messageSid) await failInboundMessage(messageSid, error instanceof Error ? error.message : "Inbound processing failed");
    return twiml(500);
  }
}

