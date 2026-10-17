import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeCodexExecutable, resolveCodexExecutable } from "./codex-bin.mjs";
import {
  codexRuntimeSelection as selectRuntimeMode,
  defaultCodexlessStateRoot,
  effectiveRuntimeRouting,
  INTERNAL_MANAGED_RUNTIME_MODE,
} from "./runtime-routing-policy.mjs";

const require = createRequire(import.meta.url);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANAGED_HOME_ENV = "CODEXLESS_MANAGED_CODEX_HOME";
const API_KEY_ENV_NAMES = new Set(["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY"]);

const PLATFORM_PACKAGE = new Map([
  ["win32:x64", {
    packageName: "@openai/codex-win32-x64",
    triple: "x86_64-pc-windows-msvc",
    executable: "codex.exe",
    versionSuffix: "win32-x64",
  }],
  ["darwin:arm64", {
    packageName: "@openai/codex-darwin-arm64",
    triple: "aarch64-apple-darwin",
    executable: "codex",
    versionSuffix: "darwin-arm64",
  }],
]);

export class CodexRuntimeProviderError extends Error {
  constructor(message, { code = "CODEX_RUNTIME_PROVIDER_ERROR", details = null } = {}) {
    super(message);
    this.name = "CodexRuntimeProviderError";
    this.code = code;
    this.details = details;
  }
}

export function codexRuntimeSelection(env = process.env) {
  try {
    return selectRuntimeMode(env);
  } catch (error) {
    throw new CodexRuntimeProviderError(error instanceof Error ? error.message : String(error), {
      code: error?.code ?? "CODEX_RUNTIME_SELECTION_INVALID",
    });
  }
}

export function managedPlatformPackageSpec({ platform = process.platform, arch = process.arch } = {}) {
  const spec = PLATFORM_PACKAGE.get(`${platform}:${arch}`);
  return spec ? { ...spec } : null;
}

export function defaultManagedCodexHome({ env = process.env, stateRoot = defaultCodexlessStateRoot() } = {}) {
  const explicit = typeof env?.[MANAGED_HOME_ENV] === "string" ? env[MANAGED_HOME_ENV].trim() : "";
  return explicit ? path.resolve(explicit) : path.join(path.resolve(stateRoot), "managed-codex-home");
}

export function managedLoginJourney({ managedCodexHome } = {}) {
  return {
    status: "login_required",
    authType: "chatgpt",
    managedCodexHome: managedCodexHome ? path.resolve(managedCodexHome) : null,
    instructions: [
      "Run the Codexless managed-login helper for this isolated Managed CODEX_HOME.",
      "Complete the official ChatGPT sign-in flow opened by the official Codex runtime.",
      "Codexless activates dual policy only after the helper's model-free readiness checks pass.",
    ],
    secretHandling: "Codexless does not read, copy, link, print, or export credential/token contents.",
  };
}

export async function createCodexRuntimeProvider({
  env = process.env,
  stateRoot = defaultCodexlessStateRoot(env),
} = {}) {
  let routing;
  try {
    routing = await effectiveRuntimeRouting({ env, root: sourceRoot, stateRoot });
  } catch (error) {
    if (error?.code === "CODEX_RUNTIME_SELECTION_INVALID") {
      throw new CodexRuntimeProviderError(error.message, { code: error.code });
    }
    throw error;
  }

  let existingPromise = null;
  const resolveExisting = async () => {
    if (!existingPromise) {
      existingPromise = resolveCodexExecutable({ env }).catch((error) => {
        throw new CodexRuntimeProviderError(
          `Existing Codex lane is required for ${routing.routes.browser === "existing" ? "Browser" : "this operation"} and Call Codex, but no usable Existing Codex runtime was found. Repair/install the official Existing Codex runtime, then retry; Codexless will not switch lanes silently. (${error instanceof Error ? error.message : String(error)})`,
          { code: "EXISTING_CODEX_REQUIRED", details: { route: routing.routes, noSilentFallback: true } }
        );
      });
    }
    return existingPromise;
  };

  let managedPromise = null;
  const resolveManaged = async () => {
    if (!managedPromise) {
      managedPromise = resolveManagedRuntime({ env, stateRoot }).catch((error) => {
        if (error instanceof CodexRuntimeProviderError) {
          error.details = {
            ...(error.details ?? {}),
            nextAction: "Run the Codexless managed-login/readiness helper or repair/reinstall Codexless. Dual-ready routing never falls back to Existing for a Managed-routed call.",
            noSilentFallback: true,
          };
        }
        throw error;
      });
    }
    return managedPromise;
  };

  const modelFree = routing.routes.stableModelFree === "managed"
    ? await resolveManaged()
    : await resolveExisting().then((existing) => existingRuntime(existing));

  return {
    selection: routing.mode,
    installMode: routing.installMode,
    activation: routing.activation,
    managedReady: routing.managedReady,
    runtimeRouting: routing,
    modelFree,
    resolveExisting,
    resolveManaged,
    browserLane: routing.routes.browser,
    formalAgentLane: routing.routes.formalAgent,
    formalAgentAvailable: routing.formalAgentAvailable,
    managedModelInvocation: routing.mode === INTERNAL_MANAGED_RUNTIME_MODE ? "blocked" : "existing-lane",
    noSilentFallback: routing.noSilentFallback,
  };
}

export async function resolveManagedRuntime({
  env = process.env,
  stateRoot = defaultCodexlessStateRoot(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const pin = await readManagedPackagePin();
  const platformSpec = managedPlatformPackageSpec({ platform, arch });
  if (!platformSpec) {
    throw new CodexRuntimeProviderError(`managed Codex runtime does not support ${platform}/${arch} for this release`, {
      code: "MANAGED_CODEX_PLATFORM_UNSUPPORTED",
    });
  }

  let codexPackageJson;
  let platformPackageJson;
  try {
    codexPackageJson = require.resolve("@openai/codex/package.json");
    platformPackageJson = require.resolve(`${platformSpec.packageName}/package.json`);
  } catch {
    throw new CodexRuntimeProviderError(
      `managed Codex runtime packages are incomplete; expected @openai/codex ${pin.version} and ${platformSpec.packageName}. Repair/reinstall Codexless.`,
      { code: "MANAGED_CODEX_PACKAGE_MISSING", details: { packageName: platformSpec.packageName } }
    );
  }

  const packageInfo = JSON.parse(await readFile(codexPackageJson, "utf8"));
  if (packageInfo.version !== pin.version) {
    throw new CodexRuntimeProviderError(
      `managed Codex package version ${String(packageInfo.version ?? "unknown")} does not match pinned ${pin.version}`,
      { code: "MANAGED_CODEX_PACKAGE_VERSION_MISMATCH" }
    );
  }

  const platformRoot = path.dirname(platformPackageJson);
  const bin = path.join(platformRoot, "vendor", platformSpec.triple, "bin", platformSpec.executable);
  try {
    await access(bin);
  } catch {
    throw new CodexRuntimeProviderError(`managed Codex native binary is missing from ${platformSpec.packageName}`, {
      code: "MANAGED_CODEX_BINARY_MISSING",
      details: { packageName: platformSpec.packageName },
    });
  }

  const platformPackageInfo = JSON.parse(await readFile(platformPackageJson, "utf8"));
  const expectedPlatformVersion = `${pin.version}-${platformSpec.versionSuffix}`;
  if (platformPackageInfo.version !== expectedPlatformVersion) {
    throw new CodexRuntimeProviderError(
      `managed Codex native package version ${String(platformPackageInfo.version ?? "unknown")} does not match exact ${expectedPlatformVersion}`,
      { code: "MANAGED_CODEX_PACKAGE_VERSION_MISMATCH" }
    );
  }

  const probe = await probeCodexExecutable(bin);
  if (!probe.ok || probe.version !== pin.version) {
    throw new CodexRuntimeProviderError(
      `managed Codex binary version ${probe.version ?? probe.versionText ?? "unknown"} does not match pinned package ${pin.version}`,
      { code: "MANAGED_CODEX_BINARY_VERSION_MISMATCH" }
    );
  }

  const managedCodexHome = defaultManagedCodexHome({ env, stateRoot });
  await mkdir(managedCodexHome, { recursive: true });
  const launchEnv = managedLaunchEnv(env, managedCodexHome);
  const binarySha256 = createHash("sha256").update(await readFile(bin)).digest("hex");
  return {
    lane: "managed",
    bin,
    launchEnv,
    codexHome: managedCodexHome,
    version: probe.version,
    source: "repo-pinned-official-package",
    packageName: "@openai/codex",
    packageVersion: pin.version,
    packageRoot: path.dirname(codexPackageJson),
    platformPackageName: platformSpec.packageName,
    platformPackageVersion: platformPackageInfo.version,
    platformPackageRoot: platformRoot,
    binarySha256,
    existingResolverUsed: false,
    loginJourney: managedLoginJourney({ managedCodexHome }),
  };
}

export function managedLaunchEnv(baseEnv, managedCodexHome) {
  const next = { ...(baseEnv ?? process.env), CODEX_HOME: path.resolve(managedCodexHome) };
  delete next.CODEX_BIN;
  delete next.CODEX_CLI_PATH;
  for (const key of Object.keys(next)) {
    if (API_KEY_ENV_NAMES.has(key.toUpperCase())) delete next[key];
  }
  return next;
}

function existingRuntime(existing) {
  return {
    lane: "existing",
    bin: existing.path,
    launchEnv: null,
    codexHome: null,
    version: existing.version,
    source: existing.source,
  };
}

async function readManagedPackagePin() {
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const value = packageJson?.dependencies?.["@openai/codex"];
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new CodexRuntimeProviderError("package.json must pin @openai/codex to one exact version for the managed runtime lane", {
      code: "MANAGED_CODEX_PACKAGE_NOT_PINNED",
      details: { value: value ?? null },
    });
  }
  return { version: value };
}
