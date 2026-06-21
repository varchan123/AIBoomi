import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { parse } from "csv-parse";
import { getSupabaseAdmin } from "../lib/supabase";
import { nullable, numberOrNull, requireFields } from "../lib/validation";

const root = process.cwd();
const rejected: string[] = [];

function reject(source: string, row: number, reason: string) {
  const message = `[skip] ${source}:${row} ${reason}`;
  rejected.push(message);
  console.error(message);
}

async function csv(file: string) {
  const content = await readFile(path.join(root, file), "utf8");

  return new Promise<Record<string, string>[]>((resolve, rejectParse) => {
    parse(
      content,
      { columns: true, skip_empty_lines: true, trim: true },
      (error, rows) => (error ? rejectParse(error) : resolve(rows))
    );
  });
}

async function jsonl(file: string) {
  const rows: Record<string, unknown>[] = [];
  const stream = createReadStream(path.join(root, file), "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber++;

    if (!line.trim()) continue;

    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      reject(file, lineNumber, `invalid JSON: ${(error as Error).message}`);
    }
  }

  return rows;
}

async function main() {
  const db = getSupabaseAdmin();

  async function upsert(
    table: string,
    rows: Record<string, unknown>[],
    onConflict: string
  ) {
    for (let i = 0; i < rows.length; i += 250) {
      const { error } = await db
        .from(table)
        .upsert(rows.slice(i, i + 250), { onConflict });

      if (error) throw new Error(`${table}: ${error.message}`);
    }

    console.log(`${table}: ${rows.length} rows loaded`);
  }

  const machines = await csv("data/synthetic/machines.csv");
  await upsert("machines", machines, "machine_id");

  const machineIds = new Set(machines.map((row) => row.machine_id));

  const employees = await csv("data/synthetic/employees.csv");
  await upsert("employees", employees, "employee_id");

  await upsert(
    "spare_parts",
    (await csv("data/synthetic/spare_parts.csv")).map((r) => ({
      ...r,
      stock_qty: Number(r.stock_qty),
      unit_cost_inr: Number(r.unit_cost_inr),
    })),
    "part_id"
  );

  const dictionaryRows = await csv("data/mappings/tep_fault_dictionary.csv");

  const validDictionaryRows = dictionaryRows.filter((r, index) => {
    if (!machineIds.has(r.default_machine_id)) {
      reject(
        "tep_fault_dictionary.csv",
        index + 2,
        "invalid default_machine_id"
      );
    }

    return machineIds.has(r.default_machine_id);
  });

  const dictionary: Record<string, any>[] = validDictionaryRows.map((r) => ({
    ...r,
    tep_fault_number: Number(r.tep_fault_number),
  }));

  await upsert("tep_fault_dictionary", dictionary, "tep_fault_number");

  const categories = new Map(
    dictionary.map((row) => [Number(row.tep_fault_number), row.rca_category])
  );

  const variableMap = (await csv("data/mappings/tep_variable_map.csv")).filter(
    (row, index) => {
      if (machineIds.has(row.mapped_machine_id)) return true;

      reject(
        "tep_variable_map.csv",
        index + 2,
        `mapped_machine_id "${row.mapped_machine_id}" is not a machine`
      );

      return false;
    }
  );

  await upsert("tep_variable_map", variableMap, "tep_tag");

  const incidents = (await csv("data/synthetic/incidents.csv"))
    .filter((row, index) => {
      const error = requireFields(row, [
        "incident_id",
        "start_time",
        "machine_id",
        "operator_description",
        "status",
      ]);

      if (error || !machineIds.has(row.machine_id)) {
        reject(
          "incidents.csv",
          index + 2,
          error ?? `invalid machine_id "${row.machine_id}"`
        );

        return false;
      }

      return true;
    })
    .map((r) => ({
      ...r,
      tep_fault_number: numberOrNull(r.tep_fault_number),
      downtime_minutes: numberOrNull(r.downtime_minutes),
      operator_id: nullable(r.operator_id),
      engineer_id: nullable(r.engineer_id),
      rca_id: null,
    }));

  await upsert("incidents", incidents, "incident_id");

  const rcas: Record<string, any>[] = (
    await jsonl("data/synthetic/rca_documents.jsonl")
  )
    .filter((row, index) => {
      const error = requireFields(row, [
        "rca_id",
        "incident_id",
        "machine_id",
        "rca_text",
      ]);

      if (error || !machineIds.has(String(row.machine_id))) {
        reject(
          "rca_documents.jsonl",
          index + 1,
          error ?? `invalid machine_id "${row.machine_id}"`
        );

        return false;
      }

      return true;
    })
    .map((row) => ({
      ...row,
      rca_category:
        row.rca_category || categories.get(Number(row.tep_fault_number)) || null,
    }));

  await upsert("rca_documents", rcas, "rca_id");

  for (const rca of rcas) {
    const { error } = await db
      .from("incidents")
      .update({ rca_id: rca.rca_id })
      .eq("incident_id", rca.incident_id);

    if (error) {
      reject(
        "rca_documents.jsonl",
        0,
        `could not link ${rca.rca_id}: ${error.message}`
      );
    }
  }

  const simpleSources = [
    ["alarm_logs", "data/synthetic/alarm_logs.csv", "alarm_id"],
    ["maintenance_actions", "data/synthetic/maintenance_actions.csv", "work_order_id"],
  ] as const;

  for (const [table, file, key] of simpleSources) {
    const rows = (await csv(file))
      .filter((row, index) => {
        if (machineIds.has(row.machine_id)) return true;

        reject(file, index + 2, `invalid machine_id "${row.machine_id}"`);
        return false;
      })
      .map((row) =>
        table === "maintenance_actions"
          ? {
              ...row,
              cost_inr: numberOrNull(row.cost_inr),
              owner_employee_id: nullable(row.owner_employee_id),
            }
          : row
      );

    await upsert(table, rows, key);
  }

  const snapshots = (await csv("data/synthetic/sensor_snapshots.csv"))
    .filter((row, index) => {
      if (machineIds.has(row.machine_id)) return true;

      reject(
        "sensor_snapshots.csv",
        index + 2,
        `invalid machine_id "${row.machine_id}"`
      );

      return false;
    })
    .map((r) => ({
      incident_id: r.incident_id,
      timestamp: r.timestamp,
      machine_id: r.machine_id,
      tep_tag: r.tep_tag,
      phase: r.phase,
      synthetic_value: numberOrNull(r.synthetic_value),
      z_score_vs_normal: numberOrNull(r.z_score_vs_normal),
      status: r.status,
    }));

  await upsert(
    "sensor_snapshots",
    snapshots,
    "incident_id,timestamp,tep_tag,phase"
  );

  const sops = (await jsonl("data/synthetic/sop_documents.jsonl")).filter(
    (row, index) => {
      if (machineIds.has(String(row.machine_id))) return true;

      reject(
        "sop_documents.jsonl",
        index + 1,
        `invalid machine_id "${row.machine_id}"`
      );

      return false;
    }
  );

  await upsert("sop_documents", sops, "sop_id");

  const signatures = (
    await jsonl("data/processed/tep_fault_signatures.jsonl")
  ).filter((row, index) => {
    if (machineIds.has(String(row.primary_machine_id))) return true;

    reject(
      "tep_fault_signatures.jsonl",
      index + 1,
      `invalid primary_machine_id "${row.primary_machine_id}"`
    );

    return false;
  });

  await upsert("tep_fault_signatures", signatures, "document_id");

  const summary = (await csv("data/processed/tep_fault_summary.csv"))
    .filter((row, index) => {
      if (machineIds.has(row.primary_machine_id)) return true;

      reject(
        "tep_fault_summary.csv",
        index + 2,
        `invalid primary_machine_id "${row.primary_machine_id}"`
      );

      return false;
    })
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          key === "tep_fault_number" || key.endsWith("_change_pct")
            ? numberOrNull(value)
            : value,
        ])
      )
    );

  await upsert("tep_fault_summary", summary, "document_id");

  console.log(`Import complete with ${rejected.length} rejected rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});