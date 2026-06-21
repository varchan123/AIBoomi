import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is required");

  const sql = await readFile(
    path.join(process.cwd(), "scripts/create_schema.sql"),
    "utf8"
  );

  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    await client.query(sql);
    console.log("Schema created successfully.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});