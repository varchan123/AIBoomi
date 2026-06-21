"use client";

import { FormEvent, useState } from "react";
import { Bot, Send } from "lucide-react";
import CitationList from "./CitationList";
import ConfidenceBadge from "./ConfidenceBadge";

export default function PlantQA() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function ask(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Question failed");
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Question failed");
    } finally { setLoading(false); }
  }

  return (
    <section className="card p-6">
      <div className="flex items-center gap-3">
        <span className="rounded-2xl bg-mint p-3 text-moss"><Bot /></span>
        <div><h2 className="text-xl font-black">Ask Plant Memory</h2><p className="text-sm text-slate-500">Structured metrics or cited knowledge.</p></div>
      </div>
      <form onSubmit={ask} className="mt-5 flex gap-3">
        <input className="input" value={question} onChange={(e) => setQuestion(e.target.value)}
          placeholder="Which machine has the most repeat failures?" required />
        <button className="button px-4" disabled={loading}><Send className="h-5 w-5" /></button>
      </form>
      {loading && <p className="mt-4 animate-pulse text-sm text-slate-500">Searching plant memory…</p>}
      {error && <p className="mt-4 text-sm text-rose-700">{error}</p>}
      {result && (
        <div className="mt-5 rounded-2xl bg-slate-50 p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white px-3 py-1 text-xs font-bold uppercase">{result.route}</span>
            {result.confidence && <ConfidenceBadge confidence={result.confidence} />}
          </div>
          <p className="leading-7">{result.answer}</p>
          {result.warning && <p className="mt-3 text-sm text-amber-800">{result.warning}</p>}
          <CitationList citations={result.citations} />
        </div>
      )}
    </section>
  );
}
