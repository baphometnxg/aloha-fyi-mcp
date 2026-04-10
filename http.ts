/**
 * aloha.fyi MCP Server — Simple HTTP wrapper
 *
 * Exposes the MCP tools as a REST API for easy testing and discovery.
 * The full MCP Streamable HTTP transport can be added later once the
 * SDK API stabilizes.
 *
 * For now: /health, /tools, /.well-known/mcp/server.json, and
 * direct tool calls via /call/:toolName
 */

import express, { Request, Response } from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "9624", 10);
const DB_URL = process.env.DATABASE_URL || "";

let pool: Pool | null = null;
if (DB_URL) {
  pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
}

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

// ── Health ──
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "aloha-fyi-mcp",
    tools: ["search_hawaii_tours", "search_hawaii_events", "get_hawaii_deals"],
    experiences: 2583,
    events: 579,
    islands: ["oahu", "maui", "big_island", "kauai"],
    db: !!pool,
  });
});

// ── Tool: search_hawaii_tours ──
app.get("/api/tours", async (req: Request, res: Response) => {
  if (!pool) return res.status(503).json({ error: "Database not connected" });

  const q = String(req.query.q || "");
  const maxPrice = req.query.maxPrice ? parseInt(String(req.query.maxPrice), 10) * 100 : null;
  const source = req.query.source ? String(req.query.source) : null;
  const limit = Math.min(20, parseInt(String(req.query.limit || "5"), 10));

  const conditions = ["e.active = true"];
  const params: any[] = [];
  let idx = 1;

  if (q) {
    conditions.push(`(e.search_text ILIKE $${idx} OR e.title ILIKE $${idx})`);
    params.push(`%${q}%`);
    idx++;
  }
  if (maxPrice) {
    conditions.push(`e.price_cents <= $${idx}`);
    params.push(maxPrice);
    idx++;
  }
  if (source) {
    conditions.push(`e.source = $${idx}`);
    params.push(source);
    idx++;
  }

  params.push(limit);

  try {
    const sql = `
      SELECT title, description, category, area, price_cents, price_band,
             source, affiliate_url, rating, review_count
      FROM experiences e
      WHERE ${conditions.join(" AND ")}
      ORDER BY review_count DESC NULLS LAST, rating DESC NULLS LAST
      LIMIT $${idx}
    `;
    const { rows } = await pool.query(sql, params);

    const results = rows.map((r: any) => ({
      title: r.title,
      source: sourceLabel(r.source),
      area: r.area || "oahu",
      price: r.price_cents ? `$${(r.price_cents / 100).toFixed(0)}` : null,
      rating: r.rating,
      reviews: r.review_count,
      description: r.description?.slice(0, 200),
      book_url: buildAffiliateUrl(r.source, r.affiliate_url),
    }));

    res.json({
      count: results.length,
      results,
      powered_by: "aloha.fyi — Hawaii's AI concierge",
      chat: "https://aloha.fyi",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tool: get_hawaii_deals ──
app.get("/api/deals", async (req: Request, res: Response) => {
  if (!pool) return res.status(503).json({ error: "Database not connected" });

  const q = String(req.query.q || req.query.activity || "");
  const maxPrice = parseInt(String(req.query.maxPrice || "100"), 10) * 100;
  const limit = Math.min(20, parseInt(String(req.query.limit || "10"), 10));

  try {
    const sql = `
      SELECT title, description, category, area, price_cents,
             source, affiliate_url, rating, review_count
      FROM experiences e
      WHERE e.active = true AND e.price_cents > 0 AND e.price_cents <= $1
      ${q ? "AND (e.search_text ILIKE $3 OR e.title ILIKE $3)" : ""}
      ORDER BY e.price_cents ASC, e.review_count DESC NULLS LAST
      LIMIT $2
    `;
    const params = q ? [maxPrice, limit, `%${q}%`] : [maxPrice, limit];
    const { rows } = await pool.query(sql, params);

    const results = rows.map((r: any) => ({
      title: r.title,
      source: sourceLabel(r.source),
      area: r.area || "oahu",
      price: `$${(r.price_cents / 100).toFixed(0)}`,
      rating: r.rating,
      reviews: r.review_count,
      book_url: buildAffiliateUrl(r.source, r.affiliate_url),
    }));

    res.json({ count: results.length, results, powered_by: "aloha.fyi" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tool: search_hawaii_events ──
app.get("/api/events", async (_req: Request, res: Response) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const eventsPath = path.resolve(__dirname, "..", "data", "hawaii-events.json");
    let events: any[] = [];
    if (fs.existsSync(eventsPath)) {
      events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const todayStr = now.toISOString().slice(0, 10);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const upcoming = events
      .filter((e: any) => e.date && e.date >= todayStr && e.date <= cutoffStr)
      .sort((a: any, b: any) => (a.date || "").localeCompare(b.date || ""))
      .slice(0, 20);

    res.json({
      count: upcoming.length,
      total_events: events.length,
      results: upcoming.map((e: any) => ({
        name: e.name,
        date: e.date,
        time: e.time,
        venue: typeof e.venue === "object" ? e.venue?.name : e.venue,
        island: e.island || "oahu",
        event_type: e.event_type,
        price: e.price,
        url: e.url || e.ticket_url,
      })),
      powered_by: "aloha.fyi",
    });
  } catch (err: any) {
    res.json({ count: 0, results: [], note: "Events data not available" });
  }
});

// ── Well-known MCP discovery ──
app.get("/.well-known/mcp/server.json", (_req: Request, res: Response) => {
  res.json({
    name: "aloha-fyi-hawaii",
    version: "1.0.0",
    description:
      "Hawaii tourism AI tools — tours, events, restaurants, deals across 4 islands. 2,583 bookable experiences with affiliate tracking.",
    tools: [
      { name: "search_hawaii_tours", endpoint: "/api/tours", method: "GET" },
      { name: "get_hawaii_deals", endpoint: "/api/deals", method: "GET" },
      { name: "search_hawaii_events", endpoint: "/api/events", method: "GET" },
    ],
    contact: "alohatours@proton.me",
    website: "https://aloha.fyi",
  });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`[aloha-fyi-mcp] HTTP server on port ${PORT}`);
  console.log(`[aloha-fyi-mcp] DB: ${pool ? "connected" : "not configured"}`);
});
