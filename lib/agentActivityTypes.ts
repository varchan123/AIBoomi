export type AgentActivityEvent = {
  message_id: string;
  direction: "inbound" | "outbound";
  message: string;
  interpreted_status: string | null;
  delivery_status: string | null;
  timestamp: string;
  masked_party: string;
  is_voice_note: boolean;
  root_cause_claim: string | null;
  fix_claim: string | null;
};

export type AgentActivityResponse = {
  work_order_id: string | null;
  workflow_status: string | null;
  conversation_status: string | null;
  delivery_status: string | null;
  events: AgentActivityEvent[];
};

export function mergeActivityEvents(
  previous: AgentActivityEvent[] = [],
  incoming: AgentActivityEvent[] = [],
) {
  const byId = new Map(previous.map((event) => [event.message_id, event]));
  for (const event of incoming) byId.set(event.message_id, event);
  return [...byId.values()].sort((left, right) =>
    new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
    || left.message_id.localeCompare(right.message_id));
}

export function activityUrl(workOrderId?: string | null) {
  return workOrderId
    ? `/api/agent/activity?work_order_id=${encodeURIComponent(workOrderId)}`
    : "/api/agent/activity";
}

export async function fetchAgentActivity(
  workOrderId?: string | null,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AgentActivityResponse> {
  const response = await fetcher(activityUrl(workOrderId), {
    method: "GET",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    let message = `Could not load WhatsApp activity (${response.status})`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}
