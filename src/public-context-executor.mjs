import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { listAllMcpServerStatus } from "./mcp-status-pagination.mjs";
import { readPreviewAccountPreflight } from "./codex-preview-account-preflight.mjs";
import {
  StockPromptInputSkillRoutingCore,
  implicitSkillRoutingUnavailable,
} from "./stock-prompt-input-skill-routing.mjs";

const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";

function decodeBase64(value) {
  return Buffer.from(value ?? "", "base64").toString("utf8");
}

export class CodexPublicContextExecutor {
  #client;
  #codexBin;
  #defaultCwd;
  #configOverrides;
  #skillRouting;
  #generation = 0;
  #startPromise = null;
  #threadsByCwd = new Map();

  constructor({
    codexBin,
    defaultCwd,
    configOverrides = [],
    clientFactory = null,
    promptInputRunner = null,
    runtimeKind,
  }) {
    if (!codexBin) throw new Error("CodexPublicContextExecutor requires codexBin");
    if (!defaultCwd) throw new Error("CodexPublicContextExecutor requires defaultCwd");
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty strings");
    }
    if (promptInputRunner !== null && typeof promptInputRunner !== "function") throw new Error("promptInputRunner must be null or a function");
    if (typeof runtimeKind !== "string" || !runtimeKind.trim()) throw new Error("runtimeKind must be explicitly provided");

    this.#codexBin = codexBin;
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#configOverrides = [...configOverrides];
    const routingOptions = {
      runtimeKind,
      codexBin: this.#codexBin,
      appServerCwd: this.#defaultCwd,
      configOverrides: this.#configOverrides,
    };
    if (promptInputRunner) routingOptions.promptInputRunner = promptInputRunner;
    this.#skillRouting = new StockPromptInputSkillRoutingCore(routingOptions);
    const options = {
      cwd: this.#defaultCwd,
      launch: () => this.#skillRouting.appServerSpec(),
      requestTimeoutMs: 30_000,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: {
        name: "codexless_public_preview",
        title: "Codexless Public Preview",
        version: "0.1.0",
      },
    };
    this.#client = clientFactory ? clientFactory(options) : new CodexAppServerClient(options);
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

  async close() {
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
    return readPreviewAccountPreflight({
      codexBin: this.#codexBin,
      defaultCwd: this.#defaultCwd,
      configOverrides: this.#configOverrides,
    });
  }

  async skillList({ cwd = this.#defaultCwd, query = "" } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const skills = await this.#readExplicitSkills(effectiveCwd);
    const needle = query.trim().toLowerCase();
    return {
      cwd: effectiveCwd,
      count: skills.length,
      skills: needle
        ? skills.filter((skill) => `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(needle))
        : skills,
    };
  }

  async skillRead({ name, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    const skills = await this.#readExplicitSkills(effectiveCwd);
    const exact = skills.find((skill) => skill.name === name);
    const matches = exact ? [exact] : skills.filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()));
    if (matches.length !== 1) {
      return {
        status: matches.length ? "ambiguous" : "not_found",
        matches: matches.map((skill) => ({ name: skill.name, path: skill.path })),
      };
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

  async #readExplicitSkills(effectiveCwd) {
    const result = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: true });
    return (result?.data ?? []).flatMap((row) => row?.skills ?? []);
  }

  async configuredMcpServers({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const configRead = await this.#request("config/read", { cwd: effectiveCwd, includeLayers: false });
    const config = configRead?.config ?? {};
    const servers = config?.mcp_servers ?? config?.mcpServers ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new Error("config/read returned invalid MCP server definitions");
    }
    return structuredClone(servers);
  }

  async configuredMcpPluginServers() {
    const result = await listAllMcpServerStatus(
      (params) => this.#request("mcpServerStatus/list", params),
      { detail: "toolsAndAuthOnly", limit: 50 }
    );
    return result.data
      .filter((server) => typeof server?.pluginId === "string" && server.pluginId && typeof server?.name === "string" && server.name)
      .map((server) => ({ name: server.name, pluginId: server.pluginId }));
  }

  async configuredMcpServerNames(options = {}) {
    return Object.keys(await this.configuredMcpServers(options));
  }

  async configuredMcpServer({ name, cwd = this.#defaultCwd } = {}) {
    if (typeof name !== "string" || !name) throw new Error("configuredMcpServer requires a non-empty name");
    const servers = await this.configuredMcpServers({ cwd });
    const value = servers?.[name];
    return value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : null;
  }

  async currentChromeSkill({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const skillsResult = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: false });
    const skills = (skillsResult?.data ?? []).flatMap((row) => row?.skills ?? []);
    const chromeSkill = skills.find((skill) => skill?.name === CHROME_SKILL_NAME && skill?.enabled !== false);
    return chromeSkill?.path
      ? { name: CHROME_SKILL_NAME, path: chromeSkill.path }
      : null;
  }

  async browserPrerequisites({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const skillsResult = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: false });
    const skills = (skillsResult?.data ?? []).flatMap((row) => row?.skills ?? []);
    const chromeSkill = skills.find((skill) => skill?.name === CHROME_SKILL_NAME && skill?.enabled !== false);
    if (!chromeSkill?.path) {
      return { status: "unavailable", reason: "chrome_skill_unavailable", chromeSkillPath: null, nodeRepl: false };
    }

    const mcp = await this.#request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 50 });
    const nodeRepl = (mcp?.data ?? []).find((server) => server?.name === NODE_REPL_SERVER);
    const tools = nodeRepl?.tools && typeof nodeRepl.tools === "object" ? Object.values(nodeRepl.tools) : [];
    const js = tools.find((tool) => tool?.name === NODE_REPL_TOOL);
    if (!js || nodeRepl?.error) {
      return {
        status: "unavailable",
        reason: "node_repl_unavailable",
        chromeSkillPath: chromeSkill.path,
        nodeRepl: false,
        nodeReplError: nodeRepl?.error ?? null,
      };
    }
    return { status: "ok", chromeSkillPath: chromeSkill.path, nodeRepl: true };
  }

  async nodeReplCall({ cwd = this.#defaultCwd, arguments: args = {}, meta = null, expectedGeneration = null }) {
    const effectiveCwd = path.resolve(cwd);
    const threadId = await this.#ensureThread(effectiveCwd, expectedGeneration);
    const params = { server: NODE_REPL_SERVER, tool: NODE_REPL_TOOL, threadId, arguments: args };
    if (meta && typeof meta === "object") params._meta = meta;
    const result = await this.#request("mcpServer/tool/call", params, { timeoutMs: 60_000, expectedGeneration });
    const contentItems = Array.isArray(result?.content) ? structuredClone(result.content) : [];
    const textParts = contentItems
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text);
    return {
      isError: result?.isError === true,
      text: textParts.length ? textParts.join("\n") : null,
      contentItems,
      data: result?.structuredContent === undefined ? null : structuredClone(result.structuredContent),
    };
  }

  async #ensureStarted() {
    if (this.#client.running) return this.#client.initializedResult ?? null;
    if (this.#startPromise) return this.#startPromise;
    const restarting = this.#generation > 0;
    this.#startPromise = (async () => {
      if (restarting) this.#threadsByCwd.clear();
      const initialized = await this.#client.start();
      this.#generation += 1;
      return initialized;
    })();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #request(method, params, { expectedGeneration = null, ...options } = {}) {
    await this.#ensureStarted();
    if (expectedGeneration !== null && expectedGeneration !== this.#generation) {
      throw new Error(
        `PUBLIC_CONTEXT_GENERATION_STALE: expected=${expectedGeneration} current=${this.#generation}; ` +
        "the Codex app-server restarted before this request was dispatched"
      );
    }
    return this.#client.request(method, params, options);
  }

  async #ensureThread(cwd, expectedGeneration = null) {
    await this.#ensureStarted();
    if (expectedGeneration !== null && expectedGeneration !== this.#generation) {
      throw new Error(
        `PUBLIC_CONTEXT_GENERATION_STALE: expected=${expectedGeneration} current=${this.#generation}; ` +
        "the Codex app-server restarted before this request was dispatched"
      );
    }
    const existing = this.#threadsByCwd.get(cwd);
    if (existing) return existing;
    const started = await this.#request("thread/start", { cwd, ephemeral: true }, { expectedGeneration });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id for public runtime context");
    this.#threadsByCwd.set(cwd, threadId);
    return threadId;
  }
}
