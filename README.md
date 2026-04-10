# aloha.fyi MCP Server 🌺

**The first dedicated Hawaii tourism MCP server.** Hawaii tours, events, restaurants, and deals for AI assistants.

When someone asks Claude, ChatGPT, or any AI "what should I do in Hawaii?" — this MCP server provides real, bookable data:

- **2,583 bookable experiences** from Viator, GetYourGuide, Klook, and Groupon
- **579 events** across Oahu, Maui, Big Island, and Kauai
- **Affiliate tracking** on every booking link
- **5 languages supported** via the main aloha.fyi concierge

Powered by [aloha.fyi](https://aloha.fyi) — Hawaii's AI concierge.

---

## Tools

### `search_hawaii_tours`
Search Hawaii tours and activities by keyword, island, price range, and category.

**Parameters:**
- `query` (string) — What the user is looking for, e.g. "snorkeling with turtles", "helicopter tour", "family luau"
- `island` (enum) — `oahu` | `maui` | `big_island` | `kauai` | `any`
- `max_price_dollars` (number, optional) — Maximum price per person in USD
- `category` (enum, optional) — `tour` | `activity` | `restaurant` | `culture` | `any`
- `limit` (number, default 5) — Number of results

**Returns:** Array of experiences with title, source (Viator/GYG/Klook/Groupon), price, rating, and affiliate booking link.

### `search_hawaii_events`
Find upcoming events, concerts, festivals, and nightlife across all Hawaiian islands.

**Parameters:**
- `query` (string) — Type of event, e.g. "live music", "luau", "concert"
- `island` (enum) — Which island
- `days_ahead` (number, default 7) — How many days ahead to search

**Returns:** Upcoming events with venue, date, price, and ticket links.

### `get_hawaii_deals`
Find budget deals and discounts for Hawaii tours and activities. Includes Groupon deals sorted by price.

**Parameters:**
- `activity` (string) — Type of activity, e.g. "snorkeling", "helicopter", "luau"
- `max_price_dollars` (number, default 100) — Maximum price per person
- `limit` (number, default 5) — Number of deals

**Returns:** Best value deals with savings, sorted cheapest first.

### `plan_hawaii_day`
Get a suggested full-day itinerary for a Hawaiian island or area.

**Parameters:**
- `island` (enum) — `oahu` | `maui` | `big_island` | `kauai`
- `vibe` (enum) — `adventure` | `chill` | `cultural` | `romantic` | `family` | `budget`
- `area` (string, optional) — Specific area like "waikiki", "north shore"

**Returns:** Morning/afternoon/evening activities with booking links.

---

## Installation

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aloha-fyi": {
      "command": "npx",
      "args": ["@aloha-fyi/mcp-hawaii"],
      "env": {
        "DATABASE_URL": "postgresql://..."
      }
    }
  }
}
```

### Remote HTTP

The hosted version is available at:

```
https://mcp-server-nani-v3-20.up.railway.app
```

Endpoints:
- `GET /health` — Service status
- `GET /api/tours?q=snorkeling&maxPrice=50` — Search tours
- `GET /api/deals?q=snorkel&maxPrice=50` — Budget deals
- `GET /api/events` — Upcoming events
- `GET /.well-known/mcp/server.json` — MCP discovery

---

## Development

```bash
npm install
npx tsc
node dist/http.js
```

Requires:
- Node.js 20+
- `DATABASE_URL` env var (PostgreSQL with `experiences` table)

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
