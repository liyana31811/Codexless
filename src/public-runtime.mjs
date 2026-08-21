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

async function closeStartedPublicRuntimeComponents({ agentExecutor, browserContext, publicContext }) {
  let cleanupFailed = false;
  let lastCleanupError;
  for (const component of [agentExecutor, browserContext, publicContext]) {
    try {
      await component?.close();
    } catch (error) {
      cleanupFailed = true;
      lastCleanupError = error;
    }
  }
  if (cleanupFailed) throw lastCleanupError;
}

export function browserMcpIsolationOverride(nodeReplConfig) {
  const isolated = nodeReplConfig && typeof nodeReplConfig === "object" && !Array.isArray(nodeReplConfig)
    ? { node_repl: nodeReplConfig }
    : {};
  return `mcp_servers=${tomlValue(isolated)}`;
}

export function browserMcpDisableOverrides(serverNames = [], { keep = null } = {}) {
  const unique = [...new Set(serverNames.filter((name) => typeof name === "string" && name))];
  return unique
    .filter((name) => name !== keep)
    .map((name) => `mcp_servers.${tomlKey(name)}.enabled=false`);
}

export function buildBrowserConfigOverrides({
  configOverrides = [],
  compatibilityOverrides = [],
  nodeReplConfig = null,
  configuredMcpServerNames = [],
  browserAvailable = true,
} = {}) {
  return [
    ...configOverrides,
    browserMcpIsolationOverride(browserAvailable ? nodeReplConfig : null),
    ...browserMcpDisableOverrides(configuredMcpServerNames, { keep: browserAvailable ? "node_repl" : null }),
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
    const [nodeReplConfig, configuredMcpServerNames, currentChromeSkill] = await Promise.all([
      publicContext.configuredMcpServer({ name: "node_repl", cwd: defaultCwd }).catch(() => null),
      publicContext.configuredMcpServerNames({ cwd: defaultCwd }).catch(() => []),
      publicContext.currentChromeSkill({ cwd: defaultCwd }).catch(() => null),
    ]);
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
      configuredMcpServerNames,
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
      await closeStartedPublicRuntimeComponents({ agentExecutor, browserContext, publicContext });
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
    await closeStartedPublicRuntimeComponents({ agentExecutor, browserContext, publicContext });
    throw error;
  }
}
