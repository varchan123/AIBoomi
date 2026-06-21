import type { Citation } from "@/lib/citations";

export default function CitationList({ citations = [] }: { citations?: Citation[] }) {
  if (!citations.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {citations.map((citation) => (
        <div key={`${citation.source_type}-${citation.source_id}`} className="rounded-xl border border-moss/15 bg-mint/50 px-3 py-2 text-xs">
          <span className="font-bold text-moss">{citation.source_id}</span>
          <span className="mx-1 text-slate-400">·</span>
          <span>{citation.title}</span>
          <p className="mt-1 text-slate-500">{citation.relevance}</p>
        </div>
      ))}
    </div>
  );
}
