"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import DashboardCards from "@/components/DashboardCards";
import IncidentDetailPanel from "@/components/IncidentDetailPanel";
import PlantQA from "@/components/PlantQA";
import RecentIncidentsTable from "@/components/RecentIncidentsTable";

export default function ManagerPage() {
  const [data, setData] = useState<any>(null);
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/dashboard").then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setData(body);
    }).catch((err) => setError(err.message));
  }, []);

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-5 py-8 sm:px-8">
      <header className="mb-8 flex items-center justify-between">
        <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-moss">ChemieGenie · Reliability view</p><h1 className="text-3xl font-black">Plant health dashboard</h1></div>
        <Link href="/" className="flex items-center gap-2 text-sm font-bold"><ArrowLeft className="h-4 w-4" /> Roles</Link>
      </header>
      {!data && !error && <div className="card flex items-center justify-center gap-3 p-16 text-slate-500"><Loader2 className="animate-spin" /> Loading SQL metrics…</div>}
      {error && <div className="card p-8 text-rose-700">{error}</div>}
      {data && (
        <div className="space-y-8">
          <DashboardCards data={data} />
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card p-6">
              <h2 className="text-xl font-black">Top problem machines</h2>
              <div className="mt-6 space-y-4">
                {data.top_problem_machines.map((row: any) => {
                  const max = data.top_problem_machines[0]?.incident_count || 1;
                  return <div key={row.machine_id}><div className="mb-2 flex justify-between text-sm"><span className="font-bold">{row.machine_id}</span><span>{row.incident_count} incidents</span></div><div className="h-3 rounded-full bg-slate-100"><div className="h-3 rounded-full bg-moss" style={{ width: `${(row.incident_count / max) * 100}%` }} /></div></div>;
                })}
              </div>
            </section>
            <section className="card p-6">
              <h2 className="text-xl font-black">Downtime by machine</h2>
              <div className="mt-6 space-y-4">
                {data.downtime_by_machine.map((row: any) => {
                  const max = data.downtime_by_machine[0]?.downtime_minutes || 1;
                  return <div key={row.machine_id}><div className="mb-2 flex justify-between text-sm"><span className="font-bold">{row.machine_id}</span><span>{row.downtime_minutes} min</span></div><div className="h-3 rounded-full bg-slate-100"><div className="h-3 rounded-full bg-amber" style={{ width: `${(row.downtime_minutes / max) * 100}%` }} /></div></div>;
                })}
              </div>
            </section>
          </div>
          <section>
            <div className="mb-4"><h2 className="text-2xl font-black">Recent incidents</h2><p className="text-sm text-slate-500">Select a row for RCA and corrective-action detail.</p></div>
            <RecentIncidentsTable incidents={data.recent_incidents} onSelect={setSelected} />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card p-6">
              <h2 className="text-xl font-black">Repeat failures</h2>
              <div className="mt-4 space-y-3">
                {data.repeat_failures.slice(0, 8).map((row: any) => <div key={`${row.machine_id}-${row.rca_category}`} className="rounded-2xl bg-slate-50 p-4"><div className="flex justify-between gap-4"><span className="font-bold">{row.machine_id}</span><span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-bold text-rose-800">{row.incident_count} repeats</span></div><p className="mt-2 text-sm text-slate-500">{row.rca_category}</p></div>)}
                {!data.repeat_failures.length && <p className="text-slate-500">No repeat patterns in this period.</p>}
              </div>
            </section>
            <PlantQA />
          </div>
        </div>
      )}
      <IncidentDetailPanel incident={selected} onClose={() => setSelected(null)} />
    </main>
  );
}
