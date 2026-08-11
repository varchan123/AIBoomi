import { SarvamAIClient } from "sarvamai";

type ToolChoice = "auto" | "none" | "required";
type ReasoningEffort = "low" | "medium" | "high" | null;

export type SarvamChatArgs = {
  messages: unknown[];
  tools?: unknown[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  responseFormat?: unknown;
};

export type SarvamProvider = {
  chat(args: SarvamChatArgs): Promise<unknown>;
  transcribe(file: File): Promise<{ transcript: string; languageCode?: string }>;
  synthesize(args: {
    text: string;
    languageCode: string;
  }): Promise<{ mimeType: string; base64Audio: string }>;
};

let client: SarvamAIClient | undefined;
let testProvider: SarvamProvider | undefined;

function apiKey() {
  const value = process.env.SARVAM_API_KEY;
  if (!value) throw new Error("SARVAM_API_KEY is required");
  return value;
}

export function getSarvamClient() {
  if (!client) client = new SarvamAIClient({ apiSubscriptionKey: apiKey() });
  return client;
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  const value = candidate.statusCode ?? candidate.status_code ?? candidate.status;
  return typeof value === "number" ? value : Number(value) || undefined;
}

async function withCappedRetry<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = errorStatus(error);
      if ((status !== 429 && status !== 503) || attempt >= delays.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

function logUsage(response: unknown) {
  if (!response || typeof response !== "object") return;
  const usage = (response as Record<string, unknown>).usage;
  if (usage) console.info("Sarvam usage", usage);
}

const liveProvider: SarvamProvider = {
  async chat(args) {
    const request: Record<string, unknown> = {
      model: process.env.SARVAM_CHAT_MODEL || "sarvam-105b",
      messages: args.messages,
      max_tokens: Math.min(Math.max(args.maxTokens || 1000, 700), 1200),
      reasoning_effort: args.reasoningEffort === undefined ? "low" : args.reasoningEffort,
      temperature: 0.1,
      n: 1,
    };
    if (args.tools?.length) {
      request.tools = args.tools;
      request.tool_choice = args.toolChoice || "auto";
    }
    if (args.responseFormat) request.response_format = args.responseFormat;
    const response = await withCappedRetry(() => getSarvamClient().chat.completions(request as never));
    logUsage(response);
    return response;
  },

  async transcribe(file) {
    const response = await withCappedRetry(() => getSarvamClient().speechToText.transcribe({
      file,
      model: "saaras:v3",
      mode: "translate",
      language_code: "unknown",
    }));
    return {
      transcript: response.transcript,
      languageCode: response.language_code || undefined,
    };
  },

  async synthesize({ text, languageCode }) {
    const response = await withCappedRetry(() => getSarvamClient().textToSpeech.convert({
      text,
      language_code: languageCode as never,
      model: "bulbul:v3",
      speaker: "shubh",
      output_audio_codec: "mp3",
      speech_sample_rate: 24000,
      pace: 1,
      temperature: 0.5,
    }));
    const base64Audio = response.audios?.[0];
    if (!base64Audio) throw new Error("Sarvam returned no synthesized audio");
    return { mimeType: "audio/mpeg", base64Audio };
  },
};

function provider() {
  return testProvider || liveProvider;
}

export function setSarvamProviderForTests(value?: SarvamProvider) {
  testProvider = value;
}

export async function runSarvamChat(args: SarvamChatArgs): Promise<unknown> {
  return provider().chat(args);
}

export async function transcribeWithSaaras(file: File) {
  return provider().transcribe(file);
}

export async function synthesizeWithBulbul(args: { text: string; languageCode: string }) {
  return provider().synthesize(args);
}
