import { z } from "zod";

export const triageInput = z.object({
  query: z.string().trim().min(8).max(2000),
  machine_id: z.string().trim().min(1),
});

export const askInput = z.object({
  question: z.string().trim().min(3).max(2000),
});

export const incidentInput = z.object({
  machine_id: z.string().min(1),
  what_actually_happened: z.string().min(5),
  root_cause_confirmed: z.string().min(3),
  fix_applied: z.string().min(3),
  preventive_action: z.string().min(3),
  downtime_minutes: z.coerce.number().int().min(0),
  operator_or_engineer: z.string().min(2),
  status: z.string().min(2),
  severity: z.string().default("Medium"),
  rca_category: z.string().optional(),
  tep_fault_number: z.coerce.number().int().optional(),
});

export function requireFields(row: Record<string, unknown>, fields: string[]) {
  const missing = fields.filter((field) => row[field] === undefined || row[field] === null || row[field] === "");
  return missing.length ? `missing required fields: ${missing.join(", ")}` : null;
}

export function nullable(value: unknown) {
  return value === "" || value === undefined ? null : value;
}

export function numberOrNull(value: unknown) {
  const n = Number(value);
  return value === "" || value === undefined || Number.isNaN(n) ? null : n;
}
