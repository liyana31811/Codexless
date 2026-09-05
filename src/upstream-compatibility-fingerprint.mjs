import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { normalizeThreadTokenUsage, projectQuotaSnapshot } from "./agent-resource.mjs";
import { resolveBrowserRuntimeCompatibility } from "./browser-runtime-compat.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { resolveCodexExecutable } from "./codex-bin.mjs";
import { normalizeBrowserLifecycleShape } from "./codex-browser-executor.mjs";
import { projectCurrentChromePlugin } from "./codex-workbench-executor.mjs";
import { readJsonFile } from "./json-file.mjs";
import { listAllMcpServerStatus } from "./mcp-status-pagination.mjs";

export const UPSTREAM_COMPATIBILITY_REPORT_SCHEMA = "codexless-upstream-compatibility-fingerprint-v0";
export const UPSTREAM_COMPATIBILITY_RELEVANT_SCHEMA = "codexless-upstream-relevant-capabilities-v0";

const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";
const BUNDLE_FAIL_CLOSED_REASONS = new Set([
  "current_browser_plugin_pair_not_found",
  "current_browser_plugin_manifest_mismatch",
  "current_browser_plugin_path_escape",
  "current_chrome_skill_path_untrusted",
]);
const PROHIBITED_COLLECTION_METHODS = [
  /^thread\//i,
  /^turn\//i,
  /^mcpServer\/tool\/call$/i,
  /^approval\//i,
];

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (value[key] === undefined) continue;
    result[key] = canonicalizeJson(value[key]);
  }
  return result;
}

export function canonicalJson(value, { pretty = true } = {}) {
  return JSON.stringify(canonicalizeJson(value), null, pretty ? 2 : 0);
}

function inspectBrowserLifecycleMembers(source) {
  if (typeof source !== "string" || !source) return null;
  return {
    tabsFinalize: /\btabs\s*(?:\.\s*finalize|\[\s*["']finalize["']\s*\])/.test(source),
    markDeliverable: /\bmarkDeliverable\s*\(/.test(source),
    markHandoff: /\bmarkHandoff\s*\(/.test(source),
  };
}

export function inspectBrowserLifecycleSource(source) {
  const members = inspectBrowserLifecycleMembers(source);
  if (!members) {
    return {
      status: "UNAVAILABLE",
      adapterShape: null,
      adapterExistingTabRelease: null,
      classification: "browser-lifecycle-source-unavailable",
      tabsFinalize: null,
      markDeliverable: null,
      markHandoff: null,
      existingTabRelease: "unproven",
      handback: "unproven",
    };
  }

  const browser = { tabs: {} };
  if (members.tabsFinalize) browser.tabs.finalize = () => {};
  const tab = {};
  if (members.markDeliverable) tab.markDeliverable = () => {};
  if (members.markHandoff) tab.markHandoff = () => {};
  const normalized = normalizeBrowserLifecycleShape(browser, tab);

  if (normalized.shape === "legacy-explicit-finalize") {
    return {
      status: "GREEN",
      adapterShape: normalized.shape,
      adapterExistingTabRelease: normalized.existingTabRelease,
      classification: "legacy-explicit-finalize",
      ...members,
      existingTabRelease: "explicit-release-proven",
      handback: "explicit-release-proven",
    };
  }
  if (normalized.shape === "finalize-absent-turn-cleanup") {
    return {
      status: "RED",
      adapterShape: normalized.shape,
      adapterExistingTabRelease: normalized.existingTabRelease,
      classification: "turn-cleanup-no-public-release",
      ...members,
      existingTabRelease: "unproven",
      handback: "unproven",
    };
  }
  return {
    status: "RED",
    adapterShape: normalized.shape,
    adapterExistingTabRelease: normalized.existingTabRelease,
    classification: "existing-tab-release-unproven",
    ...members,
    existingTabRelease: "unproven",
    handback: "unproven",
  };
}

export function buildCompatibilityFingerprintReport(evidence = {}) {
  const identityInput = evidence.identity && typeof evidence.identity === "object" ? evidence.identity : {};
  const provenanceInput = evidence.provenance && typeof evidence.provenance === "object" ? evidence.provenance : {};
  const collectionInput = evidence.collectionEnvironment && typeof evidence.collectionEnvironment === "object"
    ? evidence.collectionEnvironment
    : {};
  const collectionEnvironment = {
    status: collectionInput.status === "INCOMPLETE" ? "INCOMPLETE" : "COMPLETE",
    reason: stringOrNull(collectionInput.reason),
    action: stringOrNull(collectionInput.action),
  };
  const fingerprintUsable = collectionEnvironment.status === "COMPLETE";
  const invokedMethods = sortedUniqueStrings(evidence.invokedMethods ?? []);
  const notificationMethods = sortedUniqueStrings(evidence.notificationMethods ?? []);
  const prohibitedMethods = invokedMethods.filter((method) => PROHIBITED_COLLECTION_METHODS.some((pattern) => pattern.test(method)));
  const modelEventMethods = notificationMethods.filter((method) => /^turn\//i.test(method) || method === "thread/tokenUsage/updated");
  const chromeSkill = evidence.chromeSkill ?? findChromeSkill(evidence.skillsListResult);
  const nodeRepl = findMcpServer(evidence.mcpStatusResult, NODE_REPL_SERVER);
  const nodeReplJs = findMcpTool(nodeRepl, NODE_REPL_TOOL);

  const initializeAssessment = assessRequiredMembers("initialize", evidence.initializeResult, [
    ["platformFamily", "string"],
    ["platformOs", "string"],
  ]);
  const skillsAssessment = assessSkillsList(evidence.skillsListResult);
  const mcpAssessment = assessMcpStatusList(evidence.mcpStatusResult);
  const nodeReplAssessment = assessNodeReplCompatibility({
    mcpAssessment,
    nodeRepl,
    nodeReplJs,
  });
  const modelAssessment = assessModelList(evidence.modelListResult);
  const configAssessment = assessConfigRead(evidence.configReadResult);
  const permissionProfilesAssessment = assessPermissionProfileList(evidence.permissionProfileListResult);
  const runtimeAuthority = {
    status: "NOT_RUN",
    reason: "runtime-authority-not-probed-phase0",
  };
  const bundlePairing = projectBundlePairing(evidence.browserCompatibility);
  const browserLifecycle = evidence.browserLifecycle ?? inspectBrowserLifecycleSource(evidence.browserClientSource);
  const usageVocabulary = usageSemanticVocabulary();

  const warnings = normalizeDiagnosticEntries([
    ...(Array.isArray(evidence.warnings) ? evidence.warnings : []),
    ...(nodeRepl?.error ? [{ code: "node-repl-transient-error-observed" }] : []),
    ...(browserLifecycle.classification === "turn-cleanup-no-public-release"
      ? [{
          code: "browser-existing-tab-release-unproven",
          detail: "markDeliverable/markHandoff are turn-lifecycle marks, not proof of public existing-tab release.",
        }]
      : []),
  ]);
  const unavailableReasons = normalizeDiagnosticEntries([
    ...(Array.isArray(evidence.unavailableReasons) ? evidence.unavailableReasons : []),
    ...(bundlePairing.status === "UNAVAILABLE" || bundlePairing.status === "RED"
      ? [{ code: bundlePairing.reason ?? "browser-bundle-unavailable" }]
      : []),
  ]);

  const relevantCapabilityProjection = {
    schema: UPSTREAM_COMPATIBILITY_RELEVANT_SCHEMA,
    appServer: {
      initialize: initializeAssessment.relevantShape,
      skillsList: skillsAssessment.relevantShape,
      mcpServerStatusList: mcpAssessment.relevantShape,
      modelList: modelAssessment.relevantShape,
      configRead: configAssessment.relevantShape,
      permissionProfileList: permissionProfilesAssessment.relevantShape,
    },
    modelReasoning: modelAssessment.capabilities,
    authority: {
      configRead: configAssessment.relevantShape,
      permissionProfileCatalog: permissionProfilesAssessment.relevantShape,
      runtimeProjection: runtimeAuthority.status,
    },
    browser: {
      nodeRepl: nodeReplAssessment.relevantShape,
      bundlePairing: {
        state: bundlePairing.relevantState,
        reasonClass: bundlePairing.reasonClass,
      },
      lifecycle: {
        adapterShape: browserLifecycle.adapterShape ?? null,
        tabsFinalize: browserLifecycle.tabsFinalize,
        markDeliverable: browserLifecycle.markDeliverable,
        markHandoff: browserLifecycle.markHandoff,
        classification: browserLifecycle.classification,
        existingTabRelease: browserLifecycle.existingTabRelease,
        handback: browserLifecycle.handback,
      },
    },
    semanticSlots: {
      approval: "NOT_RUN",
      usage: "NOT_RUN",
      mutation: "NOT_RUN",
    },
    collectionDiscipline: {
      prohibitedMethodObserved: prohibitedMethods.length > 0,
      modelEventObserved: modelEventMethods.length > 0,
    },
  };
  const relevantCapabilityHash = fingerprintUsable
    ? createHash("sha256")
        .update(canonicalJson(relevantCapabilityProjection, { pretty: false }))
        .digest("hex")
    : null;

  const semanticEvidence = {
    modelFreeCollection: {
      status: prohibitedMethods.length || modelEventMethods.length ? "RED" : "GREEN",
      methodsObserved: invokedMethods,
      notificationMethodsObserved: notificationMethods,
      prohibitedMethods,
      modelEventMethods,
      modelTurnStarted: invokedMethods.some((method) => /^turn\//i.test(method)) || modelEventMethods.some((method) => /^turn\//i.test(method)),
      threadStarted: invokedMethods.some((method) => /^thread\//i.test(method)),
      browserToolCallStarted: invokedMethods.includes("mcpServer/tool/call"),
    },
    appServerRequiredShapes: combineAssessments([
      initializeAssessment,
      skillsAssessment,
      mcpAssessment,
      modelAssessment,
      configAssessment,
      permissionProfilesAssessment,
    ]),
    modelReasoning: {
      status: modelAssessment.status,
      modelCount: modelAssessment.capabilities.models.length,
      defaultModels: modelAssessment.capabilities.models.filter((entry) => entry.isDefault).map((entry) => entry.id ?? entry.model),
    },
    authority: {
      modelFreeCatalogStatus: combineAssessments([configAssessment, permissionProfilesAssessment]).status,
      configSelectedValues: configAssessment.selectedValues,
      permissionProfileCatalog: permissionProfilesAssessment.relevantShape.profiles,
      runtimeProjection: runtimeAuthority,
    },
    browserNodeRepl: {
      status: nodeReplAssessment.status,
      serverObserved: nodeReplAssessment.serverObserved,
      jsToolObserved: nodeReplAssessment.jsToolObserved,
      missingRequiredMembers: nodeReplAssessment.missingRequiredMembers,
      transientServerErrorObserved: Boolean(nodeRepl?.error),
      transientAvailabilityExcludedFromRelevantHash: true,
    },
    browserBundlePairing: {
      status: bundlePairing.status,
      decision: bundlePairing.decision,
      reason: bundlePairing.reason,
    },
    browserExistingTabRelease: {
      status: browserLifecycle.status,
      adapterShape: browserLifecycle.adapterShape ?? null,
      adapterExistingTabRelease: browserLifecycle.adapterExistingTabRelease ?? null,
      classification: browserLifecycle.classification,
      existingTabRelease: browserLifecycle.existingTabRelease,
      handback: browserLifecycle.handback,
      note: browserLifecycle.classification === "turn-cleanup-no-public-release"
        ? "Known finalize-absent turn-boundary cleanup is compatible for normal Browser lifecycle, but it does not prove an explicit existing-tab release primitive or independent-controller force release/takeover."
        : null,
    },
    browserRuntimeAttachment: {
      status: "NOT_RUN",
      reason: "phase0-does-not-attach-browser-backend-or-claim-real-tabs",
      realTabInspected: false,
      mutationAttempted: false,
    },
    approval: {
      status: "NOT_RUN",
      reason: "requires-a-real-formal-turn-to-produce-native-pending-approval-evidence",
      approvalAttempted: false,
    },
    usage: {
      status: "NOT_RUN",
      reason: "requires-a-real-formal-turn-to-produce-thread-token-usage-evidence",
      vocabulary: usageVocabulary,
      note: "Cumulative task usage uses threadTotal terminology; account quota remains an independently observed waterline and is not inferred from token totals.",
    },
    mutation: {
      status: "NOT_RUN",
      reason: "phase0-inventory-does-not-dispatch-browser-or-other-real-mutations",
      mutationAttempted: false,
    },
  };

  const browserLifecycleOverallStatus = browserLifecycle.status === "RED"
    && browserLifecycle.classification === "turn-cleanup-no-public-release"
    && browserLifecycle.adapterShape === "finalize-absent-turn-cleanup"
    && browserLifecycle.adapterExistingTabRelease === "turn-boundary-auto-release"
    ? "GREEN"
    : semanticEvidence.browserExistingTabRelease.status;
  const statusInputs = [
    semanticEvidence.modelFreeCollection.status,
    semanticEvidence.appServerRequiredShapes.status,
    semanticEvidence.modelReasoning.status,
    semanticEvidence.authority.modelFreeCatalogStatus,
    semanticEvidence.browserNodeRepl.status,
    semanticEvidence.browserBundlePairing.status,
    browserLifecycleOverallStatus,
  ];
  const overallStatus = !fingerprintUsable
    ? "YELLOW"
    : statusInputs.includes("RED")
      ? "RED"
      : statusInputs.includes("UNAVAILABLE")
        ? "YELLOW"
        : "GREEN";

  const report = {
    schema: UPSTREAM_COMPATIBILITY_REPORT_SCHEMA,
    overallStatus,
    collectionEnvironment,
    compatibilityDecisionUsable: fingerprintUsable,
    identity: {
      collectionEnvironment: {
        platform: stringOrNull(identityInput.platform),
        arch: stringOrNull(identityInput.arch),
        nodeVersion: stringOrNull(identityInput.nodeVersion),
      },
      codex: {
        version: stringOrNull(identityInput.codexVersion),
        resolutionSource: stringOrNull(identityInput.codexResolutionSource),
      },
      browserBundle: {
        build: stringOrNull(identityInput.browserBuild ?? evidence.browserCompatibility?.build),
      },
      identityPolicy: "Version/path identity is reported here but excluded from relevantCapabilityHash.",
    },
    provenance: canonicalizeJson({
      collectionCwd: stringOrNull(provenanceInput.collectionCwd),
      configOverridesFile: stringOrNull(provenanceInput.configOverridesFile),
      configOverrideCount: integerOrNull(provenanceInput.configOverrideCount),
      codexResolvedExecutable: stringOrNull(provenanceInput.codexResolvedExecutable),
      appServer: {
        transport: "stdio",
        launch: "resolved-codex-executable",
        initializeExperimentalApi: true,
        methodsObserved: invokedMethods,
        notificationMethodsObserved: notificationMethods,
        threadStarted: semanticEvidence.modelFreeCollection.threadStarted,
        modelTurnStarted: semanticEvidence.modelFreeCollection.modelTurnStarted,
      },
      browserBundle: evidence.browserCompatibility?.status === "ok"
        ? {
            source: stringOrNull(evidence.browserCompatibility.source),
            chromeSkillPath: stringOrNull(evidence.browserCompatibility.chromeSkillPath),
            chromeManifestPath: stringOrNull(evidence.browserCompatibility.chromeManifestPath),
            browserManifestPath: stringOrNull(evidence.browserCompatibility.browserManifestPath),
            browserClientPath: stringOrNull(evidence.browserCompatibility.browserClientPath),
            browserServicePath: stringOrNull(evidence.browserCompatibility.browserServicePath),
            browserClientSha256: stringOrNull(evidence.browserCompatibility.browserClientSha256),
          }
        : {
            source: stringOrNull(evidence.browserCompatibility?.source),
            reason: stringOrNull(evidence.browserCompatibility?.reason),
          },
      browserRuntimeProbe: {
        status: "not-run",
        reason: "phase0-does-not-attach-browser-backend-or-claim-real-tabs",
      },
      deploymentClaim: "none; this report describes only the collection environment and observed upstream sources",
    }),
    capabilityProjection: {
      appServer: {
        initialize: initializeAssessment,
        skillsList: skillsAssessment,
        mcpServerStatusList: mcpAssessment,
        modelList: modelAssessment,
        configRead: configAssessment,
        permissionProfileList: permissionProfilesAssessment,
      },
      modelReasoning: modelAssessment.capabilities,
      authority: {
        modelFreeCatalogStatus: combineAssessments([configAssessment, permissionProfilesAssessment]).status,
        configSelectedValues: configAssessment.selectedValues,
        permissionProfileCatalog: permissionProfilesAssessment.relevantShape.profiles,
        runtimeProjection: runtimeAuthority,
      },
      browser: {
        chromeSkill: chromeSkill
          ? {
              observed: true,
              name: stringOrNull(chromeSkill.name),
              enabled: chromeSkill.enabled !== false,
              memberShape: objectMemberShape(chromeSkill),
            }
          : {
              observed: false,
              name: CHROME_SKILL_NAME,
              enabled: null,
              memberShape: null,
            },
        nodeRepl: {
          status: nodeReplAssessment.status,
          observed: Boolean(nodeRepl),
          serverMemberShape: objectMemberShape(nodeRepl),
          jsToolObserved: Boolean(nodeReplJs),
          jsToolMemberShape: objectMemberShape(nodeReplJs),
          jsInputSchemaShape: nodeReplAssessment.jsInputSchemaShape,
          missingRequiredMembers: nodeReplAssessment.missingRequiredMembers,
          transientServerErrorObserved: Boolean(nodeRepl?.error),
          transientAvailabilityExcludedFromRelevantHash: true,
        },
      },
    },
    bundlePairing,
    schemaMemberShapes: {
      initializeResult: objectMemberShape(evidence.initializeResult),
      skillsListResult: objectMemberShape(evidence.skillsListResult),
      skillsListRow: objectMemberShape(firstArrayEntry(evidence.skillsListResult?.data)),
      chromeSkill: objectMemberShape(chromeSkill),
      mcpServerStatusListResult: objectMemberShape(evidence.mcpStatusResult),
      nodeReplServer: objectMemberShape(nodeRepl),
      nodeReplJsTool: objectMemberShape(nodeReplJs),
      nodeReplJsInputSchema: nodeReplAssessment.jsInputSchemaShape,
      modelListResult: objectMemberShape(evidence.modelListResult),
      modelListRow: objectMemberShape(firstArrayEntry(evidence.modelListResult?.data)),
      configReadResult: objectMemberShape(evidence.configReadResult),
      effectiveConfig: objectMemberShape(evidence.configReadResult?.config),
      permissionProfileListResult: objectMemberShape(evidence.permissionProfileListResult),
      permissionProfileRow: objectMemberShape(firstArrayEntry(evidence.permissionProfileListResult?.data)),
      browserLifecycleMembers: {
        tabsFinalize: browserLifecycle.tabsFinalize,
        markDeliverable: browserLifecycle.markDeliverable,
        markHandoff: browserLifecycle.markHandoff,
      },
    },
    semanticEvidence,
    warnings,
    unavailableReasons,
    fingerprint: {
      algorithm: "sha256",
      usableForCompatibilityDecision: fingerprintUsable,
      relevantCapabilityHash,
      relevantCapabilityProjection,
      excludes: [
        "account identity/PII",
        "cosmetic descriptions",
        "paths and path identity",
        "quota percentages",
        "session/thread/turn/tab/ref identifiers",
        "timestamps",
        "token totals",
        "transient backend availability",
        "version identity",
      ],
    },
  };
  return canonicalizeJson(report);
}

export async function collectUpstreamCompatibilityInventory({
  cwd = process.env.CODEX_TOOLBOX_DEFAULT_CWD || process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  resolveExecutable = resolveCodexExecutable,
  createClient = defaultClientFactory,
  resolveBrowserCompatibility = resolveBrowserRuntimeCompatibility,
  readText = (filePath) => readFile(filePath, "utf8"),
  readJson = readJsonFile,
  listMcpStatus = listAllMcpServerStatus,
} = {}) {
  const effectiveCwd = path.resolve(cwd);
  const warnings = [];
  const unavailableReasons = [];
  const invokedMethods = [];
  let notificationMethods = [];
  let codexResolution = null;
  let initializeResult = null;
  let skillsListResult = null;
  let mcpStatusResult = null;
  let modelListResult = null;
  let configReadResult = null;
  let permissionProfileListResult = null;
  let chromeSkill = null;
  let currentChromePlugin = null;
  let browserCompatibility = null;
  let browserClientSource = null;
  let client = null;
  let config = {
    status: "ok",
    file: null,
    overrides: [],
  };
  let collectionEnvironment = {
    status: "COMPLETE",
    reason: null,
    action: null,
  };

  try {
    config = await loadConfigOverrides({ env, readJson });
    if (config.status !== "ok") {
      collectionEnvironment = {
        status: "INCOMPLETE",
        reason: config.reason,
        action: "Run compatibility:report from a host-state context that can read the current user Codex config and Skills; do not classify upstream drift from this incomplete report.",
      };
      unavailableReasons.push({ code: config.reason });
      unavailableReasons.push({
        code: "collection_environment_incomplete",
        detail: "The collector could not read the configured user-level Codex state, so no comparable capability fingerprint is emitted.",
      });
    } else {
      codexResolution = await resolveExecutable({ env });
      const stderrCounter = { chunks: 0 };
      client = createClient({
        codexResolution,
        cwd: effectiveCwd,
        configOverrides: config.overrides,
        stderrHandler: () => {
          stderrCounter.chunks += 1;
        },
      });
      invokedMethods.push("initialize");
      initializeResult = await client.start();
      if (stderrCounter.chunks) {
        warnings.push({ code: "app-server-stderr-observed", occurrences: stderrCounter.chunks });
      }

      invokedMethods.push("skills/list");
      try {
        skillsListResult = await client.request("skills/list", {
          cwds: [effectiveCwd],
          forceReload: false,
        });
        chromeSkill = findChromeSkill(skillsListResult);
      } catch {
        unavailableReasons.push({ code: "skills-list-unavailable" });
      }

      invokedMethods.push("plugin/list");
      try {
        const pluginListResult = await client.request("plugin/list", {
          cwds: [effectiveCwd],
          forceRefetch: false,
        });
        currentChromePlugin = projectCurrentChromePlugin(pluginListResult);
      } catch {
        warnings.push({ code: "plugin-list-unavailable" });
      }
      if (!chromeSkill && !currentChromePlugin) {
        unavailableReasons.push({ code: "current_chrome_skill_unavailable" });
      }

      invokedMethods.push("mcpServerStatus/list");
      try {
        mcpStatusResult = await listMcpStatus(
          (params) => client.request("mcpServerStatus/list", params),
          { detail: "toolsAndAuthOnly", limit: 50 }
        );
      } catch {
        unavailableReasons.push({ code: "mcp-server-status-list-unavailable" });
      }

      invokedMethods.push("model/list");
      try {
        modelListResult = await listAllDataPages({
          requestPage: (params) => client.request("model/list", params),
          baseParams: { includeHidden: true },
          limit: 200,
        });
      } catch {
        unavailableReasons.push({ code: "model-list-unavailable" });
      }

      invokedMethods.push("config/read");
      try {
        configReadResult = await client.request("config/read", {
          cwd: effectiveCwd,
          includeLayers: false,
        });
      } catch {
        unavailableReasons.push({ code: "config-read-unavailable" });
      }

      invokedMethods.push("permissionProfile/list");
      try {
        permissionProfileListResult = await listAllDataPages({
          requestPage: (params) => client.request("permissionProfile/list", params),
          baseParams: { cwd: effectiveCwd },
          limit: 200,
        });
      } catch {
        unavailableReasons.push({ code: "permission-profile-list-unavailable" });
      }

      try {
        browserCompatibility = await resolveBrowserCompatibility({
          codexBin: codexResolution.path,
          chromeSkillPath: chromeSkill?.path ?? null,
          chromePluginBuild: currentChromePlugin?.localVersion ?? null,
          env,
        });
      } catch {
        browserCompatibility = {
          status: "unavailable",
          reason: "browser-runtime-compatibility-resolver-failed",
          source: currentChromePlugin ? "codex-plugin-list" : "codex-skills-list",
          overrides: [],
        };
      }
      if (browserCompatibility?.status === "ok") {
        try {
          browserClientSource = await readText(browserCompatibility.browserClientPath);
        } catch {
          unavailableReasons.push({ code: "browser-client-source-unreadable" });
        }
      }
      notificationMethods = Array.isArray(client.notificationMethods) ? client.notificationMethods : [];
    }
  } catch {
    unavailableReasons.push({
      code: codexResolution ? "app-server-collection-failed" : "codex-executable-resolution-failed",
    });
  } finally {
    if (client) notificationMethods = Array.isArray(client.notificationMethods) ? client.notificationMethods : notificationMethods;
    await client?.close?.().catch(() => {});
  }

  if (!browserCompatibility) {
    browserCompatibility = {
      status: "unavailable",
      reason: chromeSkill || currentChromePlugin
        ? "browser-runtime-compatibility-unavailable"
        : "current_chrome_skill_unavailable",
      source: currentChromePlugin ? "codex-plugin-list" : "codex-skills-list",
      overrides: [],
    };
  }

  return buildCompatibilityFingerprintReport({
    collectionEnvironment,
    identity: {
      platform,
      arch,
      nodeVersion,
      codexVersion: codexResolution?.version ?? null,
      codexResolutionSource: codexResolution?.source ?? null,
      browserBuild: browserCompatibility?.build ?? null,
    },
    provenance: {
      collectionCwd: effectiveCwd,
      configOverridesFile: config.file,
      configOverrideCount: config.overrides?.length ?? 0,
      codexResolvedExecutable: codexResolution?.path ?? null,
    },
    initializeResult,
    skillsListResult,
    mcpStatusResult,
    modelListResult,
    configReadResult,
    permissionProfileListResult,
    chromeSkill,
    browserCompatibility,
    browserClientSource,
    invokedMethods,
    notificationMethods,
    warnings,
    unavailableReasons,
  });
}

export async function runCompatibilityReporter({
  collect = collectUpstreamCompatibilityInventory,
  output = process.stdout,
  collectOptions = {},
} = {}) {
  const report = await collect(collectOptions);
  output.write(`${canonicalJson(report)}\n`);
  return report;
}

async function loadConfigOverrides({ env, readJson }) {
  const file = typeof env?.CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE === "string"
    && env.CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE.trim()
    ? path.resolve(env.CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE.trim())
    : null;
  if (!file) return { status: "ok", file: null, overrides: [] };
  try {
    const parsed = await readJson(file, "CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE");
    const overrides = parsed?.overrides;
    if (!Array.isArray(overrides) || !overrides.every((value) => typeof value === "string" && value.trim())) {
      return { status: "unavailable", file, overrides: [], reason: "config_overrides_invalid" };
    }
    return { status: "ok", file, overrides: [...overrides] };
  } catch {
    return { status: "unavailable", file, overrides: [], reason: "config_overrides_unreadable" };
  }
}

async function listAllDataPages({ requestPage, baseParams = {}, limit = 200, maxPages = 20 }) {
  const data = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await requestPage({
      ...baseParams,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) throw new Error("paginated App Server list returned invalid data");
    data.push(...result.data);
    const nextCursor = result?.nextCursor ?? null;
    if (nextCursor === null) return { data, nextCursor: null };
    if (typeof nextCursor !== "string" || !nextCursor || seen.has(nextCursor)) {
      throw new Error("paginated App Server list returned an invalid/repeated cursor");
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`paginated App Server list exceeded ${maxPages} pages`);
}

function defaultClientFactory({ codexResolution, cwd, configOverrides, stderrHandler }) {
  return new CodexAppServerClient({
    cwd,
    launch: () => ({
      command: codexResolution.path,
      args: [
        ...configOverrides.flatMap((value) => ["-c", value]),
        "app-server",
        "--stdio",
      ],
      options: { cwd },
    }),
    requestTimeoutMs: 20_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler,
    clientInfo: {
      name: "codexless_compatibility_report",
      title: "Codexless Compatibility Report",
      version: "0",
    },
  });
}

function projectBundlePairing(value) {
  if (value?.status === "ok") {
    return {
      status: "GREEN",
      decision: "matched",
      relevantState: "matched",
      reasonClass: null,
      reason: null,
      source: stringOrNull(value.source),
      build: stringOrNull(value.build),
      chromeManifest: {
        path: stringOrNull(value.chromeManifestPath),
      },
      browserManifest: {
        path: stringOrNull(value.browserManifestPath),
      },
      clientServicePair: {
        browserClientPath: stringOrNull(value.browserClientPath),
        browserServicePath: stringOrNull(value.browserServicePath),
        browserClientSha256: stringOrNull(value.browserClientSha256),
      },
    };
  }
  const reason = typeof value?.reason === "string" && value.reason ? value.reason : "browser-bundle-unavailable";
  const failClosed = BUNDLE_FAIL_CLOSED_REASONS.has(reason);
  return {
    status: failClosed ? "RED" : "UNAVAILABLE",
    decision: failClosed ? "fail-closed" : "unavailable",
    relevantState: failClosed ? "mismatched-or-partial" : "unavailable",
    reasonClass: failClosed ? reason : null,
    reason,
    source: stringOrNull(value?.source),
    build: stringOrNull(value?.build),
    chromeManifest: null,
    browserManifest: null,
    clientServicePair: null,
  };
}

function assessRequiredMembers(label, value, requirements) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "UNAVAILABLE",
      label,
      missingRequiredMembers: requirements.map(([member]) => member).sort(),
      relevantShape: {
        resultObject: false,
        requiredMembers: Object.fromEntries(requirements.map(([member]) => [member, false])),
      },
    };
  }
  const requiredMembers = {};
  const missing = [];
  for (const [member, expectedType] of requirements) {
    const ok = typeMatches(value[member], expectedType);
    requiredMembers[member] = ok;
    if (!ok) missing.push(member);
  }
  return {
    status: missing.length ? "RED" : "GREEN",
    label,
    missingRequiredMembers: missing.sort(),
    relevantShape: {
      resultObject: true,
      requiredMembers,
    },
  };
}

function assessSkillsList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "UNAVAILABLE",
      label: "skills/list",
      missingRequiredMembers: ["data"],
      relevantShape: {
        resultObject: false,
        dataArray: false,
        rowsSkillsArray: false,
      },
    };
  }
  const dataArray = Array.isArray(value.data);
  const rowsSkillsArray = dataArray && value.data.every((row) => row && typeof row === "object" && Array.isArray(row.skills));
  const missing = [
    ...(!dataArray ? ["data"] : []),
    ...(dataArray && !rowsSkillsArray ? ["data[].skills"] : []),
  ];
  return {
    status: missing.length ? "RED" : "GREEN",
    label: "skills/list",
    missingRequiredMembers: missing,
    relevantShape: {
      resultObject: true,
      dataArray,
      rowsSkillsArray,
    },
  };
}

function assessMcpStatusList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "UNAVAILABLE",
      label: "mcpServerStatus/list",
      missingRequiredMembers: ["data"],
      relevantShape: {
        resultObject: false,
        dataArray: false,
      },
    };
  }
  const dataArray = Array.isArray(value.data);
  return {
    status: dataArray ? "GREEN" : "RED",
    label: "mcpServerStatus/list",
    missingRequiredMembers: dataArray ? [] : ["data"],
    relevantShape: {
      resultObject: true,
      dataArray,
    },
  };
}

function assessNodeReplCompatibility({ mcpAssessment, nodeRepl, nodeReplJs }) {
  const jsInputSchemaShape = normalizeSchemaShape(nodeReplJs?.inputSchema ?? nodeReplJs?.input_schema ?? null);
  const serverObserved = Boolean(nodeRepl);
  const jsToolObserved = Boolean(nodeReplJs);
  const schemaObject = jsInputSchemaShape?.type === "object";
  const codeRequired = Array.isArray(jsInputSchemaShape?.required) && jsInputSchemaShape.required.includes("code");
  const codeString = jsInputSchemaShape?.properties?.code?.type === "string";
  const missingRequiredMembers = [
    ...(!serverObserved ? ["node_repl"] : []),
    ...(serverObserved && !jsToolObserved ? ["node_repl.tools.js"] : []),
    ...(jsToolObserved && !schemaObject ? ["node_repl.tools.js.inputSchema.type=object"] : []),
    ...(jsToolObserved && !codeRequired ? ["node_repl.tools.js.inputSchema.required:code"] : []),
    ...(jsToolObserved && !codeString ? ["node_repl.tools.js.inputSchema.properties.code.type=string"] : []),
  ];
  const status = mcpAssessment.status !== "GREEN"
    ? mcpAssessment.status
    : missingRequiredMembers.length
      ? "RED"
      : "GREEN";
  return {
    status,
    label: "node_repl/js",
    serverObserved,
    jsToolObserved,
    jsInputSchemaShape,
    missingRequiredMembers,
    relevantShape: {
      serverObserved,
      jsToolObserved,
      jsInputSchemaShape,
      requiredMembers: {
        schemaObject,
        codeRequired,
        codeString,
      },
    },
  };
}

function assessModelList(value) {
  const emptyCapabilities = { models: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "UNAVAILABLE",
      label: "model/list",
      missingRequiredMembers: ["data"],
      relevantShape: {
        resultObject: false,
        dataArray: false,
        rowsModelIdentity: false,
        rowsReasoningEffortsArray: false,
      },
      capabilities: emptyCapabilities,
    };
  }
  const dataArray = Array.isArray(value.data);
  const rows = dataArray ? value.data : [];
  const rowsModelIdentity = dataArray && rows.every((row) =>
    row && typeof row === "object" && (typeof row.id === "string" || typeof row.model === "string")
  );
  const rowsReasoningEffortsArray = dataArray && rows.every((row) =>
    Array.isArray(row?.supportedReasoningEfforts)
      && row.supportedReasoningEfforts.every((entry) => typeof entry?.reasoningEffort === "string")
  );
  const nonEmpty = dataArray && rows.length > 0;
  const missingRequiredMembers = [
    ...(!dataArray ? ["data"] : []),
    ...(dataArray && !nonEmpty ? ["data[]"] : []),
    ...(dataArray && !rowsModelIdentity ? ["data[].id|model"] : []),
    ...(dataArray && !rowsReasoningEffortsArray ? ["data[].supportedReasoningEfforts[].reasoningEffort"] : []),
  ];
  const capabilities = {
    models: dataArray ? projectModelCapabilities(rows) : [],
  };
  return {
    status: missingRequiredMembers.length ? "RED" : "GREEN",
    label: "model/list",
    missingRequiredMembers,
    relevantShape: {
      resultObject: true,
      dataArray,
      rowsModelIdentity,
      rowsReasoningEffortsArray,
    },
    capabilities,
  };
}

function projectModelCapabilities(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === "object" && (typeof row.id === "string" || typeof row.model === "string"))
    .map((row) => ({
      id: stringOrNull(row.id),
      model: stringOrNull(row.model),
      hidden: row.hidden === true,
      isDefault: row.isDefault === true,
      defaultReasoningEffort: stringOrNull(row.defaultReasoningEffort),
      supportedReasoningEfforts: sortedUniqueStrings(
        Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts.map((entry) => entry?.reasoningEffort)
          : []
      ),
      inputModalities: sortedUniqueStrings(row.inputModalities),
      supportsPersonality: typeof row.supportsPersonality === "boolean" ? row.supportsPersonality : null,
      multiAgentVersion: stringOrNull(row.multiAgentVersion),
      additionalSpeedTiers: sortedUniqueStrings(row.additionalSpeedTiers),
      serviceTierIds: sortedUniqueStrings(
        Array.isArray(row.serviceTiers) ? row.serviceTiers.map((entry) => entry?.id) : []
      ),
      defaultServiceTier: stringOrNull(row.defaultServiceTier),
    }))
    .sort((left, right) => compareStrings(
      `${left.id ?? ""}\u0000${left.model ?? ""}`,
      `${right.id ?? ""}\u0000${right.model ?? ""}`
    ));
}

const CONFIG_COMPATIBILITY_FIELDS = Object.freeze([
  ["model", "model"],
  ["modelReasoningEffort", "model_reasoning_effort"],
  ["defaultPermissions", "default_permissions"],
  ["approvalPolicy", "approval_policy"],
  ["approvalsReviewer", "approvals_reviewer"],
]);

function assessConfigRead(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "UNAVAILABLE",
      label: "config/read",
      missingRequiredMembers: ["config"],
      relevantShape: {
        resultObject: false,
        configObject: false,
        selectedKeyShape: projectConfigKeyShape(null),
      },
      selectedValues: projectConfigSelectedValues(null),
    };
  }
  const configObject = Boolean(value.config && typeof value.config === "object" && !Array.isArray(value.config));
  const keyShape = projectConfigKeyShape(configObject ? value.config : null);
  const missingRequiredMembers = configObject
    ? CONFIG_COMPATIBILITY_FIELDS.flatMap(([label]) => {
        const shape = keyShape[label];
        if (!shape.present) return [`config.${shape.sourceKey}`];
        if (!shape.typeValid) return [`config.${shape.sourceKey}:string|null`];
        return [];
      })
    : ["config"];
  return {
    status: missingRequiredMembers.length ? "RED" : "GREEN",
    label: "config/read",
    missingRequiredMembers,
    relevantShape: {
      resultObject: true,
      configObject,
      selectedKeyShape: keyShape,
    },
    selectedValues: projectConfigSelectedValues(configObject ? value.config : null),
  };
}

function projectConfigKeyShape(config) {
  return Object.fromEntries(CONFIG_COMPATIBILITY_FIELDS.map(([label, key]) => {
    const present = Boolean(config && typeof config === "object" && !Array.isArray(config) && Object.hasOwn(config, key));
    const value = present ? config[key] : undefined;
    return [label, {
      sourceKey: key,
      present,
      type: "string|null",
      typeValid: present && (value === null || typeof value === "string"),
    }];
  }));
}

function projectConfigSelectedValues(config) {
  return Object.fromEntries(CONFIG_COMPATIBILITY_FIELDS.map(([label, key]) => [
    label,
    selectedScalar(config, key),
  ]));
}

function selectedScalar(config, key) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !Object.hasOwn(config, key)) return null;
  const value = config[key];
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : null;
}

function assessPermissionProfileList(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "UNAVAILABLE",
      label: "permissionProfile/list",
      missingRequiredMembers: ["data"],
      relevantShape: {
        resultObject: false,
        dataArray: false,
        rowsIdAllowed: false,
        profiles: [],
      },
    };
  }
  const dataArray = Array.isArray(value.data);
  const rows = dataArray ? value.data : [];
  const rowsIdAllowed = dataArray && rows.every((row) =>
    row && typeof row === "object" && typeof row.id === "string" && typeof row.allowed === "boolean"
  );
  const nonEmpty = dataArray && rows.length > 0;
  const profiles = rows
    .filter((row) => typeof row?.id === "string" && typeof row?.allowed === "boolean")
    .map((row) => ({ id: row.id, allowed: row.allowed }))
    .sort((left, right) => compareStrings(left.id, right.id));
  const missingRequiredMembers = [
    ...(!dataArray ? ["data"] : []),
    ...(dataArray && !nonEmpty ? ["data[]"] : []),
    ...(dataArray && !rowsIdAllowed ? ["data[].id+allowed"] : []),
  ];
  return {
    status: missingRequiredMembers.length ? "RED" : "GREEN",
    label: "permissionProfile/list",
    missingRequiredMembers,
    relevantShape: {
      resultObject: true,
      dataArray,
      rowsIdAllowed,
      profiles,
    },
  };
}

function usageSemanticVocabulary() {
  const tokenUsage = normalizeThreadTokenUsage({
    last: {},
    total: {},
    modelContextWindow: null,
  });
  const accountQuota = projectQuotaSnapshot(null);
  return {
    tokenUsage: sortedUniqueStrings(Object.keys(tokenUsage ?? {})),
    turn: sortedUniqueStrings(Object.keys(tokenUsage?.turn ?? {})),
    threadTotal: sortedUniqueStrings(Object.keys(tokenUsage?.threadTotal ?? {})),
    accountQuota: sortedUniqueStrings(Object.keys(accountQuota ?? {})),
    rateLimits: sortedUniqueStrings(Object.keys(accountQuota?.rateLimits ?? {})),
  };
}

function combineAssessments(assessments) {
  const statuses = assessments.map((entry) => entry.status);
  return {
    status: statuses.includes("RED")
      ? "RED"
      : statuses.includes("UNAVAILABLE")
        ? "UNAVAILABLE"
        : "GREEN",
    components: assessments.map((entry) => ({
      label: entry.label,
      status: entry.status,
      missingRequiredMembers: entry.missingRequiredMembers,
    })),
  };
}

function objectMemberShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareStrings)
      .map((key) => [key, valueType(value[key])])
  );
}

function normalizeSchemaShape(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const result = {};
  if (typeof schema.type === "string") result.type = schema.type;
  if (Array.isArray(schema.required)) result.required = sortedUniqueStrings(schema.required);
  if (typeof schema.additionalProperties === "boolean") result.additionalProperties = schema.additionalProperties;
  if (Array.isArray(schema.enum)) result.enum = [...schema.enum].map((value) => scalarForShape(value));
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    result.properties = Object.fromEntries(
      Object.keys(schema.properties)
        .sort(compareStrings)
        .map((key) => [key, normalizeSchemaShape(schema.properties[key]) ?? { kind: valueType(schema.properties[key]) }])
    );
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) result[key] = schema[key].map((entry) => normalizeSchemaShape(entry) ?? { kind: valueType(entry) });
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (typeof schema[key] === "number") result[key] = schema[key];
  }
  return result;
}

function findChromeSkill(skillsResult) {
  const skills = Array.isArray(skillsResult?.data)
    ? skillsResult.data.flatMap((row) => Array.isArray(row?.skills) ? row.skills : [])
    : [];
  return skills.find((skill) => skill?.name === CHROME_SKILL_NAME && skill?.enabled !== false) ?? null;
}

function findMcpServer(result, name) {
  return Array.isArray(result?.data)
    ? result.data.find((server) => server?.name === name) ?? null
    : null;
}

function findMcpTool(server, name) {
  const tools = server?.tools && typeof server.tools === "object" && !Array.isArray(server.tools)
    ? Object.values(server.tools)
    : Array.isArray(server?.tools)
      ? server.tools
      : [];
  return tools.find((tool) => tool?.name === name) ?? null;
}

function normalizeDiagnosticEntries(entries) {
  const normalized = [];
  const seen = new Set();
  for (const entry of entries) {
    const value = typeof entry === "string"
      ? { code: entry }
      : entry && typeof entry === "object"
        ? {
            code: stringOrNull(entry.code) ?? "unspecified",
            ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
            ...(Number.isInteger(entry.occurrences) ? { occurrences: entry.occurrences } : {}),
          }
        : null;
    if (!value) continue;
    const key = canonicalJson(value, { pretty: false });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized.sort((a, b) => compareStrings(
    canonicalJson(a, { pretty: false }),
    canonicalJson(b, { pretty: false })
  ));
}

function sortedUniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .filter((value) => typeof value === "string")
  )].sort(compareStrings);
}

function firstArrayEntry(value) {
  return Array.isArray(value) && value.length ? value[0] : null;
}

function typeMatches(value, expected) {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  return typeof value === expected;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function scalarForShape(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? value
    : valueType(value);
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}
