"use client";

import React, { FormEvent, useEffect, useRef, useState } from "react";
import { Bot, ChevronRight, Loader2, RotateCcw, Send, X } from "lucide-react";
import CitationList from "./CitationList";
import ConfidenceBadge from "./ConfidenceBadge";
import { safeResponseError } from "@/lib/frontendErrors";

type ChatMessage = { id: number; role: "user" | "assistant"; text: string; result?: any };

export function appendChatMessage(messages: ChatMessage[], message: ChatMessage) {
  return [...messages, message];
}

export default function PlantQA() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); return; }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const controls = [...drawerRef.current.querySelectorAll<HTMLElement>("button, input, [href], [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.hasAttribute("disabled"));
      if (!controls.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [open]);

  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function sendQuestion(text: string) {
    const clean = text.trim();
    if (!clean || loading) return;
    const id = Date.now();
    setMessages((current) => appendChatMessage(current, { id, role: "user", text: clean }));
    setQuestion(""); setLastQuestion(clean); setLoading(true); setError("");
    try {
      const response = await fetch("/api/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: clean }),
      });
      if (!response.ok) throw new Error(await safeResponseError(response));
      const result = await response.json();
      setMessages((current) => appendChatMessage(current, { id: id + 1, role: "assistant", text: result.answer, result }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ChemieGenie could not answer that question.");
    } finally { setLoading(false); }
  }

  function ask(event: FormEvent) {
    event.preventDefault(); void sendQuestion(question);
  }

  return <>
    <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-ink px-5 py-3 font-bold text-white shadow-2xl transition hover:bg-moss focus:outline-none focus:ring-4 focus:ring-moss/30">
      <Bot className="h-5 w-5" /> Ask ChemieGenie
    </button>
    {open && <>
      <button type="button" aria-label="Close Ask ChemieGenie" onClick={close} className="fixed inset-0 z-40 bg-ink/30 lg:bg-transparent" />
      <section ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="qa-drawer-title"
        className="fixed inset-x-2 bottom-2 top-2 z-50 flex flex-col overflow-hidden rounded-3xl bg-white shadow-2xl sm:inset-x-auto sm:right-4 sm:w-[28rem] lg:bottom-4 lg:top-4">
        <header className="flex items-center justify-between border-b bg-ink p-4 text-white">
          <div className="flex items-center gap-3"><Bot /><div><h2 id="qa-drawer-title" className="font-black">Ask ChemieGenie</h2><p className="text-xs text-white/70">OpenAI-powered cited plant copilot</p></div></div>
          <button type="button" onClick={close} aria-label="Close chatbot" className="rounded-full p-2 hover:bg-white/10"><X /></button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {!messages.length && !loading && <div className="mt-10 text-center text-sm text-slate-500"><Bot className="mx-auto mb-3 h-8 w-8 text-moss" /><p className="font-bold text-slate-700">Ask a deeper plant question</p><p className="mt-1">Nothing is sent until you submit a question.</p></div>}
          {messages.map((message) => <article key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[90%] rounded-2xl p-4 text-sm ${message.role === "user" ? "bg-moss text-white" : "bg-slate-100 text-slate-800"}`}>
              <p className="whitespace-pre-wrap leading-6">{message.text}</p>
              {message.result && <div className="mt-3 border-t border-slate-300/60 pt-3">
                <div className="mb-2 flex flex-wrap items-center gap-2"><span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase">{message.result.route}</span>{message.result.confidence && <ConfidenceBadge confidence={message.result.confidence} />}</div>
                {message.result.warning && <p className="text-xs text-amber-800">{message.result.warning}</p>}
                <CitationList citations={message.result.citations || []} />
              </div>}
            </div>
          </article>)}
          {loading && <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Searching plant memory…</div>}
          {error && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800"><p>{error}</p>
            {lastQuestion && <button type="button" onClick={() => void sendQuestion(lastQuestion)} className="mt-2 flex items-center gap-1 font-bold" disabled={loading}><RotateCcw className="h-4 w-4" /> Retry question</button>}</div>}
        </div>
        <form onSubmit={ask} className="border-t bg-white p-4"><label htmlFor="chemiegenie-question" className="sr-only">Question for ChemieGenie</label>
          <div className="flex gap-2"><input ref={inputRef} id="chemiegenie-question" className="input" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask a follow-up question…" required />
            <button type="submit" className="button px-4" aria-label="Send question" disabled={loading || !question.trim()}><Send className="h-5 w-5" /></button></div>
          <button type="button" onClick={close} className="mt-3 flex w-full items-center justify-center gap-1 text-xs font-bold text-slate-500"><ChevronRight className="h-4 w-4" /> Collapse drawer</button>
        </form>
      </section>
    </>}
  </>;
}
