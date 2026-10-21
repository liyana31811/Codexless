import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexlessIdentity, codexlessPaths } from "../src/linux-identity.mjs";
import { CodexAppServerClient, CodexRpcTimeoutError } from "../src/codex-app-server-client.mjs";
import { boundLinuxPermissionProfile, findTrustedAncestor, normalizeConfigPath } from "../src/codex-authority-executor.mjs";
import { validatePermissionProjection } from "../src/codex-permission-executor.mjs";
import { findPosixExecutable, probeCodexExecutable, resolveCodexExecutable } from "../src/codex-bin.mjs";
import { codexlessPlatformSupport } from "../src/platform-support.mjs";
import { releaseAssetContract } from "../src/release-discovery.mjs";

// Run this file on each native OS. Passing here does not certify another OS.
// The protocol peer is a synthetic model-free server, not a live Codex account.
const host = `${process.platform}/${process.arch}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Linux arm64 remains unverified and cannot select a supported release asset", () => {
  const support = codexlessPlatformSupport({ platform: "linux", arch: "arm64" });
  assert.equal(support.status, "unverified");
  assert.match(support.reason, /unverified.*outside accepted preview support/);
  assert.throws(() => releaseAssetContract("0.1.2-preview.1", "linux", "arm64"), error => error.code === "UNSUPPORTED_PLATFORM");
  assert.equal(codexlessPlatformSupport({ platform: "linux", arch: "x64" }).status, "supported");
  assert.equal(codexlessPlatformSupport({ platform: "win32", arch: "x64" }).status, "supported");
  assert.equal(codexlessPlatformSupport({ platform: "darwin", arch: "arm64" }).status, "supported");
});

async function eventually(check, message) {
  const deadline = Date.now() + 5_000;
  do {
    if (await check()) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function isRunning(pid) {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function fixtureEnvironment(root) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "codex-home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_STATE_HOME: path.join(root, "state") };
}

async function serverFixture({ ignoreEof = false, cleanupError = null, malformedInitialize = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexless-native-app-server-")));
  const script = path.join(root, "synthetic-server.mjs");
  const pids = [];
  let cleanups = 0;
  await mkdir(path.join(root, "codex-home"));
  await writeFile(script, `
import { spawnSync } from 'node:child_process';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => { if (!${JSON.stringify(ignoreEof)}) process.exit(0); });
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n');
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === 'exit-now') process.exit(19);
    if (message.method === 'never-return' || message.id === undefined) continue;
    if (message.method === 'initialize' && ${JSON.stringify(malformedInitialize)}) {
      process.stdout.write('deliberately invalid JSON\\n');
      continue;
    }
    let result = { pid: process.pid, cwd: process.cwd(), codexHome: process.env.CODEX_HOME };
    if (message.method === 'command/exec') {
      const child = spawnSync(message.params.command[0], message.params.command.slice(1), { cwd: process.cwd(), env: process.env, encoding: 'utf8', shell: false, windowsHide: true });
      result = { stdout: child.stdout, stderr: child.stderr, exitCode: child.status };
    }
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`);
  const client = new CodexAppServerClient({
    cwd: root,
    launch: () => ({
      command: process.execPath,
      args: [script],
      options: { cwd: root, env: fixtureEnvironment(root) },
      cleanup: async () => { cleanups += 1; if (cleanupError) throw cleanupError; },
    }),
    stderrHandler: () => {},
  });
  return {
    root, client,
    cleanups: () => cleanups,
    async start() { const result = await client.start(); pids.push(result.pid); return result; },
    async dispose() {
      await client.close().catch(() => {});
      for (const pid of pids) {
        if (await isRunning(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        await eventually(async () => !await isRunning(pid), "synthetic peer survived fixture disposal");
      }
      // Windows can report a terminated process before releasing its CWD handle.
      // Retry only this known disposable fixture; non-transient errors still fail.
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

test(`native ${host}: trust containment preserves non-Linux baseline and Linux case boundaries`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-native-path-"));
  try {
    const project = path.join(root, "Project");
    const nested = path.join(project, "nested");
    const config = { projects: { [project]: { trust_level: "trusted" }, [nested]: { trustLevel: "trusted" }, [path.join(root, "ignored")]: { trust_level: "untrusted" } } };
    assert.equal(findTrustedAncestor(config, path.join(nested, "file"))?.root, nested);
    assert.equal(findTrustedAncestor(config, `${project}-other`), null);
    assert.equal(findTrustedAncestor(config, path.join(project, "..", "outside")), null);
    const differentlyCased = path.join(root, "project");
    assert.equal(findTrustedAncestor({ projects: { [project]: { trust_level: "trusted" } } }, differentlyCased)?.root ?? null, process.platform === "linux" ? null : project);
    const expected = process.platform === "linux" ? path.resolve(project) : path.resolve(project).replaceAll("/", "\\").toLowerCase();
    assert.equal(normalizeConfigPath(project), expected);
    if (process.platform === "linux") assert.equal(findTrustedAncestor({ projects: { "/": { trust_level: "trusted" } } }, project)?.root, "/");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test(`native ${host}: permission projection rejects absent roots and unknown policy fields`, () => {
  const workspace = path.join(os.tmpdir(), "codexless-Projection");
  const started = { activePermissionProfile: { id: ":workspace" }, runtimeWorkspaceRoots: [workspace], sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [workspace] } };
  assert.equal(validatePermissionProjection(started, workspace).profileId, ":workspace");
  assert.throws(() => validatePermissionProjection({ ...started, runtimeWorkspaceRoots: [`${workspace}-other`] }, workspace), /absent/);
  assert.throws(() => validatePermissionProjection({ ...started, sandbox: { ...started.sandbox, unknownRestriction: true } }, workspace), /fails closed/);
  assert.throws(() => validatePermissionProjection({ ...started, activePermissionProfile: { id: "unverified" } }, workspace), /custom permission/);
  const differentCase = workspace.replace("Projection", "projection");
  if (process.platform === "linux") assert.throws(() => validatePermissionProjection(started, differentCase), /absent/);
  else assert.doesNotThrow(() => validatePermissionProjection(started, differentCase));
  const allowedProfiles = [":read-only", ":workspace", ":danger-full-access"];
  assert.equal(boundLinuxPermissionProfile(":danger-full-access", { allowedProfiles }), process.platform === "linux" ? ":workspace" : ":danger-full-access");
  assert.equal(boundLinuxPermissionProfile(":workspace", { access: "readOnly", allowedProfiles }), ":read-only");
});

test(`native ${host}: binary probe launches native executable without a shell`, async () => {
  const result = await probeCodexExecutable(process.execPath);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
  assert.match(result.versionText, /^v\d+/);
  assert.equal(result.version, null, "Node is not accidentally accepted as Codex");
  await assert.rejects(resolveCodexExecutable({ env: { CODEX_BIN: process.execPath } }), { code: "CODEX_EXECUTABLE_NOT_FOUND" });
});

test(`native ${host}: POSIX PATH lookup skips relative, directory and non-executable candidates`, { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-native-executable-"));
  try {
    const shadow = path.join(root, "shadow");
    const usable = path.join(root, "usable");
    await mkdir(path.join(shadow, "codex"), { recursive: true });
    await mkdir(usable);
    const file = path.join(usable, "codex");
    await writeFile(file, "#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n", { mode: 0o600 });
    assert.equal(await findPosixExecutable("codex", { PATH: ["", "relative", shadow, usable].join(path.delimiter) }), null);
    await chmod(file, 0o700);
    assert.equal(await findPosixExecutable("codex", { PATH: ["", "relative", shadow, usable].join(path.delimiter) }), file);
    assert.equal((await probeCodexExecutable(file)).version, "1.2.3");
    assert.equal(await findPosixExecutable("../codex", { PATH: usable }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const ignoreEof of [false, true]) {
  test(`native ${host}: ${ignoreEof ? "forced" : "graceful"} server shutdown cleans launch resources once`, async () => {
    const item = await serverFixture({ ignoreEof });
    try {
      const started = await item.start();
      assert.equal(started.cwd, item.root);
      assert.equal(started.codexHome, path.join(item.root, "codex-home"));
      const argument = "literal; $HOME & echo not-a-shell";
      const result = await item.client.exec({ command: [process.execPath, "-e", "process.stdout.write(process.argv[1]);process.stderr.write('fixture-stderr');process.exitCode=7", argument] });
      assert.deepEqual(result, { stdout: argument, stderr: "fixture-stderr", exitCode: 7 });
      await item.client.close();
      await item.client.close();
      await eventually(async () => !await isRunning(started.pid), "server survived shutdown");
      assert.equal(item.cleanups(), 1);
      assert.equal(item.client.running, false);
    } finally { await item.dispose(); }
  });
}

test(`native ${host}: request timeout terminates peer and permits a clean restart`, async () => {
  const item = await serverFixture();
  try {
    const first = await item.start();
    await assert.rejects(item.client.request("never-return", {}, { timeoutMs: 100 }), CodexRpcTimeoutError);
    await eventually(async () => !await isRunning(first.pid), "timed-out server survived shutdown");
    assert.equal(item.cleanups(), 1);
    const second = await item.start();
    assert.notEqual(first.pid, second.pid);
    await item.client.close();
    assert.equal(item.cleanups(), 2);
  } finally { await item.dispose(); }
});

test(`native ${host}: unexpected exit rejects pending RPC and cleans before restart`, async () => {
  const item = await serverFixture();
  try {
    await item.start();
    const pending = item.client.request("never-return", {}, { timeoutMs: 5_000 });
    const rejection = assert.rejects(pending, /app-server exited/);
    item.client.notify("exit-now", {});
    await rejection;
    // Match the accepted non-Linux lifecycle: explicitly close a failed peer
    // before starting a replacement and release its private launch resources.
    await item.client.close();
    await item.start();
    assert.equal(item.cleanups(), 1);
    await item.client.close();
    assert.equal(item.cleanups(), 2);
  } finally { await item.dispose(); }
});

test(`native ${host}: launch cleanup failures surface and are not replayed`, async () => {
  const item = await serverFixture({ cleanupError: new Error("fixture cleanup failure") });
  try {
    const started = await item.start();
    await assert.rejects(item.client.close(), /fixture cleanup failure/);
    await item.client.close();
    await eventually(async () => !await isRunning(started.pid), "server survived failed cleanup");
    assert.equal(item.cleanups(), 1);
  } finally { await item.dispose(); }
});

test(`native ${host}: malformed initialize fails closed and performs private launch cleanup`, async () => {
  const item = await serverFixture({ malformedInitialize: true });
  try {
    await assert.rejects(item.start(), /Invalid Codex App Server JSON/);
    assert.equal(item.cleanups(), 1);
    assert.equal(item.client.running, false);
  } finally { await item.dispose(); }
});


test(`native ${host}: service identity and state preserve existing platform defaults`, () => {
  const root = path.join(os.tmpdir(), "codexless-platform-defaults");
  const env = { HOME: root, CODEXLESS_SERVER_NAME: "codexless-linux", CODEXLESS_STATE_ROOT: path.join(root, "override"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") };
  const identity = codexlessIdentity({ env });
  const paths = codexlessPaths({ env });
  if (process.platform === "linux") {
    assert.equal(identity.name, "codexless-linux");
    assert.equal(paths.config, path.join(root, "config", "codexless-linux"));
    assert.equal(paths.state, env.CODEXLESS_STATE_ROOT);
  } else {
    assert.deepEqual(identity, { name: "codexless", title: "Codexless" });
    const legacy = path.join(os.homedir(), ".config", "codexless");
    assert.deepEqual(paths, { config: legacy, data: legacy, state: legacy });
  }
});
