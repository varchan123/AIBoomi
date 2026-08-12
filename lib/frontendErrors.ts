export type SafeApiError = {
  code?: string;
  existing_work_order_id?: string;
  run_id?: string;
};

function safeId(value: unknown, pattern: RegExp) {
  const text = typeof value === "string" ? value : "";
  return pattern.test(text) ? text : null;
}

export function frontendErrorMessage(status: number, body: SafeApiError = {}, fallbackReference?: string) {
  if (body.code === "ACTIVE_CONVERSATION_CONFLICT") {
    const workOrder = safeId(body.existing_work_order_id, /^WO-AGENT-[A-Z]+$/);
    return workOrder
      ? `This maintenance contact is already handling work order ${workOrder}. Close or verify it before starting another escalation.`
      : "This maintenance contact is already handling another work order. Close or verify it before starting another escalation.";
  }
  if (body.code === "SYNTHESIS_INVALID_JSON") {
    return "The investigation response could not be completed. Please retry once.";
  }
  if (body.code === "APPROVAL_EXPIRED") {
    return "This approval expired. Run the investigation again to generate a fresh proposal.";
  }
  if (body.code === "TWILIO_SEND_FAILED") {
    return "The escalation could not be submitted to WhatsApp. No duplicate message was sent.";
  }
  if (body.code === "CONFIGURATION_ERROR") {
    return "This feature is temporarily unavailable because deployment configuration is incomplete.";
  }
  if (body.code === "WORK_ORDER_NOT_FOUND") return "This work order could not be found.";
  if (body.code === "WORK_ORDER_CLOSE_CONFLICT" || body.code === "WORK_ORDER_CLOSE_FAILED") {
    return "The request could not be closed. Please refresh and try again.";
  }
  if (body.code === "INVALID_CLOSE_REQUEST") return "Enter a closure note and confirm the maintenance outcome was reviewed.";
  const reference = safeId(body.run_id, /^RUN-[A-Z]+$/)
    || safeId(fallbackReference, /^RUN-[A-Z]+$/);
  return reference
    ? `Something went wrong while processing this request. Reference: ${reference}.`
    : "Something went wrong while processing this request.";
}

export async function safeResponseError(response: Response, fallbackReference?: string) {
  let body: SafeApiError = {};
  try { body = await response.json(); } catch {}
  return frontendErrorMessage(response.status, body, fallbackReference);
}
