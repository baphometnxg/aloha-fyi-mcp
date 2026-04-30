/**
 * AAAK telemetry check — queries mcp_requests via the production DB and
 * reports the response_mode / structured_present / response_bytes split
 * across recent traffic. Used to confirm the telemetry write path is
 * healthy after the env gate flips.
 *
 *   railway run -- node dist/scripts/check-telemetry.js
 *   railway run -- node dist/scripts/check-telemetry.js --hours=4
 *
 * Reads DATABASE_URL from env (provided by Railway). Doesn't need any
 * AAAK_* vars; this is a read-only diagnostic.
 *
 * Exit codes:
 *   0 — query succeeded
 *   1 — DB unreachable, no recent rows, or the response_mode/
 *       structured_present columns are missing (means deploy hasn't
 *       picked up the AAAK schema migration).
 */

import { Pool } from "pg";

const args = process.argv.slice(2);
let hours = 24;
for (const a of args) {
  if (a.startsWith("--hours=")) hours = Math.max(1, Math.min(720, parseInt(a.slice(8), 10) || 24));
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run via `railway run` so Railway injects it.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 5_000,
});

async function main() {
  // Schema sanity — confirm the A-003 columns exist.
  const colCheck = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'mcp_requests'
       AND column_name IN ('response_mode', 'response_bytes', 'structured_present')
     ORDER BY column_name`,
  );
  const present = new Set(colCheck.rows.map((r: any) => r.column_name));
  for (const expected of ["response_mode", "response_bytes", "structured_present"]) {
    if (!present.has(expected)) {
      console.error(`schema check FAILED: column ${expected} is missing from mcp_requests`);
      console.error("→ AAAK A-003 migration hasn't been applied. Did the server restart after deploy?");
      process.exit(1);
    }
  }

  console.log(`AAAK telemetry — last ${hours}h`);
  console.log("");

  // ── 1. Overall split by response_mode ──
  const split = await pool.query(
    `SELECT COALESCE(response_mode, '<null>') AS mode,
            COUNT(*)::int AS calls,
            ROUND(AVG(response_bytes))::int AS avg_bytes,
            SUM(CASE WHEN structured_present THEN 1 ELSE 0 END)::int AS structured
     FROM mcp_requests
     WHERE created_at > NOW() - ($1 || ' hours')::interval
       AND method = 'tools/call'
     GROUP BY 1 ORDER BY 2 DESC`,
    [String(hours)],
  );
  console.log("by response_mode:");
  for (const r of split.rows) {
    console.log(`  ${(r.mode as string).padEnd(10)} ${String(r.calls).padStart(5)} calls   avg=${r.avg_bytes}B   structured=${r.structured}`);
  }
  console.log("");

  // ── 2. Per-client breakdown ──
  const byClient = await pool.query(
    `SELECT COALESCE(client_name, '<unknown>') AS client,
            COALESCE(response_mode, '<null>') AS mode,
            COUNT(*)::int AS calls,
            SUM(CASE WHEN structured_present THEN 1 ELSE 0 END)::int AS structured
     FROM mcp_requests
     WHERE created_at > NOW() - ($1 || ' hours')::interval
       AND method = 'tools/call'
     GROUP BY 1, 2
     ORDER BY 3 DESC LIMIT 20`,
    [String(hours)],
  );
  console.log("by client × mode:");
  for (const r of byClient.rows) {
    console.log(
      `  ${(r.client as string).padEnd(20)} ${(r.mode as string).padEnd(10)} ${String(r.calls).padStart(4)} calls   structured=${r.structured}`,
    );
  }
  console.log("");

  // ── 3. Per-tool AAAK adoption ──
  const byTool = await pool.query(
    `SELECT tool_name,
            COUNT(*) FILTER (WHERE response_mode = 'aaak')::int AS aaak,
            COUNT(*) FILTER (WHERE response_mode = 'legacy')::int AS legacy,
            COUNT(*)::int AS total
     FROM mcp_requests
     WHERE created_at > NOW() - ($1 || ' hours')::interval
       AND method = 'tools/call'
       AND tool_name IS NOT NULL
     GROUP BY 1 ORDER BY 4 DESC`,
    [String(hours)],
  );
  console.log("by tool:");
  for (const r of byTool.rows) {
    const pct = r.total > 0 ? Math.round((100 * r.aaak) / r.total) : 0;
    console.log(`  ${(r.tool_name as string).padEnd(28)} aaak=${String(r.aaak).padStart(4)}  legacy=${String(r.legacy).padStart(4)}  (${pct}% AAAK)`);
  }
  console.log("");

  // ── 4. Health verdict ──
  const totalAaak = split.rows.find((r: any) => r.mode === "aaak");
  const totalLegacy = split.rows.find((r: any) => r.mode === "legacy");
  if (!totalAaak && !totalLegacy) {
    console.log("verdict: NO TRAFFIC in window — too early to tell, or server hasn't seen calls");
  } else if (totalAaak && totalAaak.structured === totalAaak.calls) {
    console.log(`verdict: HEALTHY — every aaak row has structuredContent (${totalAaak.structured}/${totalAaak.calls})`);
  } else if (totalAaak && totalAaak.structured < totalAaak.calls) {
    console.log(`verdict: WARN — ${totalAaak.calls - totalAaak.structured} aaak rows missing structured_present`);
    process.exit(1);
  } else {
    console.log("verdict: legacy-only — env gate isn't routing any clients to AAAK yet");
  }
}

main()
  .catch((err) => {
    console.error("query failed:", (err as Error).message);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
