/**
 * Gate-off invariance test — when AAAK_ENABLED is unset/false, the adapter
 * MUST NOT add structuredContent to the CallToolResult. This is the single
 * load-bearing safety property of A-002: until the flag flips, the wire
 * format is byte-for-byte identical to v1.0.0.
 *
 *   npm run aaak:gate
 *
 * The test toggles process.env.AAAK_ENABLED inside the run, so it MUST run
 * in its own node process — don't import this from another test runner.
 */

import { makeToolResult, buildResultEnvelope, buildEmptyEnvelope } from "../../lib/aaak-adapter.js";

let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.log(`✗ ${label}`);
    failed++;
  }
}

// ── AAAK off (default) ──
delete process.env.AAAK_ENABLED;
{
  const { result, stamp } = makeToolResult({
    text: "Found 1 result",
    envelope: buildResultEnvelope({ tool: "search_hawaii_tours", rows: [] }),
  });
  assert(!("structuredContent" in result), "off: structuredContent absent");
  assert(stamp.responseMode === "legacy", "off: stamp.responseMode === 'legacy'");
  assert(stamp.structuredPresent === false, "off: stamp.structuredPresent === false");
  assert(stamp.responseBytes > 0, "off: stamp.responseBytes > 0");
  assert(Array.isArray(result.content) && result.content[0]?.type === "text", "off: text content present");
}

// ── AAAK on ──
for (const truthy of ["true", "1", "yes", "on", "TRUE", "  true  "]) {
  process.env.AAAK_ENABLED = truthy;
  const { result, stamp } = makeToolResult({
    text: "Found 1 result",
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
  });
  assert("structuredContent" in result, `on (${JSON.stringify(truthy)}): structuredContent attached`);
  assert(stamp.responseMode === "aaak", `on (${JSON.stringify(truthy)}): stamp.responseMode === 'aaak'`);
  assert(stamp.structuredPresent === true, `on (${JSON.stringify(truthy)}): stamp.structuredPresent === true`);
}

// ── AAAK explicitly off-ish ──
for (const falsy of ["false", "0", "no", "off", ""]) {
  process.env.AAAK_ENABLED = falsy;
  const { result, stamp } = makeToolResult({
    text: "ok",
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
  });
  assert(!("structuredContent" in result), `off (${JSON.stringify(falsy)}): structuredContent absent`);
  assert(stamp.responseMode === "legacy", `off (${JSON.stringify(falsy)}): stamp.responseMode === 'legacy'`);
}

console.log(`\n${failed === 0 ? "all gate-off invariants hold" : `${failed} invariant(s) violated`}.`);
process.exit(failed === 0 ? 0 : 1);
