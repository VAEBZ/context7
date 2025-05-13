#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchLibraries, fetchLibraryDocumentation } from "./lib/api.js";
import { formatSearchResults } from "./lib/utils.js";
import dotenv from "dotenv";
import { getContext7Config } from "./lib/config.js";
import fs from "fs";
import path from "path";

// Load environment variables from .env file if present
dotenv.config();

// Get DEFAULT_MINIMUM_TOKENS from environment variable or use default
let DEFAULT_MINIMUM_TOKENS = 10000;
if (process.env.DEFAULT_MINIMUM_TOKENS) {
  const parsedValue = parseInt(process.env.DEFAULT_MINIMUM_TOKENS, 10);
  if (!isNaN(parsedValue) && parsedValue > 0) {
    DEFAULT_MINIMUM_TOKENS = parsedValue;
  } else {
    console.warn(
      `Warning: Invalid DEFAULT_MINIMUM_TOKENS value provided in environment variable. Using default value of 10000`
    );
  }
}

// Create server instance
const server = new McpServer({
  name: "Context7",
  description: "Retrieves up-to-date documentation and code examples for any library.",
  version: "1.0.6",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Load project config at startup
const context7Config = getContext7Config();

// Simple logging utility
function logEvent(event: string, details?: any) {
  const timestamp = new Date().toISOString();
  const msg = `[${timestamp}] ${event}`;
  if (details) {
    console.log(msg, details);
  } else {
    console.log(msg);
  }
}

// Enhanced global error logging
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  process.exit(1);
});

// Register Context7 tools
server.tool(
  "resolve-library-id",
  `Resolves a package name to a Context7-compatible library ID and returns a list of matching libraries.

You MUST call this function before 'get-library-docs' to obtain a valid Context7-compatible library ID.

When selecting the best match, consider:
- Name similarity to the query
- Description relevance
- Code Snippet count (documentation coverage)
- GitHub Stars (popularity)

> Language and version context are set dynamically from project config (.context7rc.json) but can be overridden per request.

Return the selected library ID and explain your choice. If there are multiple good matches, mention this but proceed with the most relevant one.`,
  {
    libraryName: z
      .string()
      .describe("Library name to search for and retrieve a Context7-compatible library ID. Language and version context are set dynamically from project config but can be overridden."),
  },
  {
    title: "Resolve Library ID",
    readOnlyHint: true,
    openWorldHint: true,
    idempotentHint: true,
    destructiveHint: false
  },
  async ({ libraryName }: { libraryName: string }) => {
    // Log invocation
    logEvent("resolve-library-id invoked", { libraryName });
    // Extra runtime validation
    if (typeof libraryName !== "string" || libraryName.length < 2 || libraryName.length > 100) {
      logEvent("resolve-library-id error: invalid libraryName", { libraryName });
      return {
        isError: true,
        content: [
          { type: "text", text: "Invalid library name. Must be 2-100 characters." }
        ]
      };
    }
    // Sanitize input (basic)
    const safeLibraryName = libraryName.replace(/[^a-zA-Z0-9_\-\. ]/g, "");
    const searchQuery = safeLibraryName || `${context7Config.defaultLang} ${context7Config.defaultVersion}`;
    try {
      const searchResponse = await searchLibraries(searchQuery);
      if (!searchResponse || !searchResponse.results) {
        logEvent("resolve-library-id error: no results", { searchQuery });
        return {
          isError: true,
          content: [
            { type: "text", text: "Failed to retrieve library documentation data from Context7" }
          ]
        };
      }
      if (searchResponse.results.length === 0) {
        logEvent("resolve-library-id error: empty results", { searchQuery });
        return {
          isError: true,
          content: [
            { type: "text", text: "No documentation libraries available" }
          ]
        };
      }
      const resultsText = formatSearchResults(searchResponse);
      logEvent("resolve-library-id success", { searchQuery });
      return {
        content: [
          {
            type: "text",
            text: `Available Libraries (top matches):\n\nEach result includes:\n- Library ID: Context7-compatible identifier (format: /org/repo)\n- Name: Library or package name\n- Description: Short summary\n- Code Snippets: Number of available code examples\n- GitHub Stars: Popularity indicator\n\nFor best results, select libraries based on name match, popularity (stars), snippet coverage, and relevance to your use case.\n\n---\n\n${resultsText}`,
          },
        ],
      };
    } catch (err: any) {
      logEvent("resolve-library-id error: exception", { error: err?.message || err });
      return {
        isError: true,
        content: [
          { type: "text", text: `Error: ${err?.message || err}` }
        ]
      };
    }
  }
);
console.error("[LOG] Registered tool: resolve-library-id");

server.tool(
  "get-library-docs",
  "Fetches up-to-date documentation for a library. You must call 'resolve-library-id' first to obtain the exact Context7-compatible library ID required to use this tool. Language and version are dynamic and project-aware, but can be overridden per request.",
  {
    context7CompatibleLibraryID: z
      .string()
      .describe(
        "Exact Context7-compatible library ID (e.g., 'mongodb/docs', 'vercel/nextjs') retrieved from 'resolve-library-id'."
      ),
    topic: z
      .string()
      .optional()
      .describe("Topic to focus documentation on (e.g., 'hooks', 'routing')."),
    tokens: z
      .preprocess((val) => (typeof val === "string" ? Number(val) : val), z.number())
      .transform((val) => (val < DEFAULT_MINIMUM_TOKENS ? DEFAULT_MINIMUM_TOKENS : val))
      .optional()
      .describe(
        `Maximum number of tokens of documentation to retrieve (default: ${DEFAULT_MINIMUM_TOKENS}). Higher values provide more context but consume more tokens.`
      ),
    lang: z.string().optional().describe("Programming language, e.g. 'python'. If omitted, project default is used."),
    python: z.string().optional().describe("Python version, e.g. '3.11'. If omitted, project default is used for Python."),
  },
  {
    title: "Get Library Documentation",
    readOnlyHint: true,
    openWorldHint: true,
    idempotentHint: true,
    destructiveHint: false
  },
  async ({ context7CompatibleLibraryID, tokens = DEFAULT_MINIMUM_TOKENS, topic = "", lang, python }: { context7CompatibleLibraryID: string, tokens?: number, topic?: string, lang?: string, python?: string }) => {
    // Log invocation
    logEvent("get-library-docs invoked", { context7CompatibleLibraryID, tokens, topic, lang, python });
    // Extra runtime validation
    if (typeof context7CompatibleLibraryID !== "string" || context7CompatibleLibraryID.length < 3) {
      logEvent("get-library-docs error: invalid library ID", { context7CompatibleLibraryID });
      return {
        isError: true,
        content: [
          { type: "text", text: "Invalid Context7-compatible library ID." }
        ]
      };
    }
    if (tokens && (tokens < 100 || tokens > 100000)) {
      logEvent("get-library-docs error: invalid tokens", { tokens });
      return {
        isError: true,
        content: [
          { type: "text", text: "Token count must be between 100 and 100000." }
        ]
      };
    }
    // Sanitize input (basic)
    const safeLibraryId = context7CompatibleLibraryID.replace(/[^a-zA-Z0-9_\-\/\.]/g, "");
    let folders = "";
    let libraryId = safeLibraryId;
    if (safeLibraryId.includes("?folders=")) {
      const [id, foldersParam] = safeLibraryId.split("?folders=");
      libraryId = id;
      folders = foldersParam;
    }
    const effectiveLang = lang || context7Config.defaultLang;
    const effectivePython = python || (effectiveLang === "python" ? context7Config.defaultVersion : undefined);
    try {
      const documentationText = await fetchLibraryDocumentation(libraryId, {
        tokens,
        topic,
        folders,
        lang: effectiveLang,
        python: effectivePython
      });
      if (!documentationText) {
        logEvent("get-library-docs error: not found", { libraryId, tokens, topic, lang: effectiveLang, python: effectivePython });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid Context7-compatible library ID, use the 'resolve-library-id' with the package name you wish to retrieve documentation for.",
            },
          ],
        };
      }
      logEvent("get-library-docs success", { libraryId, tokens, topic, lang: effectiveLang, python: effectivePython });
      return {
        content: [
          {
            type: "text",
            text: documentationText,
          },
        ],
      };
    } catch (error: any) {
      logEvent("get-library-docs error: exception", { error: error?.message || error });
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: ${error.message || error}`,
          },
        ],
      };
    }
  }
);
console.error("[LOG] Registered tool: get-library-docs");

// Linter error workaround: fallback to stdio if HTTP transport import fails
async function main() {
  // Check for HTTP transport via env or CLI args
  const useHttp =
    process.env.TRANSPORT === 'http' ||
    (process.argv.includes('--transport') && process.argv[process.argv.indexOf('--transport') + 1] === 'http');
  // const useSse = // Commenting out SSE logic for now
  //   process.env.TRANSPORT === 'sse' ||
  //   (process.argv.includes('--transport') && process.argv[process.argv.indexOf('--transport') + 1] === 'sse');

  if (useHttp) { // Primary check is now useHttp
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js");
      const HttpServerTransport = mod.StreamableHTTPServerTransport;
      if (!HttpServerTransport) throw new Error("StreamableHTTPServerTransport not found in module exports");
      // Parse host/port from args or use defaults
      const hostArg = process.argv.find((arg, i, arr) => arg === '--host' && arr[i+1]) ? process.argv[process.argv.indexOf('--host')+1] : '0.0.0.0';
      const portArg = process.argv.find((arg, i, arr) => arg === '--port' && arr[i+1]) ? Number(process.argv[process.argv.indexOf('--port')+1]) : 9700;
      const transport = new HttpServerTransport({ host: hostArg, port: portArg });
      // Log HTTP server creation
      console.error(`[LOG] HTTP Server Transport created at http://${hostArg}:${portArg}`);
      // Patch: log all HTTP requests (if possible)
      if (transport && typeof transport.on === 'function') {
        transport.on('request', (req: any) => {
          if (req && req.method && req.url) {
            console.error(`[LOG] HTTP ${req.method} ${req.url} Headers: ${JSON.stringify(req.headers)}`);
          } else if (req) {
            console.error(`[LOG] HTTP Incoming request with missing method/url. Req keys: ${Object.keys(req)}`);
          } else {
            console.error(`[LOG] HTTP Incoming request event triggered with no req object.`);
          }
        });
      }
      await server.connect(transport);
      console.error(`Context7 Documentation MCP Server running on http://${hostArg}:${portArg}`);
      // Prevent process from exiting if HTTP transport does not block
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 60 * 60));
      }
    } catch (e) {
      console.error("FATAL: Could not load HTTP transport for MCP server. Is @modelcontextprotocol/sdk installed and built correctly?", e);
      process.exit(1);
    }
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Context7 Documentation MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
