import { CheckCircle2, CircleAlert } from "lucide-react";

export default function AgentTrace({ trace }: { trace: Array<{ tool: string; label: string; status: string; summary: string }> }) {
  if (!trace.length) return null;
  return (
    <div>
      <h3 className="text-lg font-black">Agent action trace</h3>
      <ol className="mt-3 space-y-2">
        {trace.map((event, index) => (
          <li key={`${event.tool}-${index}`} className="flex gap-3 rounded-xl bg-slate-50 p-3 text-sm">
            {event.status === "completed"
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-moss" />
              : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />}
            <span><strong>{event.label}:</strong> {event.summary}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

