import { randomUUID } from "node:crypto";
import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { projectCodexModel } from "./codex-model-catalog.mjs";
import { listAllMcpServerStatus } from "./mcp-status-pagination.mjs";
import { readPreviewAccountPreflight } from "./codex-preview-account-preflight.mjs";
import {
  STOCK_RUNTIME_KIND,
  StockPromptInputSkillRoutingCore,
  implicitSkillRoutingUnavailable,
} from "./stock-prompt-input-skill-routing.mjs";

const MAX_BUFFER_CHARS = 512_000;
const PROCESS_RECEIPT_TTL_MS = 60 * 60_000;
const MAX_PROCESS_RECEIPTS = 100;
const CHROME_SKILL_NAME = "chrome:control-chrome";
const CHROME_PLUGIN_ID = "chrome@openai-bundled";

export function projectCurrentChromePlugin(result) {
  for (const marketplace of result?.marketplaces ?? []) {
    const plugin = (marketplace?.plugins ?? []).find((entry) => entry?.id === CHROME_PLUGIN_ID);
    if (!plugin) continue;
    const localVersion = typeof plugin.localVersion === "string" && plugin.localVersion.trim()
      ? plugin.localVersion.trim()
      : null;
    if (!localVersion) return null;
    return {
      id: CHROME_PLUGIN_ID,
      name: typeof plugin.name === "string" ? plugin.name : "chrome",
      localVersion,
      sourcePath: typeof plugin?.source?.path === "string" ? plugin.source.path : null,
    };
  }
  return null;
}

function decodeBase64(value) {
  return Buffer.from(value ?? "", "base64").toString("utf8");
}

function appendBounded(current, addition) {
  const next = `${current}${addition}`;
  if (next.length <= MAX_BUFFER_CHARS) return { text: next, truncated: false };
  return { text: next.slice(next.length - MAX_BUFFER_CHARS), truncated: true };
}

export class CodexWorkbenchExecutor {
  #client;
  #codexBin;
  #defaultCwd;
  #configOverrides;
  #launchEnv;
  #skillRouting;
  #runtimeInfo;
  #exitedProcessTtlMs;
  #processes = new Map();
  #processReceipts = new Map();
  #threadsByCwd = new Map();
  #unsubscribe = null;
  #generation = 0;
  #startPromise = null;
  #restartPromise = null;

  constructor({
    codexBin,
    defaultCwd,
    configOverrides = [],
    launchEnv = null,
    runtimeInfo = null,
    exitedProcessTtlMs = 30_000,
    clientFactory = null,
    promptInputRunner = null,
    serverRequestHandler = null,
  }) {
    if (!codexBin) throw new Error("CodexWorkbenchExecutor requires codexBin");
    if (!defaultCwd) throw new Error("CodexWorkbenchExecutor requires defaultCwd");
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty strings");
    }
    if (launchEnv !== null && (typeof launchEnv !== "object" || Array.isArray(launchEnv))) {
      throw new Error("launchEnv must be null or an environment object");
    }
    if (runtimeInfo !== null && (typeof runtimeInfo !== "object" || Array.isArray(runtimeInfo))) {
      throw new Error("runtimeInfo must be null or an object");
    }
    if (!Number.isInteger(exitedProcessTtlMs) || exitedProcessTtlMs < 1) {
      throw new Error("exitedProcessTtlMs must be a positive integer");
    }
    if (serverRequestHandler !== null && typeof serverRequestHandler !== "function") {
      throw new Error("serverRequestHandler must be null or a function");
    }

    this.#codexBin = codexBin;
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#configOverrides = [...configOverrides];
    this.#launchEnv = launchEnv ? { ...launchEnv } : null;
    this.#runtimeInfo = runtimeInfo ? structuredClone(runtimeInfo) : null;
    this.#exitedProcessTtlMs = exitedProcessTtlMs;
    const routingOptions = {
      runtimeKind: STOCK_RUNTIME_KIND,
      codexBin: this.#codexBin,
      appServerCwd: this.#defaultCwd,
      configOverrides: this.#configOverrides,
      launchEnv: this.#launchEnv,
    };
    if (promptInputRunner !== null) {
      if (typeof promptInputRunner !== "function") throw new Error("promptInputRunner must be null or a function");
      routingOptions.promptInputRunner = promptInputRunner;
    }
    this.#skillRouting = new StockPromptInputSkillRoutingCore(routingOptions);
    const clientOptions = {
      cwd: this.#defaultCwd,
      launch: () => ({
        command: codexBin,
        args: [
          ...this.#configOverrides.flatMap((value) => ["-c", value]),
          "app-server",
          "--stdio",
        ],
        options: { cwd: this.#defaultCwd, ...(this.#launchEnv ? { env: this.#launchEnv } : {}) },
      }),
      requestTimeoutMs: 30_000,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: {
        name: "codex_toolbox_workbench_preview",
        title: "Codex Toolbox Workbench Preview",
        version: "0.0.1",
      },
    };
    if (serverRequestHandler) clientOptions.serverRequestHandler = serverRequestHandler;
    this.#client = clientFactory ? clientFactory(clientOptions) : new CodexAppServerClient(clientOptions);
  }

  get notificationMethods() {
    return this.#client.notificationMethods;
  }

  get serverRequestMethods() {
    return this.#client.serverRequestMethods;
  }

  get generation() {
    return this.#generation;
  }

  get running() {
    return this.#client.running;
  }

  async start() {
    return this.#ensureStarted();
  }

  async restart() {
    if (this.#restartPromise) return this.#restartPromise;
    this.#restartPromise = (async () => {
      await this.close();
      return this.#ensureStarted();
    })();
    try {
      return await this.#restartPromise;
    } finally {
      this.#restartPromise = null;
    }
  }

  async #ensureStarted() {
    if (this.#client.running) return this.#client.initializedResult ?? null;
    if (this.#startPromise) return this.#startPromise;

    const restarting = this.#generation > 0;
    this.#startPromise = (async () => {
      if (restarting) this.#retireTransientStateForRestart();
      const initialized = await this.#client.start();
      if (!this.#unsubscribe) {
        this.#unsubscribe = this.#client.onNotification((message) => this.#onNotification(message));
      }
      this.#generation += 1;
      return initialized;
    })();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  #retireTransientStateForRestart() {
    for (const process of this.#processes.values()) {
      if (process.retireTimer) clearTimeout(process.retireTimer);
    }
    this.#processes.clear();
    this.#threadsByCwd.clear();
  }

  async #request(method, params, { expectedGeneration = null, ...options } = {}) {
    await this.#ensureStarted();
    if (expectedGeneration !== null && expectedGeneration !== this.#generation) {
      throw new Error(
        `WORKBENCH_GENERATION_STALE: expected=${expectedGeneration} current=${this.#generation}; ` +
        "the persistent Codex app-server restarted before this request was dispatched"
      );
    }
    return this.#client.request(method, params, options);
  }

  async close() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const process of this.#processes.values()) {
      if (process.retireTimer) clearTimeout(process.retireTimer);
      if (!process.exited) {
        try {
          await this.#client.request("process/kill", { processHandle: process.handle }, { timeoutMs: 2_000 });
        } catch {}
      }
    }
    this.#processes.clear();
    for (const receipt of this.#processReceipts.values()) if (receipt.retireTimer) clearTimeout(receipt.retireTimer);
    this.#processReceipts.clear();
    this.#threadsByCwd.clear();
    await this.#client.close();
  }

  async projectContext({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const method = "thread/start";
    const params = { cwd: effectiveCwd, ephemeral: true };
    const started = await this.#request(method, params);
    let implicit;
    try {
      implicit = await this.#skillRouting.readImplicitFromThreadStart({ method, params, result: started });
    } catch {
      implicit = implicitSkillRoutingUnavailable(
        "IMPLICIT_SKILLS_CORE_FAILED",
        "implicit Skill routing failed closed without affecting project context"
      );
    }
    return {
      threadId: started?.thread?.id ?? null,
      cwd: started?.cwd ?? started?.thread?.cwd ?? effectiveCwd,
      activePermissionProfile: started?.activePermissionProfile ?? null,
      runtimeWorkspaceRoots: started?.runtimeWorkspaceRoots ?? [],
      instructionSources: started?.instructionSources ?? [],
      approvalPolicy: started?.approvalPolicy ?? null,
      approvalsReviewer: started?.approvalsReviewer ?? null,
      sandbox: started?.sandbox ?? null,
      cliVersion: started?.thread?.cliVersion ?? null,
      skillRouting: { implicit },
    };
  }

  async accountPreflight() {
    const result = await readPreviewAccountPreflight({
      codexBin: this.#codexBin,
      defaultCwd: this.#defaultCwd,
      configOverrides: this.#configOverrides,
      launchEnv: this.#launchEnv,
    });
    if (!this.#runtimeInfo) return result;
    const accountMissing = result?.account?.status === "ok" && result.account.accountPresent === false;
    const { loginJourney, ...runtime } = this.#runtimeInfo;
    return {
      ...result,
      runtime: structuredClone(runtime),
      loginJourney: accountMissing && this.#runtimeInfo.lane === "managed"
        ? structuredClone(loginJourney ?? null)
        : null,
    };
  }

  async listModels({ cursor = null, limit = null, includeHidden = false } = {}) {
    if (cursor !== null && (typeof cursor !== "string" || !cursor)) throw new Error("cursor must be a non-empty string when provided");
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error("limit must be an integer from 1 to 200 when provided");
    if (typeof includeHidden !== "boolean") throw new Error("includeHidden must be a boolean");
    const result = await this.#request("model/list", {
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
      includeHidden,
    });
    return {
      models: Array.isArray(result?.data) ? result.data.map(projectCodexModel).filter(Boolean) : [],
      nextCursor: typeof result?.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async fsRead({ operation, target, query, roots }) {
    switch (operation) {
      case "readText": {
        const result = await this.#request("fs/readFile", { path: path.resolve(target) });
        return {
          path: path.resolve(target),
          text: decodeBase64(result?.dataBase64),
          byteLength: Buffer.from(result?.dataBase64 ?? "", "base64").length,
        };
      }
      case "list":
        return this.#request("fs/readDirectory", { path: path.resolve(target) });
      case "metadata":
        return this.#request("fs/getMetadata", { path: path.resolve(target) });
      case "search": {
        const effectiveRoots = Array.isArray(roots) && roots.length ? roots.map((value) => path.resolve(value)) : [this.#defaultCwd];
        return this.#request("fuzzyFileSearch", { query, roots: effectiveRoots });
      }
      default:
        throw new Error(`unsupported fs read operation: ${operation}`);
    }
  }

  async fsMutate({ operation, target, text, source, destination, recursive = true, force = true }) {
    switch (operation) {
      case "writeText":
        return this.#request("fs/writeFile", {
          path: path.resolve(target),
          dataBase64: Buffer.from(text ?? "", "utf8").toString("base64"),
        });
      case "mkdir":
        return this.#request("fs/createDirectory", { path: path.resolve(target), recursive });
      case "copy":
        return this.#request("fs/copy", {
          sourcePath: path.resolve(source),
          destinationPath: path.resolve(destination),
          recursive,
        });
      case "remove":
        return this.#request("fs/remove", { path: path.resolve(target), recursive, force });
      default:
        throw new Error(`unsupported fs mutate operation: ${operation}`);
    }
  }

  async processAction(input) {
    const action = input.action;
    await this.#ensureStarted();
    if (action === "start") {
      const processRef = `proc_${randomUUID()}`;
      const receiptRef = `terminal_receipt_${randomUUID()}`;
      const handle = `toolwire-workbench-${randomUUID()}`;
      const cwd = path.resolve(input.cwd ?? this.#defaultCwd);
      const state = {
        processRef,
        receiptRef,
        handle,
        cwd,
        command: [...input.command],
        startedAt: Date.now(),
        fullStdout: "",
        fullStderr: "",
        fullStdoutTruncated: false,
        fullStderrTruncated: false,
        pendingStdout: "",
        pendingStderr: "",
        pendingStdoutTruncated: false,
        pendingStderrTruncated: false,
        pendingEvents: [],
        pendingEventsTruncated: false,
        exited: null,
        retireTimer: null,
        workbenchGeneration: this.#generation,
      };
      this.#processes.set(processRef, state);
      try {
        await this.#request("process/spawn", {
          command: input.command,
          processHandle: handle,
          cwd,
          tty: input.tty ?? true,
          size: input.tty === false ? null : { rows: input.rows ?? 24, cols: input.cols ?? 100 },
          streamStdin: input.tty === false ? true : undefined,
          streamStdoutStderr: input.tty === false ? true : undefined,
          outputBytesCap: null,
          timeoutMs: input.timeoutMs ?? null,
        }, { expectedGeneration: state.workbenchGeneration });
      } catch (error) {
        this.#processes.delete(processRef);
        throw error;
      }
      return { status: "started", processRef, receiptRef, cwd, tty: input.tty ?? true };
    }

    const state = this.#requireProcess(input.processRef);
    if (action === "poll") {
      const stdout = state.pendingStdout;
      const stderr = state.pendingStderr;
      const events = state.pendingEvents;
      const stdoutTruncated = state.pendingStdoutTruncated;
      const stderrTruncated = state.pendingStderrTruncated;
      const eventsTruncated = state.pendingEventsTruncated;
      state.pendingStdout = "";
      state.pendingStderr = "";
      state.pendingEvents = [];
      state.pendingStdoutTruncated = false;
      state.pendingStderrTruncated = false;
      state.pendingEventsTruncated = false;
      const exited = state.exited;
      if (exited) {
        if (state.retireTimer) clearTimeout(state.retireTimer);
        this.#processes.delete(state.processRef);
      }
      return {
        status: exited ? "exited" : "running",
        processRef: state.processRef,
        receiptRef: state.receiptRef,
        stdout,
        stderr,
        events,
        stdoutTruncated,
        stderrTruncated,
        eventsTruncated,
        exit: exited,
      };
    }
    if (action === "write") {
      await this.#request("process/writeStdin", {
        processHandle: state.handle,
        deltaBase64: input.text === undefined ? null : Buffer.from(input.text, "utf8").toString("base64"),
        closeStdin: input.closeStdin ?? false,
      }, { expectedGeneration: state.workbenchGeneration });
      return { status: "written", processRef: state.processRef, closeStdin: input.closeStdin ?? false };
    }
    if (action === "resize") {
      await this.#request("process/resizePty", {
        processHandle: state.handle,
        size: { rows: input.rows, cols: input.cols },
      }, { expectedGeneration: state.workbenchGeneration });
      return { status: "resized", processRef: state.processRef, rows: input.rows, cols: input.cols };
    }
    if (action === "kill") {
      await this.#request("process/kill", { processHandle: state.handle }, { expectedGeneration: state.workbenchGeneration });
      return { status: "kill_requested", processRef: state.processRef };
    }
    throw new Error(`unsupported process action: ${action}`);
  }

  async processReceipt({ receiptRef }) {
    if (typeof receiptRef !== "string" || !receiptRef.startsWith("terminal_receipt_")) {
      throw new Error("receiptRef must be an opaque terminal_receipt reference returned by codex.process");
    }
    const receipt = this.#processReceipts.get(receiptRef);
    if (!receipt) throw new Error(`unknown or retired terminal receiptRef: ${receiptRef}`);
    return {
      status: "exited",
      receiptRef,
      processRef: receipt.processRef,
      cwd: receipt.cwd,
      command: [...receipt.command],
      startedAt: receipt.startedAt,
      exitedAt: receipt.exitedAt,
      stdout: receipt.stdout,
      stderr: receipt.stderr,
      stdoutTruncated: receipt.stdoutTruncated,
      stderrTruncated: receipt.stderrTruncated,
      exit: structuredClone(receipt.exit),
    };
  }

  async catalog({ kind, cwd = this.#defaultCwd, query = "" }) {
    const effectiveCwd = path.resolve(cwd);
    if (kind === "skills") {
      const result = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: true });
      const skills = (result?.data ?? []).flatMap((row) => row?.skills ?? []);
      const needle = query.trim().toLowerCase();
      return {
        cwd: effectiveCwd,
        count: skills.length,
        skills: needle ? skills.filter((skill) => `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(needle)) : skills,
      };
    }
    if (kind === "apps") {
      const result = await this.#request("app/installed", { forceRefresh: false });
      const apps = result?.apps ?? [];
      const needle = query.trim().toLowerCase();
      return { count: apps.length, apps: needle ? apps.filter((app) => `${app.runtimeName} ${app.id}`.toLowerCase().includes(needle)) : apps };
    }
    if (kind === "plugins") {
      const result = await this.#request("plugin/list", { cwds: [effectiveCwd], forceRefetch: false });
      if (!query.trim()) return summarizePlugins(result);
      return filterJsonObject(result, query);
    }
    if (kind === "mcp") {
      const result = await listAllMcpServerStatus(
        (params) => this.#request("mcpServerStatus/list", params),
        { detail: "toolsAndAuthOnly", limit: 50 }
      );
      const needle = query.trim().toLowerCase();
      const data = (result?.data ?? []).map((server) => {
        const tools = server?.tools && typeof server.tools === "object" ? Object.values(server.tools) : [];
        const filtered = needle ? tools.filter((tool) => `${tool.name ?? ""} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(needle)) : tools;
        return {
          name: server.name,
          authStatus: server.authStatus ?? null,
          toolCount: tools.length,
          tools: needle ? filtered : filtered.slice(0, 50).map(compactTool),
          toolsTruncated: !needle && tools.length > 50,
          error: server.error ?? null,
        };
      });
      return { servers: data, nextCursor: null };
    }
    throw new Error(`unsupported catalog kind: ${kind}`);
  }

  async readSkill({ name, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    const result = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: true });
    const skills = (result?.data ?? []).flatMap((row) => row?.skills ?? []);
    const exact = skills.find((skill) => skill.name === name);
    const matches = exact ? [exact] : skills.filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()));
    if (matches.length !== 1) {
      return { status: matches.length ? "ambiguous" : "not_found", matches: matches.map((skill) => ({ name: skill.name, path: skill.path })) };
    }
    const skill = matches[0];
    const read = await this.#request("fs/readFile", { path: skill.path });
    return {
      status: "ok",
      name: skill.name,
      description: skill.description ?? null,
      path: skill.path,
      text: decodeBase64(read?.dataBase64),
    };
  }

  async configuredMcpServerNames({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const configRead = await this.#request("config/read", { cwd: effectiveCwd, includeLayers: false });
    const config = configRead?.config ?? {};
    const servers = config?.mcp_servers ?? config?.mcpServers ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
    return Object.keys(servers);
  }

  async configuredMcpServer({ name, cwd = this.#defaultCwd } = {}) {
    if (typeof name !== "string" || !name) throw new Error("configuredMcpServer requires a non-empty name");
    const effectiveCwd = path.resolve(cwd);
    const configRead = await this.#request("config/read", { cwd: effectiveCwd, includeLayers: false });
    const config = configRead?.config ?? {};
    const servers = config?.mcp_servers ?? config?.mcpServers ?? {};
    const value = servers?.[name];
    return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : null;
  }

  async currentChromeSkill({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const result = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: false });
    const skills = (result?.data ?? []).flatMap((row) => row?.skills ?? []);
    const chromeSkill = skills.find((skill) => skill?.name === CHROME_SKILL_NAME && skill?.enabled !== false);
    return chromeSkill?.path ? { name: CHROME_SKILL_NAME, path: chromeSkill.path } : null;
  }

  async currentChromePlugin({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const result = await this.#request("plugin/list", { cwds: [effectiveCwd], forceRefetch: false });
    return projectCurrentChromePlugin(result);
  }

  async mcpCall({ server, tool, arguments: args = {}, cwd = this.#defaultCwd, meta = null, expectedGeneration = null }) {
    const effectiveCwd = path.resolve(cwd);
    const threadId = await this.#ensureThread(effectiveCwd, expectedGeneration);
    const params = { server, tool, threadId, arguments: args };
    if (meta && typeof meta === "object") params._meta = meta;
    const result = await this.#request("mcpServer/tool/call", params, { timeoutMs: 60_000, expectedGeneration });
    return projectMcpToolCallResponse({ server, tool, result });
  }

  async #ensureThread(cwd, expectedGeneration = null) {
    await this.#ensureStarted();
    if (expectedGeneration !== null && expectedGeneration !== this.#generation) {
      throw new Error(
        `WORKBENCH_GENERATION_STALE: expected=${expectedGeneration} current=${this.#generation}; ` +
        "the persistent Codex app-server restarted before this request was dispatched"
      );
    }
    const existing = this.#threadsByCwd.get(cwd);
    if (existing) return existing;
    const started = await this.#request("thread/start", { cwd, ephemeral: true }, { expectedGeneration });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id for workbench runtime context");
    this.#threadsByCwd.set(cwd, threadId);
    return threadId;
  }

  #storeProcessReceipt(state) {
    const prior = this.#processReceipts.get(state.receiptRef);
    if (prior?.retireTimer) clearTimeout(prior.retireTimer);
    const receipt = {
      receiptRef: state.receiptRef,
      processRef: state.processRef,
      cwd: state.cwd,
      command: [...state.command],
      startedAt: state.startedAt,
      exitedAt: Date.now(),
      stdout: state.fullStdout,
      stderr: state.fullStderr,
      stdoutTruncated: state.fullStdoutTruncated,
      stderrTruncated: state.fullStderrTruncated,
      exit: structuredClone(state.exited),
      retireTimer: null,
    };
    receipt.retireTimer = setTimeout(() => {
      const current = this.#processReceipts.get(state.receiptRef);
      if (current === receipt) this.#processReceipts.delete(state.receiptRef);
    }, PROCESS_RECEIPT_TTL_MS);
    receipt.retireTimer.unref?.();
    this.#processReceipts.set(state.receiptRef, receipt);
    while (this.#processReceipts.size > MAX_PROCESS_RECEIPTS) {
      const oldestRef = this.#processReceipts.keys().next().value;
      const oldest = this.#processReceipts.get(oldestRef);
      if (oldest?.retireTimer) clearTimeout(oldest.retireTimer);
      this.#processReceipts.delete(oldestRef);
    }
  }

  #requireProcess(processRef) {
    if (typeof processRef !== "string" || !processRef) throw new Error("processRef is required");
    const state = this.#processes.get(processRef);
    if (!state) throw new Error(`unknown or retired processRef: ${processRef}`);
    return state;
  }

  #onNotification(message) {
    if (message.method === "process/outputDelta") {
      const state = [...this.#processes.values()].find((item) => item.handle === message.params?.processHandle);
      if (!state) return;
      const text = decodeBase64(message.params?.deltaBase64);
      const stream = message.params?.stream === "stderr" ? "stderr" : "stdout";
      const bufferKey = stream === "stderr" ? "pendingStderr" : "pendingStdout";
      const truncatedKey = stream === "stderr" ? "pendingStderrTruncated" : "pendingStdoutTruncated";
      const bounded = appendBounded(state[bufferKey], text);
      state[bufferKey] = bounded.text;
      state[truncatedKey] = state[truncatedKey] || bounded.truncated || Boolean(message.params?.capReached);
      const fullBufferKey = stream === "stderr" ? "fullStderr" : "fullStdout";
      const fullTruncatedKey = stream === "stderr" ? "fullStderrTruncated" : "fullStdoutTruncated";
      const fullBounded = appendBounded(state[fullBufferKey], text);
      state[fullBufferKey] = fullBounded.text;
      state[fullTruncatedKey] = state[fullTruncatedKey] || fullBounded.truncated || Boolean(message.params?.capReached);
      state.pendingEvents.push({ type: "output", stream, chars: text.length, at: Date.now() });
      if (state.pendingEvents.length > 500) {
        state.pendingEvents.splice(0, state.pendingEvents.length - 500);
        state.pendingEventsTruncated = true;
      }
      return;
    }
    if (message.method === "process/exited") {
      const state = [...this.#processes.values()].find((item) => item.handle === message.params?.processHandle);
      if (!state) return;
      state.exited = {
        exitCode: message.params?.exitCode ?? null,
        stdout: message.params?.stdout ?? null,
        stderr: message.params?.stderr ?? null,
        stdoutCapReached: message.params?.stdoutCapReached ?? null,
        stderrCapReached: message.params?.stderrCapReached ?? null,
      };
      this.#storeProcessReceipt(state);
      state.retireTimer = setTimeout(() => {
        const current = this.#processes.get(state.processRef);
        if (current === state && current.exited) this.#processes.delete(state.processRef);
      }, this.#exitedProcessTtlMs);
      state.retireTimer.unref?.();
      state.pendingEvents.push({ type: "exited", exitCode: state.exited.exitCode, at: Date.now() });
      if (state.pendingEvents.length > 500) {
        state.pendingEvents.splice(0, state.pendingEvents.length - 500);
        state.pendingEventsTruncated = true;
      }
    }
  }
}

function projectMcpToolCallResponse({ server, tool, result }) {
  const contentItems = Array.isArray(result?.content) ? structuredClone(result.content) : [];
  const textParts = contentItems
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  return {
    server,
    tool,
    isError: result?.isError === true,
    text: textParts.length ? textParts.join("\n") : null,
    contentItems,
    data: result?.structuredContent === undefined ? null : structuredClone(result.structuredContent),
  };
}

function compactTool(tool) {
  return { name: tool?.name ?? null, title: tool?.title ?? null, description: tool?.description ?? null };
}

function summarizePlugins(result) {
  const marketplaces = result?.marketplaces ?? result?.data ?? [];
  if (!Array.isArray(marketplaces)) return result;
  return {
    marketplaceCount: marketplaces.length,
    marketplaces: marketplaces.map((marketplace) => ({
      name: marketplace?.name ?? marketplace?.marketplaceName ?? marketplace?.id ?? null,
      kind: marketplace?.kind ?? null,
      pluginCount: Array.isArray(marketplace?.plugins) ? marketplace.plugins.length : null,
      loadError: marketplace?.loadError ?? null,
    })),
    featuredPluginIds: result?.featuredPluginIds ?? [],
    marketplaceLoadErrors: result?.marketplaceLoadErrors ?? [],
  };
}

function filterJsonObject(value, query) {
  const needle = query.trim().toLowerCase();
  const matches = [];
  walk(value, [], matches, needle);
  return { query, matches: matches.slice(0, 100), truncated: matches.length > 100 };
}

function walk(value, pathParts, matches, needle) {
  if (matches.length > 500) return;
  if (typeof value === "string") {
    if (value.toLowerCase().includes(needle)) matches.push({ path: pathParts.join("."), value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...pathParts, String(index)], matches, needle));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => walk(item, [...pathParts, key], matches, needle));
  }
}
