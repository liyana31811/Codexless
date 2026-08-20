import assert from "node:assert/strict";
import path from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const moduleUrl = (relative) => pathToFileURL(path.join(projectRoot, relative)).href;

const events = [];
let scenario = {};
let publicContextCount = 0;

function resetScenario(next = {}) {
  events.length = 0;
  scenario = next;
  publicContextCount = 0;
}

function maybeThrow(value) {
  if (value !== undefined) throw value;
}

class FakePublicContext {
  constructor() {
    this.role = publicContextCount++ === 0 ? "public" : "browser";
    events.push(`${this.role}:construct`);
  }

  async start() {
    events.push(`${this.role}:start`);
  }

  async configuredMcpServer() {
    return { node_repl: { command: "node" } };
  }

  async configuredMcpServerNames() {
    return [];
  }

  async currentChromeSkill() {
    return null;
  }

  async close() {
    events.push(`${this.role}:close`);
    maybeThrow(scenario[`${this.role}CloseError`]);
  }
}

class FakeAgentExecutor {
  constructor() {
    events.push("agent:construct");
  }

  async open() {
    events.push("agent:open");
    maybeThrow(scenario.agentOpenError);
  }

  async close() {
    events.push("agent:close");
    maybeThrow(scenario.agentCloseError);
  }
}

class FakeAuthorityExecutor {
  constructor() {
    events.push("authority:construct");
  }

  async validate() {
    events.push("authority:validate");
    maybeThrow(scenario.authorityValidateError);
    return { status: "ok" };
  }
}

class FakeBrowserExecutor {
  constructor() {
    events.push("browser:construct");
    maybeThrow(scenario.browserConstructError);
  }
}

class FakeWorkbenchAdapter {
  constructor() {
    events.push("adapter:construct");
  }
}

mock.module(moduleUrl("src/agent-tools.mjs"), {
  exports: {
    createAgentPreviewState() {
      events.push("agent-state:create");
      maybeThrow(scenario.agentStateError);
      return {};
    },
  },
});
mock.module(moduleUrl("src/codex-agent-executor.mjs"), { exports: { CodexAgentExecutor: FakeAgentExecutor } });
mock.module(moduleUrl("src/codex-authority-executor.mjs"), { exports: { CodexAuthorityExecutor: FakeAuthorityExecutor } });
mock.module(moduleUrl("src/codex-browser-executor.mjs"), { exports: { CodexBrowserExecutor: FakeBrowserExecutor } });
mock.module(moduleUrl("src/browser-runtime-compat.mjs"), {
  exports: {
    async resolveBrowserRuntimeCompatibility() {
      events.push("browser-compat:resolve");
      maybeThrow(scenario.browserCompatibilityError);
      return { status: "ok", browserRuntimeCwd: "/browser-runtime", overrides: [] };
    },
  },
});
mock.module(moduleUrl("src/public-browser-workbench-adapter.mjs"), {
  exports: { CodexPublicBrowserWorkbenchAdapter: FakeWorkbenchAdapter },
});
mock.module(moduleUrl("src/codex-bin.mjs"), {
  exports: {
    async resolveCodexExecutable() {
      events.push("codex-bin:resolve");
      return { path: "/fake/codex" };
    },
  },
});
mock.module(moduleUrl("src/codex-quota-snapshot.mjs"), { exports: { readCodexQuotaSnapshot: async () => ({}) } });
mock.module(moduleUrl("src/codex-preview-account-preflight.mjs"), {
  exports: { createPreviewTelemetryClient: () => ({ start: async () => {}, close: async () => {} }) },
});
mock.module(moduleUrl("src/json-file.mjs"), { exports: { readJsonFile: async () => ({ overrides: [] }) } });
mock.module(moduleUrl("src/public-context-executor.mjs"), { exports: { CodexPublicContextExecutor: FakePublicContext } });
mock.module(moduleUrl("src/public-server-factory.mjs"), {
  exports: {
    createPublicServerFactory() {
      events.push("server-factory:create");
      return () => ({ });
    },
  },
});
mock.module(moduleUrl("src/recent-call-diagnostics.mjs"), {
  exports: {
    createRecentCallDiagnostics: () => ({ wrapHandler: (name, handler) => handler }),
    recentCallOptionsFromEnv: () => ({}),
  },
});
mock.module(moduleUrl("src/stock-prompt-input-skill-routing.mjs"), { exports: { STOCK_RUNTIME_KIND: "stock" } });
mock.module(moduleUrl("src/surface-contracts.mjs"), {
  exports: {
    PUBLIC_SERVER_VERSION: "test-server",
    PUBLIC_SURFACE_VERSION: "test-surface",
    PUBLIC_TOOL_NAMES: [],
  },
});

const { createPublicRuntime } = await import(moduleUrl("src/public-runtime.mjs"));

function runtimeEnv() {
  return {
    CODEXLESS_ALLOW_NONWINDOWS_PROBE: "1",
    CODEXLESS_AGENT_METERED_CONSENT: "off",
    CODEXLESS_DEFAULT_CWD: "/project",
  };
}

async function thrownValue(task) {
  try {
    await task();
    return { didThrow: false, value: undefined };
  } catch (value) {
    return { didThrow: true, value };
  }
}

test("startup failure during agent open closes the constructed agent and public context", async () => {
  const startupError = new Error("agent startup failed");
  resetScenario({ agentOpenError: startupError });
  const result = await thrownValue(() => createPublicRuntime({ env: runtimeEnv() }));
  assert.equal(result.value, startupError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "public:close"]);
});

test("startup failure before agent construction closes only the initialized public context", async () => {
  const startupError = new Error("browser compatibility failed");
  resetScenario({ browserCompatibilityError: startupError });
  const result = await thrownValue(() => createPublicRuntime({ env: runtimeEnv() }));
  assert.equal(result.value, startupError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["public:close"]);
});

test("startup failure while creating agent state closes public and agent", async () => {
  const startupError = new Error("agent state failed");
  resetScenario({ agentStateError: startupError });
  const result = await thrownValue(() => createPublicRuntime({ env: runtimeEnv() }));
  assert.equal(result.value, startupError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "public:close"]);
});

test("startup failure after browser context construction closes agent, browser, and public", async () => {
  const startupError = new Error("browser construction failed");
  resetScenario({ browserConstructError: startupError });
  const result = await thrownValue(() => createPublicRuntime({ env: runtimeEnv() }));
  assert.equal(result.value, startupError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "browser:close", "public:close"]);
});

test("startup failure before any component is initialized preserves the original error", async () => {
  const startupError = new Error("authority validation failed");
  resetScenario({ authorityValidateError: startupError });
  const result = await thrownValue(() => createPublicRuntime({ env: runtimeEnv() }));
  assert.equal(result.value, startupError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), []);
});

test("normal close attempts agent, browser, then public exactly once and is idempotent", async () => {
  resetScenario();
  const runtime = await createPublicRuntime({ env: runtimeEnv() });
  await runtime.close();
  await runtime.close();
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "browser:close", "public:close"]);
});

test("agent close failure still closes later components and remains the cleanup error", async () => {
  const agentError = new Error("agent close failed");
  resetScenario({ agentCloseError: agentError });
  const runtime = await createPublicRuntime({ env: runtimeEnv() });
  const result = await thrownValue(() => runtime.close());
  assert.equal(result.value, agentError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "browser:close", "public:close"]);
});

test("browser close failure still closes public and remains the cleanup error", async () => {
  const browserError = new Error("browser close failed");
  resetScenario({ browserCloseError: browserError });
  const runtime = await createPublicRuntime({ env: runtimeEnv() });
  const result = await thrownValue(() => runtime.close());
  assert.equal(result.value, browserError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "browser:close", "public:close"]);
});

test("later cleanup failures take precedence while every closer is attempted", async () => {
  const agentError = new Error("agent close failed");
  const browserError = new Error("browser close failed");
  const publicError = new Error("public close failed");
  resetScenario({ agentCloseError: agentError, browserCloseError: browserError, publicCloseError: publicError });
  const runtime = await createPublicRuntime({ env: runtimeEnv() });
  const result = await thrownValue(() => runtime.close());
  assert.equal(result.value, publicError);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "browser:close", "public:close"]);
});

test("a falsy cleanup throw is still propagated after later cleanup", async () => {
  resetScenario({ agentCloseError: null });
  const runtime = await createPublicRuntime({ env: runtimeEnv() });
  const result = await thrownValue(() => runtime.close());
  assert.equal(result.didThrow, true);
  assert.equal(result.value, null);
  assert.deepEqual(events.filter((event) => event.endsWith(":close")), ["agent:close", "browser:close", "public:close"]);
});
