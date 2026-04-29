/**
 * AAAK conformance test runner.
 *
 *   npm run aaak:test
 *
 * Walks tests/aaak/fixtures/, validates each *.json against the matching tool
 * envelope schema in lib/aaak.ts, and exits non-zero on any failure. Files
 * under fixtures/_invalid/ are *expected* to fail — they're negative fixtures
 * that prove the schema actually rejects malformed shapes.
 *
 * Filename convention: <tool_name>.<kind>.json
 *   e.g. search_hawaii_tours.result.json
 *        plan_hawaii_day.error.json
 *
 * No external test framework — keeps the surface dep-light and the failure
 * output legible. Runs in node 20+.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { RESPONSE_SCHEMAS, type ToolName } from "../../lib/aaak.js";

interface FixtureCase {
  path: string;
  tool: string;
  expectValid: boolean;
}

function listFixtures(dir: string): FixtureCase[] {
  const out: FixtureCase[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const expectValid = entry !== "_invalid";
      for (const child of readdirSync(full)) {
        if (!child.endsWith(".json")) continue;
        out.push({ path: join(full, child), tool: child.split(".")[0], expectValid });
      }
    } else if (entry.endsWith(".json")) {
      out.push({ path: full, tool: entry.split(".")[0], expectValid: true });
    }
  }
  return out;
}

// Source-relative — fixtures aren't copied into dist by tsc.
const FIXTURES_DIR = resolve(process.cwd(), "tests", "aaak", "fixtures");
const cases = listFixtures(FIXTURES_DIR);

let failed = 0;
let passed = 0;

for (const c of cases) {
  const label = `${c.expectValid ? "valid  " : "invalid"}  ${basename(c.path)}`;
  const schema = RESPONSE_SCHEMAS[c.tool as ToolName];
  if (!schema) {
    console.log(`✗ ${label}  — no schema for tool '${c.tool}'`);
    failed++;
    continue;
  }
  const data = JSON.parse(readFileSync(c.path, "utf8"));
  const result = schema.safeParse(data);

  if (c.expectValid && result.success) {
    console.log(`✓ ${label}`);
    passed++;
  } else if (!c.expectValid && !result.success) {
    console.log(`✓ ${label}  (rejected as expected)`);
    passed++;
  } else if (c.expectValid && !result.success) {
    console.log(`✗ ${label}`);
    console.log(`  validation errors:`);
    for (const issue of result.error.issues) {
      console.log(`    - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    failed++;
  } else {
    // !c.expectValid && result.success — schema didn't reject something it should have
    console.log(`✗ ${label}  — should have been rejected but passed`);
    failed++;
  }
}

console.log(`\n${passed}/${cases.length} fixtures conform${failed ? `, ${failed} failed` : ""}.`);
process.exit(failed === 0 ? 0 : 1);
