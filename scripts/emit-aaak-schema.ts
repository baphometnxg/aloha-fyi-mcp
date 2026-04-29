/**
 * Emit docs/aaak.schema.json from the zod schemas in lib/aaak.ts.
 *
 *   npm run aaak:schema
 *
 * The output is a single JSON Schema document with one entry per tool under
 * `definitions.<ToolName>Response`, plus shared primitive definitions. Run
 * this whenever lib/aaak.ts changes; CI should diff the result against the
 * committed file to catch drift.
 *
 * Why a script and not a one-liner: zod-to-json-schema needs a deterministic
 * `name` parameter to control where the resulting schema lives in the output
 * tree. We want a single combined document, so we build it manually.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";

import { RESPONSE_SCHEMAS } from "../lib/aaak.js";

// Resolve to the *source* docs/ regardless of whether we're running from
// dist/scripts (post-build) or scripts/ (with a future ts-node setup).
// process.cwd() is the package root when run via npm script.
const OUT = resolve(process.cwd(), "docs", "aaak.schema.json");

const definitions: Record<string, unknown> = {};
for (const [tool, schema] of Object.entries(RESPONSE_SCHEMAS)) {
  // `name` controls the $ref target; we use ToolNameResponse so the document
  // reads naturally when consumers $ref into it.
  const key = tool.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join("") + "Response";
  const json = zodToJsonSchema(schema, { name: key, target: "jsonSchema7" }) as {
    definitions?: Record<string, unknown>;
    $ref?: string;
  };
  // zodToJsonSchema returns { $ref, definitions }; we want the inner definitions.
  if (json.definitions) {
    Object.assign(definitions, json.definitions);
  }
}

const document = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AAAK v0.1 — Agent-to-Agent Adaptive Knowledge",
  description: "Structured response contract for aloha-fyi-mcp tools. See docs/aaak-spec.md.",
  protocol: "aaak/0.1",
  definitions,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(document, null, 2) + "\n", "utf8");
console.log(`[aaak] wrote ${OUT}`);
console.log(`[aaak] ${Object.keys(definitions).length} top-level definitions`);
