export type Citation = {
  source_type: string;
  source_id: string;
  title: string;
  machine_id: string | null;
  incident_id: string | null;
  relevance: string;
};

export function citationFromDocument(
  document: Record<string, any>,
  relevance = "Retrieved as supporting plant evidence",
): Citation {
  return {
    source_type: document.doc_type,
    source_id: document.source_id || document.doc_id,
    title: document.title || document.source_id || "Plant record",
    machine_id: document.machine_id || null,
    incident_id: document.metadata?.incident_id || null,
    relevance,
  };
}

export function normalizeCitations(
  raw: unknown,
  available: Citation[],
): Citation[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map(available.map((item) => [item.source_id, item]));
  return raw
    .map((item) => {
      const id = typeof item === "string" ? item : item?.source_id;
      const known = byId.get(id);
      if (!known) return null;
      return { ...known, relevance: item?.relevance || known.relevance };
    })
    .filter(Boolean) as Citation[];
}
