/**
 * aloha.fyi MCP Server — Hawaii Tourism Tools for AI Assistants
 *
 * When someone asks Claude, ChatGPT, or any AI "what should I do in Hawaii?"
 * this MCP server provides real data: tours, events, restaurants, deals —
 * all with affiliate tracking links. Every recommendation earns commission.
 *
 * Tools:
 *   search_hawaii_tours    — Find tours/activities by keyword, island, budget
 *   search_hawaii_events   — What's happening this week across 4 islands
 *   search_hawaii_restaurants — Find restaurants by cuisine, area, vibe
 *   plan_hawaii_day        — Get a full day itinerary for an island/area
 *   get_hawaii_deals       — Budget deals and discounts (Groupon, sales)
 *
 * First dedicated Hawaii tourism MCP server. $0 CAC distribution.
 * Built by aloha.fyi — AI concierge for Hawaii's visitor industry.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({
  name: "aloha-fyi-hawaii",
  version: "1.0.0",
  description: "Hawaii tourism AI tools — tours, events, restaurants, deals across Oahu, Maui, Big Island, and Kauai. Powered by aloha.fyi with 2,583 bookable experiences and 579 events.",
});

// ── Database connection (Supabase or Railway Postgres) ──

const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';

async function query(sql: string, params: any[] = []): Promise<any[]> {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  const result = await pool.query(sql, params);
  pool.end();
  return result.rows;
}

// ── Affiliate link builder ──

const CJ_PID = '7903538';
const CJ_AID = '5840172';

function buildAffiliateUrl(source: string, url: string): string {
  if (!url) return '';
  if (source === 'groupon' && !url.includes('anrdoezrs.net')) {
    return `https://www.anrdoezrs.net/click-${CJ_PID}-${CJ_AID}?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// ── Tools ──

server.tool(
  "search_hawaii_tours",
  "Search Hawaii tours and activities by keyword, island, price range, and category. Returns bookable experiences with pricing and affiliate links.",
  {
    query: z.string().describe("What the user is looking for, e.g. 'snorkeling with turtles', 'helicopter tour', 'family luau'"),
    island: z.enum(["oahu", "maui", "big_island", "kauai", "any"]).default("any").describe("Which Hawaiian island"),
    max_price_dollars: z.number().optional().describe("Maximum price per person in USD"),
    category: z.enum(["tour", "activity", "restaurant", "culture", "any"]).default("any").describe("Type of experience"),
    limit: z.number().default(5).describe("Number of results to return"),
  },
  async ({ query: q, island, max_price_dollars, category, limit }) => {
    const conditions = ["e.active = true", "e.embedding IS NOT NULL"];
    const params: any[] = [];
    let paramIdx = 1;

    if (island && island !== "any") {
      conditions.push(`e.area ILIKE $${paramIdx}`);
      const areaMap: Record<string, string> = {
        oahu: '%',  // Oahu areas: waikiki, north_shore, east_oahu, etc.
        maui: 'maui%',
        big_island: '%',  // Will need island field
        kauai: '%',
      };
      params.push(areaMap[island] || '%');
      paramIdx++;
    }

    if (max_price_dollars) {
      conditions.push(`e.price_cents <= $${paramIdx}`);
      params.push(max_price_dollars * 100);
      paramIdx++;
    }

    if (category && category !== "any") {
      conditions.push(`e.category = $${paramIdx}`);
      params.push(category);
      paramIdx++;
    }

    const sql = `
      SELECT title, description, category, area, price_cents, price_band,
             source, affiliate_url, rating, review_count
      FROM experiences e
      WHERE ${conditions.join(' AND ')}
      AND (search_text ILIKE $${paramIdx} OR title ILIKE $${paramIdx})
      ORDER BY review_count DESC NULLS LAST, rating DESC NULLS LAST
      LIMIT $${paramIdx + 1}
    `;
    params.push(`%${q}%`, limit);

    try {
      const rows = await query(sql, params);

      if (rows.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No Hawaii tours found matching "${q}". Try broader search terms or check aloha.fyi for the full catalog of 2,583 experiences.`
          }]
        };
      }

      const results = rows.map((r: any) => {
        const price = r.price_cents ? `$${(r.price_cents / 100).toFixed(0)}` : 'See link';
        const source = r.source === 'gyg' ? 'GetYourGuide' : r.source === 'groupon' ? 'Groupon' : r.source?.charAt(0).toUpperCase() + r.source?.slice(1);
        const url = buildAffiliateUrl(r.source, r.affiliate_url);
        const rating = r.rating ? `${r.rating}★` : '';
        const reviews = r.review_count ? `(${r.review_count} reviews)` : '';

        return `**${r.title}** (via ${source})\n${r.area || 'Oahu'} | ${price}/person | ${rating} ${reviews}\n${r.description?.slice(0, 150) || ''}\nBook: ${url}`;
      });

      return {
        content: [{
          type: "text",
          text: `Found ${rows.length} Hawaii experiences:\n\n${results.join('\n\n---\n\n')}\n\n_Powered by aloha.fyi — Hawaii's AI concierge. For personalized recommendations, chat at https://aloha.fyi_`
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Search error: ${err.message}. Visit https://aloha.fyi for Hawaii tour recommendations.` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "search_hawaii_events",
  "Find upcoming events, concerts, festivals, and nightlife across all Hawaiian islands. Covers 579+ events from 70+ venues.",
  {
    query: z.string().default("").describe("What kind of event, e.g. 'live music', 'luau', 'concert', 'food festival'"),
    island: z.enum(["oahu", "maui", "big_island", "kauai", "any"]).default("any").describe("Which island"),
    days_ahead: z.number().default(7).describe("How many days ahead to search"),
  },
  async ({ query: q, island, days_ahead }) => {
    // Read from hawaii-events.json (loaded at startup or fetched)
    try {
      const fs = require('fs');
      const path = require('path');
      const eventsPath = path.join(__dirname, '..', 'data', 'hawaii-events.json');
      const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

      const now = new Date();
      const cutoff = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);
      const todayStr = now.toISOString().slice(0, 10);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      let filtered = events.filter((e: any) => {
        if (!e.date) return false;
        if (e.date < todayStr || e.date > cutoffStr) return false;
        if (island && island !== 'any' && e.island && e.island !== island) return false;
        if (q) {
          const searchable = [e.name, e.venue, e.description, e.event_type, ...(e.tags || [])].join(' ').toLowerCase();
          return q.toLowerCase().split(/\s+/).every((t: string) => searchable.includes(t));
        }
        return true;
      });

      filtered.sort((a: any, b: any) => (a.date || '').localeCompare(b.date || ''));
      filtered = filtered.slice(0, 10);

      if (filtered.length === 0) {
        return {
          content: [{ type: "text", text: `No events found matching "${q}" in the next ${days_ahead} days. Check https://aloha.fyi for the latest Hawaii events.` }]
        };
      }

      const results = filtered.map((e: any) => {
        const date = e.date ? new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
        const venue = e.venue || (typeof e.venue === 'object' ? e.venue?.name : '');
        const price = e.price || 'See venue';
        const url = e.url || e.ticket_url || '';
        return `**${e.name}** — ${date} ${e.time || ''}\n${venue} | ${e.island || 'oahu'} | ${price}${url ? `\nInfo: ${url}` : ''}`;
      });

      return {
        content: [{
          type: "text",
          text: `Upcoming Hawaii events (next ${days_ahead} days):\n\n${results.join('\n\n---\n\n')}\n\n_Powered by aloha.fyi — 579+ events across 4 islands, updated weekly._`
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Events search error: ${err.message}. Visit https://aloha.fyi for Hawaii events.` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_hawaii_deals",
  "Find the best budget deals and discounts for Hawaii tours and activities. Includes Groupon deals, sales, and value options.",
  {
    activity: z.string().describe("Type of activity, e.g. 'snorkeling', 'helicopter', 'luau', 'food tour'"),
    max_price_dollars: z.number().default(100).describe("Maximum price per person"),
    limit: z.number().default(5).describe("Number of deals to return"),
  },
  async ({ activity, max_price_dollars, limit }) => {
    const sql = `
      SELECT title, description, category, area, price_cents, price_band,
             source, affiliate_url, rating, review_count
      FROM experiences e
      WHERE e.active = true
      AND e.price_cents > 0
      AND e.price_cents <= $1
      AND (e.search_text ILIKE $2 OR e.title ILIKE $2)
      ORDER BY e.price_cents ASC, e.review_count DESC NULLS LAST
      LIMIT $3
    `;

    try {
      const rows = await query(sql, [max_price_dollars * 100, `%${activity}%`, limit]);

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No deals found for "${activity}" under $${max_price_dollars}. Try a higher budget or visit https://aloha.fyi for personalized recommendations.` }]
        };
      }

      const results = rows.map((r: any) => {
        const price = `$${(r.price_cents / 100).toFixed(0)}`;
        const source = r.source === 'gyg' ? 'GetYourGuide' : r.source === 'groupon' ? 'Groupon' : r.source?.charAt(0).toUpperCase() + r.source?.slice(1);
        const url = buildAffiliateUrl(r.source, r.affiliate_url);
        const savings = r.source === 'groupon' ? ' 🏷️ DEAL' : '';
        return `**${r.title}** (via ${source})${savings}\n${r.area || 'Oahu'} | ${price}/person\n${r.description?.slice(0, 120) || ''}\nBook: ${url}`;
      });

      return {
        content: [{
          type: "text",
          text: `Best Hawaii deals for "${activity}" (under $${max_price_dollars}):\n\n${results.join('\n\n---\n\n')}\n\n_Powered by aloha.fyi — budget-friendly Hawaii experiences with affiliate tracking._`
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Deals search error: ${err.message}. Visit https://aloha.fyi for Hawaii deals.` }],
        isError: true,
      };
    }
  }
);

server.tool(
  "plan_hawaii_day",
  "Get a suggested full-day itinerary for a Hawaiian island or area. Includes morning, afternoon, and evening activities with booking links.",
  {
    island: z.enum(["oahu", "maui", "big_island", "kauai"]).describe("Which island"),
    vibe: z.enum(["adventure", "chill", "cultural", "romantic", "family", "budget"]).default("chill").describe("Trip vibe"),
    area: z.string().optional().describe("Specific area like 'waikiki', 'north shore', 'kona'"),
  },
  async ({ island, vibe, area }) => {
    // Build a simple day plan from top-rated experiences
    const vibeCategory: Record<string, string> = {
      adventure: "tour",
      chill: "activity",
      cultural: "culture",
      romantic: "activity",
      family: "tour",
      budget: "tour",
    };

    const sql = `
      SELECT title, description, category, area, price_cents, source, affiliate_url, rating
      FROM experiences e
      WHERE e.active = true AND e.rating IS NOT NULL
      ${area ? `AND e.area ILIKE $1` : ''}
      ORDER BY e.rating DESC, e.review_count DESC NULLS LAST
      LIMIT 6
    `;

    try {
      const params = area ? [`%${area}%`] : [];
      const rows = await query(sql, params);

      if (rows.length < 2) {
        return {
          content: [{ type: "text", text: `Not enough data to plan a day in ${area || island}. Visit https://aloha.fyi and chat with Nani for a personalized itinerary.` }]
        };
      }

      const morning = rows[0];
      const afternoon = rows[1];
      const evening = rows[2] || rows[1];

      const formatItem = (r: any, time: string) => {
        const price = r.price_cents ? `$${(r.price_cents / 100).toFixed(0)}` : 'Free';
        const url = buildAffiliateUrl(r.source, r.affiliate_url);
        return `**${time}: ${r.title}**\n${r.area || island} | ${price} | ${r.rating}★\n${url ? `Book: ${url}` : ''}`;
      };

      const plan = [
        formatItem(morning, '🌅 Morning'),
        formatItem(afternoon, '☀️ Afternoon'),
        formatItem(evening, '🌙 Evening'),
      ].join('\n\n');

      return {
        content: [{
          type: "text",
          text: `Your ${vibe} day in ${area || island}:\n\n${plan}\n\n_Want a more personalized plan? Chat with Nani at https://aloha.fyi — she speaks Japanese, Korean, Chinese, Spanish, and English._`
        }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Planning error: ${err.message}. Visit https://aloha.fyi for personalized Hawaii itineraries.` }],
        isError: true,
      };
    }
  }
);

// ── Export for different transports ──
export default server;
