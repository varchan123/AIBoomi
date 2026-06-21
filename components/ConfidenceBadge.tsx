export default function ConfidenceBadge({ confidence }: { confidence: string }) {
  const tone = confidence === "high"
    ? "bg-emerald-100 text-emerald-800"
    : confidence === "medium"
      ? "bg-amber-100 text-amber-800"
      : "bg-rose-100 text-rose-800";
  return <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${tone}`}>{confidence} confidence</span>;
}
