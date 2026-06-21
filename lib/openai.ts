import OpenAI from "openai";

let client: OpenAI | undefined;

export function getOpenAI() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export const chatModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
