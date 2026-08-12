"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, FileCheck2, Loader2, Mic, Play, Send, ShieldCheck, X } from "lucide-react";
import { fetchAgentActivity, mergeActivityEvents, type AgentActivityResponse } from "@/lib/agentActivityTypes";
import { safeResponseError } from "@/lib/frontendErrors";
import { buildIncidentSpeechText, mapUiLanguageToBulbul } from "@/lib/speech";

type Props = {
  proposal: any;
  report: string;
  machine: any;
  languageCode: string;
  likelyCause?: string;
  onCancel: () => void;
};

export function deliveryLabel(status?: string | null) {
  switch (status?.toLowerCase()) {
    case "queued": return "Submitted to WhatsApp";
    case "sent": return "Sent";
    case "delivered": return "Delivered";
    case "read": return "Read";
    case "failed": case "undelivered": return "Delivery failed";
    default: return "Awaiting delivery confirmation";
  }
}

export function workflowLabel(status?: string | null) {
  switch (status?.toLowerCase()) {
    case "assigned": return "Awaiting technician response";
    case "accepted": return "Accepted";
    case "in progress": return "In progress";
    case "needs help": return "Needs help";
    case "resolved - awaiting verification": return "Resolved — awaiting human verification";
    case "closed": case "resolved": return "Closed — human verified";
    default: return status || "Awaiting technician response";
  }
}

export function conversationLabel(status?: string | null) {
  return status === "closed" ? "Closed" : "Open";
}

export function latestInboundEvent(activity?: AgentActivityResponse | null) {
  return [...(activity?.events || [])].reverse().find((event) => event.direction === "inbound");
}

export function canSubmitClosure(note: string, confirmed: boolean) {
  return confirmed && note.trim().length >= 3;
}

async function ttsCacheKey(text: string, languageCode: string) {
  const source = new TextEncoder().encode(`bulbul:v3|shubh|${languageCode}|${text.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function IncidentAgent({ proposal, report, machine, languageCode, likelyCause, onCancel }: Props) {
  const [executing, setExecuting] = useState(false);
  const [completed, setCompleted] = useState<any>(null);
  const [error, setError] = useState("");
  const [trackedWorkOrderId, setTrackedWorkOrderId] = useState<string | null>(null);
  const [activity, setActivity] = useState<AgentActivityResponse | null>(null);
  const [activityError, setActivityError] = useState("");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closureNote, setClosureNote] = useState("");
  const [closureConfirmed, setClosureConfirmed] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (disposed || inFlight || document.hidden) return;
      inFlight = true; controller = new AbortController();
      try {
        const next = await fetchAgentActivity(trackedWorkOrderId, fetch, controller.signal);
        if (disposed) return;
        setActivity((previous) => ({ ...next, events: mergeActivityEvents(
          previous?.work_order_id === next.work_order_id ? previous.events : [], next.events,
        ) }));
        setActivityError("");
        if (!trackedWorkOrderId && next.work_order_id) setTrackedWorkOrderId(next.work_order_id);
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setActivityError("Live activity is temporarily unavailable. It will retry automatically.");
        }
      } finally { inFlight = false; }
    };
    const start = () => {
      if (timer || document.hidden) return;
      void poll(); timer = setInterval(() => void poll(), 4_000);
    };
    const pause = () => { if (timer) clearInterval(timer); timer = undefined; controller?.abort(); };
    const visibilityChanged = () => document.hidden ? pause() : start();
    document.addEventListener("visibilitychange", visibilityChanged); start();
    return () => { disposed = true; pause(); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [trackedWorkOrderId]);

  const messageAction = proposal?.proposed_actions?.find((action: any) => action.type === "send_whatsapp_escalation");
  const workOrderAction = proposal?.proposed_actions?.find((action: any) => action.type === "create_maintenance_work_order");
  const incidentAction = proposal?.proposed_actions?.find((action: any) => action.type === "create_open_incident");
  const latestInbound = useMemo(() => latestInboundEvent(activity), [activity]);

  async function approve() {
    if (!proposal?.approval_token || executing) return;
    setExecuting(true); setError("");
    try {
      const response = await fetch("/api/agent/execute", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: proposal.run_id, approval_token: proposal.approval_token,
          proposed_actions: proposal.proposed_actions }),
      });
      if (!response.ok) throw new Error(await safeResponseError(response, proposal.run_id));
      const result = await response.json();
      setCompleted(result); setTrackedWorkOrderId(result.work_order_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The escalation could not be submitted.");
    } finally { setExecuting(false); }
  }

  async function playResponse() {
    try {
      const text = buildIncidentSpeechText({
        summary: proposal?.spoken_response || proposal?.summary,
        likelyCause,
        recommendedAction: workOrderAction?.arguments?.requested_action,
      });
      const speechLanguageCode = mapUiLanguageToBulbul(languageCode);
      const key = await ttsCacheKey(text, speechLanguageCode);
      const cacheRequest = new Request(`${location.origin}/__chemiegenie_tts_cache/${key}`);
      const cache = "caches" in window ? await caches.open("chemiegenie-bulbul-v3") : null;
      let audioResponse = cache ? await cache.match(cacheRequest) : undefined;
      if (!audioResponse) {
        const response = await fetch("/api/speech/synthesize", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, language_code: speechLanguageCode }),
        });
        if (!response.ok) throw new Error(await safeResponseError(response, proposal?.run_id));
        audioResponse = response;
        if (cache) await cache.put(cacheRequest, response.clone());
      }
      const url = URL.createObjectURL(await audioResponse.blob());
      const audio = new Audio(url);
      audio.onended = audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch { setError("The spoken response could not be played."); }
  }

  async function closeRequest() {
    if (!activity?.work_order_id || !canSubmitClosure(closureNote, closureConfirmed) || closing) return;
    setClosing(true); setError("");
    try {
      const response = await fetch("/api/agent/close", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_order_id: activity.work_order_id, closure_note: closureNote.trim() }),
      });
      if (!response.ok) throw new Error(await safeResponseError(response, proposal?.run_id));
      const closed = await response.json();
      setActivity((current) => current ? {
        ...current,
        workflow_status: closed.work_order_status,
        conversation_status: closed.conversation_status,
        closure_note: closed.closure_note,
        closed_at: closed.closed_at,
      } : current);
      const refreshed = await fetchAgentActivity(activity.work_order_id, fetch);
      setActivity((current) => ({ ...refreshed, events: mergeActivityEvents(current?.events || [], refreshed.events) }));
      setCloseDialogOpen(false); setClosureConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be closed. Please refresh and try again.");
    } finally { setClosing(false); }
  }

  return (
    <aside className="space-y-5" aria-label="Escalation and WhatsApp activity">
      {!proposal ? <section className="card border-dashed p-6 text-center">
        <ShieldCheck className="mx-auto h-8 w-8 text-slate-400" />
        <h2 className="mt-3 font-black">Evidence-grounded escalation</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">Investigate the incident first to prepare an evidence-grounded escalation.</p>
        <button className="button mt-4 w-full" disabled>Approve and escalate</button>
      </section> : <section className="card overflow-hidden border-2 border-amber-200">
        <div className="bg-amber-50 p-5">
          <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-amber-800" /><h2 className="font-black">Escalation proposal</h2></div>
          <p className="mt-2 text-xs leading-5 text-amber-900">Human approval creates the incident and work order, then submits this exact message. Nothing is written or sent before approval.</p>
        </div>
        <div className="space-y-4 p-5 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div><p className="label">Recipient</p><p className="font-bold">{proposal.recipient?.role || "Not resolved"}</p><p className="text-xs text-slate-500">{proposal.recipient?.display}</p></div>
            <div><p className="label">Priority</p><p className="font-bold">{incidentAction?.arguments?.severity || "Review"}</p></div>
            <div><p className="label">Incident ID</p><p className="break-all font-mono text-xs">{completed?.incident_id || incidentAction?.arguments?.incident_id || "Generated after investigation"}</p></div>
            <div><p className="label">Work-order ID</p><p className="break-all font-mono text-xs">{completed?.work_order_id || workOrderAction?.arguments?.work_order_id || "Generated after investigation"}</p></div>
          </div>
          <div><p className="label">Requested maintenance check</p><p className="leading-6">{workOrderAction?.arguments?.requested_action || "No escalation recommended"}</p></div>
          <div><p className="label">Evidence included</p><p>{proposal.citations?.map((item: any) => item.source_id).join(", ") || "No strong historical match"}</p></div>
          {messageAction && <details className="rounded-xl border border-slate-200"><summary className="cursor-pointer p-3 font-bold">WhatsApp preview</summary>
            <pre className="whitespace-pre-wrap border-t border-slate-100 p-3 text-xs leading-5">{messageAction.arguments.message_body}</pre></details>}
          {!completed && proposal.requires_approval && <div className="flex gap-2">
            <button type="button" className="button flex-1" onClick={approve} disabled={executing}>
              {executing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{executing ? "Submitting…" : "Approve and escalate"}
            </button>
            <button type="button" aria-label="Cancel escalation" className="button bg-slate-600 px-4" onClick={onCancel} disabled={executing}><X className="h-4 w-4" /></button>
          </div>}
          {proposal.spoken_response && <button type="button" className="button w-full bg-indigo-700" onClick={playResponse}><Play className="h-4 w-4" /> Play response</button>}
          {completed && <div className="rounded-xl bg-emerald-50 p-4 text-emerald-900"><p className="flex items-center gap-2 font-black"><CheckCircle2 className="h-5 w-5" /> WhatsApp escalation submitted.</p></div>}
          {error && <div className="rounded-xl bg-rose-50 p-3 text-rose-800"><p>{error}</p></div>}
        </div>
      </section>}

      {activity?.work_order_id && <section className="card p-5" aria-live="polite">
        <div className="flex items-center justify-between gap-3"><div><p className="label">Live · updates every 4 seconds</p><h2 className="font-black">Technician response</h2></div>
          <span className="break-all rounded-full bg-slate-100 px-3 py-1 font-mono text-[10px] font-bold">{activity.work_order_id}</span></div>

        {latestInbound ? <div className="mt-4 rounded-2xl border-2 border-moss/30 bg-mint/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-black text-moss">Latest technician update</p>
            {latestInbound.is_voice_note && <span className="flex items-center gap-1 rounded-full bg-white px-2 py-1 text-xs font-bold"><Mic className="h-3 w-3" /> Voice note transcript</span>}</div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{latestInbound.message || "No transcript was recorded."}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-white px-2 py-1 font-bold">{workflowLabel(latestInbound.interpreted_status)}</span>
            <time className="px-2 py-1" dateTime={latestInbound.timestamp}>{new Date(latestInbound.timestamp).toLocaleString()}</time></div>
          {(latestInbound.root_cause_claim || latestInbound.fix_claim) && <div className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
            <p className="flex items-center gap-1 font-black"><AlertTriangle className="h-4 w-4" /> Unverified technician claim</p>
            {latestInbound.root_cause_claim && <p className="mt-1"><strong>Possible cause:</strong> {latestInbound.root_cause_claim}</p>}
            {latestInbound.fix_claim && <p className="mt-1"><strong>Reported fix:</strong> {latestInbound.fix_claim}</p>}
          </div>}
          {latestInbound.interpreted_status === "Resolved - Awaiting Verification" && <p className="mt-3 rounded-xl bg-amber-100 p-2 text-center text-xs font-black text-amber-900">Awaiting human verification</p>}
        </div> : <div className="mt-4 rounded-xl bg-slate-50 p-4 text-sm text-slate-500"><Clock3 className="mb-2 h-5 w-5" /> Awaiting the technician’s first response.</div>}

        <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <div className="rounded-xl border p-3"><p className="label">WhatsApp delivery</p><p className="text-sm font-black">{deliveryLabel(activity.delivery_status || completed?.message?.delivery_status)}</p></div>
          <div className="rounded-xl border p-3"><p className="label">Work-order status</p><p className="text-sm font-black">{workflowLabel(activity.workflow_status)}</p></div>
          <div className="rounded-xl border p-3"><p className="label">Conversation</p><p className="text-sm font-black">{conversationLabel(activity.conversation_status)}</p></div>
        </div>

        <h3 className="mt-5 text-sm font-black">Conversation timeline</h3>
        <div className="mt-3 max-h-[30rem] space-y-3 overflow-y-auto pr-1">
          {activity.events.map((event) => <div key={event.message_id} className={`flex ${event.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm ${event.direction === "outbound" ? "bg-ink text-white" : "border bg-slate-50"}`}>
              <p className="text-[10px] font-bold uppercase tracking-wide opacity-70">{event.direction} · {event.masked_party}</p>
              <p className="mt-1 whitespace-pre-wrap leading-5">{event.message || "No message text recorded"}</p>
              <p className="mt-2 text-[11px] opacity-70">{event.delivery_status ? deliveryLabel(event.delivery_status) : event.interpreted_status ? workflowLabel(event.interpreted_status) : "Recorded"} · {new Date(event.timestamp).toLocaleString()}</p>
            </div>
          </div>)}
        </div>
        {activity.conversation_status !== "closed" ? <button type="button" onClick={() => setCloseDialogOpen(true)}
          className="button mt-5 w-full bg-indigo-800"><FileCheck2 className="h-5 w-5" /> Verify &amp; close request</button>
          : <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
            <p className="flex items-center gap-2 font-black"><CheckCircle2 className="h-5 w-5" /> Request closed after human verification.</p>
            {activity.closure_note && <p className="mt-2 text-sm"><strong>Closure note:</strong> {activity.closure_note}</p>}
            {activity.closed_at && <time className="mt-1 block text-xs" dateTime={activity.closed_at}>{new Date(activity.closed_at).toLocaleString()}</time>}
          </div>}
        {activityError && <p className="mt-3 text-xs text-amber-800">{activityError}</p>}
      </section>}

      {closeDialogOpen && activity?.work_order_id && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/55 p-4" onMouseDown={(event) => {
        if (event.currentTarget === event.target && !closing) setCloseDialogOpen(false);
      }}>
        <section role="alertdialog" aria-modal="true" aria-labelledby="close-request-title" className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
          <div className="flex items-start justify-between gap-4"><div><p className="label">Human lifecycle action</p><h2 id="close-request-title" className="text-xl font-black">Verify &amp; close request</h2></div>
            <button type="button" aria-label="Cancel closure" className="rounded-full bg-slate-100 p-2" onClick={() => setCloseDialogOpen(false)} disabled={closing}><X className="h-4 w-4" /></button></div>
          <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm"><p><strong>Work order:</strong> {activity.work_order_id}</p>
            <p className="mt-2"><strong>Latest technician status:</strong> {workflowLabel(latestInbound?.interpreted_status || activity.workflow_status)}</p>
            <p className="mt-2"><strong>Latest update:</strong> {latestInbound?.message || "No technician update recorded."}</p></div>
          <label className="mt-5 block"><span className="label">Required closure note</span><textarea className="input min-h-28" value={closureNote} onChange={(event) => setClosureNote(event.target.value)} maxLength={1000} required /></label>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm"><input type="checkbox" className="mt-1 h-4 w-4" checked={closureConfirmed} onChange={(event) => setClosureConfirmed(event.target.checked)} />
            <span>I confirm that the maintenance outcome has been reviewed.</span></label>
          <div className="mt-5 flex flex-wrap justify-end gap-3"><button type="button" className="button bg-slate-600" onClick={() => setCloseDialogOpen(false)} disabled={closing}>Cancel</button>
            <button type="button" className="button bg-indigo-800" onClick={closeRequest} disabled={closing || !canSubmitClosure(closureNote, closureConfirmed)}>
              {closing && <Loader2 className="h-4 w-4 animate-spin" />} Verify and close</button></div>
        </section>
      </div>}
    </aside>
  );
}
