/**
 * Adapter smoke test — runs each row mapper + envelope builder with
 * synthetic inputs that mimic real DB / API shapes, then validates the
 * resulting envelope against the matching AAAK schema.
 *
 *   npm run aaak:smoke
 *
 * This is what catches drift between the adapter (A-002) and the schemas
 * (A-001). The conform.ts runner only checks hand-written fixtures; this
 * one exercises the actual code path the live MCP handlers use.
 */

import {
  buildResultEnvelope,
  buildEmptyEnvelope,
  buildErrorEnvelope,
  experienceSection,
  fallbackSection,
  inferIsland,
  mapEvent,
  mapExperience,
  mapRestaurant,
  mapWeather,
  restaurantSection,
} from "../../lib/aaak-adapter.js";
import { RESPONSE_SCHEMAS, type ToolName } from "../../lib/aaak.js";

interface Case {
  name: string;
  tool: ToolName;
  envelope: Record<string, unknown>;
}

const cases: Case[] = [];

// ── search_hawaii_tours: 1 row with all invariants populated ──
{
  const dbRow = {
    title: "Hanauma Bay Half-Day Snorkel",
    description: "Guided snorkeling at Oahu's most famous reef. Includes gear and transport from Waikiki.",
    category: "tour",
    area: "east_oahu",
    price_cents: 8900,
    source: "viator",
    affiliate_url: "https://www.viator.com/tours/Oahu/Hanauma-Bay-Snorkel/d278-12345",
    rating: 4.7,
    review_count: 2341,
  };
  const url = "https://aloha.fyi/r/aB3kT9pQz1";
  const aaak = mapExperience(dbRow, url, "oahu");
  cases.push({
    name: "tours/result",
    tool: "search_hawaii_tours",
    envelope: buildResultEnvelope({
      tool: "search_hawaii_tours",
      rows: [aaak],
      query: { query: "snorkeling", island: "oahu" },
      cached: false,
    }),
  });
}

// ── search_hawaii_tours: empty ──
cases.push({
  name: "tours/empty",
  tool: "search_hawaii_tours",
  envelope: buildEmptyEnvelope({ tool: "search_hawaii_tours", query: { query: "ice fishing" } }),
});

// ── get_hawaii_deals: groupon row marked is_deal ──
{
  const dbRow = {
    title: "Magic of Polynesia Discount",
    description: "Polynesian dinner show in Waikiki — discount admission tier.",
    area: "waikiki",
    price_cents: 4900,
    source: "groupon",
    affiliate_url: "https://www.anrdoezrs.net/click-7903538-5840172?url=https://groupon.com/...",
    rating: 4.4,
    review_count: 812,
  };
  const url = "https://aloha.fyi/r/qP9wL2vDx4";
  const aaak = mapExperience(dbRow, url);
  if (!aaak.is_deal) throw new Error("groupon row should be flagged is_deal=true");
  cases.push({
    name: "deals/result",
    tool: "get_hawaii_deals",
    envelope: buildResultEnvelope({ tool: "get_hawaii_deals", rows: [aaak] }),
  });
}

// ── search_hawaii_events: nested venue object + null ticket_url ──
{
  const e1 = mapEvent(
    {
      name: "Henry Kapono at Duke's",
      date: "2026-05-02",
      time: "4:00 PM",
      venue: { name: "Duke's Waikiki" },  // nested form (real data has both)
      island: "oahu",
      price: "Free with dinner",
      url: null,
    },
    null,
  );
  const e2 = mapEvent(
    {
      name: "Jack Johnson Concert",
      date: "2026-05-04",
      time: "7:00 PM",
      venue: "Waikiki Shell",
      island: "oahu",
      price: "$45-$120",
    },
    "https://aloha.fyi/r/eK7tY3pNb9",
  );
  cases.push({
    name: "events/result",
    tool: "search_hawaii_events",
    envelope: buildResultEnvelope({ tool: "search_hawaii_events", rows: [e1, e2] }),
  });
}

// ── get_hawaii_weather: full OpenMeteo-shaped response ──
{
  const om = {
    current: {
      temperature_2m: 81.4,
      apparent_temperature: 84.1,
      relative_humidity_2m: 68,
      uv_index: 9,
      wind_speed_10m: 12.3,
      precipitation: 0,
    },
    daily: {
      time: ["2026-04-29", "2026-04-30", "2026-05-01"],
      temperature_2m_min: [73.1, 72.4, 71.0],
      temperature_2m_max: [84.2, 83.5, 82.7],
      precipitation_probability_max: [10, 30, 40],
      wind_speed_10m_max: [14.2, 16.0, 18.5],
      uv_index_max: [10, 9, 8],
    },
  };
  const w = mapWeather("oahu", "Oʻahu", om);
  cases.push({
    name: "weather/result",
    tool: "get_hawaii_weather",
    envelope: buildResultEnvelope({ tool: "get_hawaii_weather", rows: [w] }),
  });
}

// ── get_hawaii_weather: external API failure ──
cases.push({
  name: "weather/external_failed",
  tool: "get_hawaii_weather",
  envelope: buildErrorEnvelope({
    tool: "get_hawaii_weather",
    code: "external_api_failed",
    message: "OpenMeteo 503",
    query: { island: "maui", days: 3 },
  }),
});

// ── find_hawaii_restaurants: with website + null website ──
{
  const r1 = mapRestaurant(
    {
      name: "Ono Seafood",
      category: "poke",
      neighborhood: "Kapahulu",
      description: "Walk-up poke counter with day-boat ahi.",
      rating: 4.7,
      review_count: 3104,
      price_level: "$",
      website: "https://onoseafood.com",
      phone: "(808) 732-4806",
    },
    "https://aloha.fyi/r/oN1sFp2rA8",
  );
  const r2 = mapRestaurant(
    {
      name: "Mom's Diner",
      category: "casual",
      neighborhood: null,
      description: null,
      rating: null,
      review_count: null,
      price_level: null,
      website: null,
      phone: null,
    },
    null,
  );
  cases.push({
    name: "restaurants/result",
    tool: "find_hawaii_restaurants",
    envelope: buildResultEnvelope({ tool: "find_hawaii_restaurants", rows: [r1, r2] }),
  });
}

// ── plan_hawaii_day: full itinerary with mixed sections including fallback ──
{
  const exp = mapExperience(
    {
      title: "Diamond Head Sunset Hike",
      area: "waikiki",
      category: "tour",
      price_cents: 4500,
      source: "viator",
      affiliate_url: "https://viator.com/diamond-head",
      rating: 4.6,
      review_count: 980,
      description: "Guided sunset hike to Diamond Head crater rim.",
    },
    "https://aloha.fyi/r/dH4xQ7vCm2",
    "oahu",
  );
  const rest = mapRestaurant(
    {
      name: "Helena's Hawaiian Food",
      category: "local-plate",
      neighborhood: "Kalihi",
      description: "James Beard classic. Kalua pig, pipikaula, lau lau.",
      rating: 4.6,
      review_count: 1240,
      price_level: "$$",
      website: null,
      phone: null,
    },
    null,
  );
  const itinerary = {
    island: inferIsland(null, "oahu"),
    island_label: "Oʻahu",
    vibe: "chill" as const,
    budget_per_person_dollars: 300,
    sections: [
      experienceSection("morning", exp),
      restaurantSection("lunch", rest),
      experienceSection("afternoon", exp),
      fallbackSection("dinner", "no candidate restaurant matched filters"),
    ],
  };
  cases.push({
    name: "plan/result",
    tool: "plan_hawaii_day",
    envelope: buildResultEnvelope({ tool: "plan_hawaii_day", rows: [itinerary] }),
  });
}

// ── plan_hawaii_day: not_enough_data error ──
cases.push({
  name: "plan/not_enough_data",
  tool: "plan_hawaii_day",
  envelope: buildErrorEnvelope({
    tool: "plan_hawaii_day",
    code: "not_enough_data",
    message: "Not enough adventure experiences on Kauai under $50.",
    query: { island: "kauai", vibe: "adventure", max_budget_per_person: 50 },
  }),
});

// ── Run validation ──

let failed = 0;
for (const c of cases) {
  const schema = RESPONSE_SCHEMAS[c.tool];
  const result = schema.safeParse(c.envelope);
  if (result.success) {
    console.log(`✓ ${c.name}`);
  } else {
    console.log(`✗ ${c.name}`);
    for (const issue of result.error.issues) {
      console.log(`    - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    failed++;
  }
}

console.log(`\n${cases.length - failed}/${cases.length} adapter outputs conform${failed ? `, ${failed} failed` : ""}.`);
process.exit(failed === 0 ? 0 : 1);
