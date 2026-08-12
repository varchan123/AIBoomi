import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await getSupabaseAdmin().from("machines").select("*").order("machine_id");
  if (error) {
    console.error(error);
    return NextResponse.json({ error: "Machine list unavailable", code: "MACHINES_UNAVAILABLE" }, { status: 500 });
  }
  return NextResponse.json(data);
}
