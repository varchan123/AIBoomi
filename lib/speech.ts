export const MAX_BULBUL_TEXT_LENGTH = 2_400;

export const speechLanguageOptions = [
  ["en-IN", "English"],
  ["ta-IN", "Tamil"],
  ["hi-IN", "Hindi"],
  ["te-IN", "Telugu"],
  ["kn-IN", "Kannada"],
  ["ml-IN", "Malayalam"],
  ["bn-IN", "Bengali"],
  ["mr-IN", "Marathi"],
  ["gu-IN", "Gujarati"],
  ["pa-IN", "Punjabi"],
  ["od-IN", "Odia"],
] as const;

export type SpeechLanguageCode = (typeof speechLanguageOptions)[number][0];

const supportedSpeechLanguages = new Set<string>(speechLanguageOptions.map(([code]) => code));

export function mapUiLanguageToBulbul(value: string): SpeechLanguageCode {
  return supportedSpeechLanguages.has(value) ? value as SpeechLanguageCode : "en-IN";
}

export function boundBulbulText(value: string, maximum = MAX_BULBUL_TEXT_LENGTH) {
  const text = value.trim();
  if (!text) throw new Error("Speech text is required");
  if (text.length <= maximum) return text;

  const candidate = text.slice(0, maximum + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  return (wordBoundary >= Math.floor(maximum * 0.8) ? candidate.slice(0, wordBoundary) : text.slice(0, maximum)).trimEnd();
}

export function buildIncidentSpeechText(args: {
  summary?: unknown;
  likelyCause?: unknown;
  recommendedAction?: unknown;
}) {
  const sections = [
    ["Incident summary", args.summary],
    ["Likely cause", args.likelyCause],
    ["Recommended action", args.recommendedAction],
  ].flatMap(([label, value]) => {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? [`${label}: ${text}`] : [];
  });

  return boundBulbulText(sections.join("\n"));
}
