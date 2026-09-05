import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createCodexToolboxServerFactory } from "../src/mcp-server-factory.mjs";
import { createCodexlessRuntime } from "../src/codexless-runtime.mjs";
import { managedPlatformPackageSpec } from "../src/codex-runtime-provider.mjs";
import {
  activateDualRuntimePolicy,
  readRuntimeRoutingState,
  writeRuntimeInstallPreference,
} from "../src/runtime-routing-policy.mjs";
import { HOUSEHOLD_TOOL_ALLOWLIST, PUBLIC_TOOL_ALLOWLIST } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");
const { InMemoryTransport } = require("@modelcontextprotocol/server");
const root = path.resolve(import.meta.dirname, "..");
const managedBin = path.join(root, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");

function freshManagedChildEnv() {
  const env = { ...process.env };
  // This fixture proves the no-product-override bootstrap; production Managed launch intentionally preserves this policy input.
  delete env.CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE;
  return env;
}

async function withManagedClient(run, { entrypoint = "mcp-stdio-household.mjs" } = {}) {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "codexless-managed-surface-"));
  const client = new Client({ name: "codexless-managed-runtime-surface-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", entrypoint)],
    cwd: root,
    env: {
      ...freshManagedChildEnv(),
      CODEXLESS_CODEX_RUNTIME: "managed",
      CODEXLESS_MANAGED_CODEX_HOME: tempHome,
      CODEX_TOOLBOX_DEFAULT_CWD: root,
      CODEX_TOOLBOX_AGENT_METERED_CONSENT: "always",
      CODEXLESS_CALL_PROFILE_FILE: path.join(tempHome, "missing-profile.md"),
      CODEX_BIN: "C:\\managed-test-must-not-resolve-existing\\codex.exe",
      CODEX_CLI_PATH: "C:\\managed-test-must-not-resolve-desktop\\codex.exe",
      OPENAI_API_KEY: "must-not-flow-into-managed-runtime",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    await run(client, tempHome);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("public command_exec blocks any nested Codex CLI before executor dispatch", async () => {
  let execCalls = 0;
  const createServer = createCodexToolboxServerFactory({
    executor: {
      async exec() {
        execCalls += 1;
        throw new Error("executor dispatch must be unreachable for direct Formal Codex");
      },
    },
    maxConcurrent: 1,
    version: "managed-public-guard-test",
    exposeCwd: true,
    accessModes: ["inherit", "readOnly"],
    defaultAccess: "readOnly",
    toolAllowlist: ["codex.command_exec"],
    publicPreview: true,
    guardDirectFormalCodex: true,
  });
  const server = createServer();
  const client = new Client({ name: "codexless-public-direct-formal-guard-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const command of [
      ["C:\\fake-managed\\codex.exe", "exec", "MUST_NOT_RUN"],
      ["codex.exe", "review", "MUST_NOT_RUN"],
      ["codex.exe", "--version"],
      ["cmd.exe", "/d", "/c", "codex --version"],
    ]) {
      const blocked = await client.callTool({
        name: "codex.command_exec",
        arguments: { command, cwd: root, access: "readOnly", timeoutMs: 5_000 },
      });
      assert.equal(blocked.isError, true);
      assert.equal(blocked.structuredContent?.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");
      assert.equal(execCalls, 0, `executor.exec must stay unreachable for ${command[1]}`);
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test("persisted dual_ready keeps Managed model-free serving when Existing is broken, while Existing-only calls fail visibly without downgrade or fallback", async (t) => {
  const platformSpec = managedPlatformPackageSpec();
  if (!platformSpec) {
    t.skip(`Managed dual-ready integration fixture does not support ${process.platform}/${process.arch}`);
    return;
  }

  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codexless-dual-ready-isolation-"));
  const managedHome = path.join(stateRoot, "managed-codex-home");
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await writeRuntimeInstallPreference({ stateRoot, mode: "recommended" });
  await activateDualRuntimePolicy({
    stateRoot,
    managedRuntime: {
      packageName: "@openai/codex",
      packageVersion: "0.147.0",
      platformPackageName: platformSpec.packageName,
      platformPackageVersion: `0.147.0-${platformSpec.versionSuffix}`,
      binarySha256: "d".repeat(64),
    },
    readiness: {
      status: "ready",
      accountRead: true,
      modelList: true,
      configRead: true,
      account: { authMode: "chatgpt", planType: "test" },
    },
  });
  const stateBefore = await readRuntimeRoutingState({ stateRoot });
  assert.equal(stateBefore.activation, "dual_ready");
  assert.equal(stateBefore.managedReady, true);

  const env = {
    ...freshManagedChildEnv(),
    CODEX_BIN: path.join(stateRoot, "broken-existing", "codex.exe"),
    CODEX_CLI_PATH: path.join(stateRoot, "also-broken-existing", "codex.exe"),
    CODEXLESS_MANAGED_CODEX_HOME: managedHome,
    CODEX_TOOLBOX_DEFAULT_CWD: root,
    CODEX_TOOLBOX_AGENT_METERED_CONSENT: "always",
    CODEXLESS_CALL_PROFILE_FILE: path.join(stateRoot, "missing-profile.md"),
  };
  delete env.CODEXLESS_CODEX_RUNTIME;

  const runtime = await createCodexlessRuntime({ env, mode: "household", stateRoot });
  const server = runtime.createServer();
  const client = new Client({ name: "codexless-dual-ready-fault-isolation-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    assert.equal(runtime.codexRuntime.activation, "dual_ready");
    assert.equal(runtime.codexRuntime.modelFreeLane, "managed");
    assert.equal(runtime.codexRuntime.routes.stableModelFree, "managed");
    assert.equal(runtime.codexRuntime.routes.browser, "existing");
    assert.equal(runtime.codexRuntime.routes.formalAgent, "existing");
    assert.equal(runtime.codexRuntime.noSilentFallback, true);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const managedCommand = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        command: [process.execPath, "-e", "process.stdout.write('DUAL_READY_MANAGED_OK')"],
        cwd: root,
        access: "readOnly",
        timeoutMs: 5_000,
      },
    });
    assert.equal(managedCommand.isError, false);
    assert.equal(managedCommand.structuredContent?.stdout, "DUAL_READY_MANAGED_OK");
    assert.equal(managedCommand.structuredContent?.authoritySource, "untrusted-read-only-bootstrap");

    const existingSkill = await client.callTool({
      name: "codex.skill_read",
      arguments: { name: "must-not-resolve", cwd: root },
    });
    assert.equal(existingSkill.isError, true);
    assert.equal(existingSkill.structuredContent?.errorCode, "EXISTING_CODEX_REQUIRED");
    assert.match(existingSkill.structuredContent?.error ?? "", /Repair\/install the official Existing Codex runtime/i);
    assert.match(existingSkill.structuredContent?.error ?? "", /will not switch lanes silently/i);

    const existingModels = await client.callTool({ name: "codex.model_list", arguments: { limit: 1 } });
    assert.equal(existingModels.isError, true);
    assert.equal(existingModels.structuredContent?.errorCode, "EXISTING_CODEX_REQUIRED");

    const managedAfterExistingFailure = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        command: [process.execPath, "-e", "process.stdout.write('MANAGED_STILL_OK')"],
        cwd: root,
        access: "readOnly",
        timeoutMs: 5_000,
      },
    });
    assert.equal(managedAfterExistingFailure.isError, false);
    assert.equal(managedAfterExistingFailure.structuredContent?.stdout, "MANAGED_STILL_OK");

    const stateAfter = await readRuntimeRoutingState({ stateRoot });
    assert.deepEqual(stateAfter, stateBefore, "Existing failure must not rewrite or downgrade persisted dual_ready state");
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await runtime.close().catch(() => {});
  }
});

test("managed household surface is model-free and hard-blocks Formal Agent before any Existing fallback", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("Managed Runtime Preview hard-platform integration fixture is Windows x64");
    return;
  }
  await withManagedClient(async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.deepEqual(names, [...HOUSEHOLD_TOOL_ALLOWLIST]);
    assert.equal(names.includes("codex.browser_webmcp_discover"), false, "external Chrome/Edge WebMCP must stay hidden until the upstream extension runtime exposes webmcp");
    assert.equal(names.includes("codex.browser_webmcp_call"), false, "external Chrome/Edge WebMCP must stay hidden until the upstream extension runtime exposes webmcp");
    assert.equal(PUBLIC_TOOL_ALLOWLIST.includes("codex.browser_webmcp_discover"), false, "Q75 exposure rollback must not widen the public preview");
    assert.equal(PUBLIC_TOOL_ALLOWLIST.includes("codex.browser_webmcp_call"), false, "Q75 exposure rollback must not widen the public preview");
    for (const forbidden of ["thread/start", "thread/resume", "turn/start", "turn/interrupt", "model/execute", "codex.raw_rpc"]) {
      assert.equal(names.includes(forbidden), false, `raw model/control RPC leaked into managed surface: ${forbidden}`);
    }

    const preflight = await client.callTool({ name: "codex.account_preflight", arguments: {} });
    assert.equal(preflight.isError, false);
    assert.equal(preflight.structuredContent?.runtime?.lane, "managed");
    assert.equal(preflight.structuredContent?.account?.accountPresent, false);
    assert.equal(preflight.structuredContent?.loginJourney?.status, "login_required");
    assert.equal(preflight.structuredContent?.loginJourney?.authType, "chatgpt");
    const loginText = JSON.stringify(preflight.structuredContent?.loginJourney ?? {});
    assert.doesNotMatch(loginText, /authUrl|accessToken|refreshToken|bearer|cookie/i);

    const models = await client.callTool({ name: "codex.model_list", arguments: { limit: 20 } });
    assert.equal(models.isError, false);
    assert.ok(Array.isArray(models.structuredContent?.models));
    assert.ok(models.structuredContent.models.length > 0);

    const project = await client.callTool({ name: "codex.project_context", arguments: { cwd: root } });
    assert.equal(project.isError, false);
    assert.equal(typeof project.structuredContent?.threadId, "string");
    assert.equal(project.structuredContent?.cliVersion, "0.147.0");

    const safeCommand = await client.callTool({
      name: "codex.command_exec",
      arguments: { command: [process.execPath, "-e", "process.stdout.write('MANAGED_FRONTDOOR_COMMAND_OK')"], cwd: root, access: "readOnly", timeoutMs: 5_000 },
    });
    assert.equal(safeCommand.isError, false);
    assert.equal(safeCommand.structuredContent?.stdout, "MANAGED_FRONTDOOR_COMMAND_OK");
    assert.equal(safeCommand.structuredContent?.permissionProfile, ":read-only");
    assert.equal(safeCommand.structuredContent?.authoritySource, "untrusted-read-only-bootstrap");

    const readMany = await client.callTool({
      name: "codex.read_many",
      arguments: { paths: ["package.json"], cwd: root, maxCharsPerFile: 10_000, maxTotalChars: 10_000 },
    });
    assert.equal(readMany.isError, false);
    assert.equal(readMany.structuredContent?.count, 1);

    const processStart = await client.callTool({
      name: "codex.process",
      arguments: { action: "start", command: [process.execPath, "-e", "process.stdout.write('MANAGED_FRONTDOOR_PROCESS_OK')"], cwd: root, tty: false, timeoutMs: 5_000 },
    });
    assert.equal(processStart.isError, false);
    const processRef = processStart.structuredContent?.processRef;
    const receiptRef = processStart.structuredContent?.receiptRef;
    let processPoll = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      processPoll = await client.callTool({ name: "codex.process", arguments: { action: "poll", processRef } });
      if (processPoll.structuredContent?.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(processPoll?.structuredContent?.status, "exited");
    const processReceipt = await client.callTool({ name: "codex.process_receipt", arguments: { receiptRef } });
    assert.equal(processReceipt.isError, false);
    assert.equal(processReceipt.structuredContent?.stdout, "MANAGED_FRONTDOOR_PROCESS_OK");
    assert.equal(processReceipt.structuredContent?.exit?.exitCode, 0);

    const blockedCommand = await client.callTool({
      name: "codex.command_exec",
      arguments: { command: [managedBin, "exec", "MUST_NOT_RUN"], cwd: root, access: "readOnly", timeoutMs: 5_000 },
    });
    assert.equal(blockedCommand.isError, true);
    assert.equal(blockedCommand.structuredContent?.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");

    const blockedProcess = await client.callTool({
      name: "codex.process",
      arguments: { action: "start", command: [managedBin, "review", "MUST_NOT_RUN"], cwd: root, tty: false, timeoutMs: 5_000 },
    });
    assert.equal(blockedProcess.isError, true);
    assert.equal(blockedProcess.structuredContent?.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");

    const blockedAgent = await client.callTool({
      name: "codex.agent_start",
      arguments: {
        prompt: "MUST_NOT_START_A_MODEL_TURN",
        requestId: "managed-runtime-model-call-hard-block",
        invocationRationale: "Security regression: Managed model invocation is not enabled.",
      },
    });
    assert.equal(blockedAgent.isError, true);
    assert.equal(blockedAgent.structuredContent?.errorCode, "MANAGED_CODEX_MODEL_INVOCATION_DISABLED");
    assert.match(blockedAgent.structuredContent?.error ?? "", /Managed toolbox is available/i);
    assert.match(blockedAgent.structuredContent?.error ?? "", /no Existing fallback was performed/i);
    assert.equal(blockedAgent.structuredContent?.status, undefined, "Managed Agent block must happen before Profile/consent preparation");
  });
});

test("managed public surface keeps model-free toolbox usable while Call Codex is hard-blocked with no Existing fallback", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    t.skip("Managed Runtime Preview public hard-platform integration fixture is Windows x64");
    return;
  }
  await withManagedClient(async (client, tempHome) => {
    const listed = await client.listTools();
    const publicNames = listed.tools.map((tool) => tool.name);
    assert.equal(publicNames.length, PUBLIC_TOOL_ALLOWLIST.length);
    assert.deepEqual([...publicNames].sort(), [...PUBLIC_TOOL_ALLOWLIST].sort());

    const command = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        command: [process.execPath, "-e", "process.stdout.write('MANAGED_PUBLIC_MODEL_FREE_OK')"],
        cwd: root,
        access: "readOnly",
        timeoutMs: 5_000,
      },
    });
    assert.equal(command.isError, false);
    assert.equal(command.structuredContent?.stdout, "MANAGED_PUBLIC_MODEL_FREE_OK");

    const blockedDirectFormal = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        command: [path.join(tempHome, "must-not-exist", "codex.exe"), "exec", "MUST_NOT_RUN"],
        cwd: root,
        access: "readOnly",
        timeoutMs: 5_000,
      },
    });
    assert.equal(blockedDirectFormal.isError, true);
    assert.equal(blockedDirectFormal.structuredContent?.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");

    const wrappedFormalCommand = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-Command", `& '${path.join(tempHome, "must-not-exist", "codex.exe")}' exec MUST_NOT_RUN`]
      : ["/bin/sh", "-lc", `'${path.join(tempHome, "must-not-exist", "codex")}' exec MUST_NOT_RUN`];
    const blockedWrappedFormal = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        command: wrappedFormalCommand,
        cwd: root,
        access: "readOnly",
        timeoutMs: 5_000,
      },
    });
    assert.equal(blockedWrappedFormal.isError, true);
    assert.equal(blockedWrappedFormal.structuredContent?.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");

    const ordinaryTextMentionsCodex = process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-Command", "Write-Output 'direct Codex is ordinary text here'"]
      : ["/bin/sh", "-lc", "printf '%s' 'direct Codex is ordinary text here'"];
    const allowedOrdinaryText = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        command: ordinaryTextMentionsCodex,
        cwd: root,
        access: "readOnly",
        timeoutMs: 5_000,
      },
    });
    assert.equal(allowedOrdinaryText.isError, false);
    assert.match(allowedOrdinaryText.structuredContent?.stdout ?? "", /direct Codex is ordinary text here/);

    const blocked = await client.callTool({
      name: "codex.agent_start",
      arguments: {
        prompt: "MUST_NOT_START_PUBLIC_MODEL_TURN",
        requestId: "managed-public-model-call-hard-block",
        invocationRationale: "Regression: maintenance Managed-only must block public Call Codex before any model turn.",
      },
    });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.structuredContent?.errorCode, "MANAGED_CODEX_MODEL_INVOCATION_DISABLED");
    assert.match(blocked.structuredContent?.error ?? "", /Managed toolbox is available/i);
    assert.match(blocked.structuredContent?.error ?? "", /no Existing fallback was performed/i);
  }, { entrypoint: "mcp-stdio-public.mjs" });
});
