import { NextResponse } from "next/server";
import { logSarvamError, transcribeWithSaaras } from "@/lib/sarvam";
import { MAX_RECORDING_BYTES, normalizeAudioMimeType } from "@/lib/audioRecording";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let audioMimeType = "unknown";
  let audioByteSize = 0;
  try {
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) throw new Error("One audio file is required");
    if (!file.type.startsWith("audio/")) throw new Error("Only audio uploads are supported");
    audioMimeType = normalizeAudioMimeType(file.type);
    audioByteSize = file.size;
    if (!file.size || file.size > MAX_RECORDING_BYTES) throw new Error("Audio must be between 1 byte and 5 MB");
    const result = await transcribeWithSaaras(file);
    return NextResponse.json(result);
  } catch (error) {
    logSarvamError(error, { mimeType: audioMimeType, byteSize: audioByteSize });
    return NextResponse.json(
      { error: "Transcription failed", code: "TRANSCRIPTION_FAILED" },
      { status: 400 },
    );
  }
}
