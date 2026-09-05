import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { CodexBrowserExecutor } from "../src/codex-browser-executor.mjs";
import { resolveBrowserRuntimeCompatibility } from "../src/browser-runtime-compat.mjs";
import { CodexPublicBrowserWorkbenchAdapter } from "../src/public-browser-workbench-adapter.mjs";
import { CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { probeCodexExecutable, redactHomePath, resolveCodexExecutable } from "../src/codex-bin.mjs";
import { resolveManagedRuntime } from "../src/codex-runtime-provider.mjs";
import { probeManagedRuntimeReadiness } from "../src/managed-runtime-readiness.mjs";
import { buildDoctorHealth, legacyNodeReplView, normalizeBrowserReaderHealth } from "../src/doctor-health.mjs";
import { readJsonFile } from "../src/json-file.mjs";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";
import { createRecentCallDiagnostics, recentCallOptionsFromEnv } from "../src/recent-call-diagnostics.mjs";
import { STOCK_RUNTIME_KIND } from "../src/stock-prompt-input-skill-routing.mjs";
import { effectiveRuntimeRouting } from "../src/runtime-routing-policy.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const packageJson = await readJsonFile(path.join(projectRoot, "package.json"), "package.json");
const args = parseArgs(process.argv.slice(2));
const requestedCwd = args.cwd ? path.resolve(args.cwd) : null;
const runtimeCwd = requestedCwd ?? projectRoot;
const checks = [];
const warnings = [];
const notes = [];
let codexResolution = null;
let codexProbe = null;
let appServer = null;
let projectContext = null;
let browser = normalizeBrowserReaderHealth({ status: "unavailable", reason: "not_checked" });
let nodeRepl = { status: "not_checked", reason: "conditional_feature" };
const recentCallDiagnostics = createRecentCallDiagnostics(recentCallOptionsFromEnv(process.env, { readOnly: true }));

const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
record(
  "platform",
  supportedPlatform,
  process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "Apple Silicon macOS"
      : `Unsupported platform: ${process.platform}/${process.arch}`
);
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
record("node", Number.isInteger(nodeMajor) && nodeMajor >= 22, `Node ${process.version}`, nodeMajor >= 22 ? null : "Node.js 22+ is required");
record("public-surface", PUBLIC_TOOL_NAMES.length === 44, `${PUBLIC_SURFACE_VERSION}; ${PUBLIC_TOOL_NAMES.length} tools`);

for (const spec of ["@modelcontextprotocol/node", "@modelcontextprotocol/server", "zod"]) {
  try {
    const resolved = require.resolve(spec);
    const local = isWithin(projectRoot, resolved) && resolved.toLowerCase().includes(`${path.sep}node_modules${path.sep}`.toLowerCase());
    record(`dependency:${spec}`, local, local ? "resolved from Codexless node_modules" : "resolved outside Codexless", local ? null : "Run npm ci in the Codexless install directory");
  } catch (error) {
    record(`dependency:${spec}`, false, "not resolvable", error instanceof Error ? error.message : String(error));
  }
}

let runtimeRouting = null;
let managedReadiness = { status: "unavailable", reason: "runtime_routing_not_checked" };
const managedLoginCommand = `node "${path.join(projectRoot, "scripts", "managed-codex-login.mjs")}"`;
try {
  runtimeRouting = await effectiveRuntimeRouting({ root: projectRoot });
  record(
    "runtime-routing-policy",
    runtimeRouting.noSilentFallback === true,
    `${runtimeRouting.installMode}/${runtimeRouting.activation}; modelFree=${runtimeRouting.routes.stableModelFree}; browser=${runtimeRouting.routes.browser}; callCodex=${runtimeRouting.routes.formalAgent}`,
    runtimeRouting.noSilentFallback === true ? null : "Repair/reinstall Codexless; runtime routing must never use silent fallback."
  );
  if (runtimeRouting.installMode === "recommended" && runtimeRouting.activation === "existing_only_pending_managed") {
    managedReadiness = { status: "pending", reason: "official_chatgpt_login_required", nextActionCommand: managedLoginCommand };
    record(
      "managed-runtime-readiness",
      false,
      "Managed dual activation is pending official ChatGPT login.",
      `Run: ${managedLoginCommand}`,
      false
    );
  } else if (runtimeRouting.activation === "dual_ready") {
    try {
      const managedRuntime = await resolveManagedRuntime();
      const managedProbe = await probeManagedRuntimeReadiness({ runtime: managedRuntime, cwd: runtimeCwd });
      const managedOk = managedProbe.status === "ready";
      managedReadiness = managedOk ? managedProbe : { ...managedProbe, status: "degraded", probeStatus: managedProbe.status };
      record(
        "managed-runtime-readiness",
        managedOk,
        managedOk ? `Managed ${managedRuntime.packageVersion}/${managedRuntime.platformPackageVersion} readiness PASS` : `Managed dual lane is degraded: ${managedReadiness.reason ?? "readiness unavailable"}`,
        managedOk ? null : "Dual policy remains active; run the Codexless managed-login/readiness helper or repair/reinstall Codexless. Do not fall back to Existing for Managed-routed calls."
      );
    } catch (error) {
      managedReadiness = { status: "degraded", reason: "managed_runtime_probe_failed", error: sanitizeText(error instanceof Error ? error.message : String(error)) };
      record(
        "managed-runtime-readiness",
        false,
        "Managed dual lane could not be verified",
        "Dual policy remains active; run the Codexless managed-login/readiness helper or repair/reinstall Codexless. Do not fall back to Existing for Managed-routed calls."
      );
    }
  } else {
    managedReadiness = { status: "not_applicable", reason: "advanced_existing_only" };
  }
} catch (error) {
  record("runtime-routing-policy", false, "Runtime routing state could not be read", error instanceof Error ? error.message : String(error));
}

try {
  codexResolution = await resolveCodexExecutable();
  codexProbe = await probeCodexExecutable(codexResolution.path, { cwd: runtimeCwd });
  record("codex-executable", codexProbe.ok, codexProbe.versionText ?? "Codex version probe failed", codexProbe.error);
  const parsedVersion = parseCodexVersion(codexProbe.versionText);
  record(
    "codex-version",
    Boolean(parsedVersion),
    parsedVersion ? `Codex CLI ${parsedVersion}` : "Codex CLI version could not be parsed",
    parsedVersion ? null : "Codexless could not parse the detected Codex CLI version."
  );
} catch (error) {
  record("codex-executable", false, "Codex executable resolution failed", error instanceof Error ? error.message : String(error));
}

if (codexResolution?.path && codexProbe?.ok) {
  try {
    const compatibilityAuthority = new CodexAuthorityExecutor({
      codexBin: codexResolution.path,
      defaultCwd: runtimeCwd,
      acceptedCodexVersions: null,
      allowUntrustedReadOnlyBootstrap: !requestedCwd,
    });
    const compatibility = await compatibilityAuthority.validate();
    record("codex-contract-gate", true, `Codex App Server authority contract accepted ${compatibility.codexVersion ?? "current build"}`);
  } catch (error) {
    record("codex-contract-gate", false, "Codex App Server authority contract rejected the current build", error instanceof Error ? error.message : String(error));
  }

  const stderrCapture = [];
  const client = new CodexAppServerClient({
    cwd: runtimeCwd,
    launch: () => ({
      command: codexResolution.path,
      args: ["app-server", "--stdio"],
      options: { cwd: runtimeCwd },
    }),
    requestTimeoutMs: 20_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: (chunk) => captureBounded(stderrCapture, String(chunk)),
    clientInfo: {
      name: "codexless_doctor",
      title: "Codexless Doctor",
      version: packageJson.version,
    },
  });
  try {
    const initialized = await client.start();
    appServer = {
      ok: true,
      serverName: initialized?.serverInfo?.name ?? null,
      serverVersion: initialized?.serverInfo?.version ?? null,
    };
    record("codex-app-server", true, "initialize succeeded");

    if (requestedCwd) {
      try {
        const authority = new CodexAuthorityExecutor({
          codexBin: codexResolution.path,
          defaultCwd: requestedCwd,
          acceptedCodexVersions: null,
        });
        await authority.validate();
        const resolved = await authority.resolveAuthority({ cwd: requestedCwd, access: "readOnly" });
        projectContext = {
          ok: true,
          cwd: redactHomePath(resolved.effectiveCwd),
          permissionProfile: resolved.permissionProfile,
          permissionCeiling: resolved.permissionCeiling,
          authoritySource: resolved.authoritySource,
          trustedAncestor: redactHomePath(resolved.trustedAncestor),
        };
        record("project-authority", true, `Codexless authority resolver accepted ${redactHomePath(requestedCwd)} as ${resolved.permissionProfile}`);
      } catch (error) {
        projectContext = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
        warnings.push({ kind: "project-authority", message: projectContext.error });
      }
    }

    try {
      const sourceContext = new CodexPublicContextExecutor({
        codexBin: codexResolution.path,
        defaultCwd: runtimeCwd,
        clientFactory: () => client,
        runtimeKind: STOCK_RUNTIME_KIND,
      });
      const [currentChromeSkill, configuredMcpServerNames] = await Promise.all([
        sourceContext.currentChromeSkill({ cwd: runtimeCwd }),
        sourceContext.configuredMcpServerNames({ cwd: runtimeCwd }).catch(() => []),
      ]);
      const browserCompatibility = await resolveBrowserRuntimeCompatibility({
        codexBin: codexResolution.path,
        chromeSkillPath: currentChromeSkill?.path ?? null,
      });
      if (browserCompatibility.status !== "ok") {
        browser = normalizeBrowserReaderHealth({ status: "unavailable", reason: browserCompatibility.reason });
      } else {
        const browserIsolationOverrides = [...new Set(configuredMcpServerNames)]
          .filter((name) => name !== "node_repl" && /^[A-Za-z0-9_-]+$/.test(name))
          .map((name) => `mcp_servers.${name}.enabled=false`);
        const browserContext = new CodexPublicContextExecutor({
          codexBin: codexResolution.path,
          defaultCwd: browserCompatibility.browserRuntimeCwd,
          configOverrides: [...browserCompatibility.overrides, ...browserIsolationOverrides],
          runtimeKind: STOCK_RUNTIME_KIND,
        });
        try {
          await browserContext.start();
          const browserExecutor = new CodexBrowserExecutor({
            workbench: new CodexPublicBrowserWorkbenchAdapter({
              context: browserContext,
              runtimeCwd: browserCompatibility.browserRuntimeCwd,
            }),
            defaultCwd: runtimeCwd,
          });
          browser = normalizeBrowserReaderHealth(await browserExecutor.status({ cwd: runtimeCwd }));
        } finally {
          await browserContext.close().catch(() => {});
        }
      }
      nodeRepl = legacyNodeReplView(browser);
      if (browser.status !== "available") {
        warnings.push({ kind: "browser-reader", message: `Browser Reader is not currently available (${browser.reason ?? "unverified connection"}). Core Codexless can still be healthy.` });
      }
    } catch (error) {
      browser = normalizeBrowserReaderHealth({ status: "unavailable", reason: "probe_failed" });
      nodeRepl = legacyNodeReplView(browser);
      warnings.push({ kind: "browser-reader", message: sanitizeText(error instanceof Error ? error.message : String(error)) });
    }
  } catch (error) {
    appServer = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
    record("codex-app-server", false, "initialize failed", appServer.error);
  } finally {
    await client.close().catch(() => {});
    const stderrWarnings = classifyStderr(stderrCapture.join(""));
    warnings.push(...stderrWarnings);
  }
}

notes.push("Browser Reader is conditional; unavailable Browser/Node REPL prerequisites do not make the Codexless core install invalid.");
notes.push("Permission fields have different meanings: permissionCeiling is the locally authorized maximum for an operation, while permissionProfile is the profile actually used. Read-only operations downscope; explicit write operations may inherit the local Codex ceiling. Remote callers cannot select a stronger profile.");
notes.push("codex.project_context reports a fresh Codex bootstrap projection for its cwd; per-operation authority is resolved separately. Doctor --cwd uses the same Codexless authority resolver as project execution rather than treating the bootstrap projection as a global permission result.");
notes.push("Tunnel connectivity is intentionally not changed or provisioned by doctor. Verify the release-candidate tunnel separately after local install/doctor passes.");
notes.push(`Recommended provisioning does not activate dual routing. Before first Managed readiness PASS, official Managed ChatGPT login is required. Run: ${managedLoginCommand}`);
notes.push("After dual_ready, a Managed readiness failure is degraded/fail-visible and never downgrades or silently falls back to Existing.");
notes.push("Doctor does not start a Codex model turn.");
notes.push("Recent-call diagnostics are bounded evidence: no matching receipt means only that no server-arrival record was found in the retained local window; it does not prove the Host did not send the call.");

const finalWarnings = dedupeWarnings(warnings);
const projectResult = requestedCwd ? projectContext ?? { ok: false, error: "project context was not checked" } : { status: "not_requested" };
const recentCalls = recentCallDiagnostics.query({ limit: 10 });
const health = buildDoctorHealth({
  checks,
  browserReader: browser,
  projectRequested: Boolean(requestedCwd),
  project: projectResult,
  optionalWarnings: finalWarnings.filter((warning) => warning.kind === "configured-mcp"),
});
const status = health.core.status;
const result = {
  status,
  health,
  codexless: {
    packageVersion: packageJson.version,
    serverVersion: PUBLIC_SERVER_VERSION,
    surfaceVersion: PUBLIC_SURFACE_VERSION,
    publicToolCount: PUBLIC_TOOL_NAMES.length,
    installRoot: redactHomePath(projectRoot),
  },
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  codex: {
    resolutionSource: codexResolution?.source ?? null,
    executable: codexResolution?.path ? redactHomePath(codexResolution.path) : null,
    version: codexProbe?.versionText ?? null,
    appServer,
  },
  project: projectResult,
  runtimeRouting: runtimeRouting ? {
    installMode: runtimeRouting.installMode,
    activation: runtimeRouting.activation,
    managedReady: runtimeRouting.managedReady,
    preferenceSource: runtimeRouting.preferenceSource,
    routes: runtimeRouting.routes,
    noSilentFallback: runtimeRouting.noSilentFallback,
    managedReadiness,
  } : { status: "unavailable", managedReadiness },
  capabilities: {
    browserReader: browser,
    nodeRepl,
    tunnel: { status: "not_checked", reason: "separate_release_boundary" },
  },
  diagnostics: {
    recentCalls,
  },
  checks,
  warnings: finalWarnings,
  notes,
};

if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else printHuman(result);
process.exitCode = status === "error" ? 1 : 0;

function parseArgs(argv) {
  const parsed = { json: false, cwd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (!value) throw new Error("--cwd requires a path");
      parsed.cwd = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/doctor.mjs [--json] [--cwd <project-directory>]\n");
      process.exit(0);
    } else throw new Error(`Unknown doctor argument: ${arg}`);
  }
  return parsed;
}

function record(name, ok, detail, action = null, required = true) {
  checks.push({ name, ok: Boolean(ok), required: Boolean(required), detail: sanitizeText(detail), ...(action ? { action: sanitizeText(action) } : {}) });
}

function parseCodexVersion(text) {
  const match = String(text ?? "").match(/codex-cli\s+([^\s]+)/i);
  return match?.[1] ?? null;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function captureBounded(chunks, chunk) {
  chunks.push(chunk);
  let total = chunks.reduce((sum, value) => sum + value.length, 0);
  while (total > 32_768 && chunks.length > 1) total -= chunks.shift().length;
}

function classifyStderr(stderr) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const line = sanitizeText(raw)
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "")
      .slice(0, 1000);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push({ kind: /mcp|transport|http\/request failed/i.test(line) ? "configured-mcp" : "codex-app-server-stderr", message: line });
    if (out.length >= 20) break;
  }
  return out;
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/([?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer <redacted>");
}

function dedupeWarnings(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.kind}:${row.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function printHuman(result) {
  const mark = (check) => check.ok ? "PASS" : check.required ? "FAIL" : "PENDING";
  process.stdout.write(`Codexless doctor: ${result.status.toUpperCase()}\n`);
  process.stdout.write(`Version ${result.codexless.packageVersion} | ${result.codexless.surfaceVersion} | ${result.codexless.publicToolCount} public tools\n`);
  if (result.runtimeRouting?.activation) process.stdout.write(`Runtime ${result.runtimeRouting.installMode}/${result.runtimeRouting.activation} | modelFree=${result.runtimeRouting.routes?.stableModelFree ?? "unknown"} | Browser/Call Codex=${result.runtimeRouting.routes?.browser ?? "unknown"}/${result.runtimeRouting.routes?.formalAgent ?? "unknown"}\n`);
  process.stdout.write("\n");
  for (const check of result.checks) {
    process.stdout.write(`[${mark(check)}] ${check.name}: ${check.detail}\n`);
    if (!check.ok && check.action) process.stdout.write(`       -> ${check.action}\n`);
  }
  process.stdout.write(`\nCore health: ${result.health.core.status}\n`);
  process.stdout.write(`Capability health: ${result.health.capabilities.status}\n`);
  process.stdout.write(`Optional dependency health: ${result.health.optionalDependencies.status}\n`);
  process.stdout.write(`Browser Reader: ${result.capabilities.browserReader.status} (connection=${result.capabilities.browserReader.connection.status})\n`);
  process.stdout.write(`Tunnel: ${result.capabilities.tunnel.status} (verified separately)\n`);
  if (result.project.status !== "not_requested") {
    process.stdout.write(`Project authority: ${result.project.ok ? "ok" : "needs attention"}\n`);
    if (result.project.ok) {
      process.stdout.write(`  actual profile: ${result.project.permissionProfile}\n`);
      process.stdout.write(`  local ceiling: ${result.project.permissionCeiling}\n`);
      process.stdout.write(`  authority source: ${result.project.authoritySource}\n`);
    }
  }
  const recent = result.diagnostics.recentCalls;
  process.stdout.write(`Recent calls: ${recent.count} retained match(es); persistence=${recent.persistence.status}\n`);
  if (!recent.count && recent.no_match_meaning) process.stdout.write(`  ${recent.no_match_meaning}\n`);
  if (result.warnings.length) {
    process.stdout.write("\nWarnings:\n");
    for (const warning of result.warnings) process.stdout.write(`- ${warning.kind}: ${warning.message}\n`);
  }
  process.stdout.write("\nNo Codex model turn was started.\n");
}
