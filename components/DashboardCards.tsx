import { Activity, AlertCircle, Clock3, Repeat2 } from "lucide-react";

export default function DashboardCards({ data }: { data: any }) {
  const current = data.incident_count_current_period || 0;
  const previous = data.incident_count_previous_period || 0;
  const trend = previous ? Math.round(((current - previous) / previous) * 100) : 0;
  const cards = [
    { label: "Open incidents", value: data.open_incidents?.length || 0, note: "Needs attention", icon: AlertCircle },
    { label: "Incidents · 30 days", value: current, note: `${trend >= 0 ? "+" : ""}${trend}% vs prior`, icon: Activity },
    { label: "Repeat patterns", value: data.repeat_failures?.length || 0, note: "Machine + category", icon: Repeat2 },
    { label: "Downtime leader", value: data.downtime_by_machine?.[0]?.downtime_minutes || 0, note: `${data.downtime_by_machine?.[0]?.machine_id || "—"} minutes`, icon: Clock3 },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ label, value, note, icon: Icon }) => (
        <article className="card p-5" key={label}>
          <Icon className="h-5 w-5 text-moss" />
          <p className="mt-5 text-sm font-semibold text-slate-500">{label}</p>
          <p className="mt-1 text-4xl font-black">{value}</p>
          <p className="mt-2 text-xs text-slate-500">{note}</p>
        </article>
      ))}
    </div>
  );
}
