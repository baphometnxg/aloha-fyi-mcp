/**
 * Live AAAK verification — hits the deployed MCP endpoint, calls each of
 * the six tools, parses the SSE-wrapped JSON-RPC response, and validates
 * any structuredContent against the zod schemas in lib/aaak.ts.
 *
 *   npm run aaak:verify -- --url=https://mcp-server-nani-v3-20.up.railway.app/mcp
 *   npm run aaak:verify -- --ua=claude-code/1.0
 *
 * Exit codes:
 *   0 — every tool succeeded; if structuredContent was returned, it passed schema
 *   1 — at least one tool failed schema validation, errored, or returned unexpected shape
 *
 * Used in three modes:
 *   1. Pre-flip baseline   — expects structuredContent ABSENT, trailer PRESENT
 *   2. Post-flip allowed   — expects structuredContent PRESENT (schema-valid), trailer ABSENT
 *   3. Post-flip not-allowed — same as legacy (UA outside AAAK_CLIENTS allowlist)
 *
 * Pass --expect=legacy or --expect=aaak to enforce the expectation; without
 * the flag the script just reports what it sees.
 *
 * Note: this calls the live DB-backed server. Each invocation registers
 * click-target rows and writes to mcp_requests. Don't run in tight loops.
 */

import { RESPONSE_SCHEMAS, type ToolName } from "../lib/aaak.js";

interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

const CALLS: ToolCall[] = [
  { name: "search_hawaii_tours", args: { query: "snorkeling", island: "oahu", limit: 2 } },
  { name: "get_hawaii_deals", args: { activity: "luau", max_price_dollars: 100, limit: 2 } },
  { name: "search_hawaii_events", args: { query: "luau", island: "oahu", days_ahead: 30 } },
  { name: "get_hawaii_weather", args: { island: "oahu", days: 3 } },
  { name: "find_hawaii_restaurants", args: { category: "poke", neighborhood: "waikiki", limit: 2 } },
  { name: "plan_hawaii_day", args: { island: "oahu", vibe: "chill", max_budget_per_person: 300 } },
];

interface CliOpts {
  url: string;
  ua: string;
  expect: "legacy" | "aaak" | "any";
}

function parseArgs(): CliOpts {
  const opts: CliOpts = {
    url: "https://mcp-server-nani-v3-20.up.railway.app/mcp",
    ua: "aaak-verify/1.0",
    expect: "any",
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--url=")) opts.url = arg.slice(6);
    else if (arg.startsWith("--ua=")) opts.ua = arg.slice(5);
    else if (arg === "--expect=legacy" || arg === "--expect=aaak") {
      opts.expect = arg.slice(9) as "legacy" | "aaak";
    }
  }
  return opts;
}

/**
 * MCP Streamable HTTP responses come wrapped in SSE-style framing:
 *   event: message
 *   data: {"result":{...},"jsonrpc":"2.0","id":1}
 *
 * Pull the JSON-RPC payload out of the first `data:` line. (The transport
 * supports multi-message streams, but tools/call replies are single-message.)
 */
function extractJsonRpc(body: string): { result?: any; error?: any } {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // fall through; show body in caller for debugging
      }
    }
  }
  // Fallback: maybe the server returned plain JSON (some configs do)
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

interface CallReport {
  tool: ToolName;
  ok: boolean;
  hasStructured: boolean;
  hasTrailer: boolean;
  schemaPassed: boolean | null;
  textBytes: number;
  notes: string[];
}

const TRAILER_MARKERS = [
  "_Powered by aloha.fyi",
  "_Weather via Open-Meteo",
  "_For a custom itinerary with booking help",
];

function detectTrailer(text: string): boolean {
  return TRAILER_MARKERS.some((m) => text.includes(m));
}

async function runOne(opts: CliOpts, call: ToolCall, id: number): Promise<CallReport> {
  const report: CallReport = {
    tool: call.name,
    ok: false,
    hasStructured: false,
    hasTrailer: false,
    schemaPassed: null,
    textBytes: 0,
    notes: [],
  };

  let resp: Response;
  try {
    resp = await fetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": opts.ua,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: call.name, arguments: call.args },
      }),
    });
  } catch (err) {
    report.notes.push(`fetch failed: ${(err as Error).message}`);
    return report;
  }

  if (!resp.ok) {
    report.notes.push(`HTTP ${resp.status}`);
    return report;
  }

  const body = await resp.text();
  const rpc = extractJsonRpc(body);

  if (rpc.error) {
    report.notes.push(`JSON-RPC error: ${JSON.stringify(rpc.error)}`);
    return report;
  }

  const result = rpc.result;
  if (!result) {
    report.notes.push(`no result in response: ${body.slice(0, 200)}`);
    return report;
  }

  const text = result.content?.[0]?.text ?? "";
  report.textBytes = text.length;
  report.hasTrailer = detectTrailer(text);

  if (result.structuredContent !== undefined) {
    report.hasStructured = true;
    const schema = RESPONSE_SCHEMAS[call.name];
    const parsed = schema.safeParse(result.structuredContent);
    if (parsed.success) {
      report.schemaPassed = true;
    } else {
      report.schemaPassed = false;
      report.notes.push(`schema validation failed:`);
      for (const issue of parsed.error.issues.slice(0, 3)) {
        report.notes.push(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
    }
  }

  report.ok = true;
  return report;
}

async function main() {
  const opts = parseArgs();
  console.log(`AAAK live verification`);
  console.log(`  endpoint: ${opts.url}`);
  console.log(`  UA:       ${opts.ua}`);
  console.log(`  expect:   ${opts.expect}`);
  console.log("");

  const reports: CallReport[] = [];
  for (let i = 0; i < CALLS.length; i++) {
    const r = await runOne(opts, CALLS[i], i + 1);
    reports.push(r);
    const flags: string[] = [];
    if (!r.ok) flags.push("FAIL");
    flags.push(r.hasStructured ? "structured✓" : "structured✗");
    flags.push(r.hasTrailer ? "trailer✓" : "trailer✗");
    if (r.schemaPassed === true) flags.push("schema✓");
    if (r.schemaPassed === false) flags.push("SCHEMA-FAIL");
    flags.push(`${r.textBytes}B`);
    console.log(`  ${r.tool.padEnd(28)} ${flags.join("  ")}`);
    for (const note of r.notes) console.log(`      ${note}`);
  }

  // ── Aggregate verdict ──
  const allOk = reports.every((r) => r.ok);
  const anyStructured = reports.some((r) => r.hasStructured);
  const anyTrailer = reports.some((r) => r.hasTrailer);
  const anySchemaFail = reports.some((r) => r.schemaPassed === false);
  const allSchemaPassed = reports.every((r) => r.schemaPassed !== false);

  console.log("");
  console.log(`summary:`);
  console.log(`  reachable:        ${allOk ? "yes" : "NO"}`);
  console.log(`  structuredContent: ${anyStructured ? "present (some/all)" : "absent (all)"}`);
  console.log(`  trailer in text:   ${anyTrailer ? "present (some/all)" : "absent (all)"}`);
  console.log(`  schemas:           ${anySchemaFail ? "FAILED" : allSchemaPassed && anyStructured ? "passed" : "n/a (no structured)"}`);

  let exitCode = allOk && !anySchemaFail ? 0 : 1;
  if (opts.expect === "legacy") {
    if (anyStructured) {
      console.log(`  expectation FAILED: --expect=legacy but structuredContent was present`);
      exitCode = 1;
    } else if (!anyTrailer) {
      console.log(`  expectation FAILED: --expect=legacy but no tool returned a trailer`);
      exitCode = 1;
    } else {
      console.log(`  expectation OK: legacy mode confirmed`);
    }
  } else if (opts.expect === "aaak") {
    if (!anyStructured) {
      console.log(`  expectation FAILED: --expect=aaak but no tool returned structuredContent`);
      exitCode = 1;
    } else if (anyTrailer) {
      console.log(`  expectation FAILED: --expect=aaak but a trailer leaked through`);
      exitCode = 1;
    } else if (anySchemaFail) {
      console.log(`  expectation FAILED: --expect=aaak but at least one schema check failed`);
      exitCode = 1;
    } else {
      console.log(`  expectation OK: AAAK mode confirmed and schemas valid`);
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
