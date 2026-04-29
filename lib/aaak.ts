/**
 * AAAK — Agent-to-Agent Adaptive Knowledge (v0.1, story A-001)
 *
 * Zod schemas defining the structured response contract for all six MCP tools.
 *
 *   See docs/aaak-spec.md for design rationale and rollout plan.
 *
 * Invariants (lossless across all tools that recommend a bookable item):
 *   booking_url  — affiliate revenue
 *   source       — compliance + attribution
 *   price_cents  — only numeric field user decisions hinge on
 *   island       — every recommendation is island-scoped
 *
 * Weather is the explicit exception — see WeatherResponse below — it carries
 * no booking surface, so the invariant list does not apply to it.
 *
 * This file is pure schema. No runtime side effects, no imports beyond zod.
 * A-002 will wire these into the tool handlers; A-003 adds telemetry; A-004/5
 * gate behind AAAK_ENABLED and roll out.
 */

import { z } from "zod";

// ── Shared primitives ──────────────────────────────────────────────────────

/** The four Hawaiian islands the catalog covers. Locked at the route level. */
export const Island = z.enum(["oahu", "maui", "big_island", "kauai"]);
export type Island = z.infer<typeof Island>;

/** Booking platforms we surface, plus first-party for events/restaurants. */
export const Source = z.enum([
  "viator",
  "gyg",
  "klook",
  "groupon",
  "events",       // first-party event listings (data/hawaii-events.json)
  "restaurant",   // waikiki_directory rows
]);
export type Source = z.infer<typeof Source>;

/** Distinct error codes — one per failure mode the consumer can branch on. */
export const ErrorCode = z.enum([
  "db_not_configured",
  "db_query_failed",
  "not_enough_data",        // plan_hawaii_day with too few candidates
  "external_api_failed",    // OpenMeteo, etc.
  "rate_limited",
  "daily_quota_exceeded",
  "invalid_arguments",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Description ceiling — applied uniformly to bound row size. */
const Description = z.string().max(140);

// ── Per-tool result row schemas ────────────────────────────────────────────

/**
 * Experience — search_hawaii_tours and get_hawaii_deals.
 *
 * INVARIANTS: booking_url, source, price_cents, island all required-or-null
 *             with no compression treatment.
 */
export const Experience = z.object({
  title: z.string().min(1),
  source: Source.exclude(["events", "restaurant"]),
  island: Island,
  area: z.string().nullable(),
  category: z.string().nullable(),
  price_cents: z.number().int().nonnegative().nullable(),
  rating: z.number().min(0).max(5).nullable(),
  review_count: z.number().int().nonnegative().nullable(),
  description: Description,
  booking_url: z.string().url(),
  is_deal: z.boolean(),
});
export type Experience = z.infer<typeof Experience>;

/**
 * Event — search_hawaii_events.
 *
 * Date is ISO YYYY-MM-DD. Time is freeform ("8:00 PM", "Doors 7pm") because
 * the source data isn't normalized. Price is freeform for the same reason.
 */
export const Event = z.object({
  name: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().nullable(),
  venue: z.string().nullable(),
  island: Island,
  price: z.string().nullable(),
  ticket_url: z.string().url().nullable(),
});
export type Event = z.infer<typeof Event>;

/**
 * Restaurant — find_hawaii_restaurants. Oahu-only today (waikiki_directory
 * is Oahu). When other-island restaurant data lands, widen `island`.
 */
export const Restaurant = z.object({
  name: z.string().min(1),
  category: z.string(),
  neighborhood: z.string().nullable(),
  description: Description,
  rating: z.number().min(0).max(5).nullable(),
  review_count: z.number().int().nonnegative().nullable(),
  price_level: z.string().nullable(),       // "$" through "$$$$"
  website: z.string().url().nullable(),     // /r/{code} when DB available
  phone: z.string().nullable(),
  island: z.literal("oahu"),
});
export type Restaurant = z.infer<typeof Restaurant>;

/**
 * Itinerary section — flat tagged-union shape (decision locked in spec).
 * Adding a new slot ("sunset", "late-night") is forwards-compatible.
 */
export const ItinerarySection = z.discriminatedUnion("type", [
  z.object({
    slot: z.enum(["morning", "lunch", "afternoon", "dinner"]),
    type: z.literal("experience"),
    item: Experience,
  }),
  z.object({
    slot: z.enum(["morning", "lunch", "afternoon", "dinner"]),
    type: z.literal("restaurant"),
    item: Restaurant,
  }),
  z.object({
    slot: z.enum(["morning", "lunch", "afternoon", "dinner"]),
    type: z.literal("fallback"),
    item: z.object({ fallback_reason: z.string() }),
  }),
]);
export type ItinerarySection = z.infer<typeof ItinerarySection>;

export const Itinerary = z.object({
  island: Island,
  island_label: z.string(),
  vibe: z.enum(["adventure", "chill", "cultural", "romantic", "family", "budget"]),
  budget_per_person_dollars: z.number().int().nonnegative(),
  sections: z.array(ItinerarySection),
});
export type Itinerary = z.infer<typeof Itinerary>;

/**
 * Weather — separate envelope. No booking_url, no `source` invariant.
 * The booking-URL invariant is a contract for revenue-generating tools;
 * weather is informational and rides its own response shape.
 */
export const Weather = z.object({
  island: Island,
  island_label: z.string(),
  current: z.object({
    temperature_f: z.number(),
    feels_like_f: z.number(),
    humidity_pct: z.number().min(0).max(100),
    uv_index: z.number().nullable(),
    wind_mph: z.number().min(0),
    precipitation_in: z.number().min(0),
  }),
  forecast: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      temp_f_min: z.number(),
      temp_f_max: z.number(),
      precip_probability_pct: z.number().min(0).max(100),
      wind_mph_max: z.number().min(0),
      uv_index_max: z.number().nullable(),
    })
  ),
});
export type Weather = z.infer<typeof Weather>;

// ── Envelope ───────────────────────────────────────────────────────────────

const Meta = z.object({
  count: z.number().int().nonnegative(),
  cached: z.boolean().optional(),
  source_diversity: z.number().int().nonnegative().optional(),
});

const ErrorObject = z.object({
  code: ErrorCode,
  message: z.string(),
});

/**
 * Generic envelope factory. The three `kind` values are mutually exclusive
 * shapes — successful results, deliberate empties, and errors — encoded as a
 * discriminated union on `kind` so consumers can switch without sniffing.
 */
function makeEnvelope<T extends z.ZodTypeAny>(toolName: string, resultSchema: T) {
  const Tool = z.literal(toolName);
  const Protocol = z.literal("aaak/0.1");
  const Query = z.record(z.unknown()).optional();

  return z.discriminatedUnion("kind", [
    z.object({
      ok: z.literal(true),
      kind: z.literal("result"),
      tool: Tool,
      protocol: Protocol,
      query: Query,
      results: z.array(resultSchema),
      meta: Meta,
    }),
    z.object({
      ok: z.literal(true),
      kind: z.literal("empty_result"),
      tool: Tool,
      protocol: Protocol,
      query: Query,
      results: z.array(resultSchema).length(0),
      meta: Meta,
    }),
    z.object({
      ok: z.literal(false),
      kind: z.literal("error"),
      tool: Tool,
      protocol: Protocol,
      query: Query,
      error: ErrorObject,
    }),
  ]);
}

// ── Per-tool envelope schemas ──────────────────────────────────────────────

export const SearchHawaiiToursResponse = makeEnvelope("search_hawaii_tours", Experience);
export const GetHawaiiDealsResponse    = makeEnvelope("get_hawaii_deals",    Experience);
export const SearchHawaiiEventsResponse = makeEnvelope("search_hawaii_events", Event);
export const FindHawaiiRestaurantsResponse = makeEnvelope("find_hawaii_restaurants", Restaurant);
export const PlanHawaiiDayResponse     = makeEnvelope("plan_hawaii_day",     Itinerary);
export const GetHawaiiWeatherResponse  = makeEnvelope("get_hawaii_weather",  Weather);

export type SearchHawaiiToursResponse      = z.infer<typeof SearchHawaiiToursResponse>;
export type GetHawaiiDealsResponse         = z.infer<typeof GetHawaiiDealsResponse>;
export type SearchHawaiiEventsResponse     = z.infer<typeof SearchHawaiiEventsResponse>;
export type FindHawaiiRestaurantsResponse  = z.infer<typeof FindHawaiiRestaurantsResponse>;
export type PlanHawaiiDayResponse          = z.infer<typeof PlanHawaiiDayResponse>;
export type GetHawaiiWeatherResponse       = z.infer<typeof GetHawaiiWeatherResponse>;

/** Map tool name → response schema, used by the conformance test runner. */
export const RESPONSE_SCHEMAS = {
  search_hawaii_tours: SearchHawaiiToursResponse,
  get_hawaii_deals: GetHawaiiDealsResponse,
  search_hawaii_events: SearchHawaiiEventsResponse,
  find_hawaii_restaurants: FindHawaiiRestaurantsResponse,
  plan_hawaii_day: PlanHawaiiDayResponse,
  get_hawaii_weather: GetHawaiiWeatherResponse,
} as const;

export type ToolName = keyof typeof RESPONSE_SCHEMAS;
