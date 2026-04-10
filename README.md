# aloha.fyi MCP Server 🌺

**The first dedicated Hawaii tourism MCP server.** Hawaii tours, events, and deals for AI assistants.

When someone asks Claude, ChatGPT, or any AI "what should I do in Hawaii?" — this MCP server returns real, bookable data:

- **2,583 bookable experiences** from Viator, GetYourGuide, Klook, and Groupon
- **579 events** across Oahu, Maui, Big Island, and Kauai
- **Affiliate tracking** on every booking link
- **Real MCP protocol** — Streamable HTTP, stateless, spec version 2025-03-26

Powered by [aloha.fyi](https://aloha.fyi) — Hawaii's AI concierge.

---

## Hosted endpoint

Production MCP server (no install, no setup):

```
https://mcp-server-nani-v3-20.up.railway.app/mcp
```

- Transport: Streamable HTTP (stateless)
- Protocol version: `2025-03-26`
- Auth: none (public, read-only)
- Health: [GET /health](https://mcp-server-nani-v3-20.up.railway.app/health)
- Discovery: [GET /.well-known/mcp/server.json](https://mcp-server-nani-v3-20.up.railway.app/.well-known/mcp/server.json)

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
