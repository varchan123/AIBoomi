import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentActivity } from "@/lib/agentActivity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  work_order_id: z.string().regex(/^WO-AGENT-[A-Z]+$/).optional(),
}).strict();

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = querySchema.parse({ work_order_id: url.searchParams.get("work_order_id") || undefined });
    const result = await getAgentActivity(query.work_order_id);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    console.error(error);
    const notFound = error instanceof Error && error.message.includes("not found");
    const status = notFound ? 404 : error instanceof z.ZodError ? 400 : 500;
    return NextResponse.json({ error: notFound ? "Activity not found" : "Activity unavailable", code: notFound ? "ACTIVITY_NOT_FOUND" : "ACTIVITY_UNAVAILABLE" }, {
      status,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
}
