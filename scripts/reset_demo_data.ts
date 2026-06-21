import "dotenv/config";
import pg from "pg";
import { spawnSync } from "node:child_process";

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL is required");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(`
    truncate documents, sensor_snapshots, alarm_logs, maintenance_actions,
      sop_documents, tep_fault_signatures, tep_fault_summary, rca_documents,
      incidents, tep_variable_map, tep_fault_dictionary, spare_parts, employees,
      machines restart identity cascade
  `);
} finally {
  await client.end();
}

for (const script of ["scripts/import_data.ts", "scripts/embed_documents.ts"]) {
  const result = spawnSync("npx", ["tsx", script], { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
