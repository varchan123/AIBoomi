"use client";

import Link from "next/link";
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Mic, Pencil, Search, Square } from "lucide-react";
import IncidentAgent from "@/components/IncidentAgent";
import PlantQA from "@/components/PlantQA";
import TriageResult from "@/components/TriageResult";
import { safeResponseError } from "@/lib/frontendErrors";
import { speechLanguageOptions } from "@/lib/speech";

const demoReport = "R-101 la temperature increase aagudhu. Cooling-water flow low. Valve check panniten, but response illa.";
const languages = speechLanguageOptions;

async function jsonPost(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await safeResponseError(response));
  return response.json();
}

export default function WorkerPage() {
  const [machines, setMachines] = useState<any[]>([]);
  const [machineId, setMachineId] = useState("R-101");
  const [languageCode, setLanguageCode] = useState("ta-IN");
  const [report, setReport] = useState(demoReport);
  const [triageResult, setTriageResult] = useState<any>(null);
  const [proposal, setProposal] = useState<any>(null);
  const [submittedReport, setSubmittedReport] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    fetch("/api/machines", { cache: "no-store" }).then((response) => response.ok ? response.json() : [])
      .then((items) => {
        setMachines(items);
        if (items.length && !items.some((item: any) => item.machine_id === machineId)) setMachineId(items[0].machine_id);
      }).catch(() => setMachines([]));
  }, []);

  async function transcribe(blob: Blob) {
    setTranscribing(true); setError("");
    try {
      const form = new FormData();
      form.append("audio", new File([blob], "operator-report.webm", { type: blob.type || "audio/webm" }));
      const response = await fetch("/api/speech/transcribe", { method: "POST", body: form });
      if (!response.ok) throw new Error(await safeResponseError(response));
      const result = await response.json();
      setReport(result.transcript);
      if (languages.some(([code]) => code === result.languageCode)) setLanguageCode(result.languageCode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Transcription could not be completed.");
    } finally { setTranscribing(false); }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        void transcribe(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      };
      recorderRef.current = recorder;
      recorder.start(); setRecording(true); setError("");
    } catch { setError("Audio recording is unavailable in this browser."); }
  }

  async function investigate(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError(""); setTriageResult(null); setProposal(null);
    const inputReport = report.trim();
    const [triage, agent] = await Promise.allSettled([
      jsonPost("/api/triage", { query: inputReport, machine_id: machineId }),
      jsonPost("/api/agent/investigate", { report: inputReport, selected_machine_id: machineId, language_code: languageCode }),
    ]);
    if (triage.status === "fulfilled") setTriageResult(triage.value);
    if (agent.status === "fulfilled") setProposal(agent.value);
    if (triage.status === "rejected" || agent.status === "rejected") {
      const messages = [triage, agent].filter((item) => item.status === "rejected")
        .map((item: any) => item.reason instanceof Error ? item.reason.message : "Investigation could not be completed.");
      setError([...new Set(messages)].join(" "));
    }
    if (triage.status === "fulfilled" || agent.status === "fulfilled") setSubmittedReport(inputReport);
    setLoading(false);
  }

  function editInvestigation() {
    setSubmittedReport(""); setTriageResult(null); setProposal(null); setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const machine = machines.find((item) => item.machine_id === machineId) || { machine_id: machineId, machine_name: machineId };

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] px-4 py-6 sm:px-7 lg:px-10">
      <header className="mb-7 flex items-center justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-moss">ChemieGenie · Worker console</p>
          <h1 className="mt-1 text-3xl font-black">Incident investigation</h1></div>
        <Link href="/" className="flex items-center gap-2 text-sm font-bold"><ArrowLeft className="h-4 w-4" /> Roles</Link>
      </header>

      {!submittedReport ? <form onSubmit={investigate} className="card mx-auto max-w-4xl p-6 sm:p-8">
        <div className="flex items-start gap-3"><span className="rounded-2xl bg-mint p-3 text-moss"><Search /></span>
          <div><h2 className="text-xl font-black">Describe the incident once</h2><p className="mt-1 text-sm text-slate-500">ChemieGenie will investigate plant memory and prepare an approval-gated escalation.</p></div></div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <label><span className="label">Machine</span><select className="input" value={machineId} onChange={(event) => setMachineId(event.target.value)}>
            {machines.map((item) => <option key={item.machine_id} value={item.machine_id}>{item.machine_id} — {item.machine_name}</option>)}
            {!machines.length && <option value="R-101">R-101 — Reactor</option>}
          </select></label>
          <label><span className="label">Spoken-response language</span><select className="input" value={languageCode} onChange={(event) => setLanguageCode(event.target.value)}>
            {languages.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select></label>
        </div>
        <label className="mt-5 block"><span className="label">Operator report</span>
          <textarea className="input min-h-36 resize-y" value={report} onChange={(event) => setReport(event.target.value)} required /></label>
        <div className="mt-4 flex flex-wrap gap-3">
          {recording ? <button type="button" className="button bg-rose-700" onClick={() => recorderRef.current?.stop()}><Square className="h-4 w-4" /> Stop and transcribe</button>
            : <button type="button" className="button bg-slate-700" onClick={startRecording} disabled={loading || transcribing}><Mic className="h-4 w-4" /> Record report</button>}
          <button className="button" disabled={loading || transcribing || report.trim().length < 8}>
            {(loading || transcribing) && <Loader2 className="h-4 w-4 animate-spin" />}
            {transcribing ? "Transcribing…" : loading ? "Investigating…" : "Investigate incident"}
          </button>
        </div>
        {error && <p className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      </form> : <>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 p-4">
          <div className="min-w-0"><p className="label">Submitted operator report · {machine.machine_id}</p><p className="max-w-5xl text-sm leading-6 text-slate-700">{submittedReport}</p></div>
          <button type="button" className="button shrink-0 bg-slate-700 px-4 py-2 text-sm" onClick={editInvestigation}><Pencil className="h-4 w-4" /> Edit / New investigation</button>
        </div>
        {error && <p className="mb-5 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="min-w-0">
            {triageResult || proposal ? <TriageResult result={triageResult} proposal={proposal} machine={machine} report={submittedReport} />
              : <div className="card h-96 animate-pulse bg-white/70" aria-label="Loading investigation" />}
          </div>
          <div className="min-w-0 lg:sticky lg:top-6 lg:self-start">
            <IncidentAgent proposal={proposal} report={submittedReport} machine={machine} languageCode={languageCode}
              likelyCause={triageResult?.likely_fault} onCancel={editInvestigation} />
          </div>
        </div>
      </>}
      <PlantQA />
    </main>
  );
}
