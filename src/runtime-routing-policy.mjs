import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexlessPaths } from "./linux-identity.mjs";

export const CODEXLESS_RUNTIME_ENV = "CODEXLESS_CODEX_RUNTIME";
export const RECOMMENDED_RUNTIME_MODE = "recommended";
export const EXISTING_ONLY_RUNTIME_MODE = "existing";
export const INTERNAL_MANAGED_RUNTIME_MODE = "managed";
export const PENDING_MANAGED_ACTIVATION = "existing_only_pending_managed";
export const DUAL_READY_ACTIVATION = "dual_ready";
export const RUNTIME_ROUTING_STATE_SCHEMA = 1;
export const RUNTIME_ROUTING_STATE_FILENAME = "runtime-routing-state.json";
export const RUNTIME_INSTALL_PREFERENCE_FILENAME = "runtime-install-preference.json";
export const INSTALLABLE_RUNTIME_MODES = Object.freeze([RECOMMENDED_RUNTIME_MODE, EXISTING_ONLY_RUNTIME_MODE]);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, "..");

export function defaultCodexlessStateRoot(env = process.env) {
  return codexlessPaths({ env }).state;
}

export function codexRuntimeSelection(env = process.env) {
  const raw = typeof env?.[CODEXLESS_RUNTIME_ENV] === "string" ? env[CODEXLESS_RUNTIME_ENV].trim().toLowerCase() : "";
  const mode = raw || RECOMMENDED_RUNTIME_MODE;
  if (![RECOMMENDED_RUNTIME_MODE, EXISTING_ONLY_RUNTIME_MODE, INTERNAL_MANAGED_RUNTIME_MODE].includes(mode)) {
    const error = new Error(`${CODEXLESS_RUNTIME_ENV} must be recommended, existing, or managed`);
    error.code = "CODEX_RUNTIME_SELECTION_INVALID";
    throw error;
  }
  return mode;
}

export async function readRuntimeRoutingPolicy({ root = projectRoot } = {}) {
  const policyPath = path.join(path.resolve(root), "config", "runtime-routing-policy.json");
  return validateRuntimeRoutingPolicy(JSON.parse(await readFile(policyPath, "utf8")));
}

export async function readInstalledRuntimeMode({ root = projectRoot } = {}) {
  const target = path.join(path.resolve(root), "config", "runtime-install-mode.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return RECOMMENDED_RUNTIME_MODE;
    throw error;
  }
  if (parsed?.schemaVersion !== 1 || !INSTALLABLE_RUNTIME_MODES.includes(parsed?.mode)) {
    throw new Error("config/runtime-install-mode.json must declare schemaVersion 1 and mode recommended or existing");
  }
  return parsed.mode;
}

export async function writeRuntimeInstallMode({ root = projectRoot, mode } = {}) {
  if (!INSTALLABLE_RUNTIME_MODES.includes(mode)) {
    throw new Error("installer runtime mode must be recommended or existing; Managed-only is not an installer option");
  }
  const target = path.join(path.resolve(root), "config", "runtime-install-mode.json");
  await writeFile(target, `${JSON.stringify({ schemaVersion: 1, mode }, null, 2)}\n`, "utf8");
  return { ok: true, mode, path: target };
}

export async function readRuntimeInstallPreference({ stateRoot = defaultCodexlessStateRoot() } = {}) {
  const target = path.join(path.resolve(stateRoot), RUNTIME_INSTALL_PREFERENCE_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { mode: null, path: target, persisted: false, updatedAt: null };
    throw error;
  }
  if (parsed?.schemaVersion !== 1 || !INSTALLABLE_RUNTIME_MODES.includes(parsed?.mode) || !Number.isFinite(Date.parse(parsed?.updatedAt))) {
    throw new Error("runtime install preference must declare schemaVersion 1, mode recommended|existing, and updatedAt");
  }
  return { mode: parsed.mode, path: target, persisted: true, updatedAt: parsed.updatedAt };
}

export async function writeRuntimeInstallPreference({
  stateRoot = defaultCodexlessStateRoot(),
  mode,
  now = Date.now(),
} = {}) {
  if (!INSTALLABLE_RUNTIME_MODES.includes(mode)) {
    throw new Error("runtime install preference must be recommended or existing; Managed-only is not an installer option");
  }
  const value = {
    schemaVersion: 1,
    mode,
    updatedAt: new Date(Number(now)).toISOString(),
  };
  const target = await atomicWriteJson(path.resolve(stateRoot), RUNTIME_INSTALL_PREFERENCE_FILENAME, value);
  return { ok: true, mode, path: target, updatedAt: value.updatedAt };
}

export async function clearRuntimeInstallPreference({ stateRoot = defaultCodexlessStateRoot() } = {}) {
  const target = path.join(path.resolve(stateRoot), RUNTIME_INSTALL_PREFERENCE_FILENAME);
  await rm(target, { force: true });
  return { ok: true, removed: true, path: target };
}

export async function readRuntimeRoutingState({ stateRoot = defaultCodexlessStateRoot() } = {}) {
  const target = path.join(path.resolve(stateRoot), RUNTIME_ROUTING_STATE_FILENAME);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        schemaVersion: RUNTIME_ROUTING_STATE_SCHEMA,
        activation: PENDING_MANAGED_ACTIVATION,
        managedReady: false,
        reason: "managed_readiness_not_recorded",
        managedRuntime: null,
        readiness: null,
        updatedAt: null,
        statePath: target,
        persisted: false,
      };
    }
    throw error;
  }
  return { ...validateRuntimeRoutingState(parsed), statePath: target, persisted: true };
}

export async function activateDualRuntimePolicy({
  stateRoot = defaultCodexlessStateRoot(),
  managedRuntime,
  readiness,
  now = Date.now(),
} = {}) {
  if (readiness?.status !== "ready" || readiness?.account?.authMode !== "chatgpt") {
    throw new Error("Managed readiness must PASS with official ChatGPT auth before dual policy can activate");
  }
  const state = validateRuntimeRoutingState({
    schemaVersion: RUNTIME_ROUTING_STATE_SCHEMA,
    activation: DUAL_READY_ACTIVATION,
    managedReady: true,
    reason: "managed_readiness_passed",
    managedRuntime: {
      packageName: requireString(managedRuntime?.packageName, "managed packageName"),
      packageVersion: requireString(managedRuntime?.packageVersion, "managed packageVersion"),
      platformPackageName: requireString(managedRuntime?.platformPackageName, "managed platformPackageName"),
      platformPackageVersion: requireString(managedRuntime?.platformPackageVersion, "managed platformPackageVersion"),
      binarySha256: requireSha256(managedRuntime?.binarySha256, "managed binarySha256"),
    },
    readiness: {
      accountRead: readiness.accountRead === true,
      modelList: readiness.modelList === true,
      configRead: readiness.configRead === true,
      account: { authMode: "chatgpt", planType: readiness.account?.planType ?? null },
    },
    updatedAt: new Date(Number(now)).toISOString(),
  });
  const target = await atomicWriteJson(path.resolve(stateRoot), RUNTIME_ROUTING_STATE_FILENAME, state);
  return { ...state, statePath: target, persisted: true };
}

export async function effectiveRuntimeRouting({
  env = process.env,
  root = projectRoot,
  stateRoot = defaultCodexlessStateRoot(),
} = {}) {
  const policy = await readRuntimeRoutingPolicy({ root });
  const explicit = typeof env?.[CODEXLESS_RUNTIME_ENV] === "string" && env[CODEXLESS_RUNTIME_ENV].trim();
  const preference = explicit ? { mode: null, persisted: false } : await readRuntimeInstallPreference({ stateRoot });
  const mode = explicit
    ? codexRuntimeSelection(env)
    : preference.mode ?? await readInstalledRuntimeMode({ root });
  const preferenceSource = explicit ? "environment-maintenance-override" : preference.mode ? "user-state" : "package-default";
  const state = await readRuntimeRoutingState({ stateRoot });

  if (mode === INTERNAL_MANAGED_RUNTIME_MODE) {
    return {
      mode,
      installMode: "maintenance-managed-only",
      activation: "maintenance_managed_only",
      managedReady: state.managedReady,
      provision: ["managed"],
      routes: { stableModelFree: "managed", browser: "existing", formalAgent: "existing" },
      formalAgentAvailable: false,
      installerOption: false,
      noSilentFallback: true,
      state,
      policyVersion: policy.policyVersion,
      preferenceSource,
    };
  }

  if (mode === EXISTING_ONLY_RUNTIME_MODE) {
    const declared = policy.installerModes.existing;
    return {
      mode,
      installMode: EXISTING_ONLY_RUNTIME_MODE,
      activation: "existing_only_explicit",
      managedReady: state.managedReady,
      provision: [...declared.provision],
      routes: { ...declared.routes },
      formalAgentAvailable: true,
      installerOption: true,
      noSilentFallback: policy.noSilentFallback,
      state,
      policyVersion: policy.policyVersion,
      preferenceSource,
    };
  }

  const declared = policy.installerModes.recommended;
  const dualReady = state.activation === DUAL_READY_ACTIVATION && state.managedReady === true;
  return {
    mode,
    installMode: RECOMMENDED_RUNTIME_MODE,
    activation: dualReady ? DUAL_READY_ACTIVATION : PENDING_MANAGED_ACTIVATION,
    managedReady: dualReady,
    provision: [...declared.provision],
    routes: dualReady
      ? { ...declared.routes }
      : { stableModelFree: policy.activation.pendingRoutesStableModelFreeTo, browser: "existing", formalAgent: "existing" },
    formalAgentAvailable: true,
    installerOption: true,
    noSilentFallback: policy.noSilentFallback,
    state,
    policyVersion: policy.policyVersion,
    preferenceSource,
  };
}

export function validateRuntimeRoutingPolicy(policy) {
  if (!policy || typeof policy !== "object" || policy.schemaVersion !== 1) throw new Error("runtime routing policy schemaVersion must be 1");
  if (policy.defaultInstallMode !== RECOMMENDED_RUNTIME_MODE) throw new Error("runtime routing policy defaultInstallMode must be recommended");
  if (policy.defaultActivationState !== PENDING_MANAGED_ACTIVATION) throw new Error("runtime routing policy default activation must be readiness-gated Existing");
  if (policy.dualReadyActivationState !== DUAL_READY_ACTIVATION) throw new Error("runtime routing policy dual ready activation state is invalid");
  if (policy.managedOnlyInstallerOption !== false || policy.noSilentFallback !== true) throw new Error("runtime routing policy must forbid Managed-only installer UX and silent fallback");
  if (policy.activation?.provisioningDoesNotActivateDualPolicy !== true || policy.activation?.laterManagedFailureFallback !== "forbidden") {
    throw new Error("runtime routing policy activation contract is invalid");
  }
  const methodRoutes = policy.dualReadyMethodRoutes;
  if (!methodRoutes || !Array.isArray(methodRoutes.managed) || !Array.isArray(methodRoutes.existing) || !Array.isArray(methodRoutes.localUserState)) {
    throw new Error("runtime routing policy must declare explicit dualReadyMethodRoutes");
  }
  for (const required of ["codex.command_exec", "codex.read_many", "codex.precise_edit"]) {
    if (!methodRoutes.managed.includes(required)) throw new Error(`runtime routing policy must route ${required} to Managed when dual-ready`);
  }
  for (const required of ["codex.skill_read", "codex.model_list", "codex.browser_*", "codex.agent_*"]) {
    if (!methodRoutes.existing.includes(required)) throw new Error(`runtime routing policy must route ${required} to Existing when dual-ready`);
  }
  if (!methodRoutes.localUserState.includes("codex.call_profile")) throw new Error("Codex Call Profile must remain local user state");
  const recommended = policy.installerModes?.recommended;
  const existing = policy.installerModes?.existing;
  if (!recommended || !existing) throw new Error("runtime routing policy must define recommended and existing installer modes");
  if (JSON.stringify(recommended.provision) !== JSON.stringify(["existing", "managed"])) throw new Error("recommended mode must provision Existing + Managed");
  if (recommended.routes?.stableModelFree !== "managed" || recommended.routes?.browser !== "existing" || recommended.routes?.formalAgent !== "existing") {
    throw new Error("recommended dual-ready routing must be Managed model-free + Existing Browser/Call Codex");
  }
  if (existing.routes?.stableModelFree !== "existing" || existing.routes?.browser !== "existing" || existing.routes?.formalAgent !== "existing") {
    throw new Error("existing-only routing must stay Existing for every lane");
  }
  return policy;
}

export function validateRuntimeRoutingState(state) {
  if (!state || typeof state !== "object" || state.schemaVersion !== RUNTIME_ROUTING_STATE_SCHEMA) throw new Error("runtime routing state schemaVersion must be 1");
  if (![PENDING_MANAGED_ACTIVATION, DUAL_READY_ACTIVATION].includes(state.activation)) throw new Error("runtime routing state activation is invalid");
  if (typeof state.managedReady !== "boolean") throw new Error("runtime routing state managedReady must be boolean");
  if ((state.activation === DUAL_READY_ACTIVATION) !== state.managedReady) throw new Error("dual_ready and managedReady must agree");
  if (state.activation === DUAL_READY_ACTIVATION) {
    requireString(state.reason, "runtime routing state reason");
    requireString(state.managedRuntime?.packageName, "managedRuntime.packageName");
    requireString(state.managedRuntime?.packageVersion, "managedRuntime.packageVersion");
    requireString(state.managedRuntime?.platformPackageName, "managedRuntime.platformPackageName");
    requireString(state.managedRuntime?.platformPackageVersion, "managedRuntime.platformPackageVersion");
    requireSha256(state.managedRuntime?.binarySha256, "managedRuntime.binarySha256");
    if (state.readiness?.accountRead !== true || state.readiness?.modelList !== true || state.readiness?.configRead !== true || state.readiness?.account?.authMode !== "chatgpt") {
      throw new Error("dual_ready runtime routing state requires complete Managed readiness evidence");
    }
    if (!Number.isFinite(Date.parse(state.updatedAt))) throw new Error("dual_ready runtime routing state updatedAt must be an ISO timestamp");
  }
  return structuredClone(state);
}

async function atomicWriteJson(stateRoot, filename, value) {
  await mkdir(stateRoot, { recursive: true });
  const target = path.join(stateRoot, filename);
  const temp = path.join(stateRoot, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return target;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requireSha256(value, label) {
  const normalized = requireString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return normalized;
}
