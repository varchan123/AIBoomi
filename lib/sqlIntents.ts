import { chatModel, getOpenAI } from "./openai";
import { intentSystemPrompt } from "./prompts";
import { getSupabaseAdmin } from "./supabase";

export const intents = [
  "incident_count_by_machine", "open_incidents", "top_problem_machines",
  "repeat_failures", "downtime_by_machine", "maintenance_cost_by_machine",
  "incidents_by_employee", "knowledge_question",
] as const;
export type Intent = typeof intents[number];

export async function classifyIntent(question: string) {
  const response = await getOpenAI().chat.completions.create({
    model: chatModel,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      { role: "system", content: intentSystemPrompt },
      { role: "user", content: question },
    ],
  });
  const parsed = JSON.parse(response.choices[0].message.content || "{}");
  const intent: Intent = intents.includes(parsed.intent) ? parsed.intent : "knowledge_question";
  return {
    intent,
    machine_id: parsed.machine_id || null,
    employee_name: parsed.employee_name || null,
    period_days: Math.min(Math.max(Number(parsed.period_days) || 30, 1), 3650),
    limit: Math.min(Math.max(Number(parsed.limit) || 10, 1), 50),
  };
}

export async function runStructuredIntent(classification: Awaited<ReturnType<typeof classifyIntent>>) {
  const { data, error } = await getSupabaseAdmin().rpc("structured_qa", {
    p_intent: classification.intent,
    p_machine_id: classification.machine_id,
    p_employee_name: classification.employee_name,
    p_period_days: classification.period_days,
    p_limit: classification.limit,
  });
  if (error) throw error;
  return data;
}
