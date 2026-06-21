import { X } from "lucide-react";

export default function IncidentDetailPanel({ incident, onClose }: { incident: any; onClose: () => void }) {
  if (!incident) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/35" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto bg-white p-7 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="float-right rounded-full bg-slate-100 p-2"><X /></button>
        <p className="text-xs font-bold uppercase tracking-widest text-moss">Incident detail</p>
        <h2 className="mt-2 text-3xl font-black">{incident.incident_id}</h2>
        <p className="mt-2 text-slate-500">{incident.machine_name} · {new Date(incident.start_time).toLocaleString()}</p>
        <div className="mt-8 space-y-5">
          {[
            ["Operator report", incident.operator_description],
            ["RCA category", incident.rca_category],
            ["Confirmed root cause", incident.confirmed_root_cause],
            ["Corrective action", incident.fix_applied],
            ["Preventive action", incident.preventive_action],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-slate-50 p-5">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</p>
              <p className="mt-2 leading-7">{value || "Not recorded"}</p>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
