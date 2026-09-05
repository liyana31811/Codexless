import os from "node:os";
import path from "node:path";
import { createAgentPreviewState } from "./agent-tools.mjs";
import { readJsonFile } from "./json-file.mjs";
import {
  HOUSEHOLD_SERVER_VERSION,
  HOUSEHOLD_SURFACE_VERSION,
  HOUSEHOLD_TOOL_ALLOWLIST,
  PUBLIC_SERVER_VERSION,
  PUBLIC_SURFACE_VERSION,
  PUBLIC_TOOL_ALLOWLIST,
  WORKBENCH_SERVER_VERSION,
  WORKBENCH_SURFACE_VERSION,
} from "./surface-contracts.mjs";
import { CodexAgentExecutor } from "./codex-agent-executor.mjs";
import { CodexAuthorityExecutor } from "./codex-authority-executor.mjs";
import { resolveBrowserRuntimeCompatibility } from "./browser-runtime-compat.mjs";
import { createCodexRuntimeProvider } from "./codex-runtime-provider.mjs";
import { CodexBrowserExecutor } from "./codex-browser-executor.mjs";
import { createDeferredBrowserAdapter } from "./deferred-browser-adapter.mjs";
import { LazyCodexAgentExecutor } from "./lazy-codex-agent-executor.mjs";
import { LazyCodexAuthorityExecutor } from "./lazy-codex-authority-executor.mjs";
import { BrowserElicitationBridge } from "./browser-elicitation-bridge.mjs";
import { CodexComputerUseExecutor } from "./codex-computer-use-executor.mjs";
import { CodexWorkbenchExecutor } from "./codex-workbench-executor.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";
import { createPreviewTelemetryClient } from "./codex-preview-account-preflight.mjs";
import { createCodexToolboxServerFactory } from "./mcp-server-factory.mjs";
import { createRecentCallReceiptStore } from "./recent-call-receipts.mjs";

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

function uniqueMcpServerNames(values) {
  const names = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const name = typeof value === "string" ? value : value?.name;
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export async function configuredMcpServerNamesForBrowser(workbench, { cwd } = {}) {
  if (typeof workbench?.configuredMcpServerNames === "function") {
    const configured = await workbench.configuredMcpServerNames({ cwd });
    const values = Array.isArray(configured)
      ? configured
      : Array.isArray(configured?.names)
        ? configured.names
        : Array.isArray(configured?.servers)
          ? configured.servers
          : [];
    return uniqueMcpServerNames(values);
  }
  if (typeof workbench?.catalog !== "function") {
    throw new Error("Browser MCP isolation requires configured MCP server discovery");
  }
  const catalog = await workbench.catalog({ kind: "mcp", cwd });
  const servers = Array.isArray(catalog?.servers) ? catalog.servers : [];
  if (catalog?.nextCursor || servers.length >= 50) {
    throw new Error(
      "Browser MCP isolation cannot prove the configured MCP server list is complete; " +
      "a full config/read enumeration is required before starting the isolated Browser child"
    );
  }
  return uniqueMcpServerNames(servers);
}

export function browserMcpIsolationOverrides({
  configuredMcpServerNames = [],
  nodeReplConfig = null,
  browserAvailable = true,
} = {}) {
  const overrides = [];
  if (browserAvailable && nodeReplConfig && typeof nodeReplConfig === "object" && !Array.isArray(nodeReplConfig)) {
    overrides.push(`mcp_servers=${tomlValue({ node_repl: nodeReplConfig })}`);
  }
  for (const name of uniqueMcpServerNames(configuredMcpServerNames)) {
    if (browserAvailable && name === "node_repl") continue;
    overrides.push(`mcp_servers.${tomlKey(name)}.enabled=false`);
  }
  return overrides;
}

export function buildBrowserConfigOverrides({
  configOverrides = [],
  compatibilityOverrides = [],
  configuredMcpServerNames = [],
  nodeReplConfig = null,
  browserAvailable = true,
} = {}) {
  return [
    ...configOverrides,
    ...browserMcpIsolationOverrides({ configuredMcpServerNames, nodeReplConfig, browserAvailable }),
    ...(browserAvailable ? compatibilityOverrides : []),
  ];
}

export const MANAGED_FORMAL_AGENT_BLOCK = Object.freeze({
  code: "MANAGED_CODEX_MODEL_INVOCATION_DISABLED",
  message: "Managed toolbox is available, but Managed Codex model invocation is not enabled. Call Codex / Formal Agent remains available only when Codexless is explicitly running on the Existing runtime lane; no Existing fallback was performed.",
  nextActions: Object.freeze([
    "Keep using the Managed model-free toolbox in this runtime.",
    "Use an explicitly Existing Codexless runtime for the current Call Codex / Formal Agent path.",
    "Do not enable Managed Agent work until its approval, usage, lifecycle, and runtime acceptance is completed in a separate ticket.",
  ]),
});

function managedFormalAgentError() {
  const error = new Error(MANAGED_FORMAL_AGENT_BLOCK.message);
  error.code = MANAGED_FORMAL_AGENT_BLOCK.code;
  error.nextActions = [...MANAGED_FORMAL_AGENT_BLOCK.nextActions];
  return error;
}

function createManagedFormalAgentExecutor() {
  const blocked = async () => { throw managedFormalAgentError(); };
  return {
    running: false,
    async open() { return { blocked: true, runtimeLane: "existing", managedModelInvocation: "blocked" }; },
    async close() {},
    listModels: blocked,
    start: blocked,
    show: blocked,
    resolvePendingRequest: blocked,
    rejectPendingRequest: blocked,
    resolveApproval: blocked,
    cancel: blocked,
    send: blocked,
  };
}

function createManagedFormalAgentAuthorityExecutor() {
  return { async resolveAuthority() { throw managedFormalAgentError(); } };
}

function compatibilityRuntimeMode(env) {
  const requested = env.CODEXLESS_RUNTIME_MODE;
  if (requested !== undefined) {
    if (!["household", "public", "workbench"].includes(requested)) {
      throw new Error("CODEXLESS_RUNTIME_MODE must be household, public, or workbench");
    }
    return requested;
  }

  // Compatibility env ids retained for existing launchers; these are not product names.
  const householdCompat = env.CODEX_TOOLBOX_PRIVATE_CONSTRUCTION === "1";
  const publicCompat = env.CODEX_TOOLBOX_PUBLIC_PREVIEW === "1";
  if (householdCompat && publicCompat) {
    throw new Error("Codexless runtime cannot enable household and public compatibility modes together");
  }
  if (householdCompat) return "household";
  if (publicCompat) return "public";
  return "workbench";
}

export function browserServerRequestRoutingPolicy(mode) {
  if (!["household", "public", "workbench"].includes(mode)) {
    throw new Error("Codexless runtime mode must be household, public, or workbench");
  }
  return Object.freeze({
    enabled: mode === "household" || mode === "public",
    scope: mode === "household" || mode === "public" ? "browser-only" : "disabled",
  });
}

export async function createCodexlessRuntime({
  env = process.env,
  mode = compatibilityRuntimeMode(env),
  stateRoot,
  workbenchFactory = (options) => new CodexWorkbenchExecutor(options),
} = {}) {
  if (!["household", "public", "workbench"].includes(mode)) {
    throw new Error("Codexless runtime mode must be household, public, or workbench");
  }
  const privateConstruction = mode === "household";
  const publicPreview = mode === "public";
  const browserServerRequests = browserServerRequestRoutingPolicy(mode);

  const runtimeProvider = await createCodexRuntimeProvider({ env, stateRoot });
  const modelFreeRuntime = runtimeProvider.modelFree;
  const codexBin = modelFreeRuntime.bin;
  const modelFreeLaunchEnv = modelFreeRuntime.launchEnv;

  const envNames = publicPreview
    ? {
        defaultCwd: "CODEXLESS_DEFAULT_CWD",
        profile: "CODEXLESS_PROFILE",
        configOverridesFile: "CODEXLESS_CONFIG_OVERRIDES_FILE",
        meteredConsent: "CODEXLESS_AGENT_METERED_CONSENT",
        agentTaskStateFile: "CODEXLESS_AGENT_TASK_STATE_FILE",
      }
    : {
        defaultCwd: "CODEX_TOOLBOX_DEFAULT_CWD",
        profile: "CODEX_TOOLBOX_PROFILE",
        configOverridesFile: "CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE",
        meteredConsent: "CODEX_TOOLBOX_AGENT_METERED_CONSENT",
        agentTaskStateFile: "CODEX_TOOLBOX_AGENT_TASK_STATE_FILE",
      };
  const defaultCwd = envString(env, envNames.defaultCwd, process.cwd());
  const profileOverride = envString(env, envNames.profile, null);
  const configOverridesFile = envString(env, envNames.configOverridesFile, null);
  const configOverrides = configOverridesFile
    ? (await readJsonFile(configOverridesFile, envNames.configOverridesFile))?.overrides
    : [];
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error(`${envNames.configOverridesFile} must contain { overrides: [\"key=value\", ...] }`);
  }

  const cuaHelper = privateConstruction || publicPreview ? null : envString(env, "CODEX_TOOLBOX_CUA_HELPER", null);
  const meteredConsentMode = envString(env, envNames.meteredConsent, publicPreview ? "always" : "off");
  if (!["off", "always"].includes(meteredConsentMode)) {
    throw new Error(`${envNames.meteredConsent} must be off or always`);
  }
  const agentTaskStateFile = envString(
    env,
    envNames.agentTaskStateFile,
    publicPreview
      ? path.join(os.homedir(), ".config", "codexless", "agent-task-cards.json")
      : path.join(
          os.homedir(),
          ".config",
          "codex-toolbox",
          privateConstruction ? "agent-task-cards-private.json" : "agent-task-cards-workbench.json"
        )
  );
  const maxConcurrent = 1;
  const recentCallStore = privateConstruction ? createRecentCallReceiptStore() : null;

  let workbench = null;
  let existingCatalogWorkbench = null;
  let existingCatalogWorkbenchPromise = null;
  let browserWorkbench = null;
  let browserPreview = null;
  let browserElicitationBridge = null;
  let browserRecoveryPromise = null;
  let agentExecutor = null;
  let closed = false;

  try {
    const executor = new CodexAuthorityExecutor({
      codexBin,
      defaultCwd,
      profileOverride,
      configOverrides,
      launchEnv: modelFreeLaunchEnv,
      maxTimeoutMs: 30_000,
      watchdogGraceMs: 5_000,
      outputBytesCap: 32_768,
      allowUntrustedReadOnlyBootstrap: modelFreeRuntime.lane === "managed",
    });
    const authorityValidation = await executor.validate();

    workbench = workbenchFactory({
      codexBin,
      defaultCwd,
      configOverrides,
      launchEnv: modelFreeLaunchEnv,
      runtimeInfo: modelFreeRuntime.lane === "managed"
        ? {
            lane: "managed",
            version: modelFreeRuntime.version,
            source: modelFreeRuntime.source,
            managedCodexHome: modelFreeRuntime.codexHome,
            loginJourney: modelFreeRuntime.loginJourney,
          }
        : null,
    });
    await workbench.start();

    const resolveExistingCatalogWorkbench = async () => {
      if (existingCatalogWorkbench) return existingCatalogWorkbench;
      if (!existingCatalogWorkbenchPromise) {
        existingCatalogWorkbenchPromise = (async () => {
          const existing = await runtimeProvider.resolveExisting();
          const candidate = workbenchFactory({
            codexBin: existing.path,
            defaultCwd,
            configOverrides,
          });
          try {
            await candidate.start();
            existingCatalogWorkbench = candidate;
            return candidate;
          } catch (error) {
            await candidate.close().catch(() => {});
            throw error;
          }
        })();
      }
      try {
        return await existingCatalogWorkbenchPromise;
      } finally {
        if (!existingCatalogWorkbench) existingCatalogWorkbenchPromise = null;
      }
    };
    const toolWorkbench = modelFreeRuntime.lane === "managed" && runtimeProvider.formalAgentAvailable
      ? createLaneRoutedWorkbench({ primary: workbench, resolveExisting: resolveExistingCatalogWorkbench })
      : workbench;

    let browserRuntimeCompatibility = null;
    if (modelFreeRuntime.lane === "existing") {
      let browserWorkbenchForExecutor = workbench;
      if (browserServerRequests.enabled) {
        let browserWorkbenchCwd = defaultCwd;
        let browserWorkbenchOverrides = configOverrides;
        if (privateConstruction || publicPreview) {
          const [nodeReplConfig, currentChromeSkill, currentChromePlugin, configuredMcpServerNames] = await Promise.all([
            workbench.configuredMcpServer({ name: "node_repl", cwd: defaultCwd }).catch(() => null),
            workbench.currentChromeSkill({ cwd: defaultCwd }).catch(() => null),
            typeof workbench.currentChromePlugin === "function"
              ? workbench.currentChromePlugin({ cwd: defaultCwd }).catch(() => null)
              : Promise.resolve(null),
            configuredMcpServerNamesForBrowser(workbench, { cwd: defaultCwd }),
          ]);
          browserRuntimeCompatibility = await resolveBrowserRuntimeCompatibility({
            codexBin,
            chromeSkillPath: currentChromeSkill?.path ?? null,
            chromePluginBuild: currentChromePlugin?.localVersion ?? null,
            env,
          });
          const browserAvailable = browserRuntimeCompatibility.status === "ok" && nodeReplConfig !== null;
          browserWorkbenchOverrides = buildBrowserConfigOverrides({
            configOverrides,
            compatibilityOverrides: browserRuntimeCompatibility.overrides,
            configuredMcpServerNames,
            nodeReplConfig,
            browserAvailable,
          });
          browserWorkbenchCwd = browserRuntimeCompatibility.browserRuntimeCwd;
        }
        browserElicitationBridge = new BrowserElicitationBridge({
          retireTaintedOperation: async () => {
            if (closed) return;
            if (!browserWorkbench) throw new Error("Browser Workbench is not available for tainted-operation recovery");
            browserRecoveryPromise = browserWorkbench.restart();
            try {
              await browserRecoveryPromise;
            } finally {
              browserRecoveryPromise = null;
            }
          },
        });
        browserWorkbench = workbenchFactory({
          codexBin,
          defaultCwd: browserWorkbenchCwd,
          configOverrides: browserWorkbenchOverrides,
          serverRequestHandler: (request) => browserElicitationBridge.handleServerRequest(request),
        });
        browserWorkbenchForExecutor = browserWorkbench;
      }

      browserPreview = new CodexBrowserExecutor({
        workbench: browserWorkbenchForExecutor,
        defaultCwd,
        authorityExecutor: executor,
        runtimeCompatibility: (privateConstruction || publicPreview) ? browserRuntimeCompatibility : null,
        runtimeCompatibilityResolver: (privateConstruction || publicPreview) && browserRuntimeCompatibility?.status === "ok"
          ? ({ chromeSkillPath, chromePluginBuild }) => resolveBrowserRuntimeCompatibility({ codexBin, chromeSkillPath, chromePluginBuild, env })
          : null,
      });
    } else {
      const browserMethods = [
        "status", "confirmationPolicy", "emergencyResetControlState", "listTabs", "readTab", "screenshotTab",
        "discoverElements", "prepareElementAction", "elementAction",
        "prepareCloseTab", "closeTab", "prepareBulkCloseTabs", "bulkCloseTabs", "prepareOpenTab", "openTab", "scrollTab", "keypressTab",
        "prepareNavigate", "navigate", "prepareClick", "click", "prepareDownload", "download",
        "prepareUpload", "upload", "prepareFill", "fill",
      ];
      let deferredBrowser = null;
      browserElicitationBridge = browserServerRequests.enabled
        ? new BrowserElicitationBridge({
            retireTaintedOperation: async () => {
              if (closed) return;
              if (!deferredBrowser?.initialized()) throw new Error("Browser Existing-runtime seam is not active");
              browserRecoveryPromise = deferredBrowser.restart();
              try {
                await browserRecoveryPromise;
              } finally {
                browserRecoveryPromise = null;
              }
            },
          })
        : null;
      deferredBrowser = createDeferredBrowserAdapter({
        methods: browserMethods,
        factory: async () => {
          const existing = await runtimeProvider.resolveExisting();
          const existingAuthority = new CodexAuthorityExecutor({
            codexBin: existing.path,
            defaultCwd,
            profileOverride,
            configOverrides,
            maxTimeoutMs: 30_000,
            watchdogGraceMs: 5_000,
            outputBytesCap: 32_768,
          });
          await existingAuthority.validate();
          const existingWorkbench = workbenchFactory({
            codexBin: existing.path,
            defaultCwd,
            configOverrides,
          });
          await existingWorkbench.start();
          let dedicatedBrowserWorkbench = null;
          let browserWorkbenchForExecutor = existingWorkbench;
          let compatibility = null;
          if (browserServerRequests.enabled) {
            let browserWorkbenchCwd = defaultCwd;
            let browserWorkbenchOverrides = configOverrides;
            if (privateConstruction || publicPreview) {
              const [nodeReplConfig, currentChromeSkill, currentChromePlugin, configuredMcpServerNames] = await Promise.all([
                existingWorkbench.configuredMcpServer({ name: "node_repl", cwd: defaultCwd }).catch(() => null),
                existingWorkbench.currentChromeSkill({ cwd: defaultCwd }).catch(() => null),
                typeof existingWorkbench.currentChromePlugin === "function"
                  ? existingWorkbench.currentChromePlugin({ cwd: defaultCwd }).catch(() => null)
                  : Promise.resolve(null),
                configuredMcpServerNamesForBrowser(existingWorkbench, { cwd: defaultCwd }),
              ]);
              compatibility = await resolveBrowserRuntimeCompatibility({
                codexBin: existing.path,
                chromeSkillPath: currentChromeSkill?.path ?? null,
                chromePluginBuild: currentChromePlugin?.localVersion ?? null,
                env,
              });
              const browserAvailable = compatibility.status === "ok" && nodeReplConfig !== null;
              browserWorkbenchOverrides = buildBrowserConfigOverrides({
                configOverrides,
                compatibilityOverrides: compatibility.overrides,
                configuredMcpServerNames,
                nodeReplConfig,
                browserAvailable,
              });
              browserWorkbenchCwd = compatibility.browserRuntimeCwd;
            }
            dedicatedBrowserWorkbench = workbenchFactory({
              codexBin: existing.path,
              defaultCwd: browserWorkbenchCwd,
              configOverrides: browserWorkbenchOverrides,
              serverRequestHandler: (request) => browserElicitationBridge.handleServerRequest(request),
            });
            browserWorkbenchForExecutor = dedicatedBrowserWorkbench;
          }
          const browser = new CodexBrowserExecutor({
            workbench: browserWorkbenchForExecutor,
            defaultCwd,
            authorityExecutor: existingAuthority,
            runtimeCompatibility: (privateConstruction || publicPreview) ? compatibility : null,
            runtimeCompatibilityResolver: (privateConstruction || publicPreview) && compatibility?.status === "ok"
              ? ({ chromeSkillPath, chromePluginBuild }) => resolveBrowserRuntimeCompatibility({ codexBin: existing.path, chromeSkillPath, chromePluginBuild, env })
              : null,
          });
          return {
            browser,
            restart: () => browserWorkbenchForExecutor.restart(),
            close: async () => {
              try {
                await dedicatedBrowserWorkbench?.close();
              } finally {
                await existingWorkbench.close();
              }
            },
          };
        },
      });
      browserPreview = deferredBrowser;
      browserRuntimeCompatibility = { status: "deferred", runtimeLane: "existing", selectedRuntime: modelFreeRuntime.lane };
    }

    const snapshotForRuntime = async (runtime) => {
      const telemetry = createPreviewTelemetryClient({
        codexBin: runtime.bin,
        defaultCwd,
        configOverrides,
        launchEnv: runtime.launchEnv ?? null,
        stderrHandler: () => {},
      });
      try {
        await telemetry.start();
        return await readCodexQuotaSnapshot({ client: telemetry });
      } finally {
        await telemetry.close().catch(() => {});
      }
    };
    const formalAgentUsesExisting = runtimeProvider.formalAgentAvailable && runtimeProvider.formalAgentLane === "existing";
    let formalAgentRuntime = formalAgentUsesExisting && modelFreeRuntime.lane === "existing" ? modelFreeRuntime : null;
    let formalAgentRuntimePromise = null;
    const resolveFormalAgentRuntime = async () => {
      if (formalAgentRuntime) return formalAgentRuntime;
      if (!formalAgentRuntimePromise) {
        formalAgentRuntimePromise = runtimeProvider.resolveExisting().then((existing) => ({
          lane: "existing",
          bin: existing.path,
          launchEnv: null,
          codexHome: null,
          version: existing.version,
          source: existing.source,
        }));
      }
      try {
        formalAgentRuntime = await formalAgentRuntimePromise;
        return formalAgentRuntime;
      } finally {
        if (!formalAgentRuntime) formalAgentRuntimePromise = null;
      }
    };
    const resourceSnapshotProvider = formalAgentUsesExisting
      ? async () => snapshotForRuntime(await resolveFormalAgentRuntime())
      : null;

    let agentAuthorityExecutor;
    if (formalAgentUsesExisting && modelFreeRuntime.lane === "existing") {
      agentAuthorityExecutor = executor;
      agentExecutor = new CodexAgentExecutor({
        codexBin: formalAgentRuntime.bin,
        defaultCwd,
        configOverrides,
        requestTimeoutMs: 30_000,
        resourceSnapshotProvider,
      });
    } else if (formalAgentUsesExisting) {
      agentAuthorityExecutor = new LazyCodexAuthorityExecutor({
        factory: async () => {
          const existingRuntime = await resolveFormalAgentRuntime();
          return new CodexAuthorityExecutor({
            codexBin: existingRuntime.bin,
            defaultCwd,
            profileOverride,
            configOverrides,
            maxTimeoutMs: 30_000,
            watchdogGraceMs: 5_000,
            outputBytesCap: 32_768,
          });
        },
      });
      agentExecutor = new LazyCodexAgentExecutor({
        factory: async () => {
          const existingRuntime = await resolveFormalAgentRuntime();
          return new CodexAgentExecutor({
            codexBin: existingRuntime.bin,
            defaultCwd,
            configOverrides,
            requestTimeoutMs: 30_000,
            resourceSnapshotProvider,
          });
        },
      });
    } else {
      agentAuthorityExecutor = createManagedFormalAgentAuthorityExecutor();
      agentExecutor = createManagedFormalAgentExecutor();
    }
    await agentExecutor.open();

    // HTTP MCP serving in SDK 2.x constructs a fresh McpServer per request.
    // Agent consent/card bookkeeping must therefore live at the Codexless runtime
    // lifetime rather than inside one server-registration closure.
    const agentPreviewState = createAgentPreviewState({
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      taskStateFile: agentTaskStateFile,
    });
    // HTTP MCP serving creates a fresh McpServer per request. Excel opaque
    // session refs must therefore live at runtime lifetime too, otherwise a
    // ref minted by excel_status is unknown on the very next tool call.
    const excelSessionRefs = new Map();

    let computerUse = null;
    let cuaValidation = null;
    if (cuaHelper) {
      computerUse = new CodexComputerUseExecutor({
        codexBin,
        helperPath: cuaHelper,
        defaultCwd,
      });
      cuaValidation = await computerUse.validate();
    }

    const version = publicPreview
      ? PUBLIC_SERVER_VERSION
      : privateConstruction
        ? HOUSEHOLD_SERVER_VERSION
        : WORKBENCH_SERVER_VERSION;
    const surfaceVersion = publicPreview
      ? PUBLIC_SURFACE_VERSION
      : privateConstruction
        ? HOUSEHOLD_SURFACE_VERSION
        : WORKBENCH_SURFACE_VERSION;
    const toolAllowlist = publicPreview
      ? PUBLIC_TOOL_ALLOWLIST
      : privateConstruction
        ? HOUSEHOLD_TOOL_ALLOWLIST
        : null;

    const createServer = createCodexToolboxServerFactory({
      executor,
      workbench: toolWorkbench,
      browserPreview,
      browserElicitationBridge,
      computerUse,
      agentExecutor,
      modelCatalogProvider: formalAgentUsesExisting ? agentExecutor : toolWorkbench,
      authorityExecutor: executor,
      agentAuthorityExecutor,
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      agentPreviewState,
      agentPortableCard: privateConstruction || publicPreview,
      legacyAgentCardInternals: false,
      agentReasoningEffort: privateConstruction || publicPreview,
      codexCallProfile: privateConstruction || publicPreview,
      codexCallProfileFile: (privateConstruction || publicPreview) && typeof env.CODEXLESS_CALL_PROFILE_FILE === "string" && env.CODEXLESS_CALL_PROFILE_FILE.trim()
        ? env.CODEXLESS_CALL_PROFILE_FILE.trim()
        : null,
      formalAgentBlock: runtimeProvider.formalAgentAvailable ? null : MANAGED_FORMAL_AGENT_BLOCK,
      maxConcurrent,
      version,
      exposeCwd: true,
      cwdRequired: false,
      accessModes: ["inherit", "readOnly"],
      defaultAccess: "readOnly",
      toolTitle: "Codex Model-Free Command",
      openWorldHint: true,
      surfaceVersion,
      toolAllowlist,
      publicPreview,
      guardDirectFormalCodex: privateConstruction || publicPreview,
      recentCallStore,
      excelSessionRefs,
      warnWhenUsingDefaultCwd: true,
      serverInstructions: publicPreview
        ? "Public Technical Preview surface. It exposes only the accepted first-release allowlist: Codex-authority-bounded command/read/edit construction; Codex project context/Skills/catalog reads; the accepted Browser surface at household parity; Codex Call Profile; and the formal metered Codex Agent lane with visible task/consent/usage state. Broad raw host filesystem methods, raw host process/PTY control, Computer Use, generic configured-MCP calls, and other Workbench/private control-plane capabilities outside the accepted Browser slice are intentionally absent. Remote callers cannot widen Codex permission profiles, sandbox, approval policy, trusted roots, or network authority. Browser remains constrained to the accepted explicit public Browser allowlist. Metered Agent work remains distinct from model-free tool work; Call Approval and terminal Result use the fixed compact Chat text presentation, Running stays authoritative but is not mechanically presented, and usage/quota observations must remain factual without attributing account-level quota movement to one task."
        : privateConstruction
          ? "Codexless household surface for daily self-dogfood. It exposes only an explicit server-side allowlist: accepted command_exec compatibility contract; project/account/read-only discovery; persistent process + receipts; Codex Skill/catalog reads; authority-bounded read_many and guarded precise_edit; existing-login Chrome Reader plus read-only viewport screenshot, fixed Enter/Tab/Escape keypress at current focus, authority-bounded upload, browser-managed download, exact prepared single-tab close, and narrow prepared navigation/new-tab/click/fill plus bounded scroll; the dynamic codex.browser_confirmation_policy reader; and the formal Codex Agent lane with fixed-text approval/result state and truthful consent/usage receipts. Broad raw fs_mutate, generic mcp_call, and all general CUA/computer tools are intentionally absent. Remote callers cannot widen Codex permission profiles, sandbox, approval policy, trusted roots, or network authority. Web routing is phase-aware, not tool-loyal: when the caller also has a lightweight read-only/open-web search or reader surface, use that for public-web discovery/filtering that does not need the user's authenticated/session-specific state, then switch into signed-in Browser only when the task needs a current tab/session, private/non-indexed content, live UI state, or an interaction/side effect. Browse openly, act locally. Browser navigation itself is destination-first, not gesture-faithful: when the bounded user goal is simply to reach/read another page and an exact http(s) destination is reliably available from Browser-derived evidence, prefer direct navigate/open-tab over clicking an intermediate UI element; do not guess route patterns, and always read back URL plus page identity after arrival. Keep click when the click itself matters, the URL is not reliably known, or direct routing would bypass required page state/workflow. In pure-Browser acceptance, do not use a site MCP/connector to discover the route/id and then count that as Browser evidence. For Browser work, use the currently installed Codex Chrome Skill confirmations policy as the default risk taxonomy instead of inventing a parallel permission table. Prepared action refs are exact target/state bindings only, not proof of user approval. Default user-facing UX is brand-neutral verbal task-level confirmation: when the Codex policy indicates a confirmation-worthy action class, explain that the extra permission is based on the current Codex Browser Policy and ask once for the bounded task; routine actions inside the same unchanged task must not trigger per-action prompts. Clarify when useful that Browser permission does not start a Codex task or by itself consume Codex quota. Reconfirm only when task scope materially expands, a user-authored preference requires stricter handling, or a higher-level platform rule requires action-time confirmation; user-authored context may request a looser confirmation preference only where higher-level policy permits. Metered Agent start/send is a separate lane. Normal Chat Call Approval is fixed compact text bound to the exact Task ID; only explicit valid requireCallApproval=false skips that gate. Literal Yes / No maps only to codex.agent_commit / codex.agent_decline for that exact prepared task. Running remains authoritative and supervised but is not mechanically presented. Terminal always returns the fixed text Result with truthful available usage/quota after-state. In-turn approvals that actually require the user remain conspicuous ordinary-text decisions. Do not route formal Codex model/control work through codex.command_exec or codex.process as a fallback: obvious direct Codex CLI launches are rejected with FORMAL_CODEX_AGENT_REQUIRED. The generic process/PTY lane remains a powerful host-state tool and is not claimed to be an inescapable security sandbox against arbitrarily wrapped executables."
          : "Experimental Codexless Workbench + Agent surface for self-dogfood. It combines the accepted codex.command_exec compatibility contract with Codex project context, broad raw structured filesystem/search for internal Preview work, narrower authorized read_many + guarded precise_edit for normal project construction, persistent process/PTY control plus terminal completion receipts, Skills/Plugin/App/MCP catalogs and direct configured MCP calls, accepted existing-login Chrome Reader + read-only viewport screenshot + fixed Enter/Tab/Escape keypress at current focus + authority-bounded upload + browser-managed download + exact prepared single-tab close + narrow prepared navigation/new-tab/click/fill + bounded scroll, dynamic codex.browser_confirmation_policy, and a formal Codex Agent lane. Web routing is phase-aware, not tool-loyal: when the caller also has a lightweight read-only/open-web search or reader surface, use that for public-web discovery/filtering that does not need the user's authenticated/session-specific state, then switch into signed-in Browser only when the task needs a current tab/session, private/non-indexed content, live UI state, or an interaction/side effect. Browse openly, act locally. Browser navigation itself is destination-first, not gesture-faithful: when the user goal is simply to reach/read another page and an exact http(s) destination is reliably available from Browser-derived evidence, prefer direct navigate/open-tab over clicking an intermediate UI element; do not guess route patterns, and always read back URL plus page identity after arrival. Keep click when the click itself matters, the URL is not reliably known, or direct routing would bypass required page state/workflow. In pure-Browser acceptance, do not use a site MCP/connector to discover the route/id and then count that as Browser evidence. Browser confirmation decisions use the currently installed Codex Chrome Skill confirmations policy as the default risk taxonomy plus user-authored task context. Prepared action refs are exact state/target bindings only, not approval tokens. Default Browser UX consolidates policy-required permission into one brand-neutral verbal confirmation for the bounded task; do not prompt per routine action inside the same unchanged task, do not reuse formal Codex Call Approval for Browser permission, and do not imply that Browser permission starts a metered Codex turn. Reconfirm only for materially expanded task risk or when higher-level policy requires action-time confirmation; user-authored preferences may adjust confirmation strictness only where higher-level policy permits. Metered Agent start/send remains a separate lane: it first prepares one exact server-bound task; normal Chat approval/result presentation is fixed text bound to its exact Task ID, and literal Yes / No is resolved only by codex.agent_commit / codex.agent_decline. Agent authority is resolved locally through the same Codexless/Codex authority path; remote callers cannot select permission profiles, sandbox, approval policy, roots, or network authority. When configured, isolated prepared-click CUA remains a separate regression capability. Broad Preview bodies must not be treated as a permission upgrade request. Present the returned fixed chatPresentation text directly in the user's Chat/Host language when available; keep Yes / No literal for confirmations, do not use service-machine locale as language authority, do not manufacture a Running block, and do not bury quota, approval, or completion receipts inside prose.",
      commandDescription: publicPreview
        ? "Run one buffered argv command through official Codex App Server command/exec without a Codex model turn. The caller may provide cwd as working-directory context. Codexless resolves the authorized Codex permission profile and passes it directly to command/exec. On Windows, a bare executable name is resolved through the host PATH to a directly launchable .exe/.com/.cmd/.bat shim before dispatch; this changes only executable lookup, not Codex authority. This public surface does not expose host-process control; a command blocked by local Codex permission/trust or host-state isolation must remain visible rather than silently escaping the sandbox. This model-free lane must not launch Codex CLI directly or through recognized nested wrappers; formal metered Codex work must use codex.agent_start/codex.agent_send so exact approval/result lifecycle and no-replay semantics are preserved."
        : "Run one buffered argv command through official Codex App Server command/exec without a Codex model turn. The caller may provide cwd as working-directory context. Codexless resolves the authorized Codex permission profile and passes it directly to command/exec. On Windows, a bare executable name is resolved through the host PATH to a directly launchable .exe/.com/.cmd/.bat shim before dispatch; this changes only executable lookup, not Codex authority. Use codex.process instead for genuine host-state work outside the command_exec sandbox, including explicitly requested Git repository-metadata operations on an existing .git directory or authenticated host CLI work that depends on the local Windows credential store. Select that host lane directly when the task itself requires it; do not weaken or bypass a Codex permission denial for ordinary project work. Formal Codex model/control work is not a supported command_exec fallback; obvious direct Codex CLI model/control invocations fail visibly with FORMAL_CODEX_AGENT_REQUIRED and must be routed through codex.agent_start/codex.agent_send plus the fixed-text exact-Task-ID decision flow.",
      commandArgDescription:
        "argv vector passed to Codex command/exec under the resolved/local-authorized Codex permission profile.",
      cwdArgDescription:
        "Optional local working directory context. This does not let the caller select a permission profile or widen Codex authority.",
      accessArgDescription:
        "readOnly is the safe compatibility default. inherit must be explicitly selected and uses the locally authorized/resolved Codex permission profile.",
      timeoutArgDescription:
        "Bounded command timeout in milliseconds.",
    });

    async function close() {
      if (closed) return;
      closed = true;
      try {
        await agentExecutor?.close();
      } finally {
        browserElicitationBridge?.close();
        try {
          await browserRecoveryPromise?.catch(() => {});
          if (modelFreeRuntime.lane === "managed") await browserPreview?.close?.();
          await browserWorkbench?.close();
        } finally {
          try {
            await existingCatalogWorkbench?.close();
          } finally {
            await workbench?.close();
          }
        }
      }
    }

    return {
      createServer,
      close,
      mode,
      // Compatibility booleans retained for older callers; canonical code uses mode.
      privateConstruction,
      publicPreview,
      version,
      surfaceVersion,
      toolAllowlist,
      defaultCwd,
      meteredConsentMode,
      authorityValidation,
      codexRuntime: {
        selection: runtimeProvider.selection,
        installMode: runtimeProvider.installMode,
        activation: runtimeProvider.activation,
        managedReady: runtimeProvider.managedReady,
        preferenceSource: runtimeProvider.runtimeRouting.preferenceSource,
        routes: structuredClone(runtimeProvider.runtimeRouting.routes),
        modelFreeLane: modelFreeRuntime.lane,
        modelFreeVersion: modelFreeRuntime.version,
        modelFreeSource: modelFreeRuntime.source,
        managedCodexHome: modelFreeRuntime.lane === "managed" ? modelFreeRuntime.codexHome : null,
        browserLane: runtimeProvider.browserLane,
        formalAgentLane: runtimeProvider.formalAgentLane,
        formalAgentAvailable: runtimeProvider.formalAgentAvailable,
        managedModelInvocation: runtimeProvider.managedModelInvocation,
        noSilentFallback: runtimeProvider.noSilentFallback,
      },
      cuaValidation,
      recentCallStore,
      browserRuntimeCompatibility,
    };
  } catch (error) {
    try {
      await agentExecutor?.close();
    } finally {
      browserElicitationBridge?.close();
      try {
        await browserRecoveryPromise?.catch(() => {});
        if (modelFreeRuntime.lane === "managed") await browserPreview?.close?.();
        await browserWorkbench?.close();
      } finally {
        try {
          await existingCatalogWorkbench?.close();
        } finally {
          await workbench?.close();
        }
      }
    }
    throw error;
  }
}

function createLaneRoutedWorkbench({ primary, resolveExisting }) {
  if (!primary || typeof resolveExisting !== "function") {
    throw new TypeError("lane-routed workbench requires a primary workbench and lazy Existing resolver");
  }
  const existingMethods = new Set(["catalog", "readSkill"]);
  return new Proxy(primary, {
    get(target, property, receiver) {
      if (!existingMethods.has(property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args) => {
        const existing = await resolveExisting();
        const value = Reflect.get(existing, property, existing);
        if (typeof value !== "function") throw new TypeError(`Existing workbench does not implement ${String(property)}`);
        return value.apply(existing, args);
      };
    },
  });
}
