import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BROWSER_ELICITATION_INPUT_KEY,
  BrowserElicitationBridge,
} from "../src/browser-elicitation-bridge.mjs";
import { CodexWorkbenchExecutor } from "../src/codex-workbench-executor.mjs";

let workbenchClientOptions = null;
new CodexWorkbenchExecutor({
  codexBin: "C:\\fake\\codex.exe",
  defaultCwd: "C:\\workspace",
  serverRequestHandler: () => {},
  clientFactory: (options) => {
    workbenchClientOptions = options;
    return {};
  },
});
assert.deepEqual(workbenchClientOptions?.initializeCapabilities, {
  experimentalApi: true,
});

const bridge = new BrowserElicitationBridge({
  autoApproveBrowserOrigins: false,
  continuationTtlMs: 5_000,
  requestStateKey: Buffer.alloc(32, 7),
  runtimeId: "browser-public-elicitation-test",
});
const mcpReq = {};
const input = { tabRef: "browser-tab" };
const task = () => new Promise((resolve, reject) => {
  bridge.handleServerRequest({
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: null,
      serverName: "node_repl",
      mode: "form",
      message: "Allow Browser use for https://example.test?",
      requestedSchema: {
        type: "object",
        properties: { remember: { type: "boolean" } },
      },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        origin: "https://example.test",
      },
    },
    resolve,
    reject,
  });
});

try {
  const pending = await bridge.run({
    toolName: "codex.browser_read",
    input,
    mcpReq,
    task,
  });
  assert.equal(pending.resultType, "input_required");
  assert.equal(pending.inputRequests?.[BROWSER_ELICITATION_INPUT_KEY]?.method, "elicitation/create");
  assert.match(
    pending.inputRequests?.[BROWSER_ELICITATION_INPUT_KEY]?.params?.message ?? "",
    /Allow Browser use/
  );
  assert.deepEqual(pending.inputRequests?.[BROWSER_ELICITATION_INPUT_KEY]?.params?._meta, {
    codex_approval_kind: "mcp_tool_call",
    origin: "https://example.test",
  });

  mcpReq.requestState = () => pending.requestState;
  mcpReq.inputResponses = {
    [BROWSER_ELICITATION_INPUT_KEY]: {
      action: "accept",
      content: { remember: true },
    },
  };
  const completed = await bridge.run({
    toolName: "codex.browser_read",
    input,
    mcpReq,
    task,
  });
  assert.deepEqual(completed, { action: "accept", content: { remember: true } });
} finally {
  bridge.close();
}

const autoBridge = new BrowserElicitationBridge({
  continuationTtlMs: 5_000,
  requestStateKey: Buffer.alloc(32, 8),
  runtimeId: "browser-public-auto-origin-test",
});
let autoResponse = null;
try {
  const autoResult = await autoBridge.run({
    toolName: "codex.browser_open_tab",
    input: { actionApprovalRef: "browser-action" },
    mcpReq: {},
    task: () => new Promise((resolve, reject) => {
      autoBridge.handleServerRequest({
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-2",
          turnId: null,
          serverName: "node_repl",
          mode: "form",
          message: "Allow Browser use to access https://example.test?",
          requestedSchema: { type: "object", properties: {} },
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            connector_id: "browser-use",
            tool_name: "access_browser_origin",
            origin: "https://example.test",
            persist: "always",
          },
        },
        resolve(value) {
          autoResponse = value;
          resolve({ status: "opened" });
        },
        reject,
      });
    }),
  });
  assert.deepEqual(autoResponse, { action: "accept" });
  assert.deepEqual(autoResult, { status: "opened" });

  const unrelated = await autoBridge.run({
    toolName: "codex.browser_read",
    input: { tabRef: "browser-tab" },
    mcpReq: {},
    task: () => new Promise((resolve, reject) => {
      autoBridge.handleServerRequest({
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-3",
          turnId: null,
          serverName: "node_repl",
          mode: "form",
          message: "Confirm an unrelated Browser request?",
          requestedSchema: { type: "object", properties: {} },
          _meta: {
            codex_approval_kind: "mcp_tool_call",
            connector_id: "browser-use",
            tool_name: "unrelated_browser_request",
            origin: "https://example.test",
            persist: "always",
          },
        },
        resolve,
        reject,
      });
    }),
  });
  assert.equal(unrelated.resultType, "input_required");
  assert.equal(unrelated.inputRequests?.[BROWSER_ELICITATION_INPUT_KEY]?.method, "elicitation/create");
} finally {
  autoBridge.close();
}

const runtimeSource = await readFile(
  path.resolve(import.meta.dirname, "../src/codexless-runtime.mjs"),
  "utf8"
);
const publicHttpSource = await readFile(
  path.resolve(import.meta.dirname, "../src/mcp-http-public.mjs"),
  "utf8"
);
assert.match(
  runtimeSource,
  /if \(publicPreview\) \{\s*browserElicitationBridge = new BrowserElicitationBridge/
);
assert.match(
  runtimeSource,
  /serverRequestHandler: publicPreview\s*\? \(request\) => browserElicitationBridge\.handleServerRequest\(request\)/
);
assert.doesNotMatch(
  runtimeSource,
  /browserElicitationBridge = privateConstruction\s*\?[\s\S]*?: null;/,
  "managed public Browser routing must not erase its elicitation bridge"
);
assert.match(publicHttpSource, /WebStandardStreamableHTTPServerTransport/);
assert.match(publicHttpSource, /legacy:\s*"reject"/);
assert.match(publicHttpSource, /createLegacySessionHandler/);
assert.doesNotMatch(
  publicHttpSource,
  /legacy:\s*"stateless"/,
  "2025-era Browser elicitation requires a sessionful HTTP transport"
);
assert.doesNotMatch(runtimeSource, /CODEXLESS_BROWSER_ORIGIN_APPROVAL/);

console.log("Public Browser elicitation bridge PASS");
