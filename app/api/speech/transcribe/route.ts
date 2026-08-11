import { NextResponse } from "next/server";
import { transcribeWithSaaras } from "@/lib/sarvam";

export const runtime = "nodejs";
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) throw new Error("One audio file is required");
    if (!file.type.startsWith("audio/")) throw new Error("Only audio uploads are supported");
    if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error("Audio must be between 1 byte and 5 MB");
    const result = await transcribeWithSaaras(file);
    return NextResponse.json(result);
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Transcription failed" },
      { status: 400 },
    );
  }
}

