import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_CALL_PROFILE_SCHEMA_VERSION = 2;
export const CODEX_CALL_PROFILE_DOCUMENT_TYPE = "codex-call-profile";
const LEGACY_CODEX_CALL_PROFILE_SCHEMA_VERSION = 1;
const V2_FRONTMATTER_KEYS = new Set(["schemaVersion", "profileRevision", "documentType", "requireCallApproval"]);
const V1_FRONTMATTER_KEYS = new Set([
  "schemaVersion", "profileRevision", "documentType", "invocationPolicy", "customInvocationRule",
  "requireCallApproval", "inTurnApproval", "model", "reasoningEffort",
]);

export const DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION = `# Codex Call Profile

## Apply this Profile at each decision point
Treat this Profile as the user's recurring Codex working instructions, not as a one-time setup result. Re-read and apply it whenever deciding whether to call Codex, how to route model/reasoning, how to handle a pending Codex action, or how to continue a running Codex task. These are defaults, not immutable product rules. For soft working habits such as in-turn/action approval, an explicit current-task instruction from the user takes priority over this long-term Profile; otherwise apply the valid Profile, and use the recommended default only when the Profile is missing. No one-off instruction can bypass the hard Call Codex gate: only an explicit valid requireCallApproval=false can do that. If a rule is materially ambiguous for the current situation, do not silently broaden it; ask the user when needed.

## When to call Codex
For every new task, decide again whether Codex should be called. By default, use Codex only when the current task genuinely needs Codex execution or the user explicitly asks for Codex. Do not call Codex merely because it is available. The user may replace this with a stricter, broader, or otherwise more specific calling rule.

## Keep Codex work reasonably bounded
Prefer giving Codex reasonably short, clearly bounded work units with a concrete goal and an independently checkable stopping point. Split a large multi-stage task when that can be done without losing necessary context, but do not mechanically fragment work into meaningless tiny calls. This is a reliability rule: Codex may require approvals while running, and the longer one Codex task remains in flight, the greater the chance that the calling Chat session disconnects before an approval or result is handled. Keep the unattended-risk window practical.

## Model and reasoning
Choose the model and reasoning effort that best fit the current task from the current Codex catalog. The user may define one or more task tiers, exact model/effort pairs, substitution rules, or delegate the choice to you. If this Profile names an exact model or effort, verify that choice still exists before starting Codex and do not silently substitute it unless the Profile explicitly allows substitution.

## Stay responsible for running Codex work
Starting Codex is not the end of the calling AI's responsibility. Keep track of each running Codex work unit and return to check it periodically according to task length, risk, and stage so approvals, errors, missing information, or obvious scope drift do not sit unattended. This does not require watching one session continuously, and multiple Codex sessions may be supervised in parallel when manageable. The important rule is to keep returning often enough that work does not remain stuck or run far off course.

## Use waiting time productively
Do not leave the calling Chat completely idle just because Codex is running. While waiting, do useful non-conflicting work within the same task: prepare the next step, organize context, define acceptance checks, inspect existing evidence, or supervise other active Codex work. This both improves throughput and reduces the chance that the calling Chat becomes inactive before Codex needs attention. Do not expand scope merely to stay busy, and do not freely edit the same files Codex is currently changing.

## Approvals while Codex is running
Handle routine low-risk actions on the user's behalf. Ask the user before high-risk actions, actions outside the current task, requests for additional permissions, or actions whose risk cannot be classified reliably. Treat Codexless's risk reference as default guidance, not as a replacement for the user's own rules. Follow any more specific user-authored approval rules in this Profile, including rules that require approval for an otherwise routine class of action.

## Verify and integrate Codex results
A Codex completion is not automatically the user's finished answer. Check the result against the requested work unit and available evidence, repair or follow up when necessary, and integrate the usable result back into the surrounding task before reporting completion to the user.

## Keep this Profile useful
When the user expresses a durable preference during real work, such as saying that this kind of action should no longer be asked one by one, should always be approved first, or should cause Codex to be called in the future, offer to add that detail to the Profile. Persist the change only after the user confirms; do not silently learn or rewrite long-term rules.
`;

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function safeEffective() {
  return { requireCallApproval: true };
}

export function defaultCodexCallProfilePath(env = process.env) {
  const explicit = typeof env?.CODEXLESS_CALL_PROFILE_FILE === "string"
    ? env.CODEXLESS_CALL_PROFILE_FILE.trim()
    : "";
  return explicit || path.join(os.homedir(), ".config", "codexless", "codex-call-profile.md");
}

function parseScalar(raw) {
  const value = String(raw ?? "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[0-9]+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseFrontmatter(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    return { ok: false, error: "Profile must start with Markdown frontmatter" };
  }
  const end = lines.indexOf("---", 1);
  if (end < 1) return { ok: false, error: "Profile frontmatter is not closed" };

  const fields = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const index = line.indexOf(":");
    if (index < 1) return { ok: false, error: `Invalid Profile frontmatter line: ${line}` };
    const key = line.slice(0, index).trim();
    if (!key) return { ok: false, error: "Empty Profile frontmatter key" };
    if (Object.hasOwn(fields, key)) {
      return { ok: false, error: `Duplicate Profile frontmatter key: ${key}` };
    }
    fields[key] = parseScalar(line.slice(index + 1));
  }
  return { ok: true, fields, body: lines.slice(end + 1).join("\n").trim() };
}

function assertKnownFrontmatter(fields, allowed, versionLabel) {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new Error(`Unsupported ${versionLabel} Profile frontmatter key: ${key}`);
  }
}

function validateLegacyFields(fields) {
  assertKnownFrontmatter(fields, V1_FRONTMATTER_KEYS, "legacy");
  const policy = fields.invocationPolicy === undefined ? "when_required" : String(fields.invocationPolicy).trim();
  if (!new Set(["when_required", "execution_always", "custom"]).has(policy)) {
    throw new Error("Legacy Profile invocationPolicy must be when_required, execution_always, or custom");
  }
  const customRule = typeof fields.customInvocationRule === "string" && fields.customInvocationRule.trim()
    ? fields.customInvocationRule.trim()
    : null;
  if (policy === "custom" && !customRule) throw new Error("Legacy custom Profile requires customInvocationRule");
  if (policy !== "custom" && customRule) throw new Error("Legacy customInvocationRule is valid only for invocationPolicy=custom");
  if (fields.inTurnApproval !== undefined && !new Set(["risk_based", "always_ask"]).has(String(fields.inTurnApproval).trim())) {
    throw new Error("Legacy Profile inTurnApproval must be risk_based or always_ask");
  }
  for (const [key, label] of [["model", "model"], ["reasoningEffort", "reasoningEffort"]]) {
    if (typeof fields[key] !== "string" || !fields[key].trim()) throw new Error(`Legacy Profile ${label} must be a non-empty string`);
  }
}

function legacyInstruction(fields, body) {
  const invocationPolicy = typeof fields.invocationPolicy === "string" ? fields.invocationPolicy.trim() : "when_required";
  const customRule = typeof fields.customInvocationRule === "string" && fields.customInvocationRule.trim()
    ? fields.customInvocationRule.trim()
    : null;
  let whenRule;
  if (invocationPolicy === "custom" && customRule) {
    whenRule = customRule;
  } else if (invocationPolicy === "execution_always") {
    whenRule = "Use Codex for formal execution work and for genuine capability boundaries; still judge the current task rather than calling Codex merely because it exists.";
  } else {
    whenRule = "Use Codex only when the user explicitly asks for it or when the available non-Codex route cannot reliably complete the current task.";
  }

  const model = typeof fields.model === "string" && fields.model.trim() ? fields.model.trim() : "native";
  const effort = typeof fields.reasoningEffort === "string" && fields.reasoningEffort.trim() ? fields.reasoningEffort.trim() : "native";
  const selectionRule = model === "native" && effort === "native"
    ? "Use Codex's current default model and reasoning effort unless the user asks otherwise."
    : `Prefer model ${model === "native" ? "the current Codex default" : JSON.stringify(model)} with reasoning effort ${effort === "native" ? "the current Codex default" : JSON.stringify(effort)}, unless the user explicitly overrides it for the current task.`;

  const approvalRule = fields.inTurnApproval === "risk_based"
    ? "Handle routine low-risk actions on the user's behalf. Ask before high-risk, out-of-task-scope, extra-permission, or unclassifiable actions."
    : "Ask the user for each Codex in-turn approval request.";

  return [
    "# Codex Call Profile",
    "",
    "## Apply this Profile at each decision point",
    "Treat this Profile as the user's recurring Codex working instructions. Re-read and apply it at each relevant decision point. Legacy user-authored rules below take precedence over defaults in areas they specifically cover; if a rule is materially ambiguous, do not silently broaden it.",
    "",
    "## When to call Codex",
    whenRule,
    "",
    "## Keep Codex work reasonably bounded",
    "Prefer reasonably short, clearly bounded work units with a concrete goal and an independently checkable stopping point. Split large multi-stage work when that can be done without losing necessary context, but do not mechanically fragment it into meaningless tiny calls. Codex may require approvals while running, and a longer in-flight task increases the chance that the calling Chat session disconnects before an approval or result is handled.",
    "",
    "## Model and reasoning",
    selectionRule,
    "",
    "## Stay responsible for running Codex work",
    "Starting Codex is not the end of the calling AI's responsibility. Keep track of running work and return periodically according to task length, risk, and stage so approvals, errors, missing information, or obvious scope drift do not sit unattended. Continuous watching is not required, and multiple Codex sessions may be supervised in parallel when manageable.",
    "",
    "## Use waiting time productively",
    "Do not leave the calling Chat completely idle just because Codex is running. Use waiting time for useful non-conflicting work in the same task, such as preparing the next step, organizing context, defining checks, inspecting existing evidence, or supervising other active Codex work. Do not expand scope merely to stay busy or freely edit the same files Codex is currently changing.",
    "",
    "## Approvals while Codex is running",
    approvalRule,
    "",
    "## Verify and integrate Codex results",
    "Treat Codex completion as an execution result, not automatically as the user's finished answer. Check it against the requested work unit and available evidence, follow up or repair when needed, and integrate the usable result back into the surrounding task.",
    "",
    "## Keep this Profile useful",
    "When the user expresses a durable preference during real work, offer to add that detail to the Profile. Persist the change only after the user confirms; do not silently learn or rewrite long-term rules.",
    ...(body ? ["", "## Additional user instructions", body] : []),
  ].join("\n");
}

export function parseCodexCallProfileText(text) {
  const hash = sha256(text);
  const parsed = parseFrontmatter(text);
  if (!parsed.ok) {
    return {
      status: "invalid",
      valid: false,
      error: parsed.error,
      hash,
      schemaVersion: CODEX_CALL_PROFILE_SCHEMA_VERSION,
      profileRevision: null,
      effective: safeEffective(),
      instruction: "",
      legacy: false,
    };
  }

  try {
    const { fields } = parsed;
    if (fields.documentType !== CODEX_CALL_PROFILE_DOCUMENT_TYPE) {
      throw new Error("Profile documentType must be codex-call-profile");
    }
    if (!Number.isInteger(fields.profileRevision) || fields.profileRevision < 1) {
      throw new Error("Profile profileRevision must be a positive integer");
    }
    if (typeof fields.requireCallApproval !== "boolean") {
      throw new Error("Profile requireCallApproval must be true or false");
    }

    if (fields.schemaVersion === CODEX_CALL_PROFILE_SCHEMA_VERSION) {
      assertKnownFrontmatter(fields, V2_FRONTMATTER_KEYS, "v2");
      return {
        status: "configured",
        valid: true,
        error: null,
        schemaVersion: fields.schemaVersion,
        profileRevision: fields.profileRevision,
        hash,
        effective: { requireCallApproval: fields.requireCallApproval },
        instruction: parsed.body,
        legacy: false,
      };
    }

    if (fields.schemaVersion === LEGACY_CODEX_CALL_PROFILE_SCHEMA_VERSION) {
      validateLegacyFields(fields);
      return {
        status: "configured",
        valid: true,
        error: null,
        schemaVersion: fields.schemaVersion,
        profileRevision: fields.profileRevision,
        hash,
        effective: { requireCallApproval: fields.requireCallApproval },
        instruction: legacyInstruction(fields, parsed.body),
        legacy: true,
      };
    }

    throw new Error("Unsupported Profile schemaVersion");
  } catch (error) {
    return {
      status: "invalid",
      valid: false,
      error: error instanceof Error ? error.message : String(error),
      hash,
      schemaVersion: CODEX_CALL_PROFILE_SCHEMA_VERSION,
      profileRevision: null,
      effective: safeEffective(),
      instruction: parsed.body || "",
      legacy: false,
    };
  }
}

export function loadCodexCallProfile({
  filePath = defaultCodexCallProfilePath(),
} = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return {
      status: "missing",
      valid: false,
      error: null,
      filePath: resolvedPath,
      hash: null,
      profileRevision: null,
      schemaVersion: CODEX_CALL_PROFILE_SCHEMA_VERSION,
      effective: safeEffective(),
      instruction: "",
      legacy: false,
    };
  }
  try {
    const text = readFileSync(resolvedPath, "utf8");
    return { ...parseCodexCallProfileText(text), filePath: resolvedPath };
  } catch (error) {
    return {
      status: "invalid",
      valid: false,
      error: `Profile could not be read: ${error instanceof Error ? error.message : String(error)}`,
      filePath: resolvedPath,
      hash: null,
      profileRevision: null,
      schemaVersion: CODEX_CALL_PROFILE_SCHEMA_VERSION,
      effective: safeEffective(),
      instruction: "",
      legacy: false,
    };
  }
}

function serializeProfile({
  profileRevision,
  requireCallApproval,
  instruction,
}) {
  const body = typeof instruction === "string" && instruction.trim()
    ? instruction.trim()
    : DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION.trim();
  return [
    "---",
    `schemaVersion: ${CODEX_CALL_PROFILE_SCHEMA_VERSION}`,
    `profileRevision: ${profileRevision}`,
    `documentType: ${CODEX_CALL_PROFILE_DOCUMENT_TYPE}`,
    `requireCallApproval: ${requireCallApproval ? "true" : "false"}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

export function saveCodexCallProfile({
  filePath = defaultCodexCallProfilePath(),
  requireCallApproval = true,
  instruction = DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION,
  expectedProfileRevision = null,
  expectedProfileHash = null,
} = {}) {
  if (typeof requireCallApproval !== "boolean") {
    throw new Error("requireCallApproval must be a structured boolean");
  }
  if (typeof instruction !== "string") {
    throw new Error("instruction must be a string");
  }
  const current = loadCodexCallProfile({ filePath });
  if (expectedProfileRevision !== null) {
    if (!Number.isInteger(expectedProfileRevision) || expectedProfileRevision < 1) {
      throw new Error("expectedProfileRevision must be a positive integer when provided");
    }
    if (current.profileRevision !== expectedProfileRevision) {
      throw new Error("Codex Call Profile changed since it was read; show it again before updating");
    }
  }
  if (expectedProfileHash !== null) {
    if (typeof expectedProfileHash !== "string" || !/^[0-9a-f]{64}$/i.test(expectedProfileHash)) {
      throw new Error("expectedProfileHash must be a SHA-256 hex string when provided");
    }
    if (current.hash !== expectedProfileHash.toLowerCase()) {
      throw new Error("Codex Call Profile changed since it was read; show it again before updating");
    }
  }
  const profileRevision = Number.isInteger(current.profileRevision)
    ? current.profileRevision + 1
    : 1;
  const text = serializeProfile({ profileRevision, requireCallApproval, instruction });

  const resolvedPath = path.resolve(filePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const tmp = `${resolvedPath}.tmp-${randomUUID()}`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  const latest = loadCodexCallProfile({ filePath: resolvedPath });
  if (
    latest.status !== current.status
    || latest.profileRevision !== current.profileRevision
    || latest.hash !== current.hash
  ) {
    unlinkSync(tmp);
    throw new Error("Codex Call Profile changed during update; show it again before retrying");
  }
  renameSync(tmp, resolvedPath);
  return loadCodexCallProfile({ filePath: resolvedPath });
}

export function deleteCodexCallProfile({
  filePath = defaultCodexCallProfilePath(),
} = {}) {
  const resolvedPath = path.resolve(filePath);
  if (existsSync(resolvedPath)) unlinkSync(resolvedPath);
  return loadCodexCallProfile({ filePath: resolvedPath });
}

export function bindCodexCallProfileSnapshot(profile) {
  const current = profile && typeof profile === "object"
    ? profile
    : { status: "missing", effective: safeEffective(), instruction: "", legacy: false };
  return {
    status: current.status ?? "invalid",
    schemaVersion: current.schemaVersion ?? CODEX_CALL_PROFILE_SCHEMA_VERSION,
    profileRevision: Number.isInteger(current.profileRevision) ? current.profileRevision : null,
    hash: typeof current.hash === "string" ? current.hash : null,
    effective: {
      requireCallApproval: current.effective?.requireCallApproval === false ? false : true,
    },
    instruction: typeof current.instruction === "string" ? current.instruction : "",
    legacy: current.legacy === true,
  };
}

export function unconfiguredCodexCallInstruction() {
  return {
    status: "unconfigured",
    recommended: {
      requireCallApproval: true,
      instruction: DEFAULT_CODEX_CALL_PROFILE_INSTRUCTION.trim(),
    },
    choices: [
      "Create and save a long-term Codex Call Profile using the default instruction.",
      "Customize the instruction and/or call-approval setting, then save it as the long-term Profile.",
      "Skip Profile setup for this task only and save nothing.",
    ],
    semantics: "The Profile instruction is interpreted by the calling AI for each task. Codexless hard-enforces only requireCallApproval at the Call Codex consent stage; the Profile never expands Codex authority.",
    presentationPolicy: "Use the recommended instruction silently by default. Do not enumerate or explain its detailed default principles to the user unless the user asks about them or chooses to customize the Profile.",
    note: "If Profile setup is skipped, remind again before the next new Codex task until a Profile is saved.",
  };
}
