import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { CodexWorkbenchExecutor } from "../src/codex-workbench-executor.mjs";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";
import { STOCK_RUNTIME_KIND } from "../src/stock-prompt-input-skill-routing.mjs";
import { buildBrowserConfigOverrides as householdOverrides } from "../src/codexless-runtime.mjs";
import { browserMcpDisableOverrides, browserMcpIsolationOverride, buildBrowserConfigOverrides as publicOverrides } from "../src/public-runtime.mjs";

const nodeReplConfig = {
  command: process.execPath,
  args: ["--version"],
  enabled: false, // Parser tests must never start an MCP transport.
  startup_timeout_sec: 120,
  env: { NODE_FIXTURE: "snapshot-bound" },
};
const configuredMcpServers = {
  node_repl: { command: "source-node-repl.exe", args: [], enabled: true, env: { NODE_FIXTURE: "source" } },
  cua_repl: { command: process.execPath, args: ["--version"], enabled: true, env: { SAFE_TEST: "original", "key.with.dot": "retained" }, startup_timeout_sec: 120 },
  "external.http": { url: "http://127.0.0.1:1/unused", enabled: true, http_headers: { "X-Fixture": "retained" } },
  "other-server": { type: "stdio", command: process.execPath, args: ["--version"], enabled: false, env_vars: ["FIXTURE_NOT_SET"], tools: { "safe-tool": { enabled: false } } },
};
const builders = [["household", householdOverrides], ["public", publicOverrides]];
const key = value => /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
const toml = value => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  return `{ ${Object.entries(value).map(([name, child]) => `${key(name)} = ${toml(child)}`).join(", ")} }`;
};
const disabled = servers => Object.fromEntries(Object.entries(servers).map(([name, definition]) => [name, { ...structuredClone(definition), enabled: false }]));

for (const [label, build] of builders) {
  test(`${label} isolation retains every disabled server's complete transport and enforces the snapshot node definition`, () => {
    const input = structuredClone(configuredMcpServers);
    const before = structuredClone(input);
    const user = "mcp_servers.node_repl.env.NODE_FIXTURE=\"user\"";
    const enforced = "mcp_servers.node_repl.env.NODE_FIXTURE=\"enforced\"";
    const result = build({ configOverrides: [user], compatibilityOverrides: [enforced], configuredMcpServers: input, nodeReplConfig });
    assert.equal(result[0], user);
    assert.equal(result.at(-1), enforced);
    const table = result.find(value => value.startsWith("mcp_servers="));
    const expected = disabled(input);
    expected.node_repl = structuredClone(nodeReplConfig);
    assert.equal(table, `mcp_servers=${toml(expected)}`);
    assert.equal(result.filter(value => value.startsWith("mcp_servers=")).length, 1);
    assert.equal(result.some(value => /^mcp_servers\..*\.enabled=false$/.test(value)), false, "name-only disabled stubs must never be generated");
    assert.deepEqual(input, before, "isolation must not mutate the main runtime's MCP definitions");
    assert.equal(input.cua_repl.enabled, true);
  });

  test(`${label} unavailable Browser retains schema-valid definitions while disabling every server`, () => {
    const result = build({ configuredMcpServers, nodeReplConfig, browserAvailable: false, compatibilityOverrides: ["must-not-be-applied=true"] });
    assert.equal(result.find(value => value.startsWith("mcp_servers=")), `mcp_servers=${toml(disabled(configuredMcpServers))}`);
    assert.equal(result.includes("must-not-be-applied=true"), false);
  });

  test(`${label} absent bound node definition never enables the unbound source node transport`, () => {
    const result = build({ configuredMcpServers, nodeReplConfig: null });
    assert.equal(result.find(value => value.startsWith("mcp_servers=")), `mcp_servers=${toml(disabled(configuredMcpServers))}`);
  });

  test(`${label} isolation fails closed for a disabled transport-less definition or a missing named server`, () => {
    assert.throws(() => build({ configuredMcpServers: { cua_repl: { enabled: false } }, nodeReplConfig }), /transport|definition|configured|isolation/i);
    assert.throws(() => build({ configuredMcpServers: { cua_repl: configuredMcpServers.cua_repl }, configuredMcpServerNames: ["cua_repl", "missing.server"], nodeReplConfig }), /transport|definition|configured|isolation/i);
  });

  test(`${label} plugin MCP isolation targets discovered identities without altering the plugin or snapshot node transport`, () => {
    const pluginMcpServers = [
      { name: "cua_repl", pluginId: "unified-computer-use@openai-bundled" },
      { name: "name.with.dot", pluginId: "third.party@fixture-market" },
    ];
    const before = structuredClone(pluginMcpServers);
    const result = build({ configuredMcpServers, nodeReplConfig, pluginMcpServers });
    const pluginOverride = result.find(value => value.startsWith("plugins="));
    assert.equal(pluginOverride, `plugins=${toml({
      "unified-computer-use@openai-bundled": { mcp_servers: { cua_repl: { enabled: false } } },
      "third.party@fixture-market": { mcp_servers: { "name.with.dot": { enabled: false } } },
    })}`);
    assert.equal(result.some(value => value.startsWith("plugins.")), false, "dotted CLI keys with quoted plugin IDs must not be generated");
    assert.equal(result.find(value => value.startsWith("mcp_servers=")), `mcp_servers=${toml({ ...disabled(configuredMcpServers), node_repl: nodeReplConfig })}`);
    assert.deepEqual(pluginMcpServers, before);
    assert.doesNotMatch(pluginOverride, /command|args|env|node_repl/);
  });
}

test("public per-server helper retains transport, typed fields, env and tool metadata and quotes names", () => {
  const names = ["node_repl", "cua_repl", "external.http", "other-server", "other-server"];
  const result = browserMcpDisableOverrides(names, { keep: "node_repl", configuredMcpServers });
  assert.deepEqual(result, names.slice(1, 4).map(name => `mcp_servers=${toml({ [name]: { ...configuredMcpServers[name], enabled: false } })}`));
  assert.equal(result.some(value => value.startsWith("mcp_servers.")), false, "quoted server names must use inline tables rather than dotted CLI paths");
  assert.throws(() => browserMcpDisableOverrides(["missing"], { configuredMcpServers }), /transport|definition|configured|isolation/i);
  const table = browserMcpIsolationOverride(nodeReplConfig, { configuredMcpServers });
  assert.equal(table, `mcp_servers=${toml({ ...disabled(configuredMcpServers), node_repl: nodeReplConfig })}`);
});

for (const [label, Executor] of [["workbench", CodexWorkbenchExecutor], ["public context", CodexPublicContextExecutor]]) {
  for (const configKey of ["mcp_servers", "mcpServers"]) test(`${label} config/read discovery returns a detached complete ${configKey} map`, async () => {
    const source = structuredClone(configuredMcpServers);
    const requests = [];
    const client = {
      running: false,
      async start() { this.running = true; return {}; },
      async close() { this.running = false; },
      onNotification() { return () => {}; },
      async request(method, params) {
        requests.push({ method, params });
        assert.equal(method, "config/read");
        return { config: { [configKey]: source } };
      },
    };
    const executor = new Executor({ codexBin: "unused-fixture-codex", defaultCwd: process.cwd(), clientFactory: () => client, runtimeKind: STOCK_RUNTIME_KIND });
    try {
      const result = await executor.configuredMcpServers();
      assert.deepEqual(result, source);
      result.cua_repl.command = "mutated-result";
      result.cua_repl.env.SAFE_TEST = "mutated-result";
      delete result["external.http"];
      assert.equal(source.cua_repl.command, process.execPath);
      assert.equal(source.cua_repl.env.SAFE_TEST, "original");
      assert.ok(source["external.http"]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].params.includeLayers, false);
      assert.equal(requests[0].params.cwd, path.resolve(process.cwd()));
    } finally { await executor.close(); }
  });

  test(`${label} plugin MCP discovery follows official pagination and retains only exact plugin identities`, async () => {
    const pages = [
      { data: [{ name: "node_repl" }, { name: "cua_repl", pluginId: "unified-computer-use@openai-bundled" }, { name: "plain", pluginId: null }], nextCursor: "next-page" },
      { data: [{ name: "name.with.dot", pluginId: "third.party@fixture-market" }, { name: "empty-plugin", pluginId: "" }], nextCursor: null },
    ];
    const before = structuredClone(pages);
    const requests = [];
    const client = {
      running: false,
      async start() { this.running = true; return {}; },
      async close() { this.running = false; },
      onNotification() { return () => {}; },
      async request(method, params) {
        requests.push({ method, params: structuredClone(params) });
        assert.equal(method, "mcpServerStatus/list");
        return pages[params.cursor === "next-page" ? 1 : 0];
      },
    };
    const executor = new Executor({ codexBin: "unused-fixture-codex", defaultCwd: process.cwd(), clientFactory: () => client, runtimeKind: STOCK_RUNTIME_KIND });
    try {
      const result = await executor.configuredMcpPluginServers();
      assert.deepEqual(result, [
        { name: "cua_repl", pluginId: "unified-computer-use@openai-bundled" },
        { name: "name.with.dot", pluginId: "third.party@fixture-market" },
      ]);
      result[0].name = "changed-result";
      assert.deepEqual(pages, before);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].params.cursor, "next-page");
    } finally { await executor.close(); }
  });
}

async function parserFixture(t, rootServers, overrides) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexless-browser-mcp-isolation-"));
  const file = path.join(home, "config.toml");
  const writeConfig = servers => writeFile(file, `mcp_servers=${toml(servers)}\n`);
  await writeConfig(rootServers);
  const { path: codexBin } = await resolveCodexExecutable();
  let stderr = "";
  const client = new CodexAppServerClient({ cwd: home, initializeCapabilities: { experimentalApi: true }, requestTimeoutMs: 15_000,
    stderrHandler: chunk => { stderr += chunk; },
    launch: () => ({ command: codexBin, args: [...overrides.flatMap(value => ["-c", value]), "app-server", "--stdio"], options: { cwd: home, env: { ...process.env, CODEX_HOME: home } } }),
  });
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith("codexless-browser-mcp-isolation-"));
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { client, writeConfig, home, stderr: () => stderr };
}
const parserServers = disabled(configuredMcpServers);
parserServers.node_repl = nodeReplConfig;

test("matching official parser reproduces the old disabled cua_repl stub after its inherited transport disappears", { timeout: 30_000 }, async t => {
  const fixture = await parserFixture(t, parserServers, [`mcp_servers=${toml({ node_repl: nodeReplConfig })}`, "mcp_servers.cua_repl.enabled=false"]);
  await fixture.client.start();
  const first = await fixture.client.request("config/read", { cwd: fixture.home, includeLayers: false });
  assert.equal((first.config.mcp_servers ?? first.config.mcpServers).cua_repl.command, process.execPath);
  const { cua_repl: _removed, ...rest } = parserServers;
  await fixture.writeConfig(rest);
  await assert.rejects(fixture.client.request("mcpServerStatus/list", { limit: 50 }), error =>
    error.method === "mcpServerStatus/list" && /failed to reload config: invalid transport[\s\S]*mcp_servers\.cua_repl/.test(error.message));
});

for (const [label, build] of builders) test(`${label} complete disabled map remains valid on official parser reload without starting other transports`, { timeout: 30_000 }, async t => {
  const overrides = build({ configuredMcpServers: parserServers, nodeReplConfig });
  const fixture = await parserFixture(t, parserServers, overrides);
  await fixture.client.start();
  const { cua_repl: _removed, ...rest } = parserServers;
  await fixture.writeConfig(rest);
  const status = await fixture.client.request("mcpServerStatus/list", { limit: 50 });
  assert.ok(Array.isArray(status.data));
  const result = await fixture.client.request("config/read", { cwd: fixture.home, includeLayers: false });
  const servers = result.config.mcp_servers ?? result.config.mcpServers;
  for (const [name, definition] of Object.entries(parserServers)) {
    assert.equal(servers[name].enabled, false, `${name} must remain disabled`);
    if (definition.command) { assert.equal(servers[name].command, definition.command); assert.deepEqual(servers[name].args, definition.args); }
    if (definition.url) assert.equal(servers[name].url, definition.url);
  }
  assert.deepEqual(servers.cua_repl.env, parserServers.cua_repl.env);
  assert.deepEqual(servers["external.http"].http_headers, parserServers["external.http"].http_headers);
  assert.deepEqual(servers.node_repl.env, nodeReplConfig.env);
  assert.doesNotMatch(fixture.stderr(), /failed to (?:start|connect).*MCP|invalid transport/i);
});

test("the official parser still rejects an actually invalid disabled MCP entry", { timeout: 30_000 }, async t => {
  const fixture = await parserFixture(t, { cua_repl: { enabled: false } }, []);
  await fixture.client.start();
  await assert.rejects(fixture.client.request("mcpServerStatus/list", { limit: 50 }), error =>
    error.method === "mcpServerStatus/list" && /failed to reload config:[\s\S]*invalid transport/.test(error.message));
});
