import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createPublicServerFactory } from "../src/public-server-factory.mjs";
import { createAgentPreviewState } from "../src/agent-tools.mjs";

const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "public-tools-v1.json"), "utf8"));
const agentPreviewState = createAgentPreviewState({ meteredConsentMode: "always" });
const recentCallDiagnostics = { wrapHandler: (name, handler) => handler };

const createServer = createPublicServerFactory({
  executor: {},
  authorityExecutor: {},
  publicContext: {},
  browser: {},
  agentExecutor: {},
  meteredConsentMode: "always",
  meteredQuotaProvider: null,
  agentPreviewState,
  recentCallDiagnostics,
  maxConcurrent: 1,
});
const server = createServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "codexless-public-contract-golden", version: "0.1.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  assert.deepEqual(client.getServerVersion(), fixture.server);
  assert.equal(client.getInstructions(), fixture.instructions);

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 39);
  assert.equal(JSON.stringify(listed.tools), JSON.stringify(fixture.tools), "the complete tools/list wire representation must remain frozen");
  assert.deepEqual(listed.tools.map(({ name }) => name), fixture.tools.map(({ name }) => name));
  assert.equal(new Set(listed.tools.map(({ name }) => name)).size, 39);
} finally {
  await client.close();
  await server.close();
}
