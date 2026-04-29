---
title: AAAK — Agent-to-Agent Adaptive Knowledge
version: 0.1
status: a-001 in progress
owner: Michael Crain
target_repo: baphometnxg/aloha-fyi-mcp
last_updated: 2026-04-29
---

> **Decisions locked through A-005:**
> - itinerary uses flat `sections[]` with tagged union;
> - weather has its own envelope without a `booking_url` invariant;
> - text fallback stays for v0.1 + v0.2;
> - **A-002 emits `structuredContent` only — no JSON-in-text fence.** MCP is
>   forward-compatible: clients on `2025-03-26` ignore the unknown field and
>   render `text` as they do today. Embedding the envelope inside `text` would
>   double payload size and pollute human-readable rendering for nothing —
>   any consumer that wants structured output is on a new-enough client to
>   read `structuredContent` natively. Revisit only if a real downstream
>   agent surfaces a hard requirement we don't currently have evidence for.
> - restaurant `website` standardizes through `/r/{code}` in A-002.
> - **A-004: drop the marketing trailer when AAAK is on.** UTMs on the
>   booking URL already carry attribution. Modern consumer agents either
>   read `structuredContent` and ignore text, or read text but transform /
>   summarize it before surfacing to humans — the trailer is token waste in
>   either case. When AAAK is off, the trailer is preserved exactly as today.
> - **A-005: per-client allowlist via `AAAK_CLIENTS`.** Comma-separated list
>   of `clientName` values (`claude-desktop`, `claude-code`, etc.). Unset or
>   empty → all clients eligible (assuming `AAAK_ENABLED=true`). Set →
>   AAAK on for listed clients only, legacy mode for everyone else. The
>   global `AAAK_ENABLED` is the kill switch and always wins.

# AAAK v0.1 — Agent-to-Agent Adaptive Knowledge

## Why

Every tool in this MCP server today returns a prose blob:

```
**Hanauma Bay Snorkel Tour** (via Viator)
East Oahu | $89/person ★4.7 (2,341 reviews)
Half-day guided snorkeling at Oahu's most famous reef...
Book: https://aloha.fyi/r/aB3kT9pQz1

---

**Diamond Head Sunrise Hike** (via GetYourGuide)
...

_Powered by aloha.fyi — Hawaii's AI concierge..._
```

A consumer agent (Claude, ChatGPT, Cursor, etc.) wanting to use this in a downstream workflow has to re-parse markdown to recover `price_cents`, `island`, `booking_url`, `source`. The marketing trailer burns context tokens for no agent value. The empty-result path is text-shaped identical to the success path — hard for a downstream agent to branch on without string-matching.

AAAK is the structured response contract that fixes this. Same MCP tools, additive new shape: machine-parseable rows alongside the prose, behind an env gate. Once consumer adoption is healthy, prose becomes a thin fallback or retires.

## Core idea

For every tool call, return:

1. **`structuredContent`** — typed JSON the consumer can parse without regex. Stable schema per tool. Lossless on the four invariants.
2. **`content[].text`** — minimal human-readable text block for clients that don't read `structuredContent`. Same data, prose form. Marketing trailer dropped when AAAK is on (booking URL already carries UTM attribution).

The MCP SDK's `CallToolResult` already supports both fields — we're not inventing transport, we're filling a slot the protocol provides.

## Invariants (lossless — never compressed away)

These four fields must round-trip on every result row, regardless of any future compression we do:

1. **`booking_url`** — affiliate revenue. Losing it loses the only revenue signal.
2. **`source`** — `viator` / `gyg` / `klook` / `groupon` / `events` / `restaurant`. Compliance + attribution.
3. **`price_cents`** — the one numeric field user decisions hinge on.
4. **`island`** — every recommendation is island-scoped. Without it, results are ambiguous.

Anything else is bounded-lossy:

| Field | Lossy treatment |
|---|---|
| `description` | Truncate to ≤ 140 chars (already done in prose) |
| Marketing trailer | Dropped in AAAK mode |
| Emoji decorations (`🏷️ DEAL`, `🌅 Morning`) | Replaced with structural fields (`is_deal: true`, `slot: "morning"`) |
| Source label prettification (`gyg → GetYourGuide`) | Consumer-side concern; raw `source` returned |

## Response envelope

Every tool returns the same envelope shape inside `structuredContent`:

```ts
type AAAKResponse<T> = {
  ok: boolean;
  kind: "result" | "empty_result" | "error";
  tool: string;
  protocol: "aaak/0.1";
  query?: Record<string, unknown>;   // echoed input args (for cache keys, debugging)
  results?: T[];
  meta?: {
    count: number;
    cached?: boolean;
    source_diversity?: number;        // distinct `source` values in results
  };
  error?: {
    code: ErrorCode;
    message: string;
  };
};

type ErrorCode =
  | "db_not_configured"
  | "db_query_failed"
  | "not_enough_data"
  | "external_api_failed"
  | "rate_limited"
  | "daily_quota_exceeded"
  | "invalid_arguments";
```

`empty_result` is **success with zero rows**, distinct from `error`. Today both paths return prose with no structural difference, which is the second-biggest handoff bug after the prose-only output.

## Per-tool result schemas

### `search_hawaii_tours`, `get_hawaii_deals`

```ts
type Experience = {
  title: string;
  source: "viator" | "gyg" | "klook" | "groupon";
  island: "oahu" | "maui" | "big_island" | "kauai";
  area: string | null;             // e.g. "waikiki", "north_shore"
  category: string | null;
  price_cents: number | null;
  rating: number | null;
  review_count: number | null;
  description: string;             // ≤ 140 chars
  booking_url: string;             // UTM-stamped, /r/{code} when DB available
  is_deal: boolean;                // true when source=groupon
};
```

### `search_hawaii_events`

```ts
type Event = {
  name: string;
  date: string;                    // ISO YYYY-MM-DD
  time: string | null;             // freeform, "8:00 PM"
  venue: string | null;
  island: "oahu" | "maui" | "big_island" | "kauai";
  price: string | null;            // freeform, "$45-$120" or "Free"
  ticket_url: string | null;
};
```

### `get_hawaii_weather`

```ts
type Weather = {
  island: "oahu" | "maui" | "big_island" | "kauai";
  island_label: string;            // "Oʻahu" — already in ISLAND_COORDS
  current: {
    temperature_f: number;
    feels_like_f: number;
    humidity_pct: number;
    uv_index: number | null;
    wind_mph: number;
    precipitation_in: number;
  };
  forecast: Array<{
    date: string;                  // ISO
    temp_f_min: number;
    temp_f_max: number;
    precip_probability_pct: number;
    wind_mph_max: number;
    uv_index_max: number | null;
  }>;
};
```

`results` is `[Weather]` (single-element array) so the envelope shape stays uniform across tools.

### `find_hawaii_restaurants`

```ts
type Restaurant = {
  name: string;
  category: string;                // "poke", "ramen", "fine-dining", ...
  neighborhood: string | null;
  description: string;             // ≤ 140 chars
  rating: number | null;
  review_count: number | null;
  price_level: string | null;      // "$", "$$", "$$$", "$$$$"
  website: string | null;          // UTM-stamped + /r/{code}
  phone: string | null;
  island: "oahu";                  // restaurants table is Oahu-only today
};
```

### `plan_hawaii_day`

```ts
type Itinerary = {
  island: "oahu" | "maui" | "big_island" | "kauai";
  island_label: string;
  vibe: "adventure" | "chill" | "cultural" | "romantic" | "family" | "budget";
  budget_per_person_dollars: number;
  sections: Array<{
    slot: "morning" | "lunch" | "afternoon" | "dinner";
    type: "experience" | "restaurant" | "fallback";
    item: Experience | Restaurant | { fallback_reason: string };
  }>;
};
```

`results` is `[Itinerary]`. Tagged-union `type` lets consumers narrow without type-sniffing.

## Compression rules

The current handoff has no token budget pressure inside one MCP response (max 20 rows × ~400 chars ≈ 8KB worst case). AAAK's compression is therefore mostly format, not budget:

- Drop the marketing trailer in AAAK mode (saves ~80 tokens per call, no information loss).
- Drop emoji decorations from text fallback; encode as structural fields.
- Truncate `description` consistently to 140 chars (already de facto, formalize).
- No per-row compression — invariants are already small, results are bounded by tool `limit`.

If a future tool returns unbounded data (e.g. full-text venue descriptions, KB articles), this spec needs a v0.2 round with explicit budget rules. For v0.1, format is the lever, not budget.

## Failure semantics

| Today | AAAK |
|---|---|
| `{ content: [text], isError: true }` with `text: "Search error: ..."` | `{ ok: false, kind: "error", error: { code, message } }` + same `isError: true` |
| `{ content: [text] }` with text `"No tours found for X"` | `{ ok: true, kind: "empty_result", results: [], meta: { count: 0 } }`, no `isError` |
| `{ content: [text], isError: true }` with text `"Database not configured"` | `{ ok: false, kind: "error", error: { code: "db_not_configured", ... } }` |

Every error path that today writes a string into `text` gets a typed `error.code`. Today's `mcp_requests.error` column already stores the failure label — AAAK just makes the same label visible to the consumer.

## Rollout — A-001 through A-005

Additive, env-gated, shadow-first. Nothing about today's prose response shape changes for clients that don't opt in.

| Story | Scope | Gate |
|---|---|---|
| **A-001** | `lib/aaak.ts` — zod schemas for envelope + each result type. Emit `docs/aaak.schema.json` from zod. Unit tests on the schema (round-trip a synthetic row, reject malformed input). | none — pure library |
| **A-002** | Tool adapter layer — wrap each existing tool handler so it produces `{ text, structuredContent }`. Identical text output today; `structuredContent` populated when `AAAK_ENABLED=true`. | `AAAK_ENABLED` |
| **A-003** | Extend `mcp_requests` with `response_mode TEXT` (`legacy`/`aaak`), `response_bytes INT`, `structured_present BOOLEAN`. Telemetry only — no behavior change. | always-on |
| **A-004** | Drop marketing trailer in AAAK mode. Booking URLs already carry UTM (`utm_source=aloha-mcp`, `utm_campaign=mcp-<client>`) — attribution doesn't require trailer. | `AAAK_ENABLED` |
| **A-005** | Shadow rollout: enable for known well-behaved clients first (`claude-desktop`, `claude-code`), then ramp to all. Keep prose path until adoption metric (consumer-side `structuredContent` parse rate) hits target — measured via consumer telemetry, not ours. | per-client allowlist via `AAAK_CLIENTS` |

Each story is independently mergeable. A-001 is pure schema, ships first. A-002 ships dark behind the env gate. A-003 is observability only. A-004 + A-005 are the user-visible cutover and should ship together with a rollback plan.

## Telemetry

`mcp_requests` is already the right surface. Extend with:

```sql
ALTER TABLE mcp_requests ADD COLUMN response_mode TEXT;       -- 'legacy' | 'aaak'
ALTER TABLE mcp_requests ADD COLUMN response_bytes INT;       -- size of returned payload
ALTER TABLE mcp_requests ADD COLUMN structured_present BOOL;  -- true when structuredContent emitted
```

`/stats` should grow a section breaking down call volume by `response_mode` so the cutover is measurable. Until A-005 lands, `response_mode` distribution shows shadow-mode adoption.

## Open decisions (block A-001 until resolved)

### 1. Protocol version bump

Today's server advertises MCP `2025-03-26` (see `README.md`, `http.ts`). The MCP `CallToolResult.structuredContent` field landed in spec version `2025-06-18`. Two paths:

- **Bump protocolVersion** to `2025-06-18` and require clients to support it. Cleanest, but breaks any client pinned to the older version.
- **Ship JSON-in-text fallback** — emit `\`\`\`json ... \`\`\`` inside the `text` block in addition to (or instead of) `structuredContent`. Works with every client. Uglier on the wire.

**Recommendation:** ship both — `structuredContent` for clients on `2025-06-18+`, JSON-in-text fenced block in the `text` field for older clients. Zero-cost for the server, maximum consumer reach. Decide before A-002.

### 2. Keep or kill the human-readable text block in v0.2?

Once `structuredContent` adoption is healthy, the `text` block is overhead. But `claude.ai`-style clients render it as the user-visible response — killing it makes tool output unreadable to humans. Options:

- Keep prose forever (current plan). Pay the token cost.
- Auto-generate prose from `structuredContent` at the SDK layer (consumer side), keep AAAK server emitting structured-only. Cleaner long-term, depends on consumer-side libraries we don't own.

**Recommendation:** keep prose for v0.1 + v0.2. Revisit after A-005 telemetry shows what fraction of clients ignore `text`.

### 3. Restaurant `website` click-through

In `find_hawaii_restaurants` the `r.website` value is UTM-stamped but routed through `registerClickTarget` only in some code paths. AAAK row should always carry the `/r/{code}` URL when DB is available, raw URL otherwise. Standardize this in A-002 — don't fix it in a separate cleanup PR.

### 4. Itinerary section shape

Spec above uses a flat `sections: Array<{slot, type, item}>` with tagged union. Alternative: typed object `{ morning: Experience, lunch: Restaurant, afternoon: Experience, dinner: Restaurant }`. Object form is easier to consume but rigid — adding a new slot (sunset, late-night) breaks the schema. Flat form is forwards-compatible.

**Recommendation:** flat array. Lock in before A-001.

### 5. `weather` tool affiliate posture

`get_hawaii_weather` returns no booking URL — there's nothing to book about weather. The `booking_url` invariant doesn't apply to weather rows. Either:

- Define a separate `WeatherResponse` envelope without the invariant (clean).
- Add `booking_url: null` to weather and document that the invariant is "preserved when applicable" (loose).

**Recommendation:** separate envelope. The invariants list is a contract for revenue-generating tools; weather isn't one.

## Non-goals for v0.1

- Multi-language output. Prose `text` is English; `structuredContent` is data, not localized strings. v0.2.
- Streaming responses. Stateless server, all tools return ≤ 20 rows. No streaming need.
- Per-row caching keys. Tool-level cache (5min TTL) is already in place; per-row TTLs are out of scope.
- Cross-tool composition (e.g. weather → tour filter). That belongs in the consumer agent, not the MCP server.

## Acceptance for v0.1 (close-out criteria)

- `docs/aaak.schema.json` exists, generated from zod, validates against a hand-written conformance fixture for each tool.
- All 6 tools route through the adapter (A-002), emit `structuredContent` behind `AAAK_ENABLED=true`, and pass schema validation against a fixture set.
- `mcp_requests` carries `response_mode`, `response_bytes`, `structured_present`.
- `/stats` reports `response_mode` distribution.
- One end-to-end consumer parsing test (Claude Desktop or `mcp-inspector`) confirms `structuredContent` is received and parses cleanly.

When all five hold, AAAK v0.1 ships and the open-decisions list above moves to a v0.2 doc.
