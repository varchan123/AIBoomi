import { getApprovedContact } from "./agentTools";
import { getSupabaseAdmin } from "./supabase";

type ClosureDatabase = ReturnType<typeof getSupabaseAdmin>;
let testDatabase: ClosureDatabase | undefined;

export function setWorkOrderClosureDatabaseForTests(database?: ClosureDatabase) {
  testDatabase = database;
}

export class WorkOrderClosureError extends Error {
  constructor(
    readonly code: "WORK_ORDER_NOT_FOUND" | "WORK_ORDER_CLOSE_CONFLICT" | "WORK_ORDER_CLOSE_FAILED",
    readonly statusCode: 404 | 409 | 500,
    message: string,
  ) {
    super(message);
    this.name = "WorkOrderClosureError";
  }
}

export async function closeWorkOrder(args: { workOrderId: string; closureNote: string }) {
  const db = testDatabase || getSupabaseAdmin();
  const contact = getApprovedContact("maintenance_primary");
  const { data, error } = await db.rpc("close_agent_work_order", {
    p_work_order_id: args.workOrderId,
    p_closure_note: args.closureNote.trim(),
    p_contact_id: contact.contact_id,
    p_external_user: contact.phone,
    p_closed_by: "worker_console_human",
  });
  if (!error) return data;
  if (error.code === "P0002" || error.message === "WORK_ORDER_NOT_FOUND") {
    throw new WorkOrderClosureError("WORK_ORDER_NOT_FOUND", 404, "This work order could not be found.");
  }
  if (error.code === "P0001") {
    throw new WorkOrderClosureError("WORK_ORDER_CLOSE_CONFLICT", 409, "The request could not be closed. Please refresh and try again.");
  }
  throw new WorkOrderClosureError("WORK_ORDER_CLOSE_FAILED", 500, "The request could not be closed. Please refresh and try again.");
}
