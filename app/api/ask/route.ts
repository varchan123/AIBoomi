import { NextResponse } from "next/server";
import { normalizeCitations } from "@/lib/citations";
import { chatModel, getOpenAI } from "@/lib/openai";
import { knowledgeSystemPrompt } from "@/lib/prompts";
import { retrieveEvidence } from "@/lib/retrieval";
import { classifyIntent, runStructuredIntent } from "@/lib/sqlIntents";
import { askInput } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { question } = askInput.parse(await request.json());
    const classification = await classifyIntent(question);
    if (classification.intent !== "knowledge_question") {
      const rows = await runStructuredIntent(classification);
      const response = await getOpenAI().chat.completions.create({
        model: chatModel, temperature: 0,
        messages: [
          { role: "system", content: "Summarize the supplied SQL query result briefly. Do not add facts." },
          { role: "user", content: JSON.stringify({ question, intent: classification.intent, rows }) },
        ],
      });
      return NextResponse.json({
        route: "structured", intent: classification.intent,
        answer: response.choices[0].message.content, data: rows, citations: [],
      });
    }

    const retrieval = await retrieveEvidence(question, undefined, 7);
    const evidence = retrieval.documents.map((doc) => ({
      source_id: doc.source_id, source_type: doc.doc_type, title: doc.title,
      machine_id: doc.machine_id, similarity: doc.similarity, text: doc.text, metadata: doc.metadata,
    }));
    const response = await getOpenAI().chat.completions.create({
      model: chatModel, response_format: { type: "json_object" }, temperature: 0.1,
      messages: [
        { role: "system", content: knowledgeSystemPrompt },
        { role: "user", content: JSON.stringify({ question, evidence, retrieval_is_weak: retrieval.weak }) },
      ],
    });
    const result = JSON.parse(response.choices[0].message.content || "{}");
    return NextResponse.json({
      route: "knowledge", intent: "knowledge_question",
      answer: result.answer || "I could not find enough plant evidence to answer that.",
      confidence: retrieval.weak ? "low" : result.confidence || "medium",
      warning: retrieval.weak ? result.warning || "Weak evidence match." : result.warning || null,
      citations: normalizeCitations(result.citations, retrieval.citations),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Question failed" }, { status: 400 });
  }
}
