import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const days = Math.min(Math.max(Number(new URL(request.url).searchParams.get("days")) || 30, 1), 365);
  const { data, error } = await getSupabaseAdmin().rpc("dashboard_snapshot", { period_days: days });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
