import { NextResponse } from "next/server";
import { verifyApprovalToken } from "@/lib/approvalTokens";
import { ActiveConversationConflictError, executeApprovedProposal } from "@/lib/agentStore";
import type { ProposedAction } from "@/lib/agentTypes";
import { agentExecuteInput } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = agentExecuteInput.parse(await request.json());
    const actions = input.proposed_actions as ProposedAction[];
    const payload = verifyApprovalToken({ token: input.approval_token, actions });
    const result = await executeApprovedProposal({ runId: input.run_id, payload, actions });
    return NextResponse.json(result);
  } catch (error) {
    console.error(error);
    if (error instanceof ActiveConversationConflictError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        existing_work_order_id: error.existingWorkOrderId,
      }, { status: 409 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approved execution failed" },
      { status: 400 },
    );
  }
}
