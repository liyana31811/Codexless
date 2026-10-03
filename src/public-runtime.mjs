import os from "node:os";
import path from "node:path";
import { createAgentPreviewState } from "./agent-tools.mjs";
import { CodexAgentExecutor } from "./codex-agent-executor.mjs";
import { CodexAuthorityExecutor } from "./codex-authority-executor.mjs";
import { CodexBrowserExecutor } from "./codex-browser-executor.mjs";
import { resolveBrowserRuntimeCompatibility } from "./browser-runtime-compat.mjs";
import { CodexPublicBrowserWorkbenchAdapter } from "./public-browser-workbench-adapter.mjs";
import { resolveCodexExecutable } from "./codex-bin.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";
import { createPreviewTelemetryClient } from "./codex-preview-account-preflight.mjs";
import { readJsonFile } from "./json-file.mjs";
import { CodexPublicContextExecutor } from "./public-context-executor.mjs";
import { createPublicServerFactory } from "./public-server-factory.mjs";
import { createRecentCallDiagnostics, recentCallOptionsFromEnv } from "./recent-call-diagnostics.mjs";
import { STOCK_RUNTIME_KIND } from "./stock-prompt-input-skill-routing.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "./surface-contracts.mjs";

function envString(env, name, fallback = null) {
  const value = env?.[name];
  return typeof value === "string" && value.length ? value : fallback;
}

function tomlKey(value) {
  const text = String(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : JSON.stringify(text);
}

function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, child]) => child !== null && child !== undefined)
      .map(([key, child]) => `${tomlKey(key)} = ${tomlValue(child)}`);
    return `{ ${fields.join(", ")} }`;
  }
  throw new Error(`unsupported Browser MCP config value type: ${typeof value}`);
}

function disabledMcpDefinition(name, definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition) ||
      !(typeof definition.command === "string" && definition.command || typeof definition.url === "string" && definition.url)) {
    throw new Error(`Browser MCP isolation requires a complete transport definition for ${name}`);
  }
  return { ...definition, enabled: false };
}

export function browserMcpIsolationOverride(nodeReplConfig, { configuredMcpServers = {}, browserAvailable = true } = {}) {
  const isolated = Object.create(null);
  for (const [name, definition] of Object.entries(configuredMcpServers)) {
    if (browserAvailable && name === "node_repl" && nodeReplConfig) {
      isolated.node_repl = nodeReplConfig;
      continue;
    }
    isolated[name] = disabledMcpDefinition(name, definition);
  }
  if (browserAvailable && nodeReplConfig && typeof nodeReplConfig === "object" && !Array.isArray(nodeReplConfig)) {
    isolated.node_repl = nodeReplConfig;
  }
  return `mcp_servers=${tomlValue(isolated)}`;
}

export function browserMcpDisableOverrides(serverNames = [], { keep = null, configuredMcpServers = {} } = {}) {
  const unique = [...new Set(serverNames.filter((name) => typeof name === "string" && name))];
  return unique
    .filter((name) => name !== keep)
    .map((name) => `mcp_servers=${tomlValue({ [name]: disabledMcpDefinition(name, configuredMcpServers[name]) })}`);
}

function browserPluginMcpIsolationOverride(pluginMcpServers, { keep = null } = {}) {
  const plugins = Object.create(null);
  for (const { name, pluginId } of pluginMcpServers) {
    if (name === keep) continue;
    if (typeof name !== "string" || !name || typeof pluginId !== "string" || !pluginId) {
      throw new Error("Browser MCP isolation requires plugin server provenance");
    }
    plugins[pluginId] ??= { mcp_servers: Object.create(null) };
    plugins[pluginId].mcp_servers[name] = { enabled: false };
  }
  return Object.keys(plugins).length ? [`plugins=${tomlValue(plugins)}`] : [];
}

export function buildBrowserConfigOverrides({
  configOverrides = [],
  compatibilityOverrides = [],
  nodeReplConfig = null,
  configuredMcpServerNames = [],
  configuredMcpServers = {},
  pluginMcpServers = [],
  browserAvailable = true,
} = {}) {
  for (const name of configuredMcpServerNames) {
    if (browserAvailable && name === "node_repl" && nodeReplConfig) continue;
    disabledMcpDefinition(name, configuredMcpServers[name]);
  }
  return [
    ...configOverrides,
    browserMcpIsolationOverride(nodeReplConfig, { configuredMcpServers, browserAvailable }),
    ...browserPluginMcpIsolationOverride(pluginMcpServers, { keep: browserAvailable ? "node_repl" : null }),
    ...(browserAvailable ? compatibilityOverrides : []),
  ];
}

export async function createPublicRuntime({ env = process.env } = {}) {
  const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
  if (!supportedPlatform && env.CODEXLESS_ALLOW_NONWINDOWS_PROBE !== "1") {
    throw new Error("Codexless Technical Preview currently supports Windows and Apple Silicon macOS only");
  }

  const codexResolution = await resolveCodexExecutable({ env });
  const codexBin = codexResolution.path;

  const defaultCwd = envString(env, "CODEXLESS_DEFAULT_CWD", process.cwd());
  const profileOverride = envString(env, "CODEXLESS_PROFILE", null);
  const configOverridesFile = envString(env, "CODEXLESS_CONFIG_OVERRIDES_FILE", null);
  const configOverrides = configOverridesFile
    ? (await readJsonFile(configOverridesFile, "CODEXLESS_CONFIG_OVERRIDES_FILE"))?.overrides
    : [];
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("CODEXLESS_CONFIG_OVERRIDES_FILE must contain { overrides: [\"key=value\", ...] }");
  }
  const meteredConsentMode = envString(env, "CODEXLESS_AGENT_METERED_CONSENT", "always");
  if (!["off", "always"].includes(meteredConsentMode)) {
    throw new Error("CODEXLESS_AGENT_METERED_CONSENT must be off or always");
  }
  const agentTaskStateFile = envString(
    env,
    "CODEXLESS_AGENT_TASK_STATE_FILE",
    path.join(os.homedir(), ".config", "codexless", "agent-task-cards.json")
  );
  const recentCallDiagnostics = createRecentCallDiagnostics(recentCallOptionsFromEnv(env));

  let publicContext = null;
  let browserContext = null;
  let agentExecutor = null;
  let closed = false;

  try {
    const authorityExecutor = new CodexAuthorityExecutor({
      codexBin,
      defaultCwd,
      profileOverride,
      configOverrides,
      maxTimeoutMs: 30_000,
      watchdogGraceMs: 5_000,
      outputBytesCap: 32_768,
      acceptedCodexVersions: null,
    });
    const authorityValidation = await authorityExecutor.validate();

    publicContext = new CodexPublicContextExecutor({
      codexBin,
      defaultCwd,
      configOverrides,
      runtimeKind: STOCK_RUNTIME_KIND,
    });
    await publicContext.start();
    const [configuredMcpServers, pluginMcpServers, currentChromeSkill] = await Promise.all([
      publicContext.configuredMcpServers({ cwd: defaultCwd }),
      publicContext.configuredMcpPluginServers(),
      publicContext.currentChromeSkill({ cwd: defaultCwd }).catch(() => null),
    ]);
    const nodeReplConfig = configuredMcpServers.node_repl ? structuredClone(configuredMcpServers.node_repl) : null;
    const browserCompatibility = await resolveBrowserRuntimeCompatibility({
      codexBin,
      chromeSkillPath: currentChromeSkill?.path ?? null,
      env,
    });
    const browserRuntimeCwd = browserCompatibility.browserRuntimeCwd;
    const browserAvailable = browserCompatibility.status === "ok" && nodeReplConfig !== null;
    const browserConfigOverrides = buildBrowserConfigOverrides({
      configOverrides,
      compatibilityOverrides: browserCompatibility.overrides,
      nodeReplConfig,
      configuredMcpServers,
      pluginMcpServers,
      browserAvailable,
    });

    const resourceSnapshotProvider = async () => {
      const telemetry = createPreviewTelemetryClient({
        codexBin,
        defaultCwd,
        configOverrides,
        stderrHandler: () => {},
      });
      try {
        await telemetry.start();
        return await readCodexQuotaSnapshot({ client: telemetry });
      } finally {
        await telemetry.close().catch(() => {});
      }
    };

    agentExecutor = new CodexAgentExecutor({
      codexBin,
      defaultCwd,
      configOverrides,
      requestTimeoutMs: 30_000,
      resourceSnapshotProvider,
    });
    await agentExecutor.open();

    const agentPreviewState = createAgentPreviewState({
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      taskStateFile: agentTaskStateFile,
    });

    browserContext = new CodexPublicContextExecutor({
      codexBin,
      defaultCwd: browserRuntimeCwd,
      configOverrides: browserConfigOverrides,
      runtimeKind: STOCK_RUNTIME_KIND,
    });
    const browser = new CodexBrowserExecutor({
      workbench: new CodexPublicBrowserWorkbenchAdapter({ context: browserContext, runtimeCwd: browserRuntimeCwd }),
      authorityExecutor,
      defaultCwd,
    });
    const createServer = createPublicServerFactory({
      executor: authorityExecutor,
      authorityExecutor,
      publicContext,
      browser,
      agentExecutor,
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      agentPreviewState,
      recentCallDiagnostics,
      maxConcurrent: 1,
    });

    async function close() {
      if (closed) return;
      closed = true;
      try {
        await agentExecutor?.close();
      } finally {
        try {
          await browserContext?.close();
        } finally {
          await publicContext?.close();
        }
      }
    }

    return {
      createServer,
      close,
      version: PUBLIC_SERVER_VERSION,
      surfaceVersion: PUBLIC_SURFACE_VERSION,
      toolNames: PUBLIC_TOOL_NAMES,
      defaultCwd,
      meteredConsentMode,
      authorityValidation,
      recentCallDiagnostics,
    };
  } catch (error) {
    try {
      await agentExecutor?.close();
    } finally {
      await publicContext?.close();
    }
    throw error;
  }
}
