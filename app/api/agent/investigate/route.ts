import { NextResponse } from "next/server";
import { investigateIncident, SynthesisInvalidJsonError } from "@/lib/agentRunner";
import { agentInvestigateInput } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = agentInvestigateInput.parse(await request.json());
    return NextResponse.json(await investigateIncident(input));
  } catch (error) {
    console.error(error);
    if (error instanceof SynthesisInvalidJsonError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent investigation failed" },
      { status: 400 },
    );
  }
}
