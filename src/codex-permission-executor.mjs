import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { assertRemoteModelFreeMethod } from "./toolbox-method-registry.mjs";

const execFileAsync = promisify(execFile);
const SUPPORTED_ACCESS = new Set(["readOnly", "workspaceWrite"]);
const SUPPORTED_RESOLVER_MODES = new Set(["quiet", "inherit"]);
const DEFAULT_ACCEPTED_CODEX_VERSIONS = new Set(["0.147.0"]);
const SUPPORTED_SANDBOX_TYPES = new Set(["readOnly", "workspaceWrite"]);
const SUPPORTED_BUILTIN_PROFILES = new Set([":read-only", ":workspace"]);
const KNOWN_SANDBOX_FIELDS = {
  readOnly: new Set(["type", "networkAccess"]),
  workspaceWrite: new Set([
    "type",
    "networkAccess",
    "writableRoots",
    "excludeTmpdirEnvVar",
    "excludeSlashTmp",
  ]),
};

function normalizeConfigPath(value) {
  return process.platform === "linux"
    ? path.resolve(value)
    : path.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function getMcpServers(config) {
  return config?.mcpServers ?? config?.mcp_servers ?? {};
}

function getTrustLevel(config, workspaceRoot) {
  const projects = config?.projects ?? {};
  const entry = process.platform === "linux"
    ? Object.entries(projects).find(([root]) => normalizeConfigPath(root) === normalizeConfigPath(workspaceRoot))?.[1]
    : projects[normalizeConfigPath(workspaceRoot)];
  return entry?.trust_level ?? entry?.trustLevel ?? null;
}

function hasCustomPermissionConfiguration(config) {
  const configuredProfiles = config?.permissions;
  const defaultPermissions = config?.default_permissions ?? config?.defaultPermissions ?? null;
  const hasNamedProfiles = Boolean(
    configuredProfiles && typeof configuredProfiles === "object" && Object.keys(configuredProfiles).length
  );
  const hasNonReadOnlyDefault = defaultPermissions !== null && defaultPermissions !== ":read-only";
  return hasNamedProfiles || hasNonReadOnlyDefault;
}

function buildQuietSessionConfig(config) {
  const mcpServers = getMcpServers(config);
  const disabledMcpServers = Object.fromEntries(
    Object.keys(mcpServers).map((name) => [name, { enabled: false }])
  );
  return {
    features: {
      plugins: false,
      apps: false,
    },
    mcp_servers: disabledMcpServers,
  };
}

export class ToolwirePermissionError extends Error {
  constructor(message, { code = "PERMISSION_REQUIRED", nextActions = [] } = {}) {
    super(message);
    this.name = "ToolwirePermissionError";
    this.code = code;
    this.nextActions = nextActions;
  }
}

function truncateUtf8(text, byteCap) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteCap) return { text: value, truncated: false };
  return { text: bytes.subarray(0, byteCap).toString("utf8"), truncated: true };
}

export function validatePermissionProjection(started, workspaceRoot) {
  const profileId = started?.activePermissionProfile?.id;
  const runtimeWorkspaceRoots = started?.runtimeWorkspaceRoots;
  const sandbox = started?.sandbox;
  if (!profileId || !Array.isArray(runtimeWorkspaceRoots) || !sandbox?.type) {
    throw new Error(
      "permission resolver capability gate failed: Codex did not return activePermissionProfile, runtimeWorkspaceRoots, and sandbox projection"
    );
  }
  if (!SUPPORTED_BUILTIN_PROFILES.has(profileId)) {
    throw new Error(
      `permission resolver returned unsupported custom permission profile for 0.1: ${profileId}. ` +
      "The legacy sandbox projection cannot faithfully represent custom filesystem-read constraints, so Codexless fails closed."
    );
  }
  if (!runtimeWorkspaceRoots.some((root) => normalizeConfigPath(root) === normalizeConfigPath(workspaceRoot))) {
    throw new Error("permission resolver failed closed: selected workspace is absent from Codex runtimeWorkspaceRoots");
  }
  if (!SUPPORTED_SANDBOX_TYPES.has(sandbox.type)) {
    throw new Error(`permission resolver returned unsupported sandbox type for remote preview: ${sandbox.type}`);
  }
  const knownFields = KNOWN_SANDBOX_FIELDS[sandbox.type];
  const unknownFields = Object.keys(sandbox).filter((field) => !knownFields.has(field));
  if (unknownFields.length) {
    throw new Error(
      `permission resolver returned sandbox fields that 0.1 cannot safely preserve: ${unknownFields.join(", ")}. ` +
      "Codexless fails closed instead of discarding a possibly restrictive Codex permission field."
    );
  }
  return { profileId, runtimeWorkspaceRoots, sandbox };
}

export class CodexPermissionExecutor {
  #codexBin;
  #workspaceRoot;
  #resolverMode;
  #maxTimeoutMs;
  #watchdogGraceMs;
  #outputBytesCap;
  #acceptedCodexVersions;
  #codexVersion = null;

  constructor({
    codexBin,
    workspaceRoot,
    resolverMode = "quiet",
    maxTimeoutMs = 30_000,
    watchdogGraceMs = 5_000,
    outputBytesCap = 32_768,
    acceptedCodexVersions = [...DEFAULT_ACCEPTED_CODEX_VERSIONS],
  }) {
    if (!codexBin) throw new Error("CodexPermissionExecutor requires codexBin");
    if (!workspaceRoot) throw new Error("CodexPermissionExecutor requires workspaceRoot");
    if (!SUPPORTED_RESOLVER_MODES.has(resolverMode)) {
      throw new Error(`resolverMode must be one of: ${[...SUPPORTED_RESOLVER_MODES].join(", ")}`);
    }
    if (!Number.isInteger(outputBytesCap) || outputBytesCap <= 0) {
      throw new Error("outputBytesCap must be a positive integer");
    }
    if (!Array.isArray(acceptedCodexVersions) || !acceptedCodexVersions.length || !acceptedCodexVersions.every((value) => typeof value === "string" && value)) {
      throw new Error("acceptedCodexVersions must be a non-empty string array");
    }
    this.#codexBin = codexBin;
    this.#workspaceRoot = path.resolve(workspaceRoot);
    this.#resolverMode = resolverMode;
    this.#maxTimeoutMs = maxTimeoutMs;
    this.#watchdogGraceMs = watchdogGraceMs;
    this.#outputBytesCap = outputBytesCap;
    this.#acceptedCodexVersions = new Set(acceptedCodexVersions);
  }

  get workspaceRoot() {
    return this.#workspaceRoot;
  }

  get resolverMode() {
    return this.#resolverMode;
  }

  get codexVersion() {
    return this.#codexVersion;
  }

  async validate() {
    const info = await stat(this.#workspaceRoot);
    if (!info.isDirectory()) throw new Error(`workspaceRoot is not a directory: ${this.#workspaceRoot}`);
    this.#workspaceRoot = await realpath(this.#workspaceRoot);

    const { stdout } = await execFileAsync(this.#codexBin, ["--version"], {
      cwd: this.#workspaceRoot,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const match = String(stdout).match(/codex-cli\s+([^\s]+)/i);
    if (!match) throw new Error(`unable to parse Codex CLI version from: ${String(stdout).trim()}`);
    this.#codexVersion = match[1];
    if (!this.#acceptedCodexVersions.has(this.#codexVersion)) {
      throw new Error(
        `unsupported Codex CLI version for Codexless Stable permission parity: ${this.#codexVersion}. ` +
        `Accepted versions: ${[...this.#acceptedCodexVersions].join(", ")}. ` +
        "This path depends on experimental/legacy App Server permission fields and must be re-accepted before upgrade."
      );
    }

    const client = this.#newClient(15_000);
    await client.start();
    try {
      const configRead = await client.request("config/read", {
        cwd: this.#workspaceRoot,
        includeLayers: false,
      });
      if (!configRead?.config || typeof configRead.config !== "object") {
        throw new Error("Codex config/read did not return an effective config object");
      }
      return {
        workspaceRoot: this.#workspaceRoot,
        codexVersion: this.#codexVersion,
        resolverMode: this.#resolverMode,
        trustLevel: getTrustLevel(configRead.config, this.#workspaceRoot),
        configuredMcpServers: Object.keys(getMcpServers(configRead.config)),
      };
    } finally {
      await client.close();
    }
  }

  async exec({ command, access = "readOnly", timeoutMs = 10_000 }) {
    if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === "string")) {
      throw new Error("command must be a non-empty argv string array");
    }
    if (!SUPPORTED_ACCESS.has(access)) {
      throw new Error(`unsupported access mode: ${access}`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.#maxTimeoutMs) {
      throw new Error(`timeoutMs must be an integer between 1 and ${this.#maxTimeoutMs}`);
    }

    assertRemoteModelFreeMethod("command/exec");

    const client = this.#newClient(timeoutMs + this.#watchdogGraceMs);
    await client.start();
    try {
      const configRead = await client.request("config/read", {
        cwd: this.#workspaceRoot,
        includeLayers: false,
      });
      const effectiveConfig = configRead?.config;
      if (!effectiveConfig || typeof effectiveConfig !== "object") {
        throw new Error("permission resolver failed closed: Codex config/read returned no effective config");
      }

      const trustLevel = getTrustLevel(effectiveConfig, this.#workspaceRoot);
      const resolution = trustLevel === "trusted"
        ? await this.#resolveTrustedWorkspace(client, effectiveConfig, timeoutMs)
        : this.#resolveUntrustedWorkspace(access, trustLevel, effectiveConfig);

      const sandboxPolicy = this.#downscopeSandbox(resolution, access);
      const result = await client.exec(
        {
          command,
          cwd: this.#workspaceRoot,
          sandboxPolicy,
          timeoutMs,
        },
        { timeoutMs: timeoutMs + this.#watchdogGraceMs }
      );

      const stdout = truncateUtf8(result.stdout, this.#outputBytesCap);
      const stderr = truncateUtf8(result.stderr, this.#outputBytesCap);
      return {
        ...result,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        access,
        permissionCeiling: resolution.profileId,
        resolutionSource: resolution.source,
        resolverMode: this.#resolverMode,
        notificationMethods: client.notificationMethods,
        serverRequestMethods: client.serverRequestMethods,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/CreateProcessWithLogonW failed:\s*267|helper_unknown_error|setup refresh had errors/i.test(message)) {
        throw new Error(
          `Codex Windows sandbox could not execute in workspace ${this.#workspaceRoot}. ` +
          "Mapped/virtual drives such as Google Drive are a known upstream Codex limitation; Codexless will not bypass it with broader permissions. " +
          `Original error: ${message}`
        );
      }
      throw error;
    } finally {
      await client.close();
    }
  }

  #newClient(requestTimeoutMs) {
    return new CodexAppServerClient({
      bin: this.#codexBin,
      cwd: this.#workspaceRoot,
      requestTimeoutMs,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: {
        name: "codex_toolbox_bridge_p3",
        title: "Codex Toolbox Bridge P3",
        version: "0.0.1-p3",
      },
    });
  }

  async #resolveTrustedWorkspace(client, effectiveConfig, timeoutMs) {
    const params = {
      cwd: this.#workspaceRoot,
      ephemeral: true,
    };
    if (this.#resolverMode === "quiet") {
      params.config = buildQuietSessionConfig(effectiveConfig);
    }

    const started = await client.request("thread/start", params, {
      timeoutMs: Math.min(timeoutMs + this.#watchdogGraceMs, 15_000),
    });

    const { profileId, runtimeWorkspaceRoots, sandbox } = validatePermissionProjection(
      started,
      this.#workspaceRoot
    );

    const methods = client.notificationMethods;
    if (methods.some((method) => method.startsWith("turn/") || method === "thread/tokenUsage/updated")) {
      throw new Error("permission resolver failed closed: a model turn/token-usage event appeared during model-free resolution");
    }
    if (this.#resolverMode === "quiet" && methods.includes("mcpServer/startupStatus/updated")) {
      throw new Error("quiet permission resolver failed closed: an MCP runtime still initialized");
    }

    return {
      source: "codex-thread-resolver",
      profileId,
      runtimeWorkspaceRoots,
      sandbox,
    };
  }

  #resolveUntrustedWorkspace(access, trustLevel, effectiveConfig) {
    if (hasCustomPermissionConfiguration(effectiveConfig)) {
      throw new Error(
        "Codex workspace is not explicitly trusted and custom/default permission configuration is present. " +
        "Codexless cannot safely infer the exact read ceiling without starting a resolver thread that may mutate trust, so it fails closed."
      );
    }
    if (access === "workspaceWrite") {
      throw new ToolwirePermissionError(
        `Codex workspace is not explicitly trusted${trustLevel ? ` (trust=${trustLevel})` : ""}; workspaceWrite is denied.`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Ask the user to explicitly authorize enabling the required Codex permission/trust for this workspace via a separate permission-control capability.",
            "Retry with readOnly if the task does not require writes.",
          ],
        }
      );
    }
    return {
      source: "codex-untrusted-readonly-cap",
      profileId: ":read-only",
      runtimeWorkspaceRoots: [this.#workspaceRoot],
      sandbox: { type: "readOnly", networkAccess: false },
    };
  }

  #downscopeSandbox(resolution, access) {
    if (access === "readOnly") {
      if (resolution.profileId === ":read-only" && resolution.sandbox.type === "readOnly") {
        return { ...structuredClone(resolution.sandbox), networkAccess: false };
      }
      if (resolution.profileId === ":workspace" && resolution.sandbox.type === "workspaceWrite") {
        // This conversion is only allowed for Codex's built-in :workspace profile.
        // Custom profiles are rejected above because the legacy sandbox projection cannot
        // encode their additional filesystem-read constraints. For the built-in projection,
        // switching workspaceWrite -> readOnly removes write authority without adding fields.
        return { type: "readOnly", networkAccess: false };
      }
      throw new Error(
        `readOnly downscope is not safely representable from Codex permission ceiling ${resolution.profileId} / ${resolution.sandbox.type}`
      );
    }
    if (resolution.sandbox.type !== "workspaceWrite") {
      throw new ToolwirePermissionError(
        `workspaceWrite requested but Codex permission ceiling is ${resolution.profileId} / ${resolution.sandbox.type}`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Ask the user to explicitly authorize a higher Codex permission ceiling using a separate permission-control capability.",
            "Retry with readOnly if the task can be completed without writes.",
          ],
        }
      );
    }
    return {
      ...structuredClone(resolution.sandbox),
      networkAccess: false,
    };
  }
}
