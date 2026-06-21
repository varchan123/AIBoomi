export default function RecentIncidentsTable({ incidents, onSelect }: { incidents: any[]; onSelect: (incident: any) => void }) {
  if (!incidents?.length) return <div className="card p-8 text-center text-slate-500">No incidents found.</div>;
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-ink text-white"><tr>
            {["Incident", "Machine", "Category", "Status", "Downtime"].map((h) => <th className="px-5 py-4" key={h}>{h}</th>)}
          </tr></thead>
          <tbody>
            {incidents.map((incident) => (
              <tr key={incident.incident_id} onClick={() => onSelect(incident)} className="cursor-pointer border-t border-slate-100 hover:bg-mint/40">
                <td className="px-5 py-4 font-bold">{incident.incident_id}<span className="block text-xs font-normal text-slate-400">{new Date(incident.start_time).toLocaleDateString()}</span></td>
                <td className="px-5 py-4">{incident.machine_id}</td>
                <td className="px-5 py-4">{incident.rca_category || "Unclassified"}</td>
                <td className="px-5 py-4"><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold">{incident.status}</span></td>
                <td className="px-5 py-4">{incident.downtime_minutes} min</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
