import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const STOCK_RUNTIME_KIND = "local-stock";
const PROMPT_INPUT_TIMEOUT_MS = 15_000;
const PROMPT_INPUT_MAX_BUFFER = 8 * 1024 * 1024;
const PROMPT_INPUT_LOCATOR_KINDS = new Set([
  "file",
  "environment resource",
  "orchestrator resource",
  "custom resource",
]);
const execFileAsync = promisify(execFile);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function configArgs(configOverrides) {
  return configOverrides.flatMap((value) => ["-c", value]);
}

function redactHomePath(value) {
  if (typeof value !== "string" || !value) return value ?? null;
  const home = os.homedir();
  if (!home) return value;
  const normalizedValue = path.resolve(value);
  const normalizedHome = path.resolve(home);
  const comparableValue = process.platform === "win32" ? normalizedValue.toLowerCase() : normalizedValue;
  const comparableHome = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;
  const homeToken = process.platform === "win32" ? "%USERPROFILE%" : "$HOME";
  if (comparableValue === comparableHome) return homeToken;
  if (comparableValue.startsWith(`${comparableHome}${path.sep}`)) return `${homeToken}${normalizedValue.slice(normalizedHome.length)}`;
  return normalizedValue;
}

function redactPromptInputArgs(configOverrides, resolvedModel, cwd) {
  return [
    ...configOverrides.flatMap(() => ["-c", "<redacted>"]),
    "-m",
    resolvedModel,
    "-C",
    redactHomePath(cwd),
    "debug",
    "prompt-input",
  ];
}

export function implicitSkillRoutingUnavailable(code, message, alignment = null) {
  return {
    status: "unavailable",
    source: "codex debug prompt-input",
    count: 0,
    skills: [],
    diagnostics: [{ code, message }],
    alignment,
  };
}

function classifyPromptInputFailure(error) {
  const stderr = String(error?.stderr ?? "");
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (error?.code === "ENOENT") {
    return { code: "IMPLICIT_SKILLS_EXECUTABLE_UNAVAILABLE", message: "stock Codex executable could not be started" };
  }
  if (error?.code === "ETIMEDOUT" || error?.killed === true || error?.signal === "SIGTERM") {
    return { code: "IMPLICIT_SKILLS_DEBUG_TIMEOUT", message: "stock codex debug prompt-input timed out" };
  }
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { code: "IMPLICIT_SKILLS_PROMPT_OUTPUT_TOO_LARGE", message: "stock codex debug prompt-input exceeded the bounded output limit" };
  }
  if (/unrecognized subcommand|unknown subcommand|invalid value.*prompt-input|prompt-input.*not found/i.test(`${stderr}\n${message}`)) {
    return { code: "IMPLICIT_SKILLS_DEBUG_UNAVAILABLE", message: "stock Codex does not expose the required debug prompt-input capability" };
  }
  return {
    code: "IMPLICIT_SKILLS_DEBUG_FAILED",
    message: `stock codex debug prompt-input exited unsuccessfully${Number.isInteger(error?.code) ? ` (exit ${error.code})` : ""}`,
  };
}

export async function runStockPromptInputSidecar(spec, { timeoutMs = PROMPT_INPUT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync(spec.command, spec.args, {
      cwd: spec.cwd,
      ...(spec.env ? { env: spec.env } : {}),
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: PROMPT_INPUT_MAX_BUFFER,
    });
    return { ok: true, stdout: String(stdout ?? "") };
  } catch (error) {
    const failure = classifyPromptInputFailure(error);
    return { ok: false, ...failure };
  }
}

function parseRenderedSkillLine(line) {
  if (!line.startsWith("- ")) {
    throw Object.assign(new Error("Available skills section contains a non-bullet line"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  const separator = line.indexOf(": ", 2);
  if (separator <= 2) {
    throw Object.assign(new Error("Available skills bullet is missing the current stock name separator"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  const name = line.slice(2, separator);
  const locatorMatch = line.match(/ \((file|environment resource|orchestrator resource|custom resource): (.+)\)$/);
  if (!locatorMatch || !PROMPT_INPUT_LOCATOR_KINDS.has(locatorMatch[1])) {
    throw Object.assign(new Error("Available skills bullet is missing the current stock source locator"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  const description = line.slice(separator + 2, locatorMatch.index);
  if (!name || !description || !locatorMatch[2]) {
    throw Object.assign(new Error("Available skills bullet contains an empty current stock field"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  return {
    name,
    description,
    source: { kind: locatorMatch[1], locator: locatorMatch[2] },
    rendered: line,
  };
}

export function parsePromptInputSkillCatalog(stdout) {
  let prompt;
  try {
    prompt = JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("stock codex debug prompt-input returned malformed JSON"), { code: "IMPLICIT_SKILLS_PROMPT_JSON_INVALID" });
  }
  if (!Array.isArray(prompt)) {
    throw Object.assign(new Error("stock prompt-input JSON root is not the current stock message array"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }

  const developerItems = [];
  for (const item of prompt) {
    if (!isRecord(item) || item.type !== "message" || !["developer", "user"].includes(item.role) || !Array.isArray(item.content)) {
      throw Object.assign(new Error("stock prompt-input message structure drifted from the accepted shape"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "input_text" || typeof part.text !== "string") {
        throw Object.assign(new Error("stock prompt-input content structure drifted from input_text"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
      }
    }
    if (item.role === "developer") developerItems.push(item);
  }
  if (!developerItems.length) {
    throw Object.assign(new Error("stock prompt-input contains no developer message"), { code: "IMPLICIT_SKILLS_DEVELOPER_MISSING" });
  }

  const taggedParts = developerItems.flatMap((item) => item.content)
    .filter((part) => part.text.includes("<skills_instructions>") || part.text.includes("</skills_instructions>"));
  if (taggedParts.length !== 1) {
    throw Object.assign(new Error("stock prompt-input must contain exactly one skills_instructions content part"), { code: "IMPLICIT_SKILLS_TAG_MISMATCH" });
  }

  const tagged = taggedParts[0].text;
  if (tagged.includes("\r") || !tagged.startsWith("<skills_instructions>\n") || !tagged.endsWith("\n</skills_instructions>")) {
    throw Object.assign(new Error("skills_instructions tags do not match the accepted stock boundaries"), { code: "IMPLICIT_SKILLS_TAG_MISMATCH" });
  }
  if ((tagged.match(/<skills_instructions>/g) ?? []).length !== 1 || (tagged.match(/<\/skills_instructions>/g) ?? []).length !== 1) {
    throw Object.assign(new Error("skills_instructions tag multiplicity changed"), { code: "IMPLICIT_SKILLS_TAG_MISMATCH" });
  }

  const inner = tagged.slice("<skills_instructions>\n".length, -"\n</skills_instructions>".length);
  const lines = inner.split("\n");
  if (lines[0] !== "## Skills") {
    throw Object.assign(new Error("skills_instructions is missing the accepted ## Skills heading"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  const availableIndexes = lines.map((line, index) => line === "### Available skills" ? index : -1).filter((index) => index >= 0);
  if (availableIndexes.length !== 1) {
    throw Object.assign(new Error("skills_instructions must contain exactly one ### Available skills heading"), { code: "IMPLICIT_SKILLS_AVAILABLE_SECTION_MISSING" });
  }
  const availableIndex = availableIndexes[0];
  if (availableIndex < 1) {
    throw Object.assign(new Error("### Available skills heading is outside the accepted Skills block"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  const preludeLines = lines.slice(1, availableIndex);
  const skillRootsIndex = preludeLines.indexOf("### Skill roots");
  const proseLines = skillRootsIndex >= 0 ? preludeLines.slice(0, skillRootsIndex) : preludeLines;
  const skillRootLines = skillRootsIndex >= 0 ? preludeLines.slice(skillRootsIndex + 1) : [];
  const validSkillRootLine = (line) => /^- `r\d+` = `[^`]+`$/.test(line);
  if (
    !proseLines.length
    || proseLines.some((line) => !line || line.startsWith("#") || line.startsWith("- "))
    || (skillRootsIndex >= 0 && (!skillRootLines.length || skillRootLines.some((line) => !validSkillRootLine(line))))
    || preludeLines.filter((line) => line === "### Skill roots").length > 1
  ) {
    throw Object.assign(new Error("Skills prelude structure changed before ### Available skills"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }
  const renderedLines = lines.slice(availableIndex + 1);
  if (renderedLines.some((line) => line === "" || line.startsWith("### "))) {
    throw Object.assign(new Error("Available skills section structure changed"), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
  }

  const skills = renderedLines.map(parseRenderedSkillLine);
  const names = new Set();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw Object.assign(new Error(`Available skills contains a duplicate name: ${skill.name}`), { code: "IMPLICIT_SKILLS_STRUCTURE_MISMATCH" });
    }
    names.add(skill.name);
  }
  return skills;
}

export class StockPromptInputSkillRoutingCore {
  #runtimeKind;
  #codexBin;
  #appServerCwd;
  #configOverrides;
  #launchEnv;
  #promptInputRunner;

  constructor({
    runtimeKind,
    codexBin,
    appServerCwd,
    configOverrides = [],
    launchEnv = null,
    promptInputRunner = runStockPromptInputSidecar,
  }) {
    if (typeof runtimeKind !== "string" || !runtimeKind.trim()) {
      throw new Error("StockPromptInputSkillRoutingCore requires an explicit runtimeKind");
    }
    if (typeof codexBin !== "string" || !codexBin.trim()) {
      throw new Error("StockPromptInputSkillRoutingCore requires codexBin");
    }
    if (typeof appServerCwd !== "string" || !appServerCwd.trim()) {
      throw new Error("StockPromptInputSkillRoutingCore requires appServerCwd");
    }
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty strings");
    }
    if (launchEnv !== null && (typeof launchEnv !== "object" || Array.isArray(launchEnv))) {
      throw new Error("launchEnv must be null or an environment object");
    }
    if (typeof promptInputRunner !== "function") {
      throw new Error("promptInputRunner must be a function");
    }

    this.#runtimeKind = runtimeKind;
    this.#codexBin = codexBin;
    this.#appServerCwd = path.resolve(appServerCwd);
    this.#configOverrides = Object.freeze([...configOverrides]);
    this.#launchEnv = launchEnv ? Object.freeze({ ...launchEnv }) : null;
    this.#promptInputRunner = promptInputRunner;
  }

  appServerSpec() {
    return {
      command: this.#codexBin,
      args: [...configArgs(this.#configOverrides), "app-server", "--stdio"],
      options: { cwd: this.#appServerCwd, ...(this.#launchEnv ? { env: this.#launchEnv } : {}) },
    };
  }

  async readImplicitFromThreadStart({ method, params, result }) {
    try {
      return await this.#readImplicitFromThreadStart({ method, params, result });
    } catch {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_CORE_FAILED",
        "implicit Skill routing could not establish the required stock runtime alignment"
      );
    }
  }

  async #readImplicitFromThreadStart({ method, params, result }) {
    if (this.#runtimeKind !== STOCK_RUNTIME_KIND) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_UNSUPPORTED_RUNTIME",
        "implicit Skill routing is available only for the local stock Codex app-server runtime"
      );
    }
    if (method !== "thread/start" || !isRecord(params) || params.ephemeral !== true || !isRecord(result?.thread) || result.thread.ephemeral !== true) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_UNSUPPORTED_SESSION",
        "implicit Skill parity requires a fresh ephemeral thread/start session proven by the App Server request and response"
      );
    }
    if (Object.hasOwn(params, "config")) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_THREAD_CONFIG_UNSUPPORTED",
        "implicit Skill parity is disabled when thread/start carries thread-dynamic config"
      );
    }
    if (typeof result.thread.id !== "string" || !result.thread.id) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_UNSUPPORTED_SESSION",
        "thread/start returned no usable new-thread identifier"
      );
    }

    const requestedCwd = typeof params.cwd === "string" && params.cwd.trim() ? path.resolve(params.cwd) : null;
    const responseCwd = typeof result.cwd === "string" && result.cwd.trim() ? path.resolve(result.cwd) : null;
    const threadCwd = typeof result.thread.cwd === "string" && result.thread.cwd.trim() ? path.resolve(result.thread.cwd) : null;
    if (!requestedCwd || !responseCwd || !threadCwd || !samePath(requestedCwd, responseCwd) || !samePath(responseCwd, threadCwd)) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_CWD_ALIGNMENT_UNPROVEN",
        "thread/start request cwd, response cwd, and thread cwd do not prove one effective cwd"
      );
    }

    const hasRequestedModel = Object.hasOwn(params, "model");
    const requestedModel = hasRequestedModel ? params.model : null;
    if (requestedModel !== null && (typeof requestedModel !== "string" || !requestedModel.trim())) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_MODEL_ALIGNMENT_UNPROVEN",
        "thread/start requested model is neither a non-empty string nor explicit/default null"
      );
    }
    const resolvedModel = typeof result.model === "string" ? result.model.trim() : "";
    if (!resolvedModel) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_MODEL_ALIGNMENT_UNPROVEN",
        "thread/start returned no resolved model for prompt-input alignment"
      );
    }
    if (typeof requestedModel === "string" && requestedModel.trim() !== resolvedModel) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_MODEL_ALIGNMENT_UNPROVEN",
        "thread/start resolved a model different from the explicitly requested model"
      );
    }

    const sidecarSpec = {
      command: this.#codexBin,
      args: [
        ...configArgs(this.#configOverrides),
        "-m",
        resolvedModel,
        "-C",
        responseCwd,
        "debug",
        "prompt-input",
      ],
      cwd: responseCwd,
      ...(this.#launchEnv ? { env: this.#launchEnv } : {}),
    };
    const appServerSpec = this.appServerSpec();
    const expectedConfigArgs = configArgs(this.#configOverrides);
    const sidecarConfigArgs = sidecarSpec.args.slice(0, expectedConfigArgs.length);
    const sameConfigOverrides = sidecarConfigArgs.length === expectedConfigArgs.length
      && sidecarConfigArgs.every((value, index) => value === expectedConfigArgs[index]);
    const alignment = {
      runtime: { kind: this.#runtimeKind, supported: true },
      session: {
        method,
        newSession: true,
        ephemeral: true,
        threadDynamicConfig: false,
        evidence: "thread/start request+response",
      },
      executable: {
        sameAsAppServer: sidecarSpec.command === appServerSpec.command,
        resolved: redactHomePath(sidecarSpec.command),
      },
      cwd: {
        requestMatchesResponse: samePath(requestedCwd, responseCwd),
        responseMatchesThread: samePath(responseCwd, threadCwd),
        sidecarMatchesThread: samePath(sidecarSpec.cwd, threadCwd),
        effective: redactHomePath(responseCwd),
        appServerProcessCwd: redactHomePath(appServerSpec.options.cwd),
      },
      config: {
        sidecarLaunchOverridesMatchAppServer: sameConfigOverrides,
        overrideCount: this.#configOverrides.length,
        threadDynamicConfigPresent: false,
        threadConfigSource: "current-config-no-thread-overrides",
        valuesRedacted: true,
      },
      model: {
        requestedModel: typeof requestedModel === "string" ? requestedModel.trim() : null,
        resolvedModel,
        sidecarModel: resolvedModel,
        matchesThread: true,
      },
      sidecarCommand: {
        executable: redactHomePath(sidecarSpec.command),
        args: redactPromptInputArgs(this.#configOverrides, resolvedModel, sidecarSpec.cwd),
      },
    };

    if (!alignment.executable.sameAsAppServer || !alignment.config.sidecarLaunchOverridesMatchAppServer || !alignment.cwd.sidecarMatchesThread) {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_LAUNCH_ALIGNMENT_UNPROVEN",
        "prompt-input executable/cwd/config no longer matches the proven stock App Server thread context",
        alignment
      );
    }

    let run;
    try {
      run = await this.#promptInputRunner(sidecarSpec);
    } catch (error) {
      const failure = classifyPromptInputFailure(error);
      return implicitSkillRoutingUnavailable(failure.code, failure.message, alignment);
    }
    if (!isRecord(run) || run.ok !== true) {
      const code = typeof run?.code === "string" ? run.code : "IMPLICIT_SKILLS_DEBUG_FAILED";
      const message = typeof run?.message === "string" ? run.message : "stock codex debug prompt-input failed without an accepted result";
      return implicitSkillRoutingUnavailable(code, message, alignment);
    }
    if (typeof run.stdout !== "string") {
      return implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_RUNNER_RESULT_INVALID",
        "stock codex debug prompt-input runner returned no string stdout",
        alignment
      );
    }

    try {
      const skills = parsePromptInputSkillCatalog(run.stdout);
      return {
        status: "ok",
        source: "codex debug prompt-input",
        count: skills.length,
        skills,
        diagnostics: [],
        alignment,
      };
    } catch (error) {
      return implicitSkillRoutingUnavailable(
        typeof error?.code === "string" ? error.code : "IMPLICIT_SKILLS_STRUCTURE_MISMATCH",
        error instanceof Error ? error.message : "stock prompt-input structure mismatch",
        alignment
      );
    }
  }
}
