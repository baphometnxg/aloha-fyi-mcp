# aloha.fyi MCP Server 🌺

**The first dedicated Hawaii tourism MCP server.** Hawaii tours, events, and deals for AI assistants — now with **AAAK** structured-response support so consumer agents can parse results without re-parsing prose.

When someone asks Claude, ChatGPT, or any AI "what should I do in Hawaii?" — this MCP server returns real, bookable data:

- **2,583 bookable experiences** from Viator, GetYourGuide, Klook, and Groupon
- **579 events** across Oahu, Maui, Big Island, and Kauai
- **540+ curated restaurants** in Waikiki and across Oahu
- **Live weather** for all four islands (OpenMeteo)
- **Day-plan itineraries** with morning / lunch / afternoon / dinner picks
- **Affiliate tracking** on every booking link
- **Real MCP protocol** — Streamable HTTP, stateless, spec version `2025-03-26`
- **AAAK v0.1** — typed `structuredContent` envelope alongside human-readable text. See [`docs/aaak-spec.md`](./docs/aaak-spec.md).

Powered by [aloha.fyi](https://aloha.fyi) — Hawaii's AI concierge.

> **Note on canonical source.** This repository is the public-facing mirror of the production `mcp-server` directory inside [`baphometnxg/Nani-V3`](https://github.com/baphometnxg/Nani-V3). Production deploys are driven from there; this repo is kept in sync as a standalone reference for community use and for anyone who wants to self-host. File issues here or upstream — both work.

---

## Hosted endpoint

Production MCP server (no install, no setup):

```
https://mcp-server-nani-v3-20.up.railway.app/mcp
```

- Transport: Streamable HTTP (stateless)
- Protocol version: `2025-03-26`
- Auth: none (public, read-only)
- Health: [GET /health](https://mcp-server-nani-v3-20.up.railway.app/health) — returns `aaak: { protocol, enabled, allowlist_size }` so deploy state is observable
- Discovery: [GET /.well-known/mcp/server.json](https://mcp-server-nani-v3-20.up.railway.app/.well-known/mcp/server.json)

---

## AAAK — structured response contract

By default, MCP tool results come back as a prose blob — agents that want to consume the data programmatically have to re-parse markdown to recover prices, booking URLs, islands, etc. AAAK fixes that.

When AAAK is enabled (and the calling client is on the allowlist), every tool result includes a typed `structuredContent` field carrying the data in machine-parseable form, and the marketing trailer is dropped from `text` to save tokens. When AAAK is off, the wire format is byte-equivalent to v1.0.0 — no surprises for clients that don't opt in.

**Lossless invariants — preserved on every revenue-bearing row:**
- `booking_url` (affiliate revenue)
- `source` (compliance + attribution)
- `price_cents` (the only numeric field user decisions hinge on)
- `island` (every recommendation is island-scoped)

**Example (search_hawaii_tours):**

```jsonc
{
  "ok": true,
  "kind": "result",
  "tool": "search_hawaii_tours",
  "protocol": "aaak/0.1",
  "query": { "query": "snorkeling", "island": "oahu", "limit": 1 },
  "results": [
    {
      "title": "Hanauma Bay Snorkel",
      "source": "viator",
      "island": "oahu",
      "area": "east_oahu",
      "category": "tour",
      "price_cents": 8900,
      "rating": 4.7,
      "review_count": 2341,
      "description": "Guided snorkeling at Oahu's most famous reef...",
      "booking_url": "https://aloha.fyi/r/aB3kT9pQz1",
      "is_deal": false
    }
  ],
  "meta": { "count": 1, "cached": false, "source_diversity": 1 }
}
```

Full spec: [`docs/aaak-spec.md`](./docs/aaak-spec.md). Generated JSON Schema: [`docs/aaak.schema.json`](./docs/aaak.schema.json).

**Verification scripts** for self-hosters and contributors:

```bash
npm run aaak:test    # 12 hand-written conformance fixtures
npm run aaak:smoke   # 9 adapter-output validations
npm run aaak:gate    # ~70 env-gate / trailer / allowlist invariants
npm run aaak:verify -- --expect=aaak --ua=claude-code/1.0   # live probe
```

---

## Connect to Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "aloha-fyi-hawaii": {
      "url": "https://mcp-server-nani-v3-20.up.railway.app/mcp"
    }
  }
}
```

Restart Claude Desktop. You should see the three Hawaii tools appear in the tool picker. Try:

> Find me snorkeling tours in Oahu under $100

> What events are happening in Honolulu this weekend?

> Plan a family adventure day on the Big Island — cheapest options

---

## Connect to any MCP-compatible client

Any client that supports Streamable HTTP MCP can point directly at:

```
https://mcp-server-nani-v3-20.up.railway.app/mcp
```

No API key, no OAuth, no signup.

### Manual protocol test

```bash
curl -X POST https://mcp-server-nani-v3-20.up.railway.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

---

## Tools

### `search_hawaii_tours`
Search 2,583 bookable Hawaii tours and activities by keyword, island, price range. Returns tours from Viator, GetYourGuide, Klook, and Groupon with affiliate booking links.

| Param | Type | Description |
|---|---|---|
| `query` | string (required) | e.g. "snorkeling", "helicopter tour", "family luau" |
| `island` | `oahu` \| `maui` \| `big_island` \| `kauai` \| `any` | Defaults to `any` |
| `max_price_dollars` | number | Maximum price per person in USD |
| `source` | `viator` \| `gyg` \| `klook` \| `groupon` \| `any` | Filter by booking platform |
| `limit` | number | Results (max 20, default 5) |

### `get_hawaii_deals`
Find budget deals and discounts. Returns Groupon deals and low-price options sorted cheapest first.

| Param | Type | Description |
|---|---|---|
| `activity` | string (required) | e.g. "snorkeling", "helicopter", "luau" |
| `max_price_dollars` | number | Default 100 |
| `limit` | number | Results (max 20, default 5) |

### `search_hawaii_events`
Find upcoming events, concerts, festivals, and nightlife across all Hawaiian islands. 579+ events from 70+ venues, updated weekly.

| Param | Type | Description |
|---|---|---|
| `query` | string | e.g. "live music", "luau", "concert" |
| `island` | `oahu` \| `maui` \| `big_island` \| `kauai` \| `any` | Defaults to `any` |
| `days_ahead` | number | How many days ahead to search (default 7) |

---

## Run it yourself

```bash
git clone https://github.com/baphometnxg/aloha-fyi-mcp.git
cd aloha-fyi-mcp
npm install
npx tsc
DATABASE_URL="postgresql://..." PORT=9624 node dist/http.js
```

Requires:
- Node.js 20+
- `DATABASE_URL` env var (PostgreSQL with an `experiences` table — schema in `schema.sql`)

---

## Privacy

No PII is collected by the MCP server. Stateless mode — no sessions, no cross-request profiles. Standard request metadata is logged for abuse prevention only.

Full privacy policy: [aloha.fyi/privacy](https://www.aloha.fyi/privacy)

---

## About

Built by [Michael Crain](https://aloha.fyi) — Hawaii resident, cinematographer, and founder of aloha.fyi.

**aloha.fyi** is an AI-powered multilingual tourism concierge for Hawaii's visitor industry. The concierge agent "Nani" speaks 5 languages (English, Japanese, Korean, Chinese, Spanish) and has access to 2,583 bookable experiences across 6 affiliate networks.

This MCP server exposes a subset of that capability to any AI assistant that speaks the Model Context Protocol.

- **Website**: https://aloha.fyi
- **Contact**: alohatours@proton.me
- **License**: MIT

---

*Built with aloha. Powered by AI. Rooted in Hawaiian culture.* 🌺
