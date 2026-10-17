import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { assertRemoteModelFreeMethod } from "./toolbox-method-registry.mjs";
import { ToolwirePermissionError } from "./codex-permission-executor.mjs";

const execFileAsync = promisify(execFile);
const SUPPORTED_ACCESS = new Set(["inherit", "readOnly"]);
const COMPATIBILITY_PROBE_MARKER = "TOOLWIRE_CODEX_CONTRACT_OK";
const WINDOWS_LAUNCHABLE_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);
const WINDOWS_INVALID_BASENAME = /[<>:"/\\|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isSafeWindowsBareExecutableName(value) {
  if (typeof value !== "string" || !value || value === "." || value === "..") return false;
  if (WINDOWS_INVALID_BASENAME.test(value) || /[ .]$/.test(value)) return false;
  return !WINDOWS_RESERVED_BASENAME.test(value);
}

async function resolveWindowsExecutable(command) {
  if (process.platform !== "win32") return { command, executableResolution: null };
  const requested = command[0];
  if (!requested || path.isAbsolute(requested) || requested.includes("\\") || requested.includes("/") || path.extname(requested)) {
    return { command, executableResolution: null };
  }
  if (!isSafeWindowsBareExecutableName(requested)) {
    return { command, executableResolution: null };
  }

  try {
    const { stdout } = await execFileAsync("where.exe", [requested], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    });
    const resolved = String(stdout ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value && WINDOWS_LAUNCHABLE_EXTENSIONS.has(path.extname(value).toLowerCase()));
    if (!resolved) return { command, executableResolution: null };
    return {
      command: [resolved, ...command.slice(1)],
      executableResolution: { requested, resolved, source: "windows-where" },
    };
  } catch {
    return { command, executableResolution: null };
  }
}

export function normalizeConfigPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getMcpServers(config) {
  return config?.mcpServers ?? config?.mcp_servers ?? {};
}

function buildQuietSessionConfig(config) {
  const disabledMcpServers = Object.fromEntries(
    Object.keys(getMcpServers(config)).map((name) => [name, { enabled: false }])
  );
  return {
    features: {
      plugins: false,
      apps: false,
    },
    mcp_servers: disabledMcpServers,
  };
}

export function findTrustedAncestor(config, cwd) {
  const target = normalizeConfigPath(cwd);
  const projects = config?.projects ?? {};
  let best = null;

  for (const [rawRoot, entry] of Object.entries(projects)) {
    const trustLevel = entry?.trust_level ?? entry?.trustLevel ?? null;
    if (trustLevel !== "trusted") continue;
    const normalizedRoot = normalizeConfigPath(rawRoot);
    const relative = path.relative(normalizedRoot, target);
    const withinRoot = relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (!withinRoot) continue;
    if (!best || normalizedRoot.length > best.normalizedRoot.length) {
      best = { root: path.resolve(rawRoot), normalizedRoot, trustLevel };
    }
  }

  return best;
}

export function boundLinuxPermissionProfile(profileId, { access = "inherit", allowedProfiles, platform = process.platform } = {}) {
  if (platform !== "linux") return access === "readOnly" ? ":read-only" : profileId;
  if ([":read-only", ":workspace", ":danger-full-access"].includes(profileId) && access === "readOnly") return ":read-only";
  if (profileId === ":read-only" || profileId === ":workspace") return profileId;
  const allowed = allowedProfiles instanceof Set ? allowedProfiles : new Set(allowedProfiles ?? []);
  if (profileId === ":danger-full-access" && allowed.has(":workspace")) return ":workspace";
  throw new ToolwirePermissionError(
    "Linux remote operations require a locally authorized read-only or workspace sandbox; an unbounded or unverified custom permission profile is not accepted.",
    { code: "LINUX_PERMISSION_CEILING", nextActions: ["Use a locally authorized Codex read-only/workspace profile; do not disable the sandbox to repair a remote tool call."] }
  );
}

function explicitDefaultPermissionProfile(config) {
  const candidates = [];
  for (const key of ["default_permissions", "defaultPermissions"]) {
    if (!Object.hasOwn(config ?? {}, key)) continue;
    const value = config?.[key];
    if (value === null) continue;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`authority resolver failed closed: config/read returned invalid explicit ${key} provenance`);
    }
    candidates.push(value.trim());
  }
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new Error(`authority resolver failed closed: config/read returned conflicting explicit default permission profiles: ${unique.join(", ")}`);
  }
  return unique[0] ?? null;
}

function supportedLegacyPermissionProfile(config) {
  const sandboxMode = config?.sandbox_mode ?? config?.sandboxMode ?? null;
  const approvalPolicy = config?.approval_policy ?? config?.approvalPolicy ?? null;
  if (sandboxMode === "workspace-write" && approvalPolicy === "on-request") {
    return ":workspace";
  }
  return null;
}

export function normalizeCodexAuthorityProjection({
  started,
  effectiveConfig,
  allowedProfiles,
  authorityRoot,
  allowTrustedReadOnlyDownscope = false,
}) {
  if (!started || typeof started !== "object" || Array.isArray(started)) {
    throw new Error("authority resolver failed closed: thread/start returned no usable response object");
  }
  const allowed = allowedProfiles instanceof Set ? allowedProfiles : new Set(allowedProfiles ?? []);
  const activeProfile = started.activePermissionProfile;
  const activeProfileId = activeProfile?.id;
  if (typeof activeProfileId === "string" && activeProfileId) {
    if (!allowed.has(activeProfileId)) {
      throw new Error(`authority resolver returned an active permission profile that is not currently allowed: ${activeProfileId}`);
    }
    return { profileId: activeProfileId, provenance: "activePermissionProfile" };
  }
  if (activeProfile !== null && activeProfile !== undefined) {
    throw new Error("authority resolver failed closed: activePermissionProfile is present without a usable id");
  }

  const explicitDefaultProfileId = explicitDefaultPermissionProfile(effectiveConfig);
  const legacyProfileId = explicitDefaultProfileId ? null : supportedLegacyPermissionProfile(effectiveConfig);
  const explicitProfileId = explicitDefaultProfileId ?? legacyProfileId;
  const explicitProfileProvenance = explicitDefaultProfileId
    ? "config/read:default_permissions"
    : legacyProfileId
      ? "config/read:sandbox_mode+approval_policy"
      : null;
  if (!explicitProfileId) {
    if (!allowTrustedReadOnlyDownscope) {
      throw new Error(
        "authority resolver capability gate failed closed: activePermissionProfile is null and config/read provides neither explicit default_permissions nor supported sandbox_mode/approval_policy provenance"
      );
    }
    if (!allowed.has(":read-only")) {
      throw new Error("authority resolver trusted read-only downscope failed closed: :read-only permission profile is not currently allowed");
    }

    // This fallback is only for a caller that has already established an explicit
    // trusted ancestor and is requesting readOnly. It does not infer the unknown
    // active ceiling: it selects Codex's own currently-allowed :read-only profile.
    const runtimeWorkspaceRoots = started?.runtimeWorkspaceRoots;
    if (
      Array.isArray(runtimeWorkspaceRoots) &&
      runtimeWorkspaceRoots.length > 0 &&
      !runtimeWorkspaceRoots.some((root) => normalizeConfigPath(root) === normalizeConfigPath(authorityRoot))
    ) {
      throw new Error("authority resolver failed closed: trusted read-only downscope conflicts with thread/start runtimeWorkspaceRoots");
    }
    if (typeof started.cwd !== "string" || normalizeConfigPath(started.cwd) !== normalizeConfigPath(authorityRoot)) {
      throw new Error("authority resolver failed closed: trusted read-only downscope requires matching thread/start cwd");
    }
    return { profileId: ":read-only", provenance: "trusted-read-only-downscope" };
  }
  if (!allowed.has(explicitProfileId)) {
    throw new Error(`authority resolver explicit config profile is not currently allowed: ${explicitProfileId}`);
  }

  const runtimeWorkspaceRoots = started?.runtimeWorkspaceRoots;
  if (!Array.isArray(runtimeWorkspaceRoots) || !runtimeWorkspaceRoots.some((root) => normalizeConfigPath(root) === normalizeConfigPath(authorityRoot))) {
    throw new Error("authority resolver failed closed: explicit config provenance conflicts with thread/start runtimeWorkspaceRoots");
  }
  if (typeof started?.cwd === "string" && normalizeConfigPath(started.cwd) !== normalizeConfigPath(authorityRoot)) {
    throw new Error("authority resolver failed closed: explicit config provenance conflicts with thread/start cwd");
  }

  const expectedSandboxType = new Map([
    [":read-only", "readOnly"],
    [":workspace", "workspaceWrite"],
    [":danger-full-access", "dangerFullAccess"],
  ]).get(explicitProfileId);
  if (!expectedSandboxType) {
    throw new Error(
      `authority resolver failed closed: activePermissionProfile is null and explicit custom profile ${explicitProfileId} cannot be proven equivalent from the legacy sandbox projection`
    );
  }
  if (started?.sandbox?.type !== expectedSandboxType) {
    throw new Error(
      `authority resolver failed closed: explicit profile ${explicitProfileId} conflicts with thread/start sandbox type ${String(started?.sandbox?.type ?? "missing")}`
    );
  }

  return { profileId: explicitProfileId, provenance: explicitProfileProvenance };
}

function truncateUtf8(text, byteCap) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteCap) return { text: value, truncated: false };
  return { text: bytes.subarray(0, byteCap).toString("utf8"), truncated: true };
}

function assertNoModelOrRuntimeSideEffects(client) {
  const methods = client.notificationMethods;
  if (methods.some((method) => method.startsWith("turn/") || method === "thread/tokenUsage/updated")) {
    throw new Error("authority resolver failed closed: a model turn/token-usage event appeared during model-free resolution");
  }
  if (methods.includes("mcpServer/startupStatus/updated")) {
    throw new Error("authority resolver failed closed: an MCP runtime initialized during quiet permission resolution");
  }
}

export function classifyCommandExecCompatibilityError(message, effectiveCwd = null) {
  const text = typeof message === "string" ? message : String(message ?? "");
  const cwdNote = effectiveCwd ? ` in cwd ${effectiveCwd}` : "";

  if (/Unable to create ['\"][^'\"]*\.git(?:[\\/]worktrees[\\/][^'\"]+)?[\\/]index\.lock['\"]:\s*Permission denied/i.test(text)) {
    return {
      code: "HOST_GIT_METADATA_REQUIRED",
      message:
        `Codex command/exec sandbox denied a Git repository-metadata write${cwdNote}. ` +
        "Existing .git metadata is host/VCS state and is not writable through this sandboxed command lane.",
      nextActions: [
        "If the user explicitly requested a bounded Git metadata action such as add/commit/push, use codex.process as the host-process lane for that Git action; do not silently replay the denied command.",
        "Keep ordinary project file work on codex.command_exec or the narrower project construction tools.",
        "Do not copy GitHub tokens, credential-store secrets, or other host credentials into the command_exec sandbox.",
      ],
    };
  }

  if (/SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle failed/i.test(text)) {
    return {
      code: "WINDOWS_SCHANNEL_SANDBOX_UNAVAILABLE",
      message:
        `Windows Schannel credentials are unavailable inside the Codex command/exec sandbox${cwdNote}. ` +
        "This does not by itself mean Codexless network authority is disabled.",
      nextActions: [
        "For anonymous HTTPS in command_exec, prefer Node fetch or, for Git HTTPS where appropriate, Git's OpenSSL backend (for example http.sslBackend=openssl).",
        "If the task genuinely requires host Windows credential/keyring access such as authenticated gh/Git, use codex.process only for that bounded host-state action and only with explicit user intent.",
        "Do not paste or forward stored tokens into ChatGPT or the sandbox.",
      ],
    };
  }

  return null;
}

export function classifyCommandExecResult(result, effectiveCwd = null) {
  if (!result || result.exitCode === 0) return null;
  const diagnosticText = [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n");
  if (!diagnosticText) return null;
  return classifyCommandExecCompatibilityError(diagnosticText, effectiveCwd);
}

export class CodexAuthorityExecutor {
  #codexBin;
  #defaultCwd;
  #profileOverride;
  #configOverrides;
  #launchEnv;
  #maxTimeoutMs;
  #watchdogGraceMs;
  #outputBytesCap;
  #acceptedCodexVersions;
  #allowUntrustedReadOnlyBootstrap;
  #codexVersion = null;

  constructor({
    codexBin,
    defaultCwd = null,
    profileOverride = null,
    configOverrides = [],
    launchEnv = null,
    maxTimeoutMs = 30_000,
    watchdogGraceMs = 5_000,
    outputBytesCap = 32_768,
    acceptedCodexVersions = null,
    allowUntrustedReadOnlyBootstrap = false,
  }) {
    if (!codexBin) throw new Error("CodexAuthorityExecutor requires codexBin");
    if (defaultCwd !== null && (typeof defaultCwd !== "string" || !defaultCwd.trim())) {
      throw new Error("defaultCwd must be a non-empty string when provided");
    }
    if (profileOverride !== null && (typeof profileOverride !== "string" || !profileOverride.trim())) {
      throw new Error("profileOverride must be a non-empty string when provided");
    }
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty Codex -c key=value strings");
    }
    if (launchEnv !== null && (typeof launchEnv !== "object" || Array.isArray(launchEnv))) {
      throw new Error("launchEnv must be null or an environment object");
    }
    if (!Number.isInteger(maxTimeoutMs) || maxTimeoutMs <= 0) {
      throw new Error("maxTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(outputBytesCap) || outputBytesCap <= 0) {
      throw new Error("outputBytesCap must be a positive integer");
    }
    if (acceptedCodexVersions !== null && (!Array.isArray(acceptedCodexVersions) || !acceptedCodexVersions.length || !acceptedCodexVersions.every((value) => typeof value === "string" && value))) {
      throw new Error("acceptedCodexVersions must be null or a non-empty string array");
    }
    if (typeof allowUntrustedReadOnlyBootstrap !== "boolean") {
      throw new Error("allowUntrustedReadOnlyBootstrap must be a boolean");
    }

    this.#codexBin = codexBin;
    this.#defaultCwd = defaultCwd ? path.resolve(defaultCwd) : null;
    this.#profileOverride = profileOverride;
    this.#configOverrides = [...configOverrides];
    this.#launchEnv = launchEnv ? { ...launchEnv } : null;
    this.#maxTimeoutMs = maxTimeoutMs;
    this.#watchdogGraceMs = watchdogGraceMs;
    this.#outputBytesCap = outputBytesCap;
    this.#acceptedCodexVersions = acceptedCodexVersions === null ? null : new Set(acceptedCodexVersions);
    this.#allowUntrustedReadOnlyBootstrap = allowUntrustedReadOnlyBootstrap;
  }

  get codexVersion() {
    return this.#codexVersion;
  }

  get defaultCwd() {
    return this.#defaultCwd;
  }

  get profileOverride() {
    return this.#profileOverride;
  }

  async validate() {
    if (this.#defaultCwd) {
      this.#defaultCwd = await this.#validateCwd(this.#defaultCwd);
    }

    const { stdout } = await execFileAsync(this.#codexBin, ["--version"], {
      cwd: this.#defaultCwd ?? process.cwd(),
      ...(this.#launchEnv ? { env: this.#launchEnv } : {}),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const match = String(stdout).match(/codex-cli\s+([^\s]+)/i);
    if (!match) throw new Error(`unable to parse Codex CLI version from: ${String(stdout).trim()}`);
    this.#codexVersion = match[1];
    if (this.#acceptedCodexVersions && !this.#acceptedCodexVersions.has(this.#codexVersion)) {
      throw new Error(
        `unsupported Codex CLI version for Codexless direct-profile authority: ${this.#codexVersion}. ` +
        `Accepted versions: ${[...this.#acceptedCodexVersions].join(", ")}. ` +
        "This explicit compatibility allowlist is narrower than the detected Codex build."
      );
    }

    if (!this.#defaultCwd) {
      return {
        codexVersion: this.#codexVersion,
        defaultCwd: null,
        profileOverride: this.#profileOverride,
        configOverrides: [...this.#configOverrides],
      };
    }

    const client = this.#newClient(this.#defaultCwd, 15_000);
    await client.start();
    try {
      const configRead = await client.request("config/read", {
        cwd: this.#defaultCwd,
        includeLayers: false,
      });
      const config = configRead?.config;
      if (!config || typeof config !== "object") {
        throw new Error("Codex config/read did not return an effective config object");
      }
      const profiles = await this.#listAllowedProfiles(client, this.#defaultCwd);
      if (this.#profileOverride && !profiles.has(this.#profileOverride)) {
        throw new Error(`host profile override is not allowed by Codex for ${this.#defaultCwd}: ${this.#profileOverride}`);
      }
      const compatibilityGate = await this.#probeCompatibilityWithClient(client, config, profiles);
      return {
        codexVersion: this.#codexVersion,
        versionPolicy: this.#acceptedCodexVersions ? "allowlist+contract" : "contract",
        acceptedCodexVersions: this.#acceptedCodexVersions ? [...this.#acceptedCodexVersions] : null,
        defaultCwd: this.#defaultCwd,
        profileOverride: this.#profileOverride,
        configOverrides: [...this.#configOverrides],
        trustedAncestor: findTrustedAncestor(config, this.#defaultCwd)?.root ?? null,
        allowedProfiles: [...profiles],
        compatibilityGate,
      };
    } finally {
      await client.close();
    }
  }

  async resolveAuthority({ cwd = null, access = "inherit", timeoutMs = 10_000 } = {}) {
    if (!SUPPORTED_ACCESS.has(access)) {
      throw new Error(`unsupported access mode: ${access}`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.#maxTimeoutMs) {
      throw new Error(`timeoutMs must be an integer between 1 and ${this.#maxTimeoutMs}`);
    }
    if (!this.#codexVersion) {
      throw new Error("CodexAuthorityExecutor.validate() must succeed before resolveAuthority()");
    }

    const requestedCwd = cwd ?? this.#defaultCwd;
    if (!requestedCwd) {
      throw new Error("cwd is required when no local default cwd is configured");
    }
    const effectiveCwd = await this.#validateCwd(requestedCwd);
    const client = this.#newClient(effectiveCwd, timeoutMs + this.#watchdogGraceMs);
    await client.start();
    try {
      return await this.#resolveAuthorityWithClient(client, effectiveCwd, access, timeoutMs);
    } finally {
      await client.close();
    }
  }

  async exec({ command, cwd = null, access = "inherit", timeoutMs = 10_000 }) {
    if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === "string")) {
      throw new Error("command must be a non-empty argv string array");
    }
    if (!SUPPORTED_ACCESS.has(access)) {
      throw new Error(`unsupported access mode: ${access}`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.#maxTimeoutMs) {
      throw new Error(`timeoutMs must be an integer between 1 and ${this.#maxTimeoutMs}`);
    }
    if (!this.#codexVersion) {
      throw new Error("CodexAuthorityExecutor.validate() must succeed before exec()");
    }

    assertRemoteModelFreeMethod("command/exec");

    const requestedCwd = cwd ?? this.#defaultCwd;
    if (!requestedCwd) {
      throw new Error("cwd is required when no local default cwd is configured");
    }
    const effectiveCwd = await this.#validateCwd(requestedCwd);
    const executable = await resolveWindowsExecutable(command);
    const client = this.#newClient(effectiveCwd, timeoutMs + this.#watchdogGraceMs);
    await client.start();

    try {
      const resolvedAuthority = await this.#resolveAuthorityWithClient(client, effectiveCwd, access, timeoutMs);

      const result = await client.exec(
         {
           command: executable.command,
           cwd: effectiveCwd,
          permissionProfile: resolvedAuthority.permissionProfile,
           timeoutMs,
         },
         { timeoutMs: timeoutMs + this.#watchdogGraceMs }
       );

      assertNoModelOrRuntimeSideEffects(client);

      const compatibility = classifyCommandExecResult(result, effectiveCwd);
      const stdout = truncateUtf8(result.stdout, this.#outputBytesCap);
      const stderr = truncateUtf8(result.stderr, this.#outputBytesCap);
      return {
        ...result,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(compatibility
          ? {
              errorCode: compatibility.code,
              diagnostic: compatibility.message,
              nextActions: compatibility.nextActions,
            }
          : {}),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        access,
        effectiveCwd,
        permissionProfile: resolvedAuthority.permissionProfile,
        permissionCeiling: resolvedAuthority.permissionCeiling,
        authoritySource: resolvedAuthority.authoritySource,
        trustedAncestor: resolvedAuthority.trustedAncestor,
        executableResolution: executable.executableResolution,
         notificationMethods: client.notificationMethods,
         serverRequestMethods: client.serverRequestMethods,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyCommandExecCompatibilityError(message, effectiveCwd);
      if (classified) {
        const wrapped = new Error(classified.message);
        wrapped.code = classified.code;
        wrapped.nextActions = classified.nextActions;
        throw wrapped;
      }
      if (/CreateProcessWithLogonW failed:\s*267|helper_unknown_error|setup refresh had errors/i.test(message)) {
        throw new Error(
          `Codex Windows sandbox could not execute in cwd ${effectiveCwd}. ` +
          "Mapped/virtual drives such as Google Drive remain an upstream Codex compatibility case that requires the separate Codex approval/external-execution lane. " +
          `Original error: ${message}`
        );
      }
      throw error;
    } finally {
      await client.close();
    }
  }

  async #resolveAuthorityWithClient(client, effectiveCwd, access, timeoutMs) {
    const configRead = await client.request("config/read", {
      cwd: effectiveCwd,
      includeLayers: false,
    });
    const effectiveConfig = configRead?.config;
    if (!effectiveConfig || typeof effectiveConfig !== "object") {
      throw new Error("authority resolver failed closed: Codex config/read returned no effective config");
    }

    const allowedProfiles = await this.#listAllowedProfiles(client, effectiveCwd);
    const trusted = findTrustedAncestor(effectiveConfig, effectiveCwd);
    if (!trusted && access === "readOnly" && this.#allowUntrustedReadOnlyBootstrap) {
      if (!allowedProfiles.has(":read-only")) {
        throw new Error("managed read-only bootstrap failed: :read-only permission profile is not currently allowed");
      }
      return {
        effectiveCwd,
        permissionProfile: ":read-only",
        permissionCeiling: ":read-only",
        authoritySource: "untrusted-read-only-bootstrap",
        trustedAncestor: null,
      };
    }
    if (this.#profileOverride && !trusted) {
      throw new ToolwirePermissionError(
        `Codex has no explicitly trusted project/root covering cwd ${effectiveCwd}; a host profile override may select permissions only inside an already authorized root.`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Explicitly trust/authorize the target path in Codex or local Codexless policy, then retry.",
            "Use a cwd already covered by an explicitly trusted Codex project/root.",
          ],
        }
      );
    }
    const authority = this.#profileOverride
      ? {
          profileId: this.#profileOverride,
          source: "host-profile-override",
          trustedAncestor: trusted.root,
        }
      : await this.#resolveCodexProfile(client, effectiveConfig, effectiveCwd, timeoutMs, allowedProfiles, {
          allowTrustedReadOnlyDownscope: access === "readOnly",
        });

    if (!allowedProfiles.has(authority.profileId)) {
      throw new Error(`authority resolver returned a Codex profile that is not currently allowed: ${authority.profileId}`);
    }

    const permissionProfile = boundLinuxPermissionProfile(authority.profileId, { access, allowedProfiles });
    if (!allowedProfiles.has(permissionProfile)) {
      throw new Error(`requested Codexless downscope is not available in Codex: ${permissionProfile}`);
    }

    return {
      effectiveCwd,
      permissionProfile,
      permissionCeiling: boundLinuxPermissionProfile(authority.profileId, { access: "inherit", allowedProfiles }),
      authoritySource: authority.source,
      trustedAncestor: authority.trustedAncestor,
    };
  }

  async #resolveCodexProfile(
    client,
    effectiveConfig,
    cwd,
    timeoutMs,
    allowedProfiles,
    { allowTrustedReadOnlyDownscope = false } = {}
  ) {
    const trusted = findTrustedAncestor(effectiveConfig, cwd);
    if (!trusted) {
      throw new ToolwirePermissionError(
        `Codex has no explicitly trusted project/root covering cwd ${cwd}; Codexless will not create trust as a side effect of permission resolution.`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Explicitly trust/authorize the target path in Codex or local Codexless policy, then retry.",
            "Use a cwd already covered by an explicitly trusted Codex project/root.",
          ],
        }
      );
    }

    // Codex project trust is recorded on the authorized project/root. A narrower
    // command cwd is execution context inside that authority root; resolving a
    // brand-new ephemeral thread at the narrower cwd would otherwise fall back
    // to :read-only simply because that exact subdirectory has no trust entry.
    const authorityRoot = await this.#validateCwd(trusted.root);
    let resolverConfig = effectiveConfig;
    if (normalizeConfigPath(authorityRoot) !== normalizeConfigPath(cwd)) {
      const rootConfigRead = await client.request("config/read", {
        cwd: authorityRoot,
        includeLayers: false,
      });
      resolverConfig = rootConfigRead?.config;
      if (!resolverConfig || typeof resolverConfig !== "object") {
        throw new Error("authority resolver failed closed: Codex config/read returned no config for the trusted authority root");
      }
    }

    const started = await client.request(
      "thread/start",
      {
        cwd: authorityRoot,
        ephemeral: true,
        config: buildQuietSessionConfig(resolverConfig),
      },
      { timeoutMs: Math.min(timeoutMs + this.#watchdogGraceMs, 15_000) }
    );
    const normalizedAuthority = normalizeCodexAuthorityProjection({
      started,
      effectiveConfig: resolverConfig,
      allowedProfiles,
      authorityRoot,
      allowTrustedReadOnlyDownscope,
    });

    assertNoModelOrRuntimeSideEffects(client);
    return {
      profileId: normalizedAuthority.profileId,
      source: normalizedAuthority.provenance === "trusted-read-only-downscope"
        ? "trusted-read-only-downscope"
        : "codex-quiet-profile-resolver",
      trustedAncestor: trusted.root,
    };
  }

  async #probeCompatibilityWithClient(client, effectiveConfig, allowedProfiles) {
    if (!allowedProfiles.has(":read-only")) {
      throw new Error("Codex compatibility gate failed: :read-only permission profile is not currently allowed");
    }

    const trusted = findTrustedAncestor(effectiveConfig, this.#defaultCwd);
    // Linux can start and advertise its public surface before the user selects
    // an already trusted project. This probe only checks the read-only runtime;
    // operation authority still requires trust in #resolveAuthorityWithClient.
    if (!trusted && (this.#allowUntrustedReadOnlyBootstrap || process.platform === "linux")) {
      const result = await client.exec(
        {
          command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(COMPATIBILITY_PROBE_MARKER)})`],
          cwd: this.#defaultCwd,
          permissionProfile: ":read-only",
          timeoutMs: 5_000,
        },
        { timeoutMs: 10_000 }
      );
      assertNoModelOrRuntimeSideEffects(client);
      if (result?.exitCode !== 0 || String(result?.stdout ?? "") !== COMPATIBILITY_PROBE_MARKER) {
        throw new Error(
          `Codex compatibility gate failed: managed untrusted read-only command/exec probe did not return the expected marker (exit=${String(result?.exitCode ?? "unknown")})`
        );
      }
      return {
        status: "pass",
        commandExecReadOnly: true,
        permissionProfile: ":read-only",
        permissionCeiling: ":read-only",
        authoritySource: "untrusted-read-only-bootstrap",
      };
    }
    if (!trusted) {
      throw new ToolwirePermissionError(
        `Codex has no explicitly trusted project/root covering cwd ${this.#defaultCwd}; Codexless cannot run the compatibility gate outside an already authorized root.`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Explicitly trust/authorize the Codexless project root in Codex, then restart Codexless.",
            "Do not widen Codex permissions merely to make a new Codex version pass the compatibility gate.",
          ],
        }
      );
    }

    const authority = this.#profileOverride
      ? { profileId: this.#profileOverride, source: "host-profile-override", trustedAncestor: trusted.root }
      : await this.#resolveCodexProfile(client, effectiveConfig, this.#defaultCwd, 10_000, allowedProfiles, {
          allowTrustedReadOnlyDownscope: true,
        });
    if (!allowedProfiles.has(authority.profileId)) {
      throw new Error(`Codex compatibility gate failed: resolved authority profile is not allowed: ${authority.profileId}`);
    }

    const result = await client.exec(
      {
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(COMPATIBILITY_PROBE_MARKER)})`],
        cwd: this.#defaultCwd,
        permissionProfile: ":read-only",
        timeoutMs: 5_000,
      },
      { timeoutMs: 10_000 }
    );
    assertNoModelOrRuntimeSideEffects(client);
    if (result?.exitCode !== 0 || String(result?.stdout ?? "") !== COMPATIBILITY_PROBE_MARKER) {
      throw new Error(
        `Codex compatibility gate failed: model-free command/exec read-only probe did not return the expected marker (exit=${String(result?.exitCode ?? "unknown")})`
      );
    }

    return {
      status: "pass",
      commandExecReadOnly: true,
      permissionProfile: ":read-only",
      permissionCeiling: authority.profileId,
      authoritySource: authority.source,
    };
  }

  async #listAllowedProfiles(client, cwd) {
    const listed = await client.request("permissionProfile/list", { cwd });
    const rows = Array.isArray(listed?.data) ? listed.data : [];
    const allowed = rows
      .filter((row) => row?.allowed === true && typeof row?.id === "string")
      .map((row) => row.id);
    if (!allowed.length) {
      throw new Error("Codex permissionProfile/list returned no allowed profiles");
    }
    return new Set(allowed);
  }

  #newClient(cwd, requestTimeoutMs) {
    return new CodexAppServerClient({
      cwd,
      launch: () => ({
        command: this.#codexBin,
        args: [
          ...this.#configOverrides.flatMap((value) => ["-c", value]),
          "app-server",
          "--stdio",
        ],
        options: { cwd, ...(this.#launchEnv ? { env: this.#launchEnv } : {}) },
      }),
      requestTimeoutMs,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: {
        name: "codexless_authority",
        title: "Codexless",
        version: "0.1.50-household-workspace",
      },
    });
  }

  async #validateCwd(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("cwd must be a non-empty string");
    }
    const resolved = path.resolve(value);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
    return realpath(resolved);
  }
}
