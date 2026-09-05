import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable()).path;
const testCwd = process.env.CODEXLESS_TEST_CWD;
const contractStateRoot = mkdtempSync(path.join(os.tmpdir(), "codexless-public-contract-"));
const recentCallStateFile = path.join(contractStateRoot, "recent-calls.json");
const agentTaskStateFile = path.join(contractStateRoot, "agent-task-cards.json");
process.once("exit", () => rmSync(contractStateRoot, { recursive: true, force: true }));

function createIsolatedPublicTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_")) delete env[key];
  }
  Object.assign(env, {
    CODEX_BIN: codexBin,
    // Poison legacy Toolwire variables deliberately. A clean Codexless runtime must ignore all of them.
    CODEX_TOOLBOX_DEFAULT_CWD: "Z:\\codexless-must-ignore",
    CODEX_TOOLBOX_PROFILE: "__codexless_must_ignore__",
    CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE: "Z:\\codexless-must-ignore.json",
    CODEX_TOOLBOX_AGENT_METERED_CONSENT: "__codexless_must_ignore__",
    CODEXLESS_RECENT_CALLS_STATE_FILE: recentCallStateFile,
    CODEXLESS_AGENT_TASK_STATE_FILE: agentTaskStateFile,
    ...(testCwd ? { CODEXLESS_DEFAULT_CWD: testCwd } : {}),
    ...extra,
  });
  return env;
}

assert.equal(PUBLIC_SURFACE_VERSION, "codexless-public-preview-v1");
assert.equal(PUBLIC_TOOL_NAMES.length, 44);
for (const relative of [
  "src/browser-tools.mjs",
  "src/codex-browser-executor.mjs",
  "src/construction-tools.mjs",
  "src/agent-tools.mjs",
  "src/public-context-tools.mjs",
  "src/public-server-factory.mjs",
]) {
  const text = readFileSync(path.join(projectRoot, relative), "utf8");
  assert.doesNotMatch(text, /Toolwire/, `public/model-facing source must not expose the internal Toolwire brand: ${relative}`);
}

const forbiddenNames = [
  "codex.fs_read",
  "codex.fs_mutate",
  "codex.process",
  "codex.process_receipt",
  "codex.catalog",
  "codex.mcp_call",
];

const client = new Client({ name: "codexless-public-contract", version: "0.1.0" });
if (process.env.MCP_TEST_NEGOTIATION === "modern") client.setVersionNegotiation({ mode: "auto" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-stdio-public.mjs")],
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv(),
  stderr: "pipe",
});
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[codexless] ${chunk}`));

await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...PUBLIC_TOOL_NAMES].sort());
  assert.equal(names.length, 44);

  for (const name of forbiddenNames) {
    assert.equal(names.includes(name), false, `${name} must not be exposed by the public preview`);
  }
  assert.equal(names.some((name) => name.startsWith("computer.")), false);
  assert.deepEqual(
    names.filter((name) => name.startsWith("codex.browser_")),
    PUBLIC_TOOL_NAMES.filter((name) => name.startsWith("codex.browser_")),
    "runtime Browser registration order must match the canonical public surface contract"
  );

  const commandTool = tools.tools.find((tool) => tool.name === "codex.command_exec");
  const preciseEditTool = tools.tools.find((tool) => tool.name === "codex.precise_edit");
  const skillListTool = tools.tools.find((tool) => tool.name === "codex.skill_list");
  const retiredCardToolNames = ["codex.agent_card_render", "codex.agent_card_state", "codex.agent_portable_commit", "codex.agent_portable_decline"];
  const typedExcelToolNames = ["codex.excel_status", "codex.excel_read_sheets_metadata", "codex.excel_read_ranges", "codex.excel_search_workbook", "codex.excel_write_range", "codex.excel_format_range"];
  const householdOnlyExcelToolNames = ["codex.excel_tool_schemas", "codex.excel_execute_tool"];
  assert.equal(commandTool?.annotations?.destructiveHint, true);
  assert.match(commandTool?.description ?? "", /must not launch Codex CLI|refuses nested Codex/i);
  const nestedCodexCommand = await client.callTool({
    name: "codex.command_exec",
    arguments: { command: [codexBin, "--version"], access: "readOnly" },
  });
  assert.equal(nestedCodexCommand.isError, true, "public command_exec must refuse a nested Codex CLI launch before dispatch");
  assert.equal(nestedCodexCommand.structuredContent?.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");
  assert.match(nestedCodexCommand.structuredContent?.error ?? nestedCodexCommand.content?.[0]?.text ?? "", /codex\.agent_start/i);
  assert.equal(preciseEditTool?.annotations?.destructiveHint, true);
  assert.deepEqual(Object.keys(skillListTool?.inputSchema?.properties ?? {}).sort(), ["cwd", "query"]);
  assert.equal(Object.hasOwn(skillListTool?.inputSchema?.properties ?? {}, "kind"), false);
  for (const name of retiredCardToolNames) {
    assert.equal(names.includes(name), false, `${name} must not be exposed on the normal public model-visible surface`);
  }
  for (const name of typedExcelToolNames) {
    assert.equal(names.includes(name), true, `${name} must be exposed in the 0.1.2 typed Excel public Preview`);
  }
  for (const name of householdOnlyExcelToolNames) {
    assert.equal(names.includes(name), false, `${name} must remain household-only in 0.1.2-preview.0`);
  }
  for (const name of ["codex.agent_commit", "codex.agent_decline"]) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.equal(tool?._meta?.ui?.visibility, undefined, `${name} must remain neutral and model-callable for fixed-text approval`);
    assert.deepEqual(tool?.inputSchema?.required, ["taskId"]);
    assert.deepEqual(Object.keys(tool?.inputSchema?.properties ?? {}), ["taskId"]);
    assert.equal(tool?.inputSchema?.additionalProperties, false);
    assert.match(tool?.description ?? "", /exact Task ID|single-use|duplicate|stale/i);
  }

  const resources = await client.listResources();
  assert.deepEqual(resources.resources, [], "normal public runtime must not advertise a Rich Card resource");

  const startTool = tools.tools.find((tool) => tool.name === "codex.agent_start");
  const sendTool = tools.tools.find((tool) => tool.name === "codex.agent_send");
  assert.equal(startTool?._meta?.ui?.resourceUri, undefined);
  assert.equal(startTool?._meta?.["openai/outputTemplate"], undefined);
  assert.equal(Object.hasOwn(startTool?.inputSchema?.properties ?? {}, "consentRef"), false);
  assert.equal(Object.hasOwn(sendTool?.inputSchema?.properties ?? {}, "consentRef"), false);
  assert.match(startTool?.description ?? "", /fixed compact chatPresentation|fixed approval text/i);
  assert.match(sendTool?.description ?? "", /fixed compact chatPresentation|fixed approval text/i);
  assert.doesNotMatch(startTool?.description ?? "", /Portable Card|Rich Card|card renderer/i);
  assert.doesNotMatch(sendTool?.description ?? "", /Portable Card|Rich Card|card renderer/i);
  assert.match(startTool?.inputSchema?.properties?.reasoningEffort?.description ?? "", /model_list|per-model/i);
  assert.match(sendTool?.inputSchema?.properties?.reasoningEffort?.description ?? "", /model_list|per-model/i);
  assert.equal(startTool?.inputSchema?.properties?.reasoningEffort?.maxLength, 128);
  assert.equal(sendTool?.inputSchema?.properties?.reasoningEffort?.maxLength, 128);

  const requestId = `contract-consent-${randomUUID()}`;
  const prompt = "Codexless contract probe: prepare only; do not start Codex.";
  const prepared = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt, requestId, invocationRationale: "Public contract probe for fixed-text approval." },
  });
  assert.equal(prepared.isError, false);
  assert.equal(prepared.structuredContent?.status, "consent_required");
  assert.equal(prepared.structuredContent?.turnId, null);
  assert.equal(prepared.structuredContent?.agentRef, null);
  assert.match(prepared.structuredContent?.taskId ?? "", /^C-[A-F0-9]{10}$/);
  assert.match(prepared.content?.[0]?.text ?? "", /^⚠️/);
  assert.match(prepared.content?.[0]?.text ?? "", /Call Codex\?/i);
  assert.match(prepared.content?.[0]?.text ?? "", /Yes/);
  assert.match(prepared.content?.[0]?.text ?? "", /No/);
  assert.equal(prepared.content?.[0]?.text?.includes(prepared.structuredContent.taskId), true);
  assert.deepEqual(prepared.structuredContent?.chatPresentation?.choices, ["Yes", "No"]);
  assert.equal(prepared.structuredContent?.chatPresentation?.binding?.exactTaskId, prepared.structuredContent.taskId);
  assert.equal(prepared.structuredContent?.chatPresentation?.binding?.approveTool, "codex.agent_commit");
  assert.equal(prepared.structuredContent?.chatPresentation?.binding?.declineTool, "codex.agent_decline");
  assert.equal(prepared.structuredContent?.chatPresentation?.binding?.singleConsume, true);
  for (const hidden of ["taskCard", "cardRender", "manualFallback", "shortTaskId", "taskRef"]) {
    assert.equal(Object.hasOwn(prepared.structuredContent ?? {}, hidden), false, `normal approval must not expose ${hidden}`);
  }
  assert.equal(Object.hasOwn(prepared.structuredContent?.meteredConsent ?? {}, "consentRef"), false);
  const taskId = prepared.structuredContent.taskId;

  const replay = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt, requestId, invocationRationale: "Public contract probe for fixed-text approval." },
  });
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent?.status, "consent_required", "same-request replay must stay pending");
  assert.equal(replay.structuredContent?.turnId, null, "same-request replay must not start a Codex turn");
  assert.equal(replay.structuredContent?.agentRef, null, "same-request replay must not create an agent");
  assert.equal(replay.structuredContent?.taskId, taskId, "same-request replay must preserve the exact Task ID");
  assert.equal(replay.structuredContent?.duplicate, true);

  const effortRequestId = `contract-effort-${randomUUID()}`;
  const effortPrepared = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt: "Codexless contract probe: display requested reasoning effort only.", requestId: effortRequestId, invocationRationale: "Public contract probe for reasoning-effort approval text.", reasoningEffort: "ultra" },
  });
  assert.equal(effortPrepared.isError, false);
  assert.equal(effortPrepared.structuredContent?.status, "consent_required");
  assert.equal(effortPrepared.structuredContent?.execution?.requestedReasoningEffort, "ultra");
  assert.match(effortPrepared.content?.[0]?.text ?? "", /Reasoning effort|推理强度|推論強度/i);
  assert.match(effortPrepared.content?.[0]?.text ?? "", /ultra/i);
  const effortDeclined = await client.callTool({
    name: "codex.agent_decline",
    arguments: { taskId: effortPrepared.structuredContent.taskId },
  });
  assert.equal(effortDeclined.isError, false);
  assert.equal(effortDeclined.structuredContent?.status, "rejected");

  const unknownTask = await client.callTool({
    name: "codex.agent_commit",
    arguments: { taskId: "C-0000000000" },
  });
  assert.equal(unknownTask.isError, true, "unknown Task ID must fail closed");
  assert.match(unknownTask.structuredContent?.error ?? unknownTask.content?.[0]?.text ?? "", /unknown|stale|ambiguous/i);

  const declineRequestId = `contract-decline-${randomUUID()}`;
  const declinePrompt = "Codexless contract probe: prepare, decline, and stay terminal without starting Codex.";
  const declinePrepared = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt: declinePrompt, requestId: declineRequestId, invocationRationale: "Public contract probe for terminal decline semantics." },
  });
  assert.equal(declinePrepared.isError, false);
  assert.equal(declinePrepared.structuredContent?.status, "consent_required");
  assert.equal(declinePrepared.structuredContent?.agentRef, null);
  assert.equal(declinePrepared.structuredContent?.turnId, null);
  const declineTaskId = declinePrepared.structuredContent?.taskId;
  assert.match(declineTaskId ?? "", /^C-[A-F0-9]{10}$/);

  const declined = await client.callTool({
    name: "codex.agent_decline",
    arguments: { taskId: declineTaskId },
  });
  assert.equal(declined.isError, false);
  assert.equal(declined.structuredContent?.status, "rejected");
  assert.equal(declined.structuredContent?.terminal, true);
  assert.equal(declined.structuredContent?.agentRef, null);
  assert.equal(declined.structuredContent?.turnId, null);

  const cachedCommitAfterDecline = await client.callTool({
    name: "codex.agent_commit",
    arguments: { taskId: declineTaskId },
  });
  assert.equal(cachedCommitAfterDecline.isError, false);
  assert.equal(cachedCommitAfterDecline.structuredContent?.status, "rejected");
  assert.equal(cachedCommitAfterDecline.structuredContent?.terminal, true);
  assert.equal(cachedCommitAfterDecline.structuredContent?.duplicate, true);
  assert.equal(cachedCommitAfterDecline.structuredContent?.agentRef, null);
  assert.equal(cachedCommitAfterDecline.structuredContent?.turnId, null);

  const replayAfterDecline = await client.callTool({
    name: "codex.agent_start",
    arguments: { prompt: declinePrompt, requestId: declineRequestId, invocationRationale: "Public contract probe for terminal decline semantics." },
  });
  assert.equal(replayAfterDecline.isError, false);
  assert.equal(replayAfterDecline.structuredContent?.status, "rejected");
  assert.equal(replayAfterDecline.structuredContent?.terminal, true);
  assert.equal(replayAfterDecline.structuredContent?.agentRef, null);
  assert.equal(replayAfterDecline.structuredContent?.turnId, null);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

assert.equal(existsSync(recentCallStateFile), false, "normal public runtime must not persist private recent-call diagnostics");

const httpPort = 17691;
const baseUrl = `http://127.0.0.1:${httpPort}`;
const httpChild = spawn(process.execPath, [path.join(projectRoot, "src", "mcp-http-public.mjs")], {
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv({
    CODEX_TOOLBOX_PUBLIC_HOST: "127.0.0.1",
    CODEX_TOOLBOX_PUBLIC_PORT: String(httpPort),
  }),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let httpStderr = "";
httpChild.stderr.setEncoding("utf8");
httpChild.stderr.on("data", (chunk) => { httpStderr += chunk; });

async function waitForHttpHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (httpChild.exitCode !== null) {
      throw new Error(`Codexless HTTP exited early (${httpChild.exitCode}): ${httpStderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Codexless HTTP did not become healthy: ${String(lastError ?? "timeout")}\n${httpStderr}`);
}

async function stopHttpChild() {
  if (httpChild.exitCode !== null) return;
  httpChild.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => httpChild.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (httpChild.exitCode === null) httpChild.kill("SIGKILL");
}

try {
  const health = await waitForHttpHealth();
  assert.equal(health.ok, true);
  assert.equal(health.service, "codexless-public");
  assert.equal(health.publicPreview, true);
  assert.equal(health.transport, "streamable-http");
  assert.equal(health.surfaceVersion, PUBLIC_SURFACE_VERSION);
  assert.equal(health.toolCount, PUBLIC_TOOL_NAMES.length);
  assert.equal(Object.hasOwn(health, "diagnostics"), false, "public health must not expose private recent-call diagnostics");

  const recentResponse = await fetch(`${baseUrl}/internal/recent-calls`);
  assert.equal(recentResponse.status, 404, "private recent-call diagnostics endpoint must not exist on public HTTP");
  assert.equal(recentResponse.headers.get("cache-control"), "no-store");
  const recent = await recentResponse.json();
  assert.equal(recent.error, "not_found");

  const rejectedOrigin = await fetch(`${baseUrl}/internal/recent-calls`, { headers: { origin: "https://not-loopback.invalid" } });
  assert.notEqual(rejectedOrigin.status, 200, "public HTTP must keep loopback Origin validation ahead of route handling");

  const httpClient = new Client({ name: "codexless-public-contract-http", version: "0.1.0" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await httpClient.connect(httpTransport);
    const httpTools = await httpClient.listTools();
    const httpNames = httpTools.tools.map((tool) => tool.name);
    assert.equal(httpNames.length, 44);
    assert.deepEqual([...httpNames].sort(), [...PUBLIC_TOOL_NAMES].sort());
    for (const name of forbiddenNames) {
      assert.equal(httpNames.includes(name), false, `${name} must not be exposed by the public HTTP preview`);
    }
  } finally {
    await httpClient.close().catch(() => {});
  }
} finally {
  await stopHttpChild();
}
