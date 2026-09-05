import http from "node:http";
import { createRequire } from "node:module";
import { createCodexlessRuntime } from "./codexless-runtime.mjs";
import { createMcpHttpSessionRouter } from "./mcp-http-session-router.mjs";

const require = createRequire(import.meta.url);
const { createMcpHandler } = require("@modelcontextprotocol/server");
const { localhostHostValidation, localhostOriginValidation, toNodeHandler } = require("@modelcontextprotocol/node");

const host = process.env.CODEX_TOOLBOX_PUBLIC_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CODEX_TOOLBOX_PUBLIC_PORT ?? "7690", 10);
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("Codexless public HTTP may bind only to loopback");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid CODEX_TOOLBOX_PUBLIC_PORT: ${process.env.CODEX_TOOLBOX_PUBLIC_PORT}`);
}

const runtime = await createCodexlessRuntime({ mode: "public" });
const mcpHandler = createMcpHandler(runtime.createServer, {
  legacy: "stateless",
  maxSubscriptions: 0,
  keepAliveMs: 0,
  onerror: (error) => console.error("[codexless-public-mcp]", error),
});
const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("[codexless-public-node]", error),
});
const sessionRouter = createMcpHttpSessionRouter({
  createServer: runtime.createServer,
  modernNodeHandler: nodeMcpHandler,
  onerror: (error) => console.error("[codexless-public-session]", error),
});
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const server = http.createServer(async (req, res) => {
  try {
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        // Compatibility service id retained for health-check consumers; not the product name.
        // Compatibility service id for existing public-preview health probes; not the product name.
        service: "codexless-public",
        transport: "streamable-http",
        publicPreview: true,
        version: runtime.version,
        surfaceVersion: runtime.surfaceVersion,
        toolCount: runtime.toolAllowlist?.length ?? null,
        defaultCwd: runtime.authorityValidation.defaultCwd ?? null,
      }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    await sessionRouter.handle(req, res);
  } catch (error) {
    console.error("[codexless-public-http]", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
  }
});

server.keepAliveTimeout = 5_000;
server.headersTimeout = 10_000;
server.requestTimeout = 0;
server.maxHeadersCount = 64;

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});
console.error(`Codexless public HTTP listening on http://${host}:${port}/mcp; surface=${runtime.surfaceVersion}`);

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  try {
    await sessionRouter.close();
    await mcpHandler.close();
    await new Promise((resolve) => server.close(() => resolve()));
  } finally {
    await runtime.close();
    console.error(`Codexless public HTTP stopped (${signal})`);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
