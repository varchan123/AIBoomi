import { getOpenAI } from "./openai";

export async function embedText(input: string) {
  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: input.replace(/\s+/g, " ").trim(),
  });
  return response.data[0].embedding;
}

export async function embedBatch(inputs: string[]) {
  const response = await getOpenAI().embeddings.create({
    model: "text-embedding-3-small",
    input: inputs.map((input) => input.replace(/\s+/g, " ").trim()),
  });
  return response.data.map((item) => item.embedding);
}
