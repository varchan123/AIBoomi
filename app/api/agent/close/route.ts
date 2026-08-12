import { NextResponse } from "next/server";
import { z } from "zod";
import { closeWorkOrder, WorkOrderClosureError } from "@/lib/workOrderClosure";
import { closeWorkOrderInput } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = closeWorkOrderInput.parse(await request.json());
    return NextResponse.json(await closeWorkOrder({
      workOrderId: input.work_order_id,
      closureNote: input.closure_note,
    }));
  } catch (error) {
    console.error(error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Enter a valid work-order ID and closure note.", code: "INVALID_CLOSE_REQUEST" }, { status: 400 });
    }
    if (error instanceof WorkOrderClosureError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    return NextResponse.json({ error: "The request could not be closed. Please refresh and try again.", code: "WORK_ORDER_CLOSE_FAILED" }, { status: 500 });
  }
}
