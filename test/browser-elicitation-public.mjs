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

console.log("Public Browser elicitation bridge PASS");
