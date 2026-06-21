import { Pool } from "pg";

import { getConfig } from "../lib/config";
import { pgConnString, sslFor } from "../lib/engine/aurora";
import { SCHEMA_SQL } from "../lib/sql/statements";
import { loadEnv } from "./_env";

loadEnv();

async function main(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.aurora.writerUrl) {
    console.error("AURORA_WRITER_URL is not set. Configure .env (see .env.example).");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: pgConnString(cfg.aurora.writerUrl),
    ssl: sslFor(cfg.aurora.writerUrl, cfg.aurora.caCert), // honors AURORA_CA_CERT pinning
  });
  console.log("Applying schema to Aurora writer endpoint…");
  await pool.query(SCHEMA_SQL);
  console.log("✓ schema applied (event_log, stream_watermark, billing_window, correction_epoch)");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
