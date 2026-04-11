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
 *
 * Observability (Layer 1):
 *   Every POST /mcp is logged to `mcp_requests` in Postgres with
 *   method, tool, client name/version, hashed IP, latency, row count.
 *
 * Attribution (Layer 2):
 *   Every affiliate URL returned is stamped with utm_source=aloha-mcp,
 *   utm_medium=ai-assistant, utm_campaign=mcp-<client>, plus a CJ
 *   `sid` param for Groupon/CJ links so commissions are attributable.
 */

import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── Database ──
const DB_URL = process.env.DATABASE_URL || "";
const pool = DB_URL
  ? new Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
    })
  : null;

// ── Ensure mcp_requests table exists on startup ──
async function ensureSchema() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mcp_requests (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        method TEXT,
        tool_name TEXT,
        client_name TEXT,
        client_version TEXT,
        user_agent TEXT,
        ip_hash TEXT,
        params_hash TEXT,
        query_text TEXT,
        status_code INT,
        latency_ms INT,
        row_count INT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_requests_created ON mcp_requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_requests_client  ON mcp_requests(client_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_requests_tool    ON mcp_requests(tool_name, created_at DESC);

      CREATE TABLE IF NOT EXISTS mcp_click_targets (
        code TEXT PRIMARY KEY,
        target_url TEXT NOT NULL,
        source TEXT,
        tool_name TEXT,
        client_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_click_targets_created ON mcp_click_targets(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_click_targets_client  ON mcp_click_targets(client_name);

      CREATE TABLE IF NOT EXISTS mcp_clicks (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NOT NULL,
        clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_agent TEXT,
        ip_hash TEXT,
        referer TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_clicks_code    ON mcp_clicks(code, clicked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_clicks_clicked ON mcp_clicks(clicked_at DESC);
    `);
    console.log("[aloha-fyi-mcp] schema ensured: mcp_requests, mcp_click_targets, mcp_clicks");
  } catch (err: any) {
    console.error("[aloha-fyi-mcp] schema ensure failed:", err.message);
  }
}

// ── Crypto helpers ──
const IP_SALT = process.env.MCP_IP_SALT || "aloha-fyi-mcp-v1";
function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return sha256(IP_SALT + "|" + ip);
}

// ── Client tag sanitization (used for SID / utm_campaign) ──
function sanitizeClientTag(raw: string | undefined | null): string {
  const src = (raw || "unknown").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  return src.replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * Derive a stable client identifier from the HTTP User-Agent header.
 * Stateless MCP: `tools/call` bodies don't include clientInfo, so we
 * can't use the JSON-RPC initialize handshake for per-request attribution.
 * Fall back to pattern-matching the UA string.
 */
function deriveClientFromUA(ua: string | null | undefined): string | null {
  if (!ua) return null;
  if (/claude[- ]?desktop/i.test(ua)) return "claude-desktop";
  if (/claude[- ]?code/i.test(ua)) return "claude-code";
  if (/claude\.ai|anthropic/i.test(ua)) return "claude-web";
  if (/chatgpt|openai/i.test(ua)) return "chatgpt";
  if (/cursor/i.test(ua)) return "cursor";
  if (/continue\b/i.test(ua)) return "continue";
  if (/cline/i.test(ua)) return "cline";
  if (/zed/i.test(ua)) return "zed";
  if (/windsurf/i.test(ua)) return "windsurf";
  if (/inspector/i.test(ua)) return "mcp-inspector";
  // SDK fallbacks
  if (/modelcontextprotocol|mcp-sdk/i.test(ua)) return "mcp-sdk";
  if (/python-httpx|python-requests|python/i.test(ua)) return "sdk-python";
  if (/node\.?js|undici/i.test(ua)) return "sdk-node";
  if (/curl/i.test(ua)) return "curl";
  if (/postman/i.test(ua)) return "postman";
  // Fallback: sanitized first 32 chars of UA so we at least see something
  const cleaned = ua.replace(/[^a-zA-Z0-9.\-/]+/g, "-").slice(0, 32).toLowerCase().replace(/^-+|-+$/g, "");
  return cleaned || null;
}

// ── Safe query param append ──
function addQueryParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

// ── Affiliate link builder (with attribution) ──
const CJ_PID = "7903538";
const CJ_AID = "5840172";

function buildAffiliateUrl(source: string, url: string, clientTag: string): string {
  if (!url) return "";
  const tag = sanitizeClientTag(clientTag);
  const sid = `mcp-${tag}`;

  if (source === "groupon") {
    // If already wrapped in CJ, just append sid. Otherwise wrap it.
    if (url.includes("anrdoezrs.net")) {
      return addQueryParam(url, "sid", sid);
    }
    // Stamp the underlying Groupon URL with UTMs first, then wrap in CJ with sid.
    let dest = addQueryParam(url, "utm_source", "aloha-mcp");
    dest = addQueryParam(dest, "utm_medium", "ai-assistant");
    dest = addQueryParam(dest, "utm_campaign", sid);
    return `https://www.anrdoezrs.net/click-${CJ_PID}-${CJ_AID}?url=${encodeURIComponent(dest)}&sid=${encodeURIComponent(sid)}`;
  }

  // Viator / GYG / Klook / anything else — append UTMs to the affiliate URL directly.
  let tracked = addQueryParam(url, "utm_source", "aloha-mcp");
  tracked = addQueryParam(tracked, "utm_medium", "ai-assistant");
  tracked = addQueryParam(tracked, "utm_campaign", sid);
  return tracked;
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

// ── Layer 3 — shortcode click-through ──
/**
 * Public-facing base for /r/{code} redirects. Tourists see this in Claude's
 * output, so it has to be on-brand. Defaults to aloha.fyi; override with
 * MCP_REDIRECT_BASE env var for testing.
 * NOTE: path is /r/ not /go/ because /go/ is already proxied to the Express
 * booking-track flow for the chat UI.
 */
const REDIRECT_BASE = (process.env.MCP_REDIRECT_BASE || "https://aloha.fyi").replace(/\/+$/, "");

/**
 * Deterministic shortcode: sha256(url + client) → first 10 chars base62-ish.
 * Stable — the same (url, client) pair always produces the same code, so we
 * can UPSERT without creating dupes. 62^10 = 8e17 collisions, irrelevant.
 */
function makeShortCode(url: string, clientTag: string): string {
  const input = `${url}|${clientTag}`;
  const hex = crypto.createHash("sha256").update(input).digest("hex");
  // Convert hex → base62 for shorter URLs
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = BigInt("0x" + hex.slice(0, 16)); // first 64 bits = plenty of entropy
  let out = "";
  while (n > 0n && out.length < 10) {
    out = alphabet[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(10, "0");
}

/**
 * Register a click target in the database and return the public-facing
 * /r/{code} URL. Non-blocking — if the DB is down we fall back to the
 * raw target URL so the MCP response still works.
 */
async function registerClickTarget(
  targetUrl: string,
  source: string,
  toolName: string,
  clientTag: string
): Promise<string> {
  if (!targetUrl) return "";
  if (!pool) return targetUrl;
  const code = makeShortCode(targetUrl, clientTag);
  try {
    await pool.query(
      `INSERT INTO mcp_click_targets (code, target_url, source, tool_name, client_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE SET
         target_url = EXCLUDED.target_url,
         last_seen_at = NOW()`,
      [code, targetUrl, source || null, toolName || null, clientTag || null]
    );
    return `${REDIRECT_BASE}/r/${code}`;
  } catch (err: any) {
    console.warn("[aloha-fyi-mcp] click target register failed:", err.message);
    return targetUrl;
  }
}

// ── Per-request log context, mutated by tool handlers ──
interface LogCtx {
  method: string;
  toolName: string | null;
  clientName: string | null;
  clientVersion: string | null;
  userAgent: string | null;
  ipHash: string | null;
  paramsHash: string | null;
  queryText: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  rowCount: number | null;
  error: string | null;
  startedAt: number;
}

function newLogCtx(): LogCtx {
  return {
    method: "unknown",
    toolName: null,
    clientName: null,
    clientVersion: null,
    userAgent: null,
    ipHash: null,
    paramsHash: null,
    queryText: null,
    statusCode: null,
    latencyMs: null,
    rowCount: null,
    error: null,
    startedAt: Date.now(),
  };
}

/** Parse a JSON-RPC request body (object or array for batches) into log context */
function enrichLogCtxFromBody(ctx: LogCtx, body: any): void {
  if (!body) return;
  // If batch, take the first call for logging purposes; we won't split batches per row for now.
  const call = Array.isArray(body) ? body[0] : body;
  if (!call || typeof call !== "object") return;

  ctx.method = typeof call.method === "string" ? call.method : "unknown";

  if (call.method === "initialize" && call.params?.clientInfo) {
    ctx.clientName = call.params.clientInfo.name ?? null;
    ctx.clientVersion = call.params.clientInfo.version ?? null;
  }

  if (call.method === "tools/call" && call.params) {
    ctx.toolName = call.params.name ?? null;
    const args = call.params.arguments || {};
    if (typeof args.query === "string") ctx.queryText = args.query.slice(0, 500);
    else if (typeof args.activity === "string") ctx.queryText = args.activity.slice(0, 500);
    try {
      ctx.paramsHash = sha256(JSON.stringify(args));
    } catch {
      /* ignore */
    }
  }
}

async function writeLog(ctx: LogCtx): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO mcp_requests
        (method, tool_name, client_name, client_version, user_agent, ip_hash, params_hash, query_text, status_code, latency_ms, row_count, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        ctx.method,
        ctx.toolName,
        ctx.clientName,
        ctx.clientVersion,
        ctx.userAgent,
        ctx.ipHash,
        ctx.paramsHash,
        ctx.queryText,
        ctx.statusCode,
        ctx.latencyMs,
        ctx.rowCount,
        ctx.error,
      ]
    );
  } catch (err: any) {
    console.warn("[aloha-fyi-mcp] log write failed:", err.message);
  }
}

// ── Build a fresh MCP server per request (stateless) ──
function buildServer(ctx: LogCtx): McpServer {
  const server = new McpServer(
    { name: "aloha-fyi-hawaii", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  // Tool: search_hawaii_tours
  server.registerTool(
    "search_hawaii_tours",
    {
      title: "Search Hawaii Tours",
      description:
        "Search 2,583 bookable Hawaii tours and activities by keyword, island, price range. Returns tours from Viator, GetYourGuide, Klook, and Groupon with affiliate booking links. Use this when users ask about Hawaii tours, activities, or things to do.",
      inputSchema: {
        query: z
          .string()
          .describe("What to search for, e.g. 'snorkeling', 'helicopter tour', 'luau', 'family activities'"),
        island: z
          .enum(["oahu", "maui", "big_island", "kauai", "any"])
          .default("any")
          .describe("Which Hawaiian island"),
        max_price_dollars: z.number().optional().describe("Maximum price per person in USD"),
        source: z
          .enum(["viator", "gyg", "klook", "groupon", "any"])
          .default("any")
          .describe("Filter by booking platform"),
        limit: z.number().default(5).describe("Number of results (max 20)"),
      },
    },
    async ({ query, island, max_price_dollars, source, limit }): Promise<CallToolResult> => {
      ctx.toolName = "search_hawaii_tours";
      ctx.queryText = (query || "").slice(0, 500);
      if (!pool) {
        ctx.error = "db_not_configured";
        return {
          content: [{ type: "text", text: "Database not configured. Visit https://aloha.fyi for Hawaii tours." }],
          isError: true,
        };
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
        ctx.rowCount = rows.length;

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No Hawaii tours found for "${query}". Try broader search terms or visit https://aloha.fyi for the full catalog.`,
              },
            ],
          };
        }

        const tag = ctx.clientName || "unknown";
        const lines = await Promise.all(
          rows.map(async (r: any) => {
            const price = r.price_cents ? `$${(r.price_cents / 100).toFixed(0)}` : "See link";
            const src = sourceLabel(r.source);
            const affUrl = buildAffiliateUrl(r.source, r.affiliate_url, tag);
            const url = await registerClickTarget(affUrl, r.source, "search_hawaii_tours", tag);
            const rating = r.rating ? ` ★${r.rating}` : "";
            const reviews = r.review_count ? ` (${r.review_count} reviews)` : "";
            return `**${r.title}** (via ${src})\n${r.area || "Oahu"} | ${price}/person${rating}${reviews}\n${r.description?.slice(0, 150) || ""}\nBook: ${url}`;
          })
        );

        const text = `Found ${rows.length} Hawaii experiences:\n\n${lines.join("\n\n---\n\n")}\n\n_Powered by aloha.fyi — Hawaii's AI concierge_`;
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        ctx.error = String(err?.message || err).slice(0, 500);
        return { content: [{ type: "text", text: `Search error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: get_hawaii_deals
  server.registerTool(
    "get_hawaii_deals",
    {
      title: "Hawaii Budget Deals",
      description:
        "Find budget deals and discounts for Hawaii activities. Returns Groupon deals and low-price options sorted cheapest first. Use when users want affordable Hawaii experiences or budget travel tips.",
      inputSchema: {
        activity: z.string().describe("Type of activity, e.g. 'snorkeling', 'helicopter', 'luau', 'food tour'"),
        max_price_dollars: z.number().default(100).describe("Maximum price per person in USD"),
        limit: z.number().default(5).describe("Number of deals (max 20)"),
      },
    },
    async ({ activity, max_price_dollars, limit }): Promise<CallToolResult> => {
      ctx.toolName = "get_hawaii_deals";
      ctx.queryText = (activity || "").slice(0, 500);
      if (!pool) {
        ctx.error = "db_not_configured";
        return {
          content: [
            { type: "text", text: "Database not configured. Visit https://aloha.fyi/experiences/deals for Hawaii deals." },
          ],
          isError: true,
        };
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
        ctx.rowCount = rows.length;

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No deals found for "${activity}" under $${max_price_dollars}. Try a higher budget.`,
              },
            ],
          };
        }

        const tag = ctx.clientName || "unknown";
        const lines = await Promise.all(
          rows.map(async (r: any) => {
            const price = `$${(r.price_cents / 100).toFixed(0)}`;
            const src = sourceLabel(r.source);
            const affUrl = buildAffiliateUrl(r.source, r.affiliate_url, tag);
            const url = await registerClickTarget(affUrl, r.source, "get_hawaii_deals", tag);
            const savings = r.source === "groupon" ? " 🏷️ DEAL" : "";
            return `**${r.title}** (via ${src})${savings}\n${r.area || "Oahu"} | ${price}/person\nBook: ${url}`;
          })
        );

        const text = `Best Hawaii deals for "${activity}" (under $${max_price_dollars}):\n\n${lines.join("\n\n---\n\n")}\n\n_Powered by aloha.fyi_`;
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        ctx.error = String(err?.message || err).slice(0, 500);
        return { content: [{ type: "text", text: `Deals search error: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: search_hawaii_events
  server.registerTool(
    "search_hawaii_events",
    {
      title: "Hawaii Events & Concerts",
      description:
        "Find upcoming events, concerts, festivals, and nightlife across all Hawaiian islands. 579+ events from 70+ venues, updated weekly. Use when users ask what's happening in Hawaii or want entertainment options.",
      inputSchema: {
        query: z.string().default("").describe("Type of event, e.g. 'live music', 'luau', 'concert', 'food festival'"),
        island: z.enum(["oahu", "maui", "big_island", "kauai", "any"]).default("any"),
        days_ahead: z.number().default(7).describe("How many days ahead to search"),
      },
    },
    async ({ query, island, days_ahead }): Promise<CallToolResult> => {
      ctx.toolName = "search_hawaii_events";
      ctx.queryText = (query || "").slice(0, 500);
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
        ctx.rowCount = filtered.length;

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No events found matching "${query}" in the next ${days_ahead} days. Visit https://aloha.fyi for the full events calendar.`,
              },
            ],
          };
        }

        const tag = ctx.clientName || "unknown";
        const lines = await Promise.all(
          filtered.map(async (e: any) => {
            const date = e.date
              ? new Date(e.date + "T00:00:00").toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })
              : "";
            const venue = typeof e.venue === "object" ? e.venue?.name : e.venue;
            const price = e.price || "See venue";
            const rawUrl = e.url || e.ticket_url || "";
            let url = "";
            if (rawUrl) {
              let tracked = addQueryParam(rawUrl, "utm_source", "aloha-mcp");
              tracked = addQueryParam(tracked, "utm_medium", "ai-assistant");
              tracked = addQueryParam(tracked, "utm_campaign", `mcp-${sanitizeClientTag(tag)}`);
              url = await registerClickTarget(tracked, "events", "search_hawaii_events", tag);
            }
            return `**${e.name}** — ${date} ${e.time || ""}\n${venue || ""} | ${e.island || "oahu"} | ${price}${url ? `\n${url}` : ""}`;
          })
        );

        const text = `Upcoming Hawaii events (next ${days_ahead} days):\n\n${lines.join("\n\n---\n\n")}\n\n_Powered by aloha.fyi — 579+ events across 4 islands_`;
        return { content: [{ type: "text", text }] };
      } catch (err: any) {
        ctx.error = String(err?.message || err).slice(0, 500);
        return { content: [{ type: "text", text: `Events error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

// ── Express app ──
const app = express();
app.use(express.json({ limit: "1mb" }));

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
    observability: "layer1+layer2",
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

// MCP POST endpoint — stateless, logged
app.post("/mcp", async (req: Request, res: Response) => {
  const ctx = newLogCtx();
  ctx.userAgent = (req.get("user-agent") || "").slice(0, 500) || null;
  const rawIp =
    (req.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "";
  ctx.ipHash = hashIp(rawIp);
  enrichLogCtxFromBody(ctx, req.body);
  // Stateless fallback: if initialize didn't identify the client (e.g. this
  // is a tools/call request), derive a client name from the User-Agent header.
  if (!ctx.clientName) {
    ctx.clientName = deriveClientFromUA(ctx.userAgent);
  }

  let loggedOnce = false;
  const flushLog = () => {
    if (loggedOnce) return;
    loggedOnce = true;
    ctx.latencyMs = Date.now() - ctx.startedAt;
    ctx.statusCode = res.statusCode;
    writeLog(ctx);
  };
  res.on("finish", flushLog);
  res.on("close", flushLog);

  try {
    const server = buildServer(ctx);
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
    ctx.error = String(err?.message || err).slice(0, 500);
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

// ── Startup ──
ensureSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`[aloha-fyi-mcp] Streamable HTTP server on port ${PORT}`);
    console.log(`[aloha-fyi-mcp] MCP endpoint: POST /mcp`);
    console.log(`[aloha-fyi-mcp] Health: GET /health`);
    console.log(`[aloha-fyi-mcp] DB: ${pool ? "connected" : "not configured"}`);
    console.log(`[aloha-fyi-mcp] Observability: Layer 1 (request logging) + Layer 2 (SID threading)`);
  });
});
