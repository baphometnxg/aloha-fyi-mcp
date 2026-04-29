/**
 * Gate-off invariance test — when AAAK_ENABLED is unset/false, the adapter
 * MUST NOT add structuredContent to the CallToolResult AND MUST preserve
 * the marketing trailer in the text. Together those are the load-bearing
 * safety properties: until the flag flips, the wire format is byte-for-byte
 * identical to v1.0.0.
 *
 *   npm run aaak:gate
 *
 * Tests cover:
 *   - global AAAK_ENABLED gate (truthy/falsy variants)
 *   - A-004 trailer drop / preserve
 *   - A-005 AAAK_CLIENTS allowlist behavior
 *
 * The test toggles process.env between cases; runs in a fresh node process.
 */

import {
  makeToolResult,
  buildResultEnvelope,
  buildEmptyEnvelope,
  isAAAKEnabledForClient,
  getAAAKAllowlist,
} from "../../lib/aaak-adapter.js";

let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    console.log(`✗ ${label}`);
    failed++;
  }
}

function reset(): void {
  delete process.env.AAAK_ENABLED;
  delete process.env.AAAK_CLIENTS;
}

const BODY = "Found 1 result";
const TRAILER = "_Powered by aloha.fyi_";
const EXPECTED_LEGACY_TEXT = `${BODY}\n\n${TRAILER}`;

console.log("── Global gate ──────────────────────────────────────");

// AAAK off (default)
reset();
{
  const { result, stamp } = makeToolResult({
    text: BODY,
    trailer: TRAILER,
    envelope: buildResultEnvelope({ tool: "search_hawaii_tours", rows: [] }),
  });
  assert(!("structuredContent" in result), "off: structuredContent absent");
  assert(stamp.responseMode === "legacy", "off: stamp.responseMode === 'legacy'");
  assert(stamp.structuredPresent === false, "off: stamp.structuredPresent === false");
  assert(stamp.responseBytes > 0, "off: stamp.responseBytes > 0");
  assert(
    Array.isArray(result.content) && (result.content[0] as any)?.text === EXPECTED_LEGACY_TEXT,
    "off: trailer preserved in text",
  );
}

// AAAK on (truthy variants)
for (const truthy of ["true", "1", "yes", "on", "TRUE", "  true  "]) {
  reset();
  process.env.AAAK_ENABLED = truthy;
  const { result, stamp } = makeToolResult({
    text: BODY,
    trailer: TRAILER,
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
  });
  assert("structuredContent" in result, `on (${JSON.stringify(truthy)}): structuredContent attached`);
  assert(stamp.responseMode === "aaak", `on (${JSON.stringify(truthy)}): mode === 'aaak'`);
  assert(stamp.structuredPresent === true, `on (${JSON.stringify(truthy)}): structuredPresent`);
  assert(
    (result.content[0] as any)?.text === BODY,
    `on (${JSON.stringify(truthy)}): trailer dropped from text`,
  );
}

// AAAK off (falsy variants — also dropped trailer treatment must NOT trigger)
for (const falsy of ["false", "0", "no", "off", ""]) {
  reset();
  process.env.AAAK_ENABLED = falsy;
  const { result, stamp } = makeToolResult({
    text: BODY,
    trailer: TRAILER,
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
  });
  assert(!("structuredContent" in result), `off (${JSON.stringify(falsy)}): structuredContent absent`);
  assert(stamp.responseMode === "legacy", `off (${JSON.stringify(falsy)}): mode === 'legacy'`);
  assert(
    (result.content[0] as any)?.text === EXPECTED_LEGACY_TEXT,
    `off (${JSON.stringify(falsy)}): trailer preserved`,
  );
}

console.log("\n── Trailer absent (no trailer arg) ──────────────────");

// When no trailer is passed, body is the entire text in both modes
reset();
{
  const { result } = makeToolResult({
    text: BODY,
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
  });
  assert((result.content[0] as any)?.text === BODY, "no-trailer / off: text === body");
}
process.env.AAAK_ENABLED = "true";
{
  const { result } = makeToolResult({
    text: BODY,
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
  });
  assert((result.content[0] as any)?.text === BODY, "no-trailer / on: text === body");
}

console.log("\n── A-005 allowlist ──────────────────────────────────");

// Empty / unset allowlist → all clients eligible (when global gate is on)
reset();
process.env.AAAK_ENABLED = "true";
assert(getAAAKAllowlist() === null, "AAAK_CLIENTS unset → null");
assert(isAAAKEnabledForClient("claude-desktop"), "no allowlist: any client → enabled");
assert(isAAAKEnabledForClient(null), "no allowlist: null client → enabled");
assert(isAAAKEnabledForClient("random-ua"), "no allowlist: unknown client → enabled");

process.env.AAAK_CLIENTS = "";
assert(getAAAKAllowlist() === null, "AAAK_CLIENTS='' → null (treated as unset)");
assert(isAAAKEnabledForClient("anything"), "empty allowlist: client → enabled");

// Explicit allowlist → only listed clients
process.env.AAAK_CLIENTS = "claude-desktop, claude-code ,mcp-inspector";
{
  const list = getAAAKAllowlist();
  assert(
    Array.isArray(list) && list.length === 3 && list[0] === "claude-desktop" && list[1] === "claude-code" && list[2] === "mcp-inspector",
    "AAAK_CLIENTS parsed (trimmed, lowercased)",
  );
}
assert(isAAAKEnabledForClient("claude-desktop"), "allowlist: claude-desktop → enabled");
assert(isAAAKEnabledForClient("claude-code"), "allowlist: claude-code → enabled");
assert(isAAAKEnabledForClient("CLAUDE-CODE"), "allowlist: case-insensitive match");
assert(!isAAAKEnabledForClient("chatgpt"), "allowlist: chatgpt → off");
assert(!isAAAKEnabledForClient("cursor"), "allowlist: cursor → off");
assert(!isAAAKEnabledForClient(null), "allowlist + null client → off (no UA → no match)");
assert(!isAAAKEnabledForClient(""), "allowlist + empty client → off");

// Global kill switch wins over allowlist
process.env.AAAK_ENABLED = "false";
process.env.AAAK_CLIENTS = "claude-desktop";
assert(!isAAAKEnabledForClient("claude-desktop"), "kill switch wins over allowlist");

// End-to-end: makeToolResult honors allowlist
reset();
process.env.AAAK_ENABLED = "true";
process.env.AAAK_CLIENTS = "claude-desktop";
{
  const onResult = makeToolResult({
    text: BODY,
    trailer: TRAILER,
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
    clientName: "claude-desktop",
  });
  assert("structuredContent" in onResult.result, "allowlist hit: structuredContent attached");
  assert(onResult.stamp.responseMode === "aaak", "allowlist hit: mode === 'aaak'");
  assert((onResult.result.content[0] as any)?.text === BODY, "allowlist hit: trailer dropped");

  const offResult = makeToolResult({
    text: BODY,
    trailer: TRAILER,
    envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours" }),
    clientName: "chatgpt",
  });
  assert(!("structuredContent" in offResult.result), "allowlist miss: structuredContent absent");
  assert(offResult.stamp.responseMode === "legacy", "allowlist miss: mode === 'legacy'");
  assert(
    (offResult.result.content[0] as any)?.text === EXPECTED_LEGACY_TEXT,
    "allowlist miss: trailer preserved",
  );
}

reset();

console.log(`\n${failed === 0 ? "all gate invariants hold" : `${failed} invariant(s) violated`}.`);
process.exit(failed === 0 ? 0 : 1);
