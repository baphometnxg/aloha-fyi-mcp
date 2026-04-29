/**
 * AAAK adapter — bridges DB rows / external API payloads into typed AAAK
 * envelopes, and decides whether to attach `structuredContent` to a
 * CallToolResult based on the AAAK_ENABLED env gate.
 *
 *   See lib/aaak.ts for the schemas.
 *   See docs/aaak-spec.md for the contract.
 *
 * Story: A-002 (response adapter), A-003 (telemetry stamps).
 *
 * Design notes:
 *   - This module never throws. Bad inputs produce best-effort output and
 *     the resulting envelope will fail schema validation upstream — that's
 *     a desired signal, not a runtime bug.
 *   - `isAAAKEnabled()` is read per-call so flipping the env var via Railway
 *     restart-free reload (or a future runtime toggle) takes effect without
 *     re-deploying the server.
 *   - `responseBytes` is approximated via JSON.stringify length on the
 *     CallToolResult. It does not include MCP transport framing — it's a
 *     trend signal, not a billing meter.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  Experience,
  Event as AAAKEvent,
  Restaurant,
  Itinerary,
  ItinerarySection,
  Weather,
  ToolName,
  ErrorCode,
  Island,
} from "./aaak.js";

// ── Env gate ───────────────────────────────────────────────────────────────

export function isAAAKEnabled(): boolean {
  const raw = (process.env.AAAK_ENABLED || "").toLowerCase().trim();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

// ── Telemetry stamp (A-003) ────────────────────────────────────────────────

export interface AAAKLogStamp {
  responseMode: "legacy" | "aaak";
  structuredPresent: boolean;
  responseBytes: number;
}

// ── Island inference ───────────────────────────────────────────────────────

/**
 * Best-effort island guess from a free-text `area` value (e.g. "waikiki",
 * "north_shore", "kihei", "kona"). The catalog doesn't carry an island
 * column today; we derive it. Falls back to the query island, then to
 * "oahu" (the long-tail default — most rows are Oahu).
 */
export function inferIsland(area: string | null | undefined, queryIsland?: string): Island {
  if (area) {
    const a = area.toLowerCase();
    if (/maui|lahaina|kihei|wailea|hana|kahului|paia|makawao/.test(a)) return "maui";
    if (/big[- _]?island|kona|hilo|waikoloa|kailua-kona|volcano|hawi|honokaa/.test(a)) return "big_island";
    if (/kauai|poipu|princeville|hanalei|lihue|kapaa|waimea/.test(a)) return "kauai";
    return "oahu";
  }
  if (
    queryIsland === "oahu" ||
    queryIsland === "maui" ||
    queryIsland === "big_island" ||
    queryIsland === "kauai"
  ) {
    return queryIsland;
  }
  return "oahu";
}

// ── Per-tool row mappers ───────────────────────────────────────────────────

/**
 * Map an `experiences` table row → AAAK Experience. The caller is
 * responsible for resolving the booking_url through the click-target
 * registrar (so we get /r/{code} when DB is reachable).
 */
export function mapExperience(
  row: Record<string, any>,
  bookingUrl: string,
  queryIsland?: string,
): Experience {
  const island = inferIsland(row.area, queryIsland);
  return {
    title: String(row.title ?? ""),
    source: row.source as Experience["source"],
    island,
    area: row.area ?? null,
    category: row.category ?? null,
    price_cents: row.price_cents ?? null,
    rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : null,
    review_count: row.review_count ?? null,
    description: String(row.description ?? "").slice(0, 140),
    booking_url: bookingUrl,
    is_deal: row.source === "groupon",
  };
}

/** Map a hawaii-events.json record → AAAK Event. */
export function mapEvent(e: Record<string, any>, ticketUrl: string | null): AAAKEvent {
  const venue = typeof e.venue === "object" ? (e.venue?.name ?? null) : (e.venue ?? null);
  const island: Island =
    e.island === "maui" || e.island === "big_island" || e.island === "kauai" ? e.island : "oahu";
  return {
    name: String(e.name ?? ""),
    date: String(e.date ?? ""),
    time: e.time ?? null,
    venue,
    island,
    price: e.price ?? null,
    ticket_url: ticketUrl,
  };
}

/** Map a `waikiki_directory` row → AAAK Restaurant. */
export function mapRestaurant(row: Record<string, any>, websiteUrl: string | null): Restaurant {
  return {
    name: String(row.name ?? ""),
    category: String(row.category ?? ""),
    neighborhood: row.neighborhood ?? null,
    description: String(row.description ?? "").slice(0, 140),
    rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : null,
    review_count: row.review_count ?? null,
    price_level: row.price_level ?? null,
    website: websiteUrl,
    phone: row.phone ?? null,
    island: "oahu",
  };
}

/**
 * Map an OpenMeteo response → AAAK Weather. Caller passes the resolved
 * `island` enum and the human label from ISLAND_COORDS.
 */
export function mapWeather(island: Island, islandLabel: string, w: any): Weather {
  const cur = w?.current ?? {};
  const daily = w?.daily ?? {};
  const days: Weather["forecast"] = [];
  const times: string[] = daily.time ?? [];
  for (let i = 0; i < times.length; i++) {
    days.push({
      date: times[i],
      temp_f_min: Math.round(daily.temperature_2m_min?.[i] ?? 0),
      temp_f_max: Math.round(daily.temperature_2m_max?.[i] ?? 0),
      precip_probability_pct: Math.round(daily.precipitation_probability_max?.[i] ?? 0),
      wind_mph_max: Math.round(daily.wind_speed_10m_max?.[i] ?? 0),
      uv_index_max:
        daily.uv_index_max?.[i] !== undefined && daily.uv_index_max?.[i] !== null
          ? Math.round(daily.uv_index_max[i])
          : null,
    });
  }
  return {
    island,
    island_label: islandLabel,
    current: {
      temperature_f: Math.round(cur.temperature_2m ?? 0),
      feels_like_f: Math.round(cur.apparent_temperature ?? 0),
      humidity_pct: Math.max(0, Math.min(100, Math.round(cur.relative_humidity_2m ?? 0))),
      uv_index: cur.uv_index ?? null,
      wind_mph: Math.round(cur.wind_speed_10m ?? 0),
      precipitation_in: cur.precipitation ?? 0,
    },
    forecast: days,
  };
}

// ── Envelope builders ──────────────────────────────────────────────────────

const PROTOCOL = "aaak/0.1" as const;

interface ResultEnvelopeInput<T> {
  tool: ToolName;
  rows: T[];
  query?: Record<string, unknown>;
  cached?: boolean;
}

interface EmptyEnvelopeInput {
  tool: ToolName;
  query?: Record<string, unknown>;
}

interface ErrorEnvelopeInput {
  tool: ToolName;
  code: ErrorCode;
  message: string;
  query?: Record<string, unknown>;
}

function sourceDiversity(rows: any[]): number {
  const set = new Set<string>();
  for (const r of rows) {
    if (r && typeof r === "object" && typeof r.source === "string") set.add(r.source);
  }
  return set.size;
}

export function buildResultEnvelope<T>(input: ResultEnvelopeInput<T>) {
  const meta: Record<string, unknown> = { count: input.rows.length };
  if (input.cached !== undefined) meta.cached = input.cached;
  const sd = sourceDiversity(input.rows as any[]);
  if (sd > 0) meta.source_diversity = sd;
  return {
    ok: true as const,
    kind: "result" as const,
    tool: input.tool,
    protocol: PROTOCOL,
    query: input.query,
    results: input.rows,
    meta,
  };
}

export function buildEmptyEnvelope(input: EmptyEnvelopeInput) {
  return {
    ok: true as const,
    kind: "empty_result" as const,
    tool: input.tool,
    protocol: PROTOCOL,
    query: input.query,
    results: [] as never[],
    meta: { count: 0 },
  };
}

export function buildErrorEnvelope(input: ErrorEnvelopeInput) {
  return {
    ok: false as const,
    kind: "error" as const,
    tool: input.tool,
    protocol: PROTOCOL,
    query: input.query,
    error: { code: input.code, message: input.message },
  };
}

// ── CallToolResult assembly ────────────────────────────────────────────────

interface MakeResultOpts {
  text: string;
  envelope: Record<string, unknown>;  // any of the three envelope shapes above
  isError?: boolean;
}

/**
 * Assemble the final CallToolResult and stamp the telemetry context.
 * `structuredContent` is attached only when AAAK_ENABLED is truthy.
 */
export function makeToolResult(opts: MakeResultOpts): { result: CallToolResult; stamp: AAAKLogStamp } {
  const enabled = isAAAKEnabled();
  const result: CallToolResult = {
    content: [{ type: "text", text: opts.text }],
  };
  if (opts.isError) result.isError = true;
  if (enabled) {
    result.structuredContent = opts.envelope;
  }
  const stamp: AAAKLogStamp = {
    responseMode: enabled ? "aaak" : "legacy",
    structuredPresent: enabled,
    responseBytes: JSON.stringify(result).length,
  };
  return { result, stamp };
}

// ── Itinerary section helpers ──────────────────────────────────────────────

export function experienceSection(slot: ItinerarySection["slot"], item: Experience): ItinerarySection {
  return { slot, type: "experience", item };
}

export function restaurantSection(slot: ItinerarySection["slot"], item: Restaurant): ItinerarySection {
  return { slot, type: "restaurant", item };
}

export function fallbackSection(slot: ItinerarySection["slot"], reason: string): ItinerarySection {
  return { slot, type: "fallback", item: { fallback_reason: reason } };
}
