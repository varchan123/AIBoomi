"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, Loader2, Wrench } from "lucide-react";
import PlantQA from "@/components/PlantQA";
import TriageResult from "@/components/TriageResult";

const demoQuery = "Reactor temperature is rising and cooling water flow seems low";

export default function WorkerPage() {
  const [machines, setMachines] = useState<any[]>([]);
  const [machineId, setMachineId] = useState("CW-101");
  const [query, setQuery] = useState(demoQuery);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetch("/api/machines").then((r) => r.json()).then(setMachines).catch(() => setMachines([])); }, []);

  async function triage(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(""); setResult(null); setCreated(null);
    try {
      const response = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, machine_id: machineId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Triage failed");
      setResult(body);
    } catch (err) { setError(err instanceof Error ? err.message : "Triage failed"); }
    finally { setLoading(false); }
  }

  async function closeOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const response = await fetch("/api/incidents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload, machine_id: machineId,
          rca_category: result?.likely_category,
          tep_fault_number: result?.matched_documents?.find((d: any) => d.tep_fault_number)?.tep_fault_number,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save resolution");
      setCreated(body);
      event.currentTarget.reset();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save resolution"); }
    finally { setSaving(false); }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-5 py-8 sm:px-8">
      <header className="mb-8 flex items-center justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-moss">Worker console</p><h1 className="text-3xl font-black">Breakdown triage</h1></div>
        <Link href="/" className="flex items-center gap-2 text-sm font-bold"><ArrowLeft className="h-4 w-4" /> Roles</Link>
      </header>
      <div className="grid gap-8 lg:grid-cols-[1.45fr_.75fr]">
        <div className="space-y-8 min-w-0">
          <form onSubmit={triage} className="card p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-3"><span className="rounded-2xl bg-mint p-3 text-moss"><Wrench /></span><div><h2 className="text-xl font-black">What&apos;s happening?</h2><p className="text-sm text-slate-500">Describe what you see and hear in plain language.</p></div></div>
            <label className="label">Machine</label>
            <select className="input mb-5" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {machines.map((machine) => <option key={machine.machine_id} value={machine.machine_id}>{machine.machine_id} — {machine.machine_name}</option>)}
              {!machines.length && <option value="CW-101">CW-101 — Reactor Cooling Water System</option>}
            </select>
            <label className="label">Breakdown description</label>
            <textarea className="input min-h-36 resize-y" value={query} onChange={(e) => setQuery(e.target.value)} required />
            <button className="button mt-5 w-full sm:w-auto" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{loading ? "Searching plant memory…" : "Get cited first checks"}
            </button>
            {error && <p className="mt-4 text-sm text-rose-700">{error}</p>}
          </form>
          {result && <TriageResult result={result} />}
          {result && (
            <form onSubmit={closeOut} className="card p-6 sm:p-8">
              <h2 className="text-2xl font-black">Log the final resolution</h2>
              <p className="mt-2 text-sm text-slate-500">This creates a new incident, RCA, and searchable memory record.</p>
              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                {[
                  ["what_actually_happened", "What actually happened"],
                  ["root_cause_confirmed", "Root cause confirmed"],
                  ["fix_applied", "Fix applied"],
                  ["preventive_action", "Preventive action"],
                ].map(([name, label]) => <label key={name}><span className="label">{label}</span><textarea name={name} className="input min-h-24" required /></label>)}
                <label><span className="label">Downtime minutes</span><input name="downtime_minutes" className="input" type="number" min="0" required /></label>
                <label><span className="label">Operator / engineer</span><input name="operator_or_engineer" className="input" required /></label>
                <label><span className="label">Status</span><select name="status" className="input"><option>Resolved</option><option>Monitoring</option><option>Open</option></select></label>
                <label><span className="label">Severity</span><select name="severity" className="input"><option>Medium</option><option>Low</option><option>High</option><option>Critical</option></select></label>
              </div>
              <button className="button mt-6" disabled={saving}>{saving ? "Saving and embedding…" : "Save resolution"}</button>
              {created && <p className="mt-5 rounded-2xl bg-emerald-50 p-4 font-semibold text-emerald-800">Created {created.incident_id} and embedded {created.rca_id}.</p>}
            </form>
          )}
        </div>
        <div className="lg:sticky lg:top-8 lg:self-start"><PlantQA /></div>
      </div>
    </main>
  );
}
