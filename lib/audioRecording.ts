export const MAX_RECORDING_BYTES = 5 * 1024 * 1024;
export const MIN_RECORDING_DURATION_MS = 1_000;
export const MAX_RECORDING_DURATION_MS = 30_000;

export const supportedRecorderMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

export function selectRecorderMimeType(isSupported: (mimeType: string) => boolean) {
  return supportedRecorderMimeTypes.find((mimeType) => isSupported(mimeType)) || null;
}

export function normalizeAudioMimeType(mimeType: string) {
  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0];
  if (normalized === "audio/webm") return "audio/webm";
  if (normalized === "audio/ogg") return "audio/ogg";
  return normalized;
}

export function audioExtension(mimeType: string) {
  switch (normalizeAudioMimeType(mimeType)) {
    case "audio/webm": return "webm";
    case "audio/ogg": case "audio/opus": return "ogg";
    case "audio/mpeg": case "audio/mp3": return "mp3";
    case "audio/mp4": case "audio/x-m4a": return "m4a";
    case "audio/wav": case "audio/x-wav": return "wav";
    case "audio/flac": return "flac";
    case "audio/aac": return "aac";
    case "audio/amr": return "amr";
    default: return "audio";
  }
}

export function prepareRecordingFile(blob: Blob, durationMs: number) {
  if (!blob.size) throw new Error("The recording was empty. Please record again.");
  if (durationMs < MIN_RECORDING_DURATION_MS) throw new Error("Record for at least 1 second before transcribing.");
  if (durationMs > MAX_RECORDING_DURATION_MS) throw new Error("Recordings must be 30 seconds or shorter.");
  if (blob.size > MAX_RECORDING_BYTES) throw new Error("Recordings must be 5 MB or smaller.");
  const mimeType = blob.type || "audio/webm";
  return new File([blob], `operator-report.${audioExtension(mimeType)}`, { type: mimeType });
}
