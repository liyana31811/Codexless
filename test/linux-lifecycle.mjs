import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { linuxPaths, main, rollbackInstallation, runtimeEnvironment, systemdUnit } from "../scripts/linux.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.CODEXLESS_LINUX_TEST_NPM ?? path.join(path.dirname(process.execPath), "npm");

test("Linux lifecycle uses absolute XDG paths, loopback, a separate Codex home and a quoted systemd unit", () => {
  const paths = linuxPaths({ XDG_DATA_HOME: "/tmp/data space", XDG_CONFIG_HOME: "/tmp/config", XDG_STATE_HOME: "/tmp/state" }, "/tmp/home");
  assert.equal(paths.app, "/tmp/data space/codexless-linux/app");
  assert.equal(paths.codexHome, "/tmp/state/codexless-linux/codex-home");
  assert.throws(() => linuxPaths({ XDG_DATA_HOME: "relative" }, "/tmp/home"), /absolute/);
  const config = { schemaVersion: 1, applicationId: "codexless-linux", serverName: "codexless-linux", host: "127.0.0.1", port: 7691, defaultCwd: "/tmp/project", codexBin: null };
  const env = runtimeEnvironment(paths, config, { CODEX_HOME: "/original/.codex", PATH: "/usr/bin", CODEXLESS_LINUX_TUNNEL_API_KEY: "transport-secret", OPENAI_ADMIN_KEY: "admin-secret", OPENAI_API_KEY: "api-secret", CODEX_API_KEY: "codex-secret", AZURE_OPENAI_API_KEY: "azure-secret", CODEXLESS_PROFILE: "original", CODEXLESS_CONFIG_OVERRIDES_FILE: "/original/overrides.json", CODEXLESS_CALL_PROFILE_FILE: "/original/call.json", CODEXLESS_MANAGED_CODEX_HOME: "/original/home", CODEX_TOOLBOX_PROFILE: "original", CODEX_BIN: "/original/codex" });
  assert.equal(env.CODEX_HOME, paths.codexHome);
  assert.equal(env.CODEXLESS_CODEX_RUNTIME, "existing");
  assert.equal(env.CODEXLESS_SERVER_NAME, "codexless-linux");
  assert.equal(env.CODEXLESS_LINUX_TUNNEL_API_KEY, undefined); assert.equal(env.OPENAI_ADMIN_KEY, undefined);
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "CODEXLESS_PROFILE", "CODEXLESS_CONFIG_OVERRIDES_FILE", "CODEXLESS_CALL_PROFILE_FILE", "CODEXLESS_MANAGED_CODEX_HOME", "CODEX_TOOLBOX_PROFILE", "CODEX_BIN"]) assert.equal(env[key], undefined, key);
  assert.equal(env.CODEXLESS_AGENT_TASK_STATE_FILE, path.join(paths.state, "agent-tasks.json"));
  assert.throws(() => runtimeEnvironment(paths, { ...config, host: "0.0.0.0" }), /loopback/);
  assert.throws(() => runtimeEnvironment(paths, { ...config, sandbox: "danger-full-access" }), /unsupported/);
  assert.match(systemdUnit(paths), /ExecStart="\/tmp\/data space\/codexless-linux\/runtime\/bin\/node"/);
  assert.match(systemdUnit(paths), /\nWorkingDirectory=\/tmp\/data space\/codexless-linux\/app\n/);
  assert.match(systemdUnit(paths), /XDG_STATE_HOME=\/tmp\/state/);
  assert.match(systemdUnit(paths), /KillMode=control-group/);
  assert.doesNotMatch(systemdUnit(paths), /sudo|danger-full-access|enable --now/);
});

test("install, stdio, idempotent reinstall, guarded update, rollback and uninstall preserve user state", { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "codexless-linux-lifecycle-"));
  const home = path.join(scratch, "home space"), source = path.join(scratch, "source space");
  const testEnv = { HOME: home, XDG_DATA_HOME: path.join(home, "xdg-data"), XDG_CONFIG_HOME: path.join(home, "xdg-config"), XDG_STATE_HOME: path.join(home, "xdg-state"), XDG_RUNTIME_DIR: path.join(home, "no-systemd"), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, "no-bus")}`, PATH: "/usr/bin:/bin" };
  const paths = linuxPaths(testEnv, home);
  const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = testEnv.DBUS_SESSION_BUS_ADDRESS;
  try {
    for (const dir of ["scripts", "src", "config"]) await mkdir(path.join(source, dir), { recursive: true });
    await cp(path.join(root, "bin"), path.join(source, "bin"), { recursive: true, dereference: false, verbatimSymlinks: true });
    await cp(path.join(root, "scripts", "linux.mjs"), path.join(source, "scripts", "linux.mjs"));
    const packageInfo = { name: "codexless", version: "1.0.0", type: "module" };
    await writeFile(path.join(source, "package.json"), JSON.stringify(packageInfo));
    await writeFile(path.join(source, "npm-shrinkwrap.json"), JSON.stringify({ ...packageInfo, lockfileVersion: 3, requires: true, packages: { "": packageInfo } }));
    await writeFile(path.join(source, "scripts", "doctor.mjs"), 'console.log(JSON.stringify({status:"ok"}));\n');
    await writeFile(path.join(source, "src", "mcp-stdio-public.mjs"), 'console.log(JSON.stringify({serverName:process.env.CODEXLESS_SERVER_NAME,platform:process.platform,codexHome:process.env.CODEX_HOME,cwd:process.cwd(),transportKeyPresent:Boolean(process.env.CODEXLESS_LINUX_TUNNEL_API_KEY),apiKeyPresent:Boolean(process.env.OPENAI_API_KEY)}));\n');
    await writeFile(path.join(source, "config", "runtime-install-mode.json"), '{"schemaVersion":1,"mode":"recommended"}\n');
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const sentinel = '# Original config must survive unchanged\nmodel = "existing-user-model"\n';
    await writeFile(path.join(home, ".codex", "config.toml"), sentinel);
    const sourceAlias = path.join(scratch, "project alias");
    await symlink(source, sourceAlias);
    const options = ["--source", source, "--node", process.execPath, "--npm", npm, "--cwd", sourceAlias, "--trust-project"];
    const installed = await main(["install", ...options], paths);
    assert.equal(installed.action, "installed");
    assert.equal(installed.serviceStarted, false);
    assert.equal(installed.autostartEnabled, false);
    assert.equal(installed.projectTrust, "create_trusted");
    assert.equal(JSON.parse(await readFile(paths.runtimeConfig, "utf8")).defaultCwd, source);
    assert.equal((await lstat(paths.runtimeConfig)).mode & 0o777, 0o600);
    assert.equal((await lstat(path.join(paths.runtime, "bin", "node"))).mode & 0o111, 0o111);
    assert.equal(await readlink(path.join(paths.bin, "codexless-linux-stdio")), path.join(paths.app, "bin", "codexless-linux-stdio"));
    const isolatedConfig = await readFile(path.join(paths.codexHome, "config.toml"), "utf8");
    assert.match(isolatedConfig, /sandbox_mode = "workspace-write"/);
    assert.ok(isolatedConfig.includes(`[projects.${JSON.stringify(source)}]`));
    assert.doesNotMatch(isolatedConfig, /danger-full-access/);
    assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), sentinel);
    const stdio = await execute(path.join(paths.bin, "codexless-linux-stdio"), [], { env: { ...testEnv, CODEXLESS_LINUX_TUNNEL_API_KEY: "transport-secret", OPENAI_API_KEY: "api-secret" }, timeout: 10_000 });
    const result = JSON.parse(stdio.stdout);
    assert.equal(result.platform, "linux"); assert.equal(result.serverName, "codexless-linux");
    assert.equal(result.codexHome, paths.codexHome); assert.equal(result.cwd, source);
    assert.equal(result.transportKeyPresent, false); assert.equal(result.apiKeyPresent, false);
    const isolatedConfigPath = path.join(paths.codexHome, "config.toml");
    await rename(isolatedConfigPath, `${isolatedConfigPath}.saved`);
    await symlink(path.join(home, ".codex", "config.toml"), isolatedConfigPath);
    await assert.rejects(main(["doctor", "--lifecycle-only"], paths), /symlinked isolated Codex/);
    await assert.rejects(main(["login"], paths), /symlinked isolated Codex/);
    await assert.rejects(main(["update", ...options], paths), /symlinked isolated Codex/);
    await rm(isolatedConfigPath); await rename(`${isolatedConfigPath}.saved`, isolatedConfigPath);
    await link(path.join(home, ".codex", "config.toml"), path.join(paths.codexHome, "auth.json"));
    await assert.rejects(main(["doctor", "--lifecycle-only"], paths), /hard-linked isolated Codex/);
    await rm(path.join(paths.codexHome, "auth.json"));
    assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), sentinel);
    const lifecycleDoctor = await main(["doctor", "--lifecycle-only"], paths);
    assert.equal(lifecycleDoctor.ok, true);
    await assert.rejects(main(["start"], paths), /confirmation/);
    await assert.rejects(main(["enable"], paths), /confirmation/);
    const configBefore = await readFile(paths.runtimeConfig, "utf8");
    const reinstalled = await main(["install", ...options], paths);
    assert.equal(reinstalled.action, "updated");
    assert.equal(reinstalled.projectTrust, "already_trusted");
    assert.equal(await readFile(paths.runtimeConfig, "utf8"), configBefore);
    const otherProject = path.join(scratch, "other project");
    await mkdir(otherProject);
    const receiptBeforeTrustFailure = await readFile(paths.ownership, "utf8");
    await assert.rejects(main(["update", ...options, "--cwd", otherProject], paths), /existing isolated Codex config/);
    await assert.rejects(main(["update", ...options, "--cwd", path.join(scratch, "missing")], paths), /existing directory/);
    await assert.rejects(main(["update", ...options, "--cwd", path.join(source, "package.json")], paths), /existing directory/);
    assert.equal(await readFile(paths.runtimeConfig, "utf8"), configBefore);
    assert.equal(await readFile(paths.ownership, "utf8"), receiptBeforeTrustFailure);
    assert.equal(await readFile(isolatedConfigPath, "utf8"), isolatedConfig);
    await writeFile(path.join(paths.app, "user-local-change.txt"), "keep me\n");
    await assert.rejects(main(["update", ...options], paths), /local changes/);
    await assert.rejects(main(["uninstall"], paths), /local changes/);
    assert.equal(await readFile(path.join(paths.app, "user-local-change.txt"), "utf8"), "keep me\n");
    await rm(path.join(paths.app, "user-local-change.txt"));
    packageInfo.version = "2.0.0";
    await writeFile(path.join(source, "package.json"), JSON.stringify(packageInfo));
    await writeFile(path.join(source, "npm-shrinkwrap.json"), JSON.stringify({ ...packageInfo, lockfileVersion: 3, requires: true, packages: { "": packageInfo } }));
    const updated = await main(["update", ...options], paths);
    assert.equal(updated.version, "2.0.0");
    const { processIdentity } = await import("../scripts/linux-chatgpt.mjs");
    const sessionRuntime = path.join(scratch, "session runtime"), sessionLock = path.join(sessionRuntime, "chatgpt-session.lock");
    await mkdir(sessionLock, { recursive: true, mode: 0o700 });
    const sessionConfig = path.join(paths.config, "session.json"), sessionOwner = path.join(sessionLock, "owner.json");
    await writeFile(sessionConfig, JSON.stringify({ runtimeDir: sessionRuntime }), { mode: 0o600 });
    const liveIdentity = await processIdentity(process.pid);
    assert.ok(liveIdentity);
    await writeFile(sessionOwner, JSON.stringify({ ...liveIdentity, sessionId: "lifecycle-test" }), { mode: 0o600 });
    for (const command of ["install", "update", "rollback", "uninstall"]) await assert.rejects(main([command, ...(command === "install" || command === "update" ? options : [])], paths), /codexless-linux-chatgpt stop/);
    // A PID with a different start time is stale and must not block maintenance.
    await writeFile(sessionOwner, JSON.stringify({ ...liveIdentity, startTime: "0", sessionId: "lifecycle-test" }));
    await assert.rejects(main(["update", ...options, "--cwd", path.join(scratch, "missing")], paths), /existing directory/);
    await rm(sessionConfig); await rm(sessionRuntime, { recursive: true });
    const desktopReceipt = path.join(paths.config, "desktop-integration.json");
    await writeFile(desktopReceipt, "{}", { mode: 0o600 });
    await assert.rejects(main(["uninstall"], paths), /linux-desktop\.py.*restore/);
    assert.equal(JSON.parse(await readFile(path.join(paths.app, "package.json"), "utf8")).version, "2.0.0");
    await rm(desktopReceipt);
    const currentReceipt = await readFile(paths.ownership, "utf8");
    const backup = updated.previousBackup;
    const assertCurrent = async () => {
      assert.equal(await readFile(paths.ownership, "utf8"), currentReceipt);
      assert.equal(JSON.parse(await readFile(path.join(paths.app, "package.json"), "utf8")).version, "2.0.0");
      assert.ok((await lstat(path.join(paths.runtime, "bin", "node"))).isFile());
      assert.equal(await readFile(paths.runtimeConfig, "utf8"), configBefore);
    };
    // Missing or corrupted backup components must be rejected before a working
    // directory is moved. Restore each fixture for the next independent check.
    for (const relative of ["app", "runtime", "app/node_modules", "runtime/bin/node", "runtime/lib/node_modules/npm/bin/npm-cli.js"]) {
      const target = path.join(backup, relative);
      await rename(target, `${target}.saved`);
      try { await assert.rejects(main(["rollback"], paths), /unavailable|integrity/); await assertCurrent(); }
      finally { await rename(`${target}.saved`, target); }
    }
    for (const relative of ["app/package.json", "runtime/bin/node", "runtime/lib/node_modules/npm/bin/npm-cli.js"]) {
      const target = path.join(backup, relative), contents = await readFile(target);
      await writeFile(target, Buffer.concat([contents, Buffer.from("\n# corrupt fixture\n")]));
      try { await assert.rejects(main(["rollback"], paths), /integrity/); await assertCurrent(); }
      finally { await writeFile(target, contents); }
    }
    const backupReceiptPath = path.join(backup, "installation.json"), backupReceiptBytes = await readFile(backupReceiptPath);
    const unverifiedReceipt = JSON.parse(backupReceiptBytes);
    delete unverifiedReceipt.runtimeFiles;
    await writeFile(backupReceiptPath, JSON.stringify(unverifiedReceipt));
    try { await assert.rejects(main(["rollback"], paths), /no complete runtime\/dependency integrity snapshot/); await assertCurrent(); }
    finally { await writeFile(backupReceiptPath, backupReceiptBytes); }
    // Every directory switch and a post-write receipt failure restore the same
    // current app/runtime/receipt and preserve the prior backup for a retry.
    const backupNamesBefore = (await readdir(path.join(paths.data, "backups"))).sort();
    for (const failingMove of [1, 2, 3, 4]) {
      let calls = 0;
      await assert.rejects(rollbackInstallation(paths, { move: async (from, to) => { if (++calls === failingMove) throw new Error("Injected move failure"); return await rename(from, to); } }), /working installation and receipt were restored/);
      await assertCurrent();
      assert.deepEqual((await readdir(path.join(paths.data, "backups"))).sort(), backupNamesBefore);
    }
    await assert.rejects(rollbackInstallation(paths, { commitReceipt: async (target, value) => { await writeFile(target, JSON.stringify(value)); throw new Error("Injected receipt failure after write"); } }), /working installation and receipt were restored/);
    await assertCurrent();
    assert.deepEqual((await readdir(path.join(paths.data, "backups"))).sort(), backupNamesBefore);
    assert.equal((await main(["rollback"], paths)).version, "1.0.0");
    assert.equal(await readFile(paths.runtimeConfig, "utf8"), configBefore);
    const uninstalled = await main(["uninstall"], paths);
    assert.equal(uninstalled.configurationPreserved, true);
    await assert.rejects(lstat(paths.app), { code: "ENOENT" });
    assert.equal(await readFile(path.join(home, ".codex", "config.toml"), "utf8"), sentinel);
    assert.equal(await readFile(path.join(paths.codexHome, "config.toml"), "utf8"), isolatedConfig);
    assert.ok((await readdir(path.join(paths.data, "backups"))).length >= 1);
    assert.equal((await main(["uninstall"], paths)).action, "already_uninstalled");
  } finally {
    if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
    await rm(scratch, { recursive: true, force: true });
  }
});
