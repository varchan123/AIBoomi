import { NextResponse } from "next/server";
import { synthesizeWithBulbul } from "@/lib/sarvam";
import { speechSynthesizeInput } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (process.env.ENABLE_SARVAM_TTS !== "true") {
      return NextResponse.json({ error: "Speech playback is disabled" }, { status: 503 });
    }
    const input = speechSynthesizeInput.parse(await request.json());
    const result = await synthesizeWithBulbul({ text: input.text, languageCode: input.language_code });
    const bytes = Uint8Array.from(Buffer.from(result.base64Audio, "base64"));
    return new Response(bytes, {
      headers: {
        "Content-Type": result.mimeType,
        "Cache-Control": "private, max-age=86400",
        "X-ChemieGenie-TTS-Speaker": "shubh",
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Speech synthesis failed" },
      { status: 400 },
    );
  }
}
