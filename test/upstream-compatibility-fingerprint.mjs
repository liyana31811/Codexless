import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompatibilityFingerprintReport,
  canonicalJson,
  collectUpstreamCompatibilityInventory,
  inspectBrowserLifecycleSource,
  runCompatibilityReporter,
} from "../src/upstream-compatibility-fingerprint.mjs";

const HEX64 = "a".repeat(64);

function baseEvidence() {
  const chromeSkill = {
    name: "chrome:control-chrome",
    path: "C:\\Users\\Example\\.codex\\plugins\\cache\\openai-bundled\\chrome\\26.1\\skills\\control-chrome\\SKILL.md",
    scope: "user",
    enabled: true,
    description: "cosmetic text",
  };
  return {
    identity: {
      platform: "win32",
      arch: "x64",
      nodeVersion: "v24.18.0",
      codexVersion: "0.148.0-alpha.15",
      codexResolutionSource: "codex-desktop-runtime-cache",
      browserBuild: "26.1",
    },
    provenance: {
      collectionCwd: "C:\\work\\repo",
      configOverridesFile: "C:\\Users\\Example\\.config\\codex-overrides.json",
      configOverrideCount: 4,
      codexResolvedExecutable: "C:\\Users\\Example\\AppData\\Local\\OpenAI\\Codex\\bin\\abc\\codex.exe",
    },
    initializeResult: {
      platformFamily: "windows",
      platformOs: "windows",
      codexHome: "C:\\Users\\Example\\.codex",
      userAgent: "codex/0.148.0-alpha.15",
    },
    skillsListResult: {
      data: [{
        cwd: "C:\\work\\repo",
        errors: [],
        skills: [chromeSkill],
      }],
    },
    chromeSkill,
    mcpStatusResult: {
      data: [{
        name: "node_repl",
        authStatus: "notApplicable",
        error: null,
        tools: {
          js: {
            name: "js",
            title: "JavaScript",
            description: "cosmetic tool description",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["code"],
              properties: {
                code: { type: "string", description: "cosmetic schema description" },
                title: { type: "string", minLength: 1, maxLength: 80 },
              },
            },
          },
        },
      }],
      nextCursor: null,
    },
    modelListResult: {
      data: [{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        description: "cosmetic model description",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "cosmetic" },
          { reasoningEffort: "medium", description: "cosmetic" },
          { reasoningEffort: "high", description: "cosmetic" },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        multiAgentVersion: "v2",
        additionalSpeedTiers: ["fast"],
        serviceTiers: [{ id: "priority", name: "Fast", description: "cosmetic" }],
        defaultServiceTier: null,
      }],
      nextCursor: null,
    },
    configReadResult: {
      config: {
        model: "gpt-test",
        model_reasoning_effort: "medium",
        default_permissions: ":read-only",
        approval_policy: null,
        approvals_reviewer: null,
      },
      origins: {},
    },
    permissionProfileListResult: {
      data: [
        { id: ":read-only", description: null, allowed: true },
        { id: ":workspace", description: "cosmetic", allowed: true },
      ],
      nextCursor: null,
    },
    browserCompatibility: {
      status: "ok",
      source: "codex-skills-list",
      build: "26.1",
      chromeSkillPath: chromeSkill.path,
      browserRuntimeCwd: "C:\\Users\\Example",
      browserServicePath: "C:\\Users\\Example\\.codex\\plugins\\cache\\openai-bundled\\browser\\26.1\\scripts\\browser-service.mjs",
      browserClientPath: "C:\\Users\\Example\\.codex\\plugins\\cache\\openai-bundled\\chrome\\26.1\\scripts\\browser-client.mjs",
      browserClientSha256: HEX64,
      chromeManifestPath: "C:\\Users\\Example\\.codex\\plugins\\cache\\openai-bundled\\chrome\\26.1\\.codex-plugin\\plugin.json",
      browserManifestPath: "C:\\Users\\Example\\.codex\\plugins\\cache\\openai-bundled\\browser\\26.1\\.codex-plugin\\plugin.json",
      overrides: [],
    },
    browserClientSource: "const api = { tabs: { finalize() {} } };",
    invokedMethods: [
      "initialize",
      "skills/list",
      "mcpServerStatus/list",
      "model/list",
      "config/read",
      "permissionProfile/list",
    ],
    notificationMethods: [],
    warnings: [
      { code: "z-warning" },
      { code: "a-warning" },
    ],
    unavailableReasons: [],
  };
}

function clone(value) {
  return structuredClone(value);
}

test("canonical ordering and relevant hash are deterministic", () => {
  const left = baseEvidence();
  const right = clone(left);
  right.invokedMethods.reverse();
  right.warnings.reverse();

  const leftReport = buildCompatibilityFingerprintReport(left);
  const rightReport = buildCompatibilityFingerprintReport(right);

  assert.equal(leftReport.fingerprint.relevantCapabilityHash, rightReport.fingerprint.relevantCapabilityHash);
  assert.equal(canonicalJson(leftReport), canonicalJson(rightReport));
  assert.deepEqual(leftReport.warnings.map((entry) => entry.code), ["a-warning", "z-warning"]);
});

test("session/ref/time/quota/token/PII and transient backend facts are excluded from relevant hash", () => {
  const clean = baseEvidence();
  const noisy = clone(clean);

  noisy.provenance.collectionCwd = "C:\\Temp\\session-123\\repo";
  noisy.provenance.codexResolvedExecutable = "C:\\Users\\Private Person\\AppData\\Local\\Codex\\codex.exe";
  noisy.initializeResult.timestamp = "2099-01-01T00:00:00Z";
  noisy.initializeResult.sessionId = "session-secret";
  noisy.initializeResult.turn_id = "turn-secret";
  noisy.initializeResult.threadId = "thread-secret";
  noisy.initializeResult.account = { email: "private@example.com", name: "Private Person" };
  noisy.skillsListResult.data[0].cwd = "C:\\Temp\\different";
  noisy.chromeSkill.path = "C:\\Temp\\volatile\\SKILL.md";
  noisy.skillsListResult.data[0].skills[0].path = noisy.chromeSkill.path;
  noisy.mcpStatusResult.data[0].error = { message: "temporary backend outage", at: "2099-01-01T00:00:00Z" };
  noisy.mcpStatusResult.data[0].authStatus = "temporarilyUnavailable";
  noisy.quota = { percentRemaining: 17 };
  noisy.tokens = { input: 123456, output: 789 };
  noisy.tab = { tabRef: "tab-secret", title: "Private title", url: "https://private.example/" };
  noisy.refId = "ref-secret";
  noisy.warnings.push({ code: "transient-backend-offline", occurrences: 99 });

  const cleanHash = buildCompatibilityFingerprintReport(clean).fingerprint.relevantCapabilityHash;
  const noisyHash = buildCompatibilityFingerprintReport(noisy).fingerprint.relevantCapabilityHash;

  assert.equal(cleanHash, noisyHash);
});

test("version and path identity changes do not change relevant capability hash", () => {
  const oldEvidence = baseEvidence();
  const newEvidence = clone(oldEvidence);
  newEvidence.identity.codexVersion = "0.999.0";
  newEvidence.identity.browserBuild = "99.999";
  newEvidence.identity.codexResolutionSource = "explicit-CODEX_BIN";
  newEvidence.provenance.codexResolvedExecutable = "D:\\Portable\\codex.exe";
  newEvidence.provenance.collectionCwd = "D:\\repo";
  newEvidence.browserCompatibility.build = "99.999";
  newEvidence.browserCompatibility.chromeSkillPath = "D:\\bundle\\SKILL.md";
  newEvidence.browserCompatibility.browserClientPath = "D:\\bundle\\browser-client.mjs";
  newEvidence.browserCompatibility.browserServicePath = "D:\\bundle\\browser-service.mjs";
  newEvidence.browserCompatibility.chromeManifestPath = "D:\\bundle\\chrome-plugin.json";
  newEvidence.browserCompatibility.browserManifestPath = "D:\\bundle\\browser-plugin.json";
  newEvidence.browserCompatibility.browserClientSha256 = "b".repeat(64);
  newEvidence.chromeSkill.path = "D:\\bundle\\SKILL.md";
  newEvidence.skillsListResult.data[0].skills[0].path = "D:\\bundle\\SKILL.md";

  const oldReport = buildCompatibilityFingerprintReport(oldEvidence);
  const newReport = buildCompatibilityFingerprintReport(newEvidence);

  assert.notDeepEqual(oldReport.identity, newReport.identity);
  assert.notDeepEqual(oldReport.provenance, newReport.provenance);
  assert.equal(oldReport.fingerprint.relevantCapabilityHash, newReport.fingerprint.relevantCapabilityHash);
});

test("additive irrelevant fields do not change relevant capability hash", () => {
  const baseline = baseEvidence();
  const additive = clone(baseline);
  additive.initializeResult.newCosmeticField = { arbitrary: true };
  additive.skillsListResult.newEnvelopeMetadata = "ignored";
  additive.skillsListResult.data[0].skills[0].newOptionalField = 42;
  additive.mcpStatusResult.data[0].newBackendMetadata = { latencyMs: 900 };
  additive.browserCompatibility.newResolverDetail = "ignored";
  additive.extraFutureEnvelope = { anything: ["goes", "here"] };

  const baselineHash = buildCompatibilityFingerprintReport(baseline).fingerprint.relevantCapabilityHash;
  const additiveHash = buildCompatibilityFingerprintReport(additive).fingerprint.relevantCapabilityHash;

  assert.equal(baselineHash, additiveHash);
});

test("node_repl server removal changes relevant hash and is structured RED", () => {
  const baseline = buildCompatibilityFingerprintReport(baseEvidence());
  const missing = baseEvidence();
  missing.mcpStatusResult.data = [];

  const report = buildCompatibilityFingerprintReport(missing);

  assert.notEqual(report.fingerprint.relevantCapabilityHash, baseline.fingerprint.relevantCapabilityHash);
  assert.equal(report.semanticEvidence.browserNodeRepl.status, "RED");
  assert.equal(report.overallStatus, "RED");
  assert.equal(report.semanticEvidence.browserNodeRepl.serverObserved, false);
  assert.ok(report.semanticEvidence.browserNodeRepl.missingRequiredMembers.includes("node_repl"));
  assert.equal(report.fingerprint.relevantCapabilityProjection.browser.nodeRepl.serverObserved, false);
});

test("node_repl js removal changes relevant hash and is structured RED", () => {
  const baseline = buildCompatibilityFingerprintReport(baseEvidence());
  const missing = baseEvidence();
  missing.mcpStatusResult.data[0].tools = {};

  const report = buildCompatibilityFingerprintReport(missing);

  assert.notEqual(report.fingerprint.relevantCapabilityHash, baseline.fingerprint.relevantCapabilityHash);
  assert.equal(report.semanticEvidence.browserNodeRepl.status, "RED");
  assert.equal(report.overallStatus, "RED");
  assert.equal(report.semanticEvidence.browserNodeRepl.jsToolObserved, false);
  assert.ok(report.semanticEvidence.browserNodeRepl.missingRequiredMembers.includes("node_repl.tools.js"));
});

test("node_repl js normalized schema drift changes relevant hash and invalid required shape is RED", () => {
  const baseline = buildCompatibilityFingerprintReport(baseEvidence());
  const changed = baseEvidence();
  changed.mcpStatusResult.data[0].tools.js.inputSchema.required = [];
  changed.mcpStatusResult.data[0].tools.js.inputSchema.properties.code.type = "number";

  const report = buildCompatibilityFingerprintReport(changed);

  assert.notEqual(report.fingerprint.relevantCapabilityHash, baseline.fingerprint.relevantCapabilityHash);
  assert.equal(report.semanticEvidence.browserNodeRepl.status, "RED");
  assert.ok(report.semanticEvidence.browserNodeRepl.missingRequiredMembers.includes("node_repl.tools.js.inputSchema.required:code"));
  assert.ok(report.semanticEvidence.browserNodeRepl.missingRequiredMembers.includes("node_repl.tools.js.inputSchema.properties.code.type=string"));
});

test("model/reasoning catalog and permissionProfile capability catalog changes are hash-relevant", () => {
  const baseline = buildCompatibilityFingerprintReport(baseEvidence());

  const modelChanged = baseEvidence();
  modelChanged.modelListResult.data[0].supportedReasoningEfforts.push({ reasoningEffort: "ultra", description: "cosmetic" });
  const modelReport = buildCompatibilityFingerprintReport(modelChanged);
  assert.equal(modelReport.semanticEvidence.modelReasoning.status, "GREEN");
  assert.notEqual(modelReport.fingerprint.relevantCapabilityHash, baseline.fingerprint.relevantCapabilityHash);

  const profilesChanged = baseEvidence();
  profilesChanged.permissionProfileListResult.data = profilesChanged.permissionProfileListResult.data.filter((row) => row.id !== ":workspace");
  const profilesReport = buildCompatibilityFingerprintReport(profilesChanged);
  assert.equal(profilesReport.semanticEvidence.authority.modelFreeCatalogStatus, "GREEN");
  assert.notEqual(profilesReport.fingerprint.relevantCapabilityHash, baseline.fingerprint.relevantCapabilityHash);
});

test("user-selected config values are diagnostic only and do not change relevant capability hash", () => {
  const baseline = buildCompatibilityFingerprintReport(baseEvidence());
  const changed = baseEvidence();
  changed.configReadResult.config.model = "another-model";
  changed.configReadResult.config.model_reasoning_effort = "high";
  changed.configReadResult.config.default_permissions = ":workspace";
  changed.configReadResult.config.approval_policy = "never";
  changed.configReadResult.config.approvals_reviewer = "policy";

  const report = buildCompatibilityFingerprintReport(changed);

  assert.equal(report.fingerprint.relevantCapabilityHash, baseline.fingerprint.relevantCapabilityHash);
  assert.equal(report.semanticEvidence.authority.configSelectedValues.model, "another-model");
  assert.equal(report.semanticEvidence.authority.configSelectedValues.modelReasoningEffort, "high");
  assert.equal(report.semanticEvidence.authority.configSelectedValues.defaultPermissions, ":workspace");
});

test("runtime authority projection stays explicit NOT_RUN in Phase 0", () => {
  const report = buildCompatibilityFingerprintReport(baseEvidence());
  assert.deepEqual(report.semanticEvidence.authority.runtimeProjection, {
    status: "NOT_RUN",
    reason: "runtime-authority-not-probed-phase0",
  });
  assert.equal(report.semanticEvidence.authority.modelFreeCatalogStatus, "GREEN");
});

test("approval usage and mutation semantic slots stay explicit NOT_RUN", () => {
  const report = buildCompatibilityFingerprintReport(baseEvidence());
  assert.equal(report.semanticEvidence.approval.status, "NOT_RUN");
  assert.equal(report.semanticEvidence.usage.status, "NOT_RUN");
  assert.equal(report.semanticEvidence.mutation.status, "NOT_RUN");
  assert.equal(report.semanticEvidence.browserRuntimeAttachment.status, "NOT_RUN");
  assert.ok(report.semanticEvidence.usage.vocabulary.tokenUsage.includes("threadTotal"));
  assert.ok(report.semanticEvidence.usage.vocabulary.threadTotal.includes("totalTokens"));
});

test("required member missing produces structured RED evidence", () => {
  const evidence = baseEvidence();
  delete evidence.initializeResult.platformOs;

  const report = buildCompatibilityFingerprintReport(evidence);
  const initialize = report.capabilityProjection.appServer.initialize;

  assert.equal(initialize.status, "RED");
  assert.deepEqual(initialize.missingRequiredMembers, ["platformOs"]);
  assert.equal(report.semanticEvidence.appServerRequiredShapes.status, "RED");
  assert.equal(report.overallStatus, "RED");
  assert.notEqual(
    report.fingerprint.relevantCapabilityHash,
    buildCompatibilityFingerprintReport(baseEvidence()).fingerprint.relevantCapabilityHash
  );
});

test("Browser build/pair mismatch is structured RED and fail-closed", () => {
  const evidence = baseEvidence();
  evidence.browserCompatibility = {
    status: "unavailable",
    source: "codex-skills-list",
    build: "26.1",
    reason: "current_browser_plugin_manifest_mismatch",
    overrides: [],
  };

  const report = buildCompatibilityFingerprintReport(evidence);

  assert.equal(report.bundlePairing.status, "RED");
  assert.equal(report.bundlePairing.decision, "fail-closed");
  assert.equal(report.bundlePairing.reason, "current_browser_plugin_manifest_mismatch");
  assert.equal(report.semanticEvidence.browserBundlePairing.status, "RED");
  assert.equal(report.overallStatus, "RED");
  assert.equal(report.fingerprint.relevantCapabilityProjection.browser.bundlePairing.state, "mismatched-or-partial");
});

test("Browser partial pair not found is structured RED and fail-closed", () => {
  const evidence = baseEvidence();
  evidence.browserCompatibility = {
    status: "unavailable",
    source: "codex-skills-list",
    build: "26.1",
    reason: "current_browser_plugin_pair_not_found",
    overrides: [],
  };

  const report = buildCompatibilityFingerprintReport(evidence);

  assert.equal(report.bundlePairing.status, "RED");
  assert.equal(report.bundlePairing.decision, "fail-closed");
  assert.equal(report.bundlePairing.reason, "current_browser_plugin_pair_not_found");
  assert.equal(report.semanticEvidence.browserBundlePairing.status, "RED");
  assert.equal(report.overallStatus, "RED");
  assert.equal(report.fingerprint.relevantCapabilityProjection.browser.bundlePairing.state, "mismatched-or-partial");
});

test("finalize-absent Browser marks are turn cleanup only and never GREEN release", () => {
  const lifecycle = inspectBrowserLifecycleSource(
    "class Tab { async markDeliverable() {} async markHandoff() {} }"
  );
  assert.equal(lifecycle.tabsFinalize, false);
  assert.equal(lifecycle.adapterShape, "finalize-absent-turn-cleanup");
  assert.equal(lifecycle.adapterExistingTabRelease, "turn-boundary-auto-release");
  assert.equal(lifecycle.classification, "turn-cleanup-no-public-release");
  assert.equal(lifecycle.existingTabRelease, "unproven");
  assert.equal(lifecycle.handback, "unproven");
  assert.equal(lifecycle.status, "RED");

  const evidence = baseEvidence();
  evidence.browserClientSource = "class Tab { markDeliverable() {} markHandoff() {} }";
  const report = buildCompatibilityFingerprintReport(evidence);
  assert.equal(report.semanticEvidence.browserExistingTabRelease.status, "RED");
  assert.equal(
    report.semanticEvidence.browserExistingTabRelease.classification,
    "turn-cleanup-no-public-release"
  );
  assert.equal(report.semanticEvidence.browserExistingTabRelease.existingTabRelease, "unproven");
  assert.equal(report.semanticEvidence.browserExistingTabRelease.handback, "unproven");
  assert.match(report.semanticEvidence.browserExistingTabRelease.note, /independent-controller force release\/takeover/);
  assert.ok(report.warnings.some((entry) => entry.code === "browser-existing-tab-release-unproven"));
  assert.equal(report.overallStatus, "GREEN");
});

test("unknown or unsupported Browser release lifecycle remains overall RED", () => {
  const evidence = baseEvidence();
  evidence.browserLifecycle = {
    status: "RED",
    adapterShape: "unsupported",
    adapterExistingTabRelease: "unavailable",
    classification: "existing-tab-release-unproven",
    tabsFinalize: false,
    markDeliverable: false,
    markHandoff: false,
    existingTabRelease: "unproven",
    handback: "unproven",
  };

  const report = buildCompatibilityFingerprintReport(evidence);

  assert.equal(report.semanticEvidence.browserExistingTabRelease.status, "RED");
  assert.equal(report.semanticEvidence.browserExistingTabRelease.classification, "existing-tab-release-unproven");
  assert.equal(report.semanticEvidence.browserExistingTabRelease.existingTabRelease, "unproven");
  assert.equal(report.semanticEvidence.browserExistingTabRelease.handback, "unproven");
  assert.equal(report.overallStatus, "RED");
});

test("incomplete collection environment suppresses comparable capability fingerprint", () => {
  const evidence = baseEvidence();
  evidence.collectionEnvironment = {
    status: "INCOMPLETE",
    reason: "config_overrides_unreadable",
    action: "run from host-state context",
  };

  const report = buildCompatibilityFingerprintReport(evidence);

  assert.equal(report.collectionEnvironment.status, "INCOMPLETE");
  assert.equal(report.collectionEnvironment.reason, "config_overrides_unreadable");
  assert.equal(report.compatibilityDecisionUsable, false);
  assert.equal(report.fingerprint.usableForCompatibilityDecision, false);
  assert.equal(report.fingerprint.relevantCapabilityHash, null);
  assert.equal(report.overallStatus, "YELLOW");
});

test("configured user Codex state unreadable marks collector environment incomplete without launching App Server", async () => {
  let resolvedExecutable = false;
  const report = await collectUpstreamCompatibilityInventory({
    cwd: "C:\\work\\repo",
    env: {
      CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE: "C:\\Users\\Example\\.config\\codex-overrides.json",
    },
    platform: "win32",
    arch: "x64",
    nodeVersion: "v24-test",
    readJson: async () => {
      throw new Error("sandbox cannot read user config");
    },
    resolveExecutable: async () => {
      resolvedExecutable = true;
      return { path: "C:\\fake\\codex.exe", source: "test", version: "0.test" };
    },
  });

  assert.equal(resolvedExecutable, false);
  assert.equal(report.collectionEnvironment.status, "INCOMPLETE");
  assert.equal(report.collectionEnvironment.reason, "config_overrides_unreadable");
  assert.match(report.collectionEnvironment.action, /host-state context/);
  assert.equal(report.compatibilityDecisionUsable, false);
  assert.equal(report.fingerprint.usableForCompatibilityDecision, false);
  assert.equal(report.fingerprint.relevantCapabilityHash, null);
  assert.ok(report.unavailableReasons.some((entry) => entry.code === "collection_environment_incomplete"));
  assert.equal(report.semanticEvidence.modelFreeCollection.modelTurnStarted, false);
});

test("collector and reporter stay model-free, avoid Browser calls, and write only supplied stdout", async () => {
  const requests = [];
  const reads = [];
  let closed = false;
  const fakeClient = {
    notificationMethods: [],
    async start() {
      return { platformFamily: "windows", platformOs: "windows", userAgent: "codex/test" };
    },
    async request(method) {
      requests.push(method);
      if (method === "skills/list") {
        return {
          data: [{
            cwd: "C:\\work\\repo",
            errors: [],
            skills: [],
          }],
        };
      }
      if (method === "plugin/list") {
        return {
          marketplaces: [{
            plugins: [{
              id: "chrome@openai-bundled",
              name: "chrome",
              localVersion: "26.1",
              source: { path: "C:\\bundle\\chrome" },
            }],
          }],
        };
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [{
            name: "node_repl",
            tools: {
              js: {
                name: "js",
                inputSchema: {
                  type: "object",
                  required: ["code"],
                  properties: { code: { type: "string" } },
                },
              },
            },
            error: null,
          }],
          nextCursor: null,
        };
      }
      if (method === "model/list") {
        return {
          data: [{
            id: "gpt-test",
            model: "gpt-test",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          }],
          nextCursor: null,
        };
      }
      if (method === "config/read") {
        return {
          config: {
            model: "gpt-test",
            model_reasoning_effort: "medium",
            default_permissions: ":read-only",
            approval_policy: "on-request",
            approvals_reviewer: "user",
          },
          origins: {},
        };
      }
      if (method === "permissionProfile/list") {
        return {
          data: [{ id: ":read-only", allowed: true, description: null }],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
    async close() {
      closed = true;
    },
  };

  const report = await collectUpstreamCompatibilityInventory({
    cwd: "C:\\work\\repo",
    env: {},
    platform: "win32",
    arch: "x64",
    nodeVersion: "v24-test",
    resolveExecutable: async () => ({
      path: "C:\\fake\\codex.exe",
      source: "test",
      version: "0.test",
    }),
    createClient: ({ configOverrides }) => {
      assert.deepEqual(configOverrides, []);
      return fakeClient;
    },
    resolveBrowserCompatibility: async ({ chromeSkillPath: observedPath, chromePluginBuild }) => {
      assert.equal(observedPath, null);
      assert.equal(chromePluginBuild, "26.1");
      return {
        status: "ok",
        source: "codex-plugin-list",
        build: "26.1",
        chromeSkillPath: null,
        browserServicePath: "C:\\bundle\\browser\\26.1\\scripts\\browser-service.mjs",
        browserClientPath: "C:\\bundle\\chrome\\26.1\\scripts\\browser-client.mjs",
        browserClientSha256: HEX64,
        chromeManifestPath: "C:\\bundle\\chrome\\26.1\\.codex-plugin\\plugin.json",
        browserManifestPath: "C:\\bundle\\browser\\26.1\\.codex-plugin\\plugin.json",
        overrides: [],
      };
    },
    readText: async (filePath) => {
      reads.push(filePath);
      return "const browser = { tabs: { finalize() {} } };";
    },
  });

  assert.deepEqual(requests, [
    "skills/list",
    "plugin/list",
    "mcpServerStatus/list",
    "model/list",
    "config/read",
    "permissionProfile/list",
  ]);
  assert.equal(closed, true);
  assert.deepEqual(reads, ["C:\\bundle\\chrome\\26.1\\scripts\\browser-client.mjs"]);
  assert.deepEqual(report.provenance.appServer.methodsObserved, [
    "config/read",
    "initialize",
    "mcpServerStatus/list",
    "model/list",
    "permissionProfile/list",
    "plugin/list",
    "skills/list",
  ]);
  assert.equal(report.bundlePairing.status, "GREEN");
  assert.equal(report.bundlePairing.source, "codex-plugin-list");
  assert.equal(report.capabilityProjection.browser.chromeSkill.observed, false);
  assert.equal(report.unavailableReasons.some((entry) => entry.code === "current_chrome_skill_unavailable"), false);
  assert.equal(report.semanticEvidence.modelFreeCollection.status, "GREEN");
  assert.equal(report.semanticEvidence.modelFreeCollection.modelTurnStarted, false);
  assert.equal(report.semanticEvidence.modelFreeCollection.threadStarted, false);
  assert.equal(report.semanticEvidence.modelFreeCollection.browserToolCallStarted, false);
  assert.equal(report.semanticEvidence.authority.modelFreeCatalogStatus, "GREEN");
  assert.equal(report.semanticEvidence.authority.runtimeProjection.status, "NOT_RUN");
  assert.equal(report.semanticEvidence.modelReasoning.status, "GREEN");
  assert.equal(report.semanticEvidence.browserNodeRepl.status, "GREEN");
  assert.equal(report.semanticEvidence.browserRuntimeAttachment.realTabInspected, false);
  assert.equal(report.semanticEvidence.browserRuntimeAttachment.mutationAttempted, false);
  assert.equal(report.semanticEvidence.approval.status, "NOT_RUN");
  assert.equal(report.semanticEvidence.usage.status, "NOT_RUN");
  assert.equal(report.semanticEvidence.mutation.status, "NOT_RUN");
  assert.ok(!requests.some((method) => method.startsWith("thread/")));
  assert.ok(!requests.some((method) => method.startsWith("turn/")));
  assert.ok(!requests.includes("mcpServer/tool/call"));

  const writes = [];
  const returned = await runCompatibilityReporter({
    collect: async () => report,
    output: { write: (text) => writes.push(text) },
  });
  assert.equal(returned, report);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], `${canonicalJson(report)}\n`);
  assert.doesNotMatch(writes[0], /thread-secret|private@example\.com/);
});
