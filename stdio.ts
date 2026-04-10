#!/usr/bin/env node
/**
 * aloha.fyi MCP Server — stdio transport for Claude Desktop / Cursor
 *
 * Add to Claude Desktop config:
 * {
 *   "mcpServers": {
 *     "aloha-fyi": {
 *       "command": "npx",
 *       "args": ["@aloha-fyi/mcp-hawaii"],
 *       "env": {
 *         "DATABASE_URL": "your-postgres-connection-string"
 *       }
 *     }
 *   }
 * }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import server from "./index.js";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never use console.log in stdio mode — it corrupts JSON-RPC
  console.error("[aloha-fyi-mcp] Hawaii tourism server running (stdio)");
}

main().catch((err) => {
  console.error("[aloha-fyi-mcp] Fatal:", err);
  process.exit(1);
});
