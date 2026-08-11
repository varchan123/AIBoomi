"use client";

import React, { FormEvent, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Play, Send, ShieldCheck, Square, X } from "lucide-react";
import AgentTrace from "./AgentTrace";
import { fetchAgentActivity, mergeActivityEvents, type AgentActivityResponse } from "@/lib/agentActivityTypes";

type AgentState = "idle" | "recording" | "transcribing" | "investigating" |
  "awaiting_approval" | "executing" | "completed" | "error";

const demoReport = "R-101 la temperature increase aagudhu. Cooling-water flow low. Valve check panniten, but response illa.";
const languages = [
  ["en-IN", "English"], ["ta-IN", "Tamil"], ["hi-IN", "Hindi"], ["te-IN", "Telugu"],
  ["kn-IN", "Kannada"], ["ml-IN", "Malayalam"], ["bn-IN", "Bengali"], ["mr-IN", "Marathi"],
  ["gu-IN", "Gujarati"], ["pa-IN", "Punjabi"], ["od-IN", "Odia"],
];

async function responseError(response: Response) {
  try { return (await response.json()).error || `Request failed (${response.status})`; }
  catch { return `Request failed (${response.status})`; }
}

async function ttsCacheKey(text: string, languageCode: string) {
  const source = new TextEncoder().encode(`bulbul:v3|shubh|${languageCode}|${text.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function IncidentAgent({ machines }: { machines: any[] }) {
  const [state, setState] = useState<AgentState>("idle");
  const [report, setReport] = useState(demoReport);
  const [machineId, setMachineId] = useState("R-101");
  const [languageCode, setLanguageCode] = useState("ta-IN");
  const [proposal, setProposal] = useState<any>(null);
  const [completed, setCompleted] = useState<any>(null);
  const [error, setError] = useState("");
  const [trackedWorkOrderId, setTrackedWorkOrderId] = useState<string | null>(null);
  const [activity, setActivity] = useState<AgentActivityResponse | null>(null);
  const [activityError, setActivityError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const next = await fetchAgentActivity(trackedWorkOrderId, fetch, controller.signal);
        if (disposed) return;
        setActivity((previous) => ({
          ...next,
          events: mergeActivityEvents(
            previous?.work_order_id === next.work_order_id ? previous.events : [],
            next.events,
          ),
        }));
        setActivityError("");
        if (!trackedWorkOrderId && next.work_order_id) setTrackedWorkOrderId(next.work_order_id);
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setActivityError(cause instanceof Error ? cause.message : "Could not refresh WhatsApp activity");
        }
      } finally {
        inFlight = false;
      }
    };

    const start = () => {
      if (timer || document.hidden) return;
      void poll();
      timer = setInterval(() => void poll(), 4_000);
    };
    const pause = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      controller?.abort();
    };
    const visibilityChanged = () => document.hidden ? pause() : start();

    document.addEventListener("visibilitychange", visibilityChanged);
    start();
    return () => {
      disposed = true;
      pause();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [trackedWorkOrderId]);

  async function transcribe(blob: Blob) {
    setState("transcribing"); setError("");
    const form = new FormData();
    form.append("audio", new File([blob], "operator-report.webm", { type: blob.type || "audio/webm" }));
    const response = await fetch("/api/speech/transcribe", { method: "POST", body: form });
    if (!response.ok) throw new Error(await responseError(response));
    const result = await response.json();
    setReport(result.transcript);
    if (languages.some(([code]) => code === result.languageCode)) setLanguageCode(result.languageCode);
    setState("idle");
  }

  async function startRecording() {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("Audio recording is not supported by this browser");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        transcribe(blob).catch((cause) => { setError(cause instanceof Error ? cause.message : "Transcription failed"); setState("error"); });
      };
      recorderRef.current = recorder;
      recorder.start(); setState("recording"); setError("");
      stopTimerRef.current = setTimeout(() => recorder.state === "recording" && recorder.stop(), 25_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start recording"); setState("error");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  async function investigate(event: FormEvent) {
    event.preventDefault(); setState("investigating"); setError(""); setProposal(null); setCompleted(null);
    try {
      const response = await fetch("/api/agent/investigate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report, selected_machine_id: machineId, language_code: languageCode }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json();
      setProposal(result); setState(result.requires_approval ? "awaiting_approval" : "idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investigation failed"); setState("error");
    }
  }

  async function approve() {
    if (!proposal?.approval_token) return;
    setState("executing"); setError("");
    try {
      const response = await fetch("/api/agent/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: proposal.run_id, approval_token: proposal.approval_token,
          proposed_actions: proposal.proposed_actions }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json();
      setCompleted(result);
      setTrackedWorkOrderId(result.work_order_id);
      setState("completed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Escalation failed"); setState("error");
    }
  }

  async function playResponse() {
    const text = String(proposal?.spoken_response || proposal?.summary || "").slice(0, 500);
    if (!text) return;
    try {
      setError("");
      const key = await ttsCacheKey(text, languageCode);
      const cacheRequest = new Request(`${location.origin}/__chemiegenie_tts_cache/${key}`);
      const cache = "caches" in window ? await caches.open("chemiegenie-bulbul-v3") : null;
      let audioResponse = cache ? await cache.match(cacheRequest) : undefined;
      if (!audioResponse) {
        const response = await fetch("/api/speech/synthesize", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, language_code: languageCode }),
        });
        if (!response.ok) throw new Error(await responseError(response));
        audioResponse = response;
        if (cache) await cache.put(cacheRequest, response.clone());
      }
      const url = URL.createObjectURL(await audioResponse.blob());
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not play response");
    }
  }

  const messageAction = proposal?.proposed_actions?.find((action: any) => action.type === "send_whatsapp_escalation");
  const busy = ["recording", "transcribing", "investigating", "executing"].includes(state);

  return (
    <section className="card border-2 border-moss/20 p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-moss">Sarvam-powered action agent</p>
          <h2 className="mt-1 text-2xl font-black">Incident escalation agent</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">Investigates plant evidence, proposes a bounded action, waits for approval, then creates and escalates the work order.</p></div>
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-800">Human approval enforced</span>
      </div>

      <form onSubmit={investigate} className="mt-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label><span className="label">Selected machine</span><select className="input" value={machineId} onChange={(event) => setMachineId(event.target.value)}>
            {machines.map((machine) => <option key={machine.machine_id} value={machine.machine_id}>{machine.machine_id} - {machine.machine_name}</option>)}
            {!machines.length && <option value="R-101">R-101 - Reactor</option>}
          </select></label>
          <label><span className="label">Spoken response language</span><select className="input" value={languageCode} onChange={(event) => setLanguageCode(event.target.value)}>
            {languages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
        </div>
        <label className="mt-4 block"><span className="label">Operator report or transcript</span>
          <textarea className="input min-h-32 resize-y" value={report} onChange={(event) => setReport(event.target.value)} required /></label>
        <div className="mt-4 flex flex-wrap gap-3">
          {state === "recording"
            ? <button type="button" className="button bg-rose-700" onClick={stopRecording}><Square className="h-4 w-4" /> Stop and transcribe</button>
            : <button type="button" className="button bg-slate-700" onClick={startRecording} disabled={busy}><Mic className="h-4 w-4" /> Record report</button>}
          <button className="button" disabled={busy || report.trim().length < 8}>
            {(state === "transcribing" || state === "investigating") && <Loader2 className="h-4 w-4 animate-spin" />}
            {state === "transcribing" ? "Transcribing with Saaras..." : state === "investigating" ? "Agent investigating..." : "Investigate incident"}
          </button>
        </div>
      </form>

      {error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {proposal && <div className="mt-7 space-y-6 border-t border-slate-100 pt-6">
        <div><p className="label">Agent summary</p><p className="leading-7 text-slate-700">{proposal.summary}</p></div>
        {proposal.clarification_question && <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{proposal.clarification_question}</p>}
        <AgentTrace trace={proposal.trace || []} />
        {!!proposal.citations?.length && <div><h3 className="text-lg font-black">Grounding evidence</h3>
          <ul className="mt-3 space-y-2 text-sm">{proposal.citations.map((citation: any) => <li key={citation.source_id} className="rounded-xl border border-slate-200 p-3"><strong>{citation.source_id}</strong> - {citation.title}</li>)}</ul></div>}
        {proposal.requires_approval && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex items-center gap-2"><ShieldCheck className="text-amber-800" /><h3 className="text-lg font-black">Approval required</h3></div>
          <p className="mt-3 text-sm"><strong>Recipient:</strong> {proposal.recipient?.role} ({proposal.recipient?.display})</p>
          <p className="mt-4 text-xs font-bold uppercase tracking-wider text-amber-900">Exact WhatsApp message</p>
          <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-white p-4 text-sm leading-6">{messageAction?.arguments?.message_body}</pre>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="button" onClick={approve} disabled={state === "executing"}>
              {state === "executing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {state === "executing" ? "Creating and sending..." : "Approve and escalate"}
            </button>
            <button type="button" className="button bg-slate-600" onClick={() => { setProposal(null); setState("idle"); }} disabled={state === "executing"}><X className="h-4 w-4" /> Cancel</button>
          </div>
        </div>}
        <button type="button" className="button bg-indigo-700" onClick={playResponse}><Play className="h-4 w-4" /> Play response</button>
      </div>}
      {completed && <div className="mt-6 rounded-2xl bg-emerald-50 p-5 text-emerald-900">
        <p className="font-black">Escalation completed</p>
        <p className="mt-1 text-sm">Created {completed.incident_id} and {completed.work_order_id}. WhatsApp status: {completed.message?.delivery_status || "queued"}.</p>
      </div>}

      <div className="mt-6 border-t border-slate-100 pt-6" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="label">Automatically updating</p>
            <h3 className="text-lg font-black">WhatsApp activity</h3>
          </div>
          {activity?.work_order_id && <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700">
            {activity.work_order_id}
          </span>}
        </div>

        {activity?.work_order_id ? <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">WhatsApp delivery</p>
              <p className="mt-1 font-black capitalize">{activity.delivery_status || completed?.message?.delivery_status || "pending"}</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Work-order status</p>
              <p className="mt-1 font-black">{activity.workflow_status || "Unknown"}</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Conversation</p>
              <p className="mt-1 font-black capitalize">{activity.conversation_status || "Unknown"}</p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {activity.events.map((event) => <div key={event.message_id}
              className={`flex ${event.direction === "outbound" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                event.direction === "outbound" ? "bg-moss text-white" : "border border-slate-200 bg-slate-50 text-slate-800"
              }`}>
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide opacity-80">
                  <span>{event.direction}</span><span>•</span><span>{event.masked_party}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap leading-6">{event.message || "No message text recorded"}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs opacity-80">
                  {event.delivery_status && <span>Delivery: {event.delivery_status}</span>}
                  {event.interpreted_status && <span>Status: {event.interpreted_status}</span>}
                  <time dateTime={event.timestamp}>{event.timestamp.replace("T", " ").replace("Z", " UTC").slice(0, 23)}</time>
                </div>
              </div>
            </div>)}
            {!activity.events.length && <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">No WhatsApp messages recorded yet.</p>}
          </div>
        </> : <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
          No active maintenance-contact conversation to restore.
        </p>}
        {activityError && <p className="mt-3 text-xs text-rose-700">Timeline refresh paused by an error: {activityError}</p>}
      </div>
    </section>
  );
}
