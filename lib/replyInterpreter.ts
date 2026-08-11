import { replyClassifierSystemPrompt } from "./agentPrompts";
import type { ReplyClassification } from "./agentTypes";
import { runSarvamChat, type SarvamChatArgs } from "./sarvam";
import { replyClassificationSchema } from "./validation";

const replyJsonSchema = {
  type: "json_schema",
  json_schema: {
    name: "technician_reply",
    strict: true,
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        intent: { type: "string", enum: ["accepted", "needs_help", "progress_update", "resolution_claim", "unrelated", "ambiguous", "suspicious"] },
        status_update: { anyOf: [
          { type: "string", enum: ["Accepted", "In Progress", "Needs Help", "Resolved - Awaiting Verification"] },
          { type: "null" },
        ] },
        technician_update: { anyOf: [{ type: "string" }, { type: "null" }] },
        root_cause_claim: { anyOf: [{ type: "string" }, { type: "null" }] },
        fix_claim: { anyOf: [{ type: "string" }, { type: "null" }] },
        needs_human_review: { type: "boolean" },
      },
      required: ["intent", "status_update", "technician_update", "root_cause_claim", "fix_claim", "needs_human_review"],
    },
  },
};

const statusByIntent = {
  accepted: "Accepted",
  needs_help: "Needs Help",
  progress_update: "In Progress",
  resolution_claim: "Resolved - Awaiting Verification",
} as const;

export async function interpretTechnicianReply(args: {
  message: string;
  workOrder: Record<string, unknown>;
  chat?: (args: SarvamChatArgs) => Promise<unknown>;
}): Promise<ReplyClassification> {
  const chat = args.chat || runSarvamChat;
  const response: any = await chat({
    messages: [
      { role: "system", content: replyClassifierSystemPrompt },
      { role: "user", content: JSON.stringify({ technician_message: args.message, work_order: args.workOrder,
        instruction: "Extract only claims present in the message. Do not infer a root cause or fix." }) },
    ],
    toolChoice: "none", maxTokens: 700, reasoningEffort: null, responseFormat: replyJsonSchema,
  });
  const content = response?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Sarvam returned no reply classification");
  const parsed = replyClassificationSchema.parse(JSON.parse(content));
  const permittedStatus = statusByIntent[parsed.intent as keyof typeof statusByIntent] || null;
  return {
    ...parsed,
    status_update: permittedStatus,
    needs_human_review: parsed.needs_human_review || !permittedStatus || Boolean(parsed.root_cause_claim || parsed.fix_claim),
  };
}

