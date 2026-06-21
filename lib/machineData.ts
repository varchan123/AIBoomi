import { readFile } from "node:fs/promises";
import path from "node:path";

export const MACHINE_META: Record<string, { name: string }> = {
  "R-101": { name: "Reactor" },
  "E-201": { name: "Condenser" },
  "V-301": { name: "Product Separator" },
  "T-401": { name: "Stripper" },
  "K-501": { name: "Recycle Compressor" },
  "F-101": { name: "A Feed System" },
  "F-102": { name: "D Feed System" },
  "F-103": { name: "E Feed System" },
  "F-104": { name: "A+C Feed System" },
  "CW-101": { name: "Reactor Cooling Water System" },
  "CW-201": { name: "Separator Cooling Water System" },
};

export type NormalizedSop = {
  machine_id: string;
  title: string;
  content: string;
  steps: string[];
  safety_notes: string[];
  raw: Record<string, unknown>;
};

let sopCache: Map<string, NormalizedSop> | null = null;

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeSop(raw: Record<string, unknown>): NormalizedSop | null {
  const machineId = String(raw.machine_id || raw.equipment_id || raw.machine || "").trim();
  if (!machineId) return null;
  const content = String(raw.content || raw.procedure || "").trim();
  return {
    machine_id: machineId,
    title: String(raw.title || raw.name || `SOP for ${machineId}`),
    content,
    steps: stringList(raw.steps),
    safety_notes: stringList(raw.safety_notes),
    raw,
  };
}

async function loadSops() {
  if (sopCache) return sopCache;
  const file = path.join(process.cwd(), "data", "synthetic", "sop_documents.jsonl");
  const text = await readFile(file, "utf8");
  sopCache = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const sop = normalizeSop(JSON.parse(line));
      if (sop) sopCache?.set(sop.machine_id, sop);
    } catch (error) {
      console.error(`Invalid SOP JSONL at line ${index + 1}:`, error);
    }
  });
  return sopCache;
}

export async function getSopForMachine(machineId: string) {
  return (await loadSops()).get(machineId) || null;
}

export function machineAsset(machineId: string) {
  return {
    machine_id: machineId,
    machine_name: MACHINE_META[machineId]?.name || machineId,
    schematic_url: `/machines/${machineId}/schematic.png`,
    overall_process_url: "/machines/overall.png",
  };
}
