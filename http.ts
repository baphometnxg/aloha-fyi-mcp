/**
 * aloha.fyi MCP Server — Streamable HTTP transport (stateless)
 *
 * Real MCP protocol server for AI assistants (Claude, ChatGPT, etc.)
 * Returns Hawaii tourism data with affiliate booking links.
 *
 * Endpoints:
 *   GET  /health   — Railway health check (REST)
 *   POST /mcp      — MCP protocol endpoint (Streamable HTTP)
 *   GET  /mcp      — 405 (stateless mode)
 *   DELETE /mcp    — 405 (stateless mode)
 */

import express, { Request, Response } from "express";
import { z } from "zod";
import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── Database ──
const DB_URL = process.env.DATABASE_URL || "";
const pool = DB_URL
  ? new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ── Affiliate link builder ──
const CJ_PID = "7903538";
const CJ_AID = "5840172";

function buildAffiliateUrl(source: string, url: string): string {
  if (!url) return "";
  if (source === "groupon" && !url.includes("anrdoezrs.net")) {
    return `https://www.anrdoezrs.net/click-${CJ_PID}-${CJ_AID}?url=${encodeURIComponent(url)}`;
  }
  return url;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    gyg: "GetYourGuide",
    groupon: "Groupon",
    viator: "Viator",
    klook: "Klook",
  };
  return labels[source] || (source ? source.charAt(0).toUpperCase() + source.slice(1) : "");
}

// ── Build a fresh MCP server per request (stateless) ──
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "aloha-fyi-hawaii", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  // Tool: search_hawaii_tours
  server.registerTool(
    "search_hawaii_tours",
    {
      title: "Search Hawaii Tours",
      description: "Search 2,583 bookable Hawaii tours and activities by keyword, island, price range. Returns tours from Viator, GetYourGuide, Klook, and Groupon with affiliate booking links. Use this when users ask about Hawaii tours, activities, or things to do.",
      inputSchema: {
        query: z.string().describe("What to search for, e.g. 'snorkeling', 'helicopter tour', 'luau', 'family activities'"),
        island: z.enum(["oahu", "maui", "big_island", "kauai", "any"]).default("any").describe("Which Hawaiian island"),
        max_price_dollars: z.number().optional().describe("Maximum price per person in USD"),
        source: z.enum(["viator", "gyg", "klook", "groupon", "any"]).default("any").describe("Filter by booking platform"),
        limit: z.number().default(5).describe("Number of results (max 20)"),
      },
    },
    async ({ query, island, max_price_dollars, source, limit }): Promise<CallToolResult> => {
      if (!pool) {
        return { content: [{ type: "text", text: "Database not configured. Visit https://aloha.fyi for Hawaii tours." }], isError: true };
      }
      const lim = Math.min(20, Math.max(1, limit));
      const conditions = ["e.active = true"];
      const params: any[] = [];
      let idx = 1;

      if (query) {
        conditions.push(`(e.search_text ILIKE $${idx} OR e.title ILIKE $${idx})`);
        params.push(`%${query}%`);
        idx++;
      }
      if (max_price_dollars) {
        conditions.push(`e.price_cents <= $${idx}`);
        params.push(max_price_dollars * 100);
        idx++;
      }
      if (source && source !== "any") {
        conditions.push(`e.source = $${idx}`);
        params.push(source);
        idx++;
      }
      params.push(lim);

      try {
        const sql = `
          SELECT title, description, category, area, price_cents, source, affiliate_url, rating, review_count
          FROM experiences e
          WHERE ${conditions.join(" AND ")}
          ORDER BY review_count DESC NULLS LAST, rating DESC NULLS LAST
          LIMIT $${idx}
        `;
        const { rows } = await pool.query(sql, params);

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `No Hawaii tours found for "${query}". Try broader search terms or visit https://aloha.fyi for the full catalog.` }] };
        }

        const lines = rows.map((r: any) => {
          const price = r.price_cents ? `$${(r.price_cents / 100).toFixed(0)}` : "See link";
          const src = sourceLabel(r.source);
          const url = buildAffiliateUrl(r.source, r.affiliate_url);
          const rating = r.rating ? ` ★${r.rating}` : "";
          const reviews = r.review_count ? ` (${r.review_count} reviews)` : "";
          return `**${r.title}** (via ${src})\n${r.area || "Oahu"} | ${price}/person${rating}${reviews}\n${r.description?.slice(0, 150) || ""}\nBook: ${url}`;
        });

        const text = `Found ${rows.length} Hawaii experiences:\n\n${lines.join("\n\n---\n\n")}\n\n_Powered by aloha.fyi — Hawaii's AI concierge_`;
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Search error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: get_hawaii_deals
  server.registerTool(
    "get_hawaii_deals",
    {
      title: "Hawaii Budget Deals",
      description: "Find budget deals and discounts for Hawaii activities. Returns Groupon deals and low-price options sorted cheapest first. Use when users want affordable Hawaii experiences or budget travel tips.",
      inputSchema: {
        activity: z.string().describe("Type of activity, e.g. 'snorkeling', 'helicopter', 'luau', 'food tour'"),
        max_price_dollars: z.number().default(100).describe("Maximum price per person in USD"),
        limit: z.number().default(5).describe("Number of deals (max 20)"),
      },
    },
    async ({ activity, max_price_dollars, limit }): Promise<CallToolResult> => {
      if (!pool) {
        return { content: [{ type: "text", text: "Database not configured. Visit https://aloha.fyi/experiences/deals for Hawaii deals." }], isError: true };
      }
      const lim = Math.min(20, Math.max(1, limit));
      try {
        const sql = `
          SELECT title, description, area, price_cents, source, affiliate_url, rating, review_count
          FROM experiences e
          WHERE e.active = true AND e.price_cents > 0 AND e.price_cents <= $1
          ${activity ? "AND (e.search_text ILIKE $3 OR e.title ILIKE $3)" : ""}
          ORDER BY e.price_cents ASC, e.review_count DESC NULLS LAST
          LIMIT $2
        `;
        const params = activity ? [max_price_dollars * 100, lim, `%${activity}%`] : [max_price_dollars * 100, lim];
        const { rows } = await pool.query(sql, params);

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `No deals found for "${activity}" under $${max_price_dollars}. Try a higher budget.` }] };
        }

        const lines = rows.map((r: any) => {
          const price = `$${(r.price_cents / 100).toFixed(0)}`;
          const src = sourceLabel(r.source);
          const url = buildAffiliateUrl(r.source, r.affiliate_url);
          const savings = r.source === "groupon" ? " 🏷️ DEAL" : "";
          return `**${r.title}** (via ${src})${savings}\n${r.area || "Oahu"} | ${price}/person\nBook: ${url}`;
        });

        const text = `Best Hawaii deals for "${activity}" (under $${max_price_dollars}):\n\n${lines.join("\n\n---\n\n")}\n\n_Powered by aloha.fyi_`;
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Deals search error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: search_hawaii_events
  server.registerTool(
    "search_hawaii_events",
    {
      title: "Hawaii Events & Concerts",
      description: "Find upcoming events, concerts, festivals, and nightlife across all Hawaiian islands. 579+ events from 70+ venues, updated weekly. Use when users ask what's happening in Hawaii or want entertainment options.",
      inputSchema: {
        query: z.string().default("").describe("Type of event, e.g. 'live music', 'luau', 'concert', 'food festival'"),
        island: z.enum(["oahu", "maui", "big_island", "kauai", "any"]).default("any"),
        days_ahead: z.number().default(7).describe("How many days ahead to search"),
      },
    },
    async ({ query, island, days_ahead }): Promise<CallToolResult> => {
      try {
        const eventsPath = path.resolve(__dirname, "..", "data", "hawaii-events.json");
        let events: any[] = [];
        if (fs.existsSync(eventsPath)) {
          events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
        }

        const now = new Date();
        const cutoff = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);
        const todayStr = now.toISOString().slice(0, 10);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        let filtered = events.filter((e: any) => {
          if (!e.date) return false;
          if (e.date < todayStr || e.date > cutoffStr) return false;
          if (island && island !== "any" && e.island && e.island !== island) return false;
          if (query) {
            const searchable = [e.name, e.venue, e.description, e.event_type].join(" ").toLowerCase();
            return query.toLowerCase().split(/\s+/).every((t: string) => searchable.includes(t));
          }
          return true;
        });

        filtered.sort((a: any, b: any) => (a.date || "").localeCompare(b.date || ""));
        filtered = filtered.slice(0, 10);

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: `No events found matching "${query}" in the next ${days_ahead} days. Visit https://aloha.fyi for the full events calendar.` }] };
        }

        const lines = filtered.map((e: any) => {
          const date = e.date ? new Date(e.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
          const venue = typeof e.venue === "object" ? e.venue?.name : e.venue;
          const price = e.price || "See venue";
          const url = e.url || e.ticket_url || "";
          return `**${e.name}** — ${date} ${e.time || ""}\n${venue || ""} | ${e.island || "oahu"} | ${price}${url ? `\n${url}` : ""}`;
        });

        const text = `Upcoming Hawaii events (next ${days_ahead} days):\n\n${lines.join("\n\n---\n\n")}\n\n_Powered by aloha.fyi — 579+ events across 4 islands_`;
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Events error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// ── Express app ──
const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "9624", 10);

// REST health check (for Railway)
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "aloha-fyi-mcp",
    protocol: "MCP Streamable HTTP",
    version: "1.0.0",
    tools: ["search_hawaii_tours", "get_hawaii_deals", "search_hawaii_events"],
    experiences: 2583,
    events: 579,
    islands: ["oahu", "maui", "big_island", "kauai"],
    db: !!pool,
  });
});

// Well-known MCP discovery
app.get("/.well-known/mcp/server.json", (_req: Request, res: Response) => {
  res.json({
    name: "aloha-fyi-hawaii",
    version: "1.0.0",
    description: "Hawaii tourism AI tools — tours, events, deals across 4 islands with affiliate booking links.",
    transport: "streamable-http",
    endpoint: "/mcp",
    tools: [
      { name: "search_hawaii_tours", description: "Search 2,583 Hawaii tours and activities" },
      { name: "get_hawaii_deals", description: "Budget deals sorted by price" },
      { name: "search_hawaii_events", description: "579+ upcoming events across 4 islands" },
    ],
    contact: "alohatours@proton.me",
    website: "https://aloha.fyi",
  });
});

// MCP POST endpoint — stateless
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error("[MCP] Request error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode: reject GET/DELETE
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode." },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`[aloha-fyi-mcp] Streamable HTTP server on port ${PORT}`);
  console.log(`[aloha-fyi-mcp] MCP endpoint: POST /mcp`);
  console.log(`[aloha-fyi-mcp] Health: GET /health`);
  console.log(`[aloha-fyi-mcp] DB: ${pool ? "connected" : "not configured"}`);
});
