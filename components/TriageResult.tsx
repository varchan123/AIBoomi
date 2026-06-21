"use client";

import { useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, FileText, HardHat,
  History, ImageIcon, Search, Settings, TableProperties, X,
} from "lucide-react";
import CitationList from "./CitationList";
import ConfidenceBadge from "./ConfidenceBadge";

function display(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("; ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function parseDataStrings(val: any) {
  if (typeof val === "string" && val.includes("{") && val.includes("}")) {
    try {
      if (val.includes("; {")) {
        return val.split("; ").map((str) => JSON.parse(str.trim()));
      }
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

function displayTableCell(key: string, rawValue: any) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return "—";
  
  if (key === "downtime_minutes") return `${rawValue} min`;

  let value = rawValue;
  if (typeof value === "string") {
    value = parseDataStrings(value);
  }

  if (key === "handled_by") {
    const people = Array.isArray(value) ? value : [value];
    if (!people.length || (typeof people[0] === "string" && people[0] === "—")) return "—";
    return (
      <div className="space-y-2">
        {people.map((p, i) => {
          if (typeof p !== "object") return <div key={i}>{String(p)}</div>;
          return (
            <div key={i} className="rounded bg-slate-50 p-2 text-xs">
              <span className="font-bold">{p.name || p.employee_id}</span><br/>
              <span className="text-slate-500">{p.role || p.involvement || ""}</span>
            </div>
          );
        })}
      </div>
    );
  }

  if (key === "alarm_data") {
    const alarms = Array.isArray(value) ? value : [value];
    if (!alarms.length) return "—";
    return (
      <div className="flex flex-col gap-1">
        {alarms.map((a, i) => {
          if (typeof a !== 'object') return <span key={i}>{String(a)}</span>;
          const isBad = a.severity === 'Critical' || a.severity === 'High';
          return (
            <span key={i} className={`rounded px-2 py-1 text-xs font-semibold ${isBad ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'}`}>
              {a.alarm_id || a.tep_tag}: {a.alarm_type} ({a.severity})
            </span>
          );
        })}
      </div>
    );
  }

  if (key === "process_variables") {
    const vars = Array.isArray(value) ? value : [value];
    if (!vars.length) return "—";
    return (
      <div className="flex flex-col gap-1">
        {vars.map((v, i) => {
          if (typeof v !== 'object') return <span key={i} className="text-xs">{String(v)}</span>;
          return <span key={i} className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800 font-medium">
            {v.tep_tag} ({v.phase}): {v.synthetic_value}
          </span>
        })}
      </div>
    );
  }

  if (key === "spare_parts_used") {
    const parts = Array.isArray(value) ? value : [value];
    if (!parts.length || (parts.length === 1 && parts[0] === 'No part')) return "No part";
    return (
      <div className="flex flex-col gap-1">
        {parts.map((p, i) => {
          if (typeof p !== 'object') return <span key={i} className="text-xs">{String(p)}</span>;
          return <span key={i} className="rounded bg-indigo-50 px-2 py-1 text-xs text-indigo-800 font-medium">
            {p.part_id}: {p.part_name}
          </span>
        })}
      </div>
    );
  }

  if (key === "maintenance_actions") {
    const actions = Array.isArray(value) ? value : [value];
    if (!actions.length) return "—";
    return (
      <div className="space-y-2">
        {actions.map((a, i) => {
          if (typeof a !== 'object') return <span key={i}>{String(a)}</span>;
          return <div key={i}>
            <span className="font-semibold text-xs text-slate-500 uppercase tracking-wider">{a.maintenance_type}</span>
            <p className="mt-1 text-xs">{a.action_taken}</p>
          </div>
        })}
      </div>
    );
  }

  return display(rawValue);
}

function EquipmentModal({ equipment, onClose }: { equipment: any; onClose: () => void }) {
  const [tab, setTab] = useState<"schematic" | "sop" | "overall">("schematic");
  const [schematicMissing, setSchematicMissing] = useState(false);
  const [overallMissing, setOverallMissing] = useState(false);
  const tabs = [
    ["schematic", "Equipment schematic"],
    ["sop", "SOP"],
    ["overall", "Overall process"],
  ] as const;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-ink/55 p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-5xl overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-100 p-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-moss">{equipment.machine_id}</p>
            <h3 className="mt-1 text-2xl font-black">{equipment.machine_name}</h3>
            <p className="mt-1 text-sm text-slate-500">
              Related incidents: {equipment.related_incident_ids?.join(", ") || "—"}
            </p>
          </div>
          <button onClick={onClose} className="rounded-full bg-slate-100 p-2 hover:bg-slate-200" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto border-b border-slate-100 px-6 pt-4">
          {tabs.map(([value, label]) => (
            <button key={value} onClick={() => setTab(value)}
              className={`whitespace-nowrap rounded-t-xl px-4 py-3 text-sm font-bold ${tab === value ? "bg-moss text-white" : "bg-slate-100 text-slate-600"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="max-h-[68vh] overflow-y-auto p-6">
          {tab === "schematic" && (
            schematicMissing
              ? <p className="rounded-2xl bg-slate-50 p-8 text-center text-slate-500">No schematic uploaded for this equipment yet.</p>
              : <img src={equipment.schematic_url} alt={`${equipment.machine_name} schematic`}
                  onError={() => setSchematicMissing(true)} className="mx-auto max-h-[58vh] w-auto rounded-2xl object-contain" />
          )}
          {tab === "sop" && (
            equipment.sop
              ? <div className="space-y-5">
                  <div><p className="label">SOP title</p><h4 className="text-xl font-black">{equipment.sop.title}</h4></div>
                  <p className="whitespace-pre-wrap leading-7 text-slate-700">{equipment.sop.content || "SOP content not found for this equipment."}</p>
                  {!!equipment.sop.steps?.length && <div><p className="label">Steps</p><ol className="list-decimal space-y-2 pl-5">{equipment.sop.steps.map((step: string) => <li key={step}>{step}</li>)}</ol></div>}
                  {!!equipment.sop.safety_notes?.length && <div className="rounded-2xl bg-amber-50 p-4"><p className="label">Safety notes</p>{equipment.sop.safety_notes.map((note: string) => <p key={note}>{note}</p>)}</div>}
                </div>
              : <p className="rounded-2xl bg-slate-50 p-8 text-center text-slate-500">SOP content not found for this equipment.</p>
          )}
          {tab === "overall" && (
            overallMissing
              ? <p className="rounded-2xl bg-slate-50 p-8 text-center text-slate-500">Overall process image not uploaded yet.</p>
              : <img src={equipment.overall_process_url} alt="Overall process"
                  onError={() => setOverallMissing(true)} className="mx-auto max-h-[58vh] w-auto rounded-2xl object-contain" />
          )}
        </div>
      </div>
    </div>
  );
}

const detailColumns = [
  ["rca_id", "RCA ID"],
  ["incident_id", "Incident ID"],
  ["machine_id", "Machine ID"],
  ["machine_name", "Machine name"],
  ["tep_fault_number", "TEP fault"],
  ["problem_statement", "Problem statement"],
  ["root_cause", "Root cause"],
  ["corrective_action", "Corrective action"],
  ["preventive_action", "Preventive action"],
  ["alarm_data", "Alarm data"],
  ["process_variables", "Process variables"],
  ["spare_parts_used", "Spare parts used"],
  ["maintenance_actions", "Maintenance actions"],
  ["downtime_minutes", "Downtime"],
  ["severity", "Severity"],
  ["status", "Status"],
  ["handled_by", "Handled by"],
  ["timestamp", "Timestamp"],
] as const;

export default function TriageResult({ result }: { result: any }) {
  const [equipment, setEquipment] = useState<any>(null);

  return (
    <>
      <section className="card space-y-10 p-6 sm:p-8 min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Likely match</p>
            <h2 className="mt-2 text-3xl font-black">{result.likely_fault}</h2>
            <p className="mt-1 text-slate-600">{result.likely_category}</p>
          </div>
          <ConfidenceBadge confidence={result.confidence} />
        </div>

        <div>
          <p className="label">User issue summary</p>
          <p className="rounded-2xl bg-slate-50 p-5 leading-7 text-slate-700">{result.issue_summary}</p>
          <p className="mt-3 text-sm text-slate-500">{result.confidence_reason}</p>
        </div>

        {result.warning && (
          <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><p>{result.warning}</p>
          </div>
        )}

        <div>
          <h3 className="flex items-center gap-2 text-xl font-black"><CheckCircle2 className="text-moss" /> First checks to perform</h3>
          <div className="mt-4 grid gap-4">
            {(result.first_checks || []).map((item: any, index: number) => (
              <article key={index} className="rounded-2xl border border-slate-200 p-5">
                <p className="font-bold">{index + 1}. {item.check}</p>
                <p className="mt-2 text-sm leading-6 text-slate-600">{item.why}</p>
              </article>
            ))}
          </div>
        </div>

        <div>
          <h3 className="flex items-center gap-2 text-xl font-black"><History className="text-amber" /> What was done last time</h3>
          <div className="mt-4 grid gap-4">
            {(result.what_was_done_last_time || []).map((item: any, index: number) => (
              <article key={index} className="rounded-2xl bg-sand/70 p-5">
                {item.incident_id && <p className="mb-2 text-xs font-bold uppercase tracking-wider text-amber-800">{item.incident_id}</p>}
                <p className="leading-7">{item.summary || item.action || "—"}</p>
              </article>
            ))}
          </div>
        </div>

        <div>
          <h3 className="flex items-center gap-2 text-xl font-black"><Settings className="text-moss" /> Affected equipment and SOPs</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(result.affected_equipment || []).map((item: any) => (
              <article key={item.machine_id} className="rounded-2xl border border-slate-200 p-5">
                <p className="text-xs font-bold uppercase tracking-wider text-moss">{item.machine_id}</p>
                <h4 className="mt-1 text-lg font-black">{item.machine_name}</h4>
                <p className="mt-2 text-xs text-slate-500">Incidents: {item.related_incident_ids?.join(", ") || "—"}</p>
                <button type="button" onClick={() => setEquipment(item)} className="button mt-4 w-full gap-2">
                  <ImageIcon className="h-4 w-4" /> View schematic + SOP
                </button>
              </article>
            ))}
          </div>
        </div>

        <div>
          <h3 className="flex items-center gap-2 text-xl font-black"><Search className="text-moss" /> Similar incidents</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(result.similar_incidents || []).map((incident: any) => (
              <article key={incident.incident_id} className="rounded-2xl bg-slate-100 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-black">{incident.incident_id}</span>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-bold">{incident.status || "—"}</span>
                </div>
                <p className="mt-2 text-sm text-slate-600">{incident.title}</p>
              </article>
            ))}
            {!result.similar_incidents?.length && <p className="text-slate-500">No similar incidents were found.</p>}
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-xl font-black"><TableProperties className="text-moss" /> Incident details table</h3>
          <div className="mt-4 max-w-full overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[2200px] text-left text-sm">
              <thead className="bg-ink text-white">
                <tr>{detailColumns.map(([, label]) => <th key={label} className="px-4 py-3 align-top whitespace-nowrap">{label}</th>)}</tr>
              </thead>
              <tbody>
                {(result.incident_details || []).map((detail: any) => (
                  <tr key={detail.incident_id} className="border-t border-slate-100 align-top">
                    {detailColumns.map(([key]) => (
                      <td key={key} className="min-w-[12rem] px-4 py-4 align-top">
                        {displayTableCell(key, detail[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <details className="rounded-2xl border border-slate-200">
          <summary className="flex cursor-pointer list-none items-center justify-between p-5 font-bold">
            <span className="flex items-center gap-2"><FileText className="h-5 w-5 text-moss" /> View source details</span>
            <ChevronDown className="h-5 w-5" />
          </summary>
          <div className="space-y-4 border-t border-slate-100 p-5">
            <CitationList citations={result.citations} />
            {(result.matched_documents || []).map((document: any) => (
              <article key={document.doc_id} className="rounded-2xl bg-slate-50 p-4">
                <p className="font-bold">{document.source_id} · {document.title || document.doc_type}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{document.text}</p>
              </article>
            ))}
          </div>
        </details>
      </section>

      {equipment && <EquipmentModal equipment={equipment} onClose={() => setEquipment(null)} />}
    </>
  );
}
