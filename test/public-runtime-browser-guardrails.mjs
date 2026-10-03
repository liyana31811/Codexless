import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { browserMcpDisableOverrides, browserMcpIsolationOverride, buildBrowserConfigOverrides } from "../src/public-runtime.mjs";

const nodeReplConfig = {
  command: "C:\\Program Files\\Codex\\node_repl.exe",
  args: [],
  startup_timeout_sec: 120,
  env: {
    "NORMAL_KEY": "value",
    "key.with.dot": "special",
    "space key": "still-safe",
  },
};
const configuredMcpServers = {
  node_repl: { command: "source-node-repl.exe", args: [], enabled: true },
  "slay-the-spire": { command: "game-server.exe", args: ["--stdio"], enabled: true },
  "name.with.dot": { command: "quoted-server.exe", args: [], enabled: true },
  "other-server": { url: "https://example.invalid/mcp", enabled: true },
};
const isolated = browserMcpIsolationOverride(nodeReplConfig, { configuredMcpServers });
assert.match(isolated, /^mcp_servers=\{/);
assert.match(isolated, /node_repl\s*=\s*\{/);
assert.match(isolated, /"key\.with\.dot"\s*=\s*"special"/);
assert.match(isolated, /"space key"\s*=\s*"still-safe"/);
assert.match(isolated, /slay-the-spire\s*=\s*\{ command\s*=\s*"game-server\.exe", args\s*=\s*\["--stdio"\], enabled\s*=\s*false \}/);
assert.match(isolated, /"name\.with\.dot"\s*=\s*\{ command\s*=\s*"quoted-server\.exe", args\s*=\s*\[\], enabled\s*=\s*false \}/);
assert.match(isolated, /other-server\s*=\s*\{ url\s*=\s*"https:\/\/example\.invalid\/mcp", enabled\s*=\s*false \}/);
assert.doesNotMatch(isolated, /source-node-repl/);

const configuredMcpServerNames = ["node_repl", "slay-the-spire", "name.with.dot", "other-server", "other-server"];
const disableOverrides = browserMcpDisableOverrides(configuredMcpServerNames, { keep: "node_repl", configuredMcpServers });
assert.deepEqual(disableOverrides, [
  "mcp_servers={ slay-the-spire = { command = \"game-server.exe\", args = [\"--stdio\"], enabled = false } }",
  "mcp_servers={ \"name.with.dot\" = { command = \"quoted-server.exe\", args = [], enabled = false } }",
  "mcp_servers={ other-server = { url = \"https://example.invalid/mcp\", enabled = false } }",
]);

const userCompatibilityOverride = "mcp_servers.node_repl.env.CODEX_CLI_PATH=\"user-value\"";
const enforcedCompatibilityOverride = "mcp_servers.node_repl.env.CODEX_CLI_PATH=\"resolved-value\"";
const merged = buildBrowserConfigOverrides({
  configOverrides: [userCompatibilityOverride, "features.apps=true"],
  compatibilityOverrides: [enforcedCompatibilityOverride],
  nodeReplConfig,
  configuredMcpServerNames,
  configuredMcpServers,
  browserAvailable: true,
});
assert.equal(merged[0], userCompatibilityOverride, "user overrides are applied before Browser isolation/compatibility");
assert.match(merged[2], /^mcp_servers=\{/);
assert.equal(merged[2], isolated, "Browser child must preserve every non-node_repl transport while explicitly disabling it");
assert.equal(merged.some(value => /^mcp_servers\..*\.enabled=false$/.test(value)), false, "Browser child must never create transport-less disabled MCP entries");
assert.equal(merged.at(-1), enforcedCompatibilityOverride, "trusted compatibility override must win over a conflicting user override");

const degraded = buildBrowserConfigOverrides({
  configOverrides: ["features.apps=true"],
  compatibilityOverrides: [enforcedCompatibilityOverride],
  nodeReplConfig,
  configuredMcpServerNames,
  configuredMcpServers,
  browserAvailable: false,
});
assert.equal(degraded[1], browserMcpIsolationOverride(null, { configuredMcpServers, browserAvailable: false }), "degraded Browser child must retain complete schema-valid disabled transports");
assert.match(degraded[1], /node_repl\s*=\s*\{ command\s*=\s*"source-node-repl\.exe", args\s*=\s*\[\], enabled\s*=\s*false \}/);
assert.equal(degraded.some(value => /^mcp_servers\..*\.enabled=false$/.test(value)), false, "degraded Browser child must not reconstruct an invalid node_repl or other MCP stub");
assert.equal(degraded.includes(enforcedCompatibilityOverride), false, "compatibility env must not be injected when the Browser transport is unavailable");

const runtimeSource = await readFile(path.resolve(import.meta.dirname, "../src/public-runtime.mjs"), "utf8");
assert.doesNotMatch(runtimeSource, /await\s+browserContext\.start\s*\(/, "Browser child must remain lazy so Browser failure cannot kill core startup");
assert.match(runtimeSource, /new CodexPublicContextExecutor\([\s\S]*defaultCwd:\s*browserRuntimeCwd/);

console.log("Public runtime Browser guardrails PASS");
