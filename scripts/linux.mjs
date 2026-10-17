#!/usr/bin/env node
// Independent Linux lifecycle. This never writes original Codex configuration or credentials.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "codexless-linux";
const UNIT_MARKER = "# Managed by codexless-linux; independent of codexless";
const COMMANDS = ["install", "start", "stop", "restart", "status", "logs", "doctor", "update", "rollback", "uninstall", "http", "stdio", "enable", "disable", "login", "tunnel", "chatgpt"];
const COPY_ENTRIES = ["src", "scripts", "bin", "config", "skills", "package.json", "npm-shrinkwrap.json", "README.md", "README.zh-CN.md", "README.linux.md", "README.linux-tunnel.zh-CN.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "EXPORT_SYNC.md", "LICENSE"];

export function linuxPaths(env = process.env, home = os.homedir()) {
  const xdg = (key, fallback) => env[key] ? absolute(env[key], key) : path.join(home, fallback);
  const data = path.join(xdg("XDG_DATA_HOME", ".local/share"), ID);
  const config = path.join(xdg("XDG_CONFIG_HOME", ".config"), ID);
  const state = path.join(xdg("XDG_STATE_HOME", ".local/state"), ID);
  return {
    home, data, config, state, app: path.join(data, "app"), runtime: path.join(data, "runtime"),
    bin: path.join(home, ".local", "bin"),
    runtimeConfig: path.join(config, "runtime.json"), ownership: path.join(state, "installation.json"), codexHome: path.join(state, "codex-home"),
    unit: path.join(xdg("XDG_CONFIG_HOME", ".config"), "systemd", "user", `${ID}.service`),
    log: path.join(state, "logs", "server.log"),
  };
}

function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\n\r\0]/.test(value)) throw new Error(`${label} must be an absolute path without control characters`);
  return path.resolve(value);
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function systemdQuote(value, escapeDollar = false) {
  const quoted = String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${escapeDollar ? quoted.replaceAll("$", "$$") : quoted}"`;
}
async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function json(target) { return JSON.parse(await readFile(target, "utf8")); }
async function atomicJson(target, value) {
  await atomicFile(target, `${JSON.stringify(value, null, 2)}\n`);
}
async function atomicFile(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, target);
}
async function rejectSymlink(target) {
  if (await exists(target) && (await lstat(target)).isSymbolicLink()) throw new Error(`Refusing a symlinked codexless-linux private path: ${target}`);
}
async function guardCodexHome(paths) {
  await rejectSymlink(paths.codexHome);
  for (const name of ["config.toml", "auth.json"]) {
    const target = path.join(paths.codexHome, name);
    if (!(await exists(target))) continue;
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symlinked isolated Codex ${name}`);
    if (stat.nlink > 1) throw new Error(`Refusing a hard-linked isolated Codex ${name}`);
    if (!stat.isFile()) throw new Error(`Isolated Codex ${name} must be a regular file`);
  }
}
async function withLifecycleLock(paths, operation) {
  for (const target of [paths.data, paths.config, paths.state, paths.codexHome, paths.runtimeConfig, paths.ownership]) await rejectSymlink(target);
  await guardCodexHome(paths);
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const lock = path.join(paths.state, "lifecycle.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another lifecycle operation owns ${lock}; inspect its owner.json before removing a stale lock`); throw error; }
  try {
    await atomicJson(path.join(lock, "owner.json"), { applicationId: ID, pid: process.pid, startedAt: new Date().toISOString() });
    return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function run(command, args, { env = process.env, cwd, timeout = 180_000, inherit = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout?.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-1_000_000); });
    child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-1_000_000); });
    let killTimer;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000); }, timeout);
    child.once("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}

async function digestTree(root, { omitRootNodeModules = true } = {}) {
  const files = {};
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (omitRootNodeModules && !relative && entry.name === "node_modules") continue;
      const rel = path.join(relative, entry.name), target = path.join(root, rel);
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isSymbolicLink()) files[rel] = `symlink:${await readlink(target)}`;
      else if (entry.isFile()) files[rel] = createHash("sha256").update(await readFile(target)).digest("hex");
      else throw new Error(`Unsupported file type in application: ${rel}`);
    }
  }
  await walk();
  return files;
}

async function ownership(paths, { required = true } = {}) {
  if (!(await exists(paths.ownership))) {
    if (required) throw new Error("No codexless-linux ownership receipt exists; install first");
    return null;
  }
  const receipt = await json(paths.ownership);
  if (receipt.schemaVersion !== 1 || receipt.applicationId !== ID || receipt.app !== paths.app || receipt.runtime !== paths.runtime) throw new Error("Installation ownership receipt does not match these XDG paths");
  return receipt;
}
async function assertUnmodified(paths, receipt) {
  await assertTreeIntegrity(paths.app, receipt.files, "Installed application");
  if (receipt.runtimeFiles) await assertTreeIntegrity(paths.runtime, receipt.runtimeFiles, "Installed runtime", false);
  if (receipt.dependencyFiles) await assertTreeIntegrity(path.join(paths.app, "node_modules"), receipt.dependencyFiles, "Installed dependencies", false);
}
async function assertTreeIntegrity(root, expected, label, omitRootNodeModules = true) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error(`${label} has no valid integrity snapshot`);
  const actual = await digestTree(root, { omitRootNodeModules });
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(key => expected[key] !== actual[key]);
  if (changed.length) throw new Error(`${label} has local changes; preserve/review them before update or uninstall: ${changed.slice(0, 8).join(", ")}`);
}
async function fullIntegrity(paths, receipt) {
  return { ...receipt, runtimeFiles: await digestTree(paths.runtime, { omitRootNodeModules: false }), dependencyFiles: await digestTree(path.join(paths.app, "node_modules"), { omitRootNodeModules: false }) };
}
async function canonicalDirectory(value, label) {
  const directory = await realpath(absolute(value, label)).catch(error => { throw new Error(`${label} must resolve to an existing directory (${error.code})`); });
  if (!(await lstat(directory)).isDirectory()) throw new Error(`${label} must resolve to an existing directory`);
  return directory;
}
async function trustProjectState(paths, cwd, requested) {
  if (!requested) return "not_requested";
  const target = path.join(paths.codexHome, "config.toml");
  if (!(await exists(target))) return "create_trusted";
  const config = await readFile(target, "utf8");
  // Accept the explicit table emitted by this installer. Do not attempt to rewrite
  // arbitrary user TOML or infer a trust grant from unrelated project sections.
  const table = `[projects.${JSON.stringify(cwd)}]`;
  const start = config.split(/\r?\n/).findIndex(line => line.trim() === table);
  if (start >= 0) {
    const lines = config.split(/\r?\n/).slice(start + 1);
    const end = lines.findIndex(line => line.trim().startsWith("["));
    if (lines.slice(0, end < 0 ? undefined : end).some(line => /^\s*trust_level\s*=\s*"trusted"\s*(?:#.*)?$/.test(line))) return "already_trusted";
  }
  throw new Error(`--trust-project cannot be silently applied to an existing isolated Codex config. Explicitly trust ${cwd} in ${target}, or omit --trust-project to preserve current trust. No configuration was changed.`);
}
async function ensureManagedUnit(paths) {
  if (await exists(paths.unit)) {
    if (!(await readFile(paths.unit, "utf8")).startsWith(`${UNIT_MARKER}\n`)) throw new Error("An unrelated codexless-linux systemd unit exists; it was not overwritten");
  }
}
export function systemdUnit(paths) {
  // Path-valued unit directives retain literal quote marks; only argv/Environment use quotes.
  const unitPath = value => String(value).replaceAll("%", "%%");
  return `${UNIT_MARKER}\n[Unit]\nDescription=Codexless Linux independent loopback MCP service\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=${systemdQuote(`HOME=${paths.home}`)} ${systemdQuote(`XDG_DATA_HOME=${path.dirname(paths.data)}`)} ${systemdQuote(`XDG_CONFIG_HOME=${path.dirname(paths.config)}`)} ${systemdQuote(`XDG_STATE_HOME=${path.dirname(paths.state)}`)}\nWorkingDirectory=${unitPath(paths.app)}\nExecStart=${systemdQuote(path.join(paths.runtime, "bin", "node"), true)} ${systemdQuote(path.join(paths.app, "scripts", "linux.mjs"), true)} http\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\nUMask=0077\nStandardOutput=append:${unitPath(paths.log)}\nStandardError=append:${unitPath(paths.log)}\n\n[Install]\nWantedBy=default.target\n`;
}

async function resolveNpm(options, nodeSource) {
  let candidate = options.npm;
  if (!candidate) {
    for (const possible of [path.join(path.dirname(nodeSource), "npm"), ...String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "npm"))]) {
      if (await exists(possible)) { candidate = possible; break; }
    }
  }
  if (!candidate) throw new Error("npm was not found; pass --npm /absolute/path/to/npm");
  const cli = await realpath(absolute(candidate, "--npm"));
  // The official npm CLI is JavaScript; run it with the selected Node, avoiding PATH/shebang ambiguity.
  const packageRoot = path.resolve(path.dirname(cli), "..");
  if ((await json(path.join(packageRoot, "package.json"))).name !== "npm") throw new Error("--npm must resolve to the official npm CLI");
  return { cli, packageRoot };
}

async function install(paths, options, updating = false) {
  await assertSessionStopped(paths);
  const old = await ownership(paths, { required: updating });
  if (old) {
    await assertStopped();
    await assertUnmodified(paths, old);
  } else if (await exists(paths.app) || await exists(paths.runtime)) throw new Error("Unowned installation paths exist; no files were overwritten");
  await ensureManagedUnit(paths);
  const source = await canonicalDirectory(options.source ?? sourceRoot, "--source");
  if (source === paths.app || source.startsWith(`${paths.data}${path.sep}`)) throw new Error("Install/update source must be a separate reviewed checkout");
  const packageInfo = await json(path.join(source, "package.json"));
  if (!["codexless", ID].includes(packageInfo.name) || !(await exists(path.join(source, "scripts", "linux.mjs")))) throw new Error("Source is not a Linux-adapted Codexless checkout");
  const nodeSource = await realpath(absolute(options.node ?? process.execPath, "--node"));
  const version = await run(nodeSource, ["-p", "process.versions.node"], { timeout: 10_000 });
  if (version.code !== 0 || Number.parseInt(version.stdout, 10) < 22) throw new Error("Node.js 22+ is required");
  const npm = options["copy-deps"] ? null : await resolveNpm(options, nodeSource);
  let config = { schemaVersion: 1, applicationId: ID, serverName: ID, host: "127.0.0.1", port: 7691, defaultCwd: source, codexBin: null };
  if (await exists(paths.runtimeConfig)) config = await loadConfig(paths);
  config.defaultCwd = await canonicalDirectory(options.cwd ?? config.defaultCwd, "--cwd/defaultCwd");
  if (options.codex) config.codexBin = absolute(options.codex, "--codex");
  if (options.port) config.port = Number(options.port);
  validateConfig(config);
  const projectTrust = await trustProjectState(paths, config.defaultCwd, options["trust-project"]);
  const previousConfig = await exists(paths.runtimeConfig) ? await readFile(paths.runtimeConfig) : null;
  const previousUnit = await exists(paths.unit) ? await readFile(paths.unit) : null;
  const createdCommands = [];
  for (const dir of [paths.data, paths.config, paths.state, paths.bin, path.join(paths.state, "logs"), path.dirname(paths.unit)]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const staging = path.join(paths.data, `.stage-${randomUUID()}`);
  const stagedApp = path.join(staging, "app"), stagedRuntime = path.join(staging, "runtime");
  await mkdir(stagedApp, { recursive: true, mode: 0o700 });
  let backup = null, activatedApp = false, activatedRuntime = false;
  try {
    for (const entry of COPY_ENTRIES) if (await exists(path.join(source, entry))) await cp(path.join(source, entry), path.join(stagedApp, entry), { recursive: true, dereference: false, verbatimSymlinks: true });
    if (options["copy-deps"]) {
      if (!(await exists(path.join(source, "node_modules")))) throw new Error("--copy-deps requires a prepared source node_modules directory");
      await cp(path.join(source, "node_modules"), path.join(stagedApp, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
    } else {
      const result = await run(nodeSource, [npm.cli, "ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stagedApp, env: { ...process.env, PATH: `${path.dirname(nodeSource)}${path.delimiter}${process.env.PATH ?? ""}` }, timeout: 300_000 });
      if (result.code !== 0) throw new Error(`npm ci failed (exit ${result.code}, timeout=${result.timedOut}); staged install was discarded`);
    }
    // Empty production dependency sets need the same explicit integrity root.
    await mkdir(path.join(stagedApp, "node_modules"), { recursive: true });
    await mkdir(path.join(stagedRuntime, "bin"), { recursive: true, mode: 0o700 });
    await copyFile(nodeSource, path.join(stagedRuntime, "bin", "node"));
    await chmod(path.join(stagedRuntime, "bin", "node"), 0o755);
    if (npm) {
      await mkdir(path.join(stagedRuntime, "lib", "node_modules"), { recursive: true });
      await cp(npm.packageRoot, path.join(stagedRuntime, "lib", "node_modules", "npm"), { recursive: true, dereference: false, verbatimSymlinks: true });
      await symlink("../lib/node_modules/npm/bin/npm-cli.js", path.join(stagedRuntime, "bin", "npm"));
    }
    await writeFile(path.join(stagedApp, "config", "runtime-install-mode.json"), `${JSON.stringify({ schemaVersion: 1, mode: "existing" }, null, 2)}\n`);
    for (const entry of await readdir(path.join(stagedApp, "bin"))) if (entry.startsWith(ID)) await chmod(path.join(stagedApp, "bin", entry), 0o755);
    // Check wrapper collisions before activating either directory.
    for (const name of [ID, ...COMMANDS.map(command => `${ID}-${command}`)]) {
      const target = path.join(paths.bin, name);
      if (await exists(target)) {
        const stat = await lstat(target);
        if (!stat.isSymbolicLink() || await readlink(target) !== path.join(paths.app, "bin", name)) throw new Error(`Unrelated command exists: ${target}`);
      }
    }
    if (old) {
      // Legacy receipts are upgraded while both current directories are intact.
      const backupReceipt = await fullIntegrity(paths, old);
      backup = path.join(paths.data, "backups", `${Date.now()}-${randomUUID()}`);
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await rename(paths.app, path.join(backup, "app"));
      try { await rename(paths.runtime, path.join(backup, "runtime")); } catch (error) { await rename(path.join(backup, "app"), paths.app); throw error; }
      await atomicJson(path.join(backup, "installation.json"), backupReceipt);
    }
    await rename(stagedApp, paths.app);
    activatedApp = true;
    await rename(stagedRuntime, paths.runtime);
    activatedRuntime = true;
    await atomicJson(paths.runtimeConfig, config);
    await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
    const isolatedConfig = path.join(paths.codexHome, "config.toml");
    if (!(await exists(isolatedConfig))) {
      const trust = options["trust-project"] ? `\n[projects.${JSON.stringify(config.defaultCwd)}]\ntrust_level = "trusted"\n` : "";
      await writeFile(isolatedConfig, `# Independent codexless-linux home; original ~/.codex is untouched.\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\n${trust}`, { mode: 0o600, flag: "wx" });
    }
    await atomicFile(paths.unit, systemdUnit(paths));
    for (const name of [ID, ...COMMANDS.map(command => `${ID}-${command}`)]) {
      const target = path.join(paths.bin, name);
      if (!(await exists(target))) { await symlink(path.join(paths.app, "bin", name), target); createdCommands.push(target); }
    }
    const receipt = await fullIntegrity(paths, { schemaVersion: 1, applicationId: ID, app: paths.app, runtime: paths.runtime, source, version: packageInfo.version, installedAt: new Date().toISOString(), files: await digestTree(paths.app), previousBackup: backup ?? old?.previousBackup ?? null });
    await atomicJson(paths.ownership, receipt);
    return { ok: true, action: updating || old ? "updated" : "installed", applicationId: ID, paths, version: packageInfo.version, previousBackup: receipt.previousBackup, projectTrust, serviceStarted: false, autostartEnabled: false, next: `${ID}-doctor` };
  } catch (error) {
    if (activatedApp) await rm(paths.app, { recursive: true, force: true });
    if (activatedRuntime) await rm(paths.runtime, { recursive: true, force: true });
    if (backup) {
      if (!(await exists(paths.app)) && await exists(path.join(backup, "app"))) await rename(path.join(backup, "app"), paths.app);
      if (!(await exists(paths.runtime)) && await exists(path.join(backup, "runtime"))) await rename(path.join(backup, "runtime"), paths.runtime);
    }
    for (const target of createdCommands) await rm(target, { force: true });
    if (activatedApp || activatedRuntime) {
      if (previousConfig) await atomicFile(paths.runtimeConfig, previousConfig); else await rm(paths.runtimeConfig, { force: true });
      if (previousUnit) await atomicFile(paths.unit, previousUnit); else await rm(paths.unit, { force: true });
    }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

function validateConfig(config) {
  if (config.schemaVersion !== 1 || config.applicationId !== ID || config.serverName !== ID) throw new Error("runtime.json must declare the independent codexless-linux identity");
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) throw new Error("runtime.json host must be loopback");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("runtime.json port must be 1..65535");
  absolute(config.defaultCwd, "defaultCwd");
  if (config.codexBin !== null) absolute(config.codexBin, "codexBin");
  const allowed = new Set(["schemaVersion", "applicationId", "serverName", "host", "port", "defaultCwd", "codexBin"]);
  if (Object.keys(config).some(key => !allowed.has(key))) throw new Error("runtime.json contains unsupported settings; arbitrary Codex permission overrides are not accepted");
}
async function loadConfig(paths) {
  for (const target of [paths.config, paths.state, paths.codexHome, paths.runtimeConfig]) await rejectSymlink(target);
  await guardCodexHome(paths);
  const config = await json(paths.runtimeConfig); validateConfig(config); return config;
}
export function runtimeEnvironment(paths, config, env = process.env) {
  validateConfig(config);
  const inherited = { ...env };
  // A Tunnel key authorizes the transport; it must never reach MCP tools or Codex children.
  for (const key of Object.keys(inherited)) if (["OPENAI_API_KEY", "CODEX_API_KEY", "AZURE_OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "CONTROL_PLANE_API_KEY", "CODEX_BIN"].includes(key) || key.startsWith("TUNNEL_CLIENT_") || key.startsWith("CODEXLESS_") || key.startsWith("CODEX_TOOLBOX_")) delete inherited[key];
  // Only documented lifecycle settings are added. Codex trust/sandbox remain authoritative.
  return {
    ...inherited, CODEX_HOME: paths.codexHome, CODEXLESS_SERVER_NAME: ID, CODEXLESS_LINUX: "1", CODEXLESS_STATE_ROOT: paths.state,
    CODEXLESS_CODEX_RUNTIME: "existing", CODEXLESS_DEFAULT_CWD: config.defaultCwd,
    CODEXLESS_AGENT_TASK_STATE_FILE: path.join(paths.state, "agent-tasks.json"),
    CODEXLESS_RECENT_CALLS_STATE_FILE: path.join(paths.state, "recent-calls.json"),
    CODEX_TOOLBOX_PUBLIC_HOST: config.host, CODEX_TOOLBOX_PUBLIC_PORT: String(config.port),
    ...(config.codexBin ? { CODEX_BIN: config.codexBin } : {}),
    PATH: `${path.join(paths.runtime, "bin")}${path.delimiter}${env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
  };
}
async function service(args, inherit = false) { return await run("systemctl", ["--user", ...args], { inherit, timeout: 25_000 }); }
async function assertStopped() {
  try { const result = await service(["is-active", `${ID}.service`]); if (result.code === 0 || ["activating", "deactivating", "reloading"].includes(result.stdout.trim())) throw new Error("Stop codexless-linux before changing its installation"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function assertSessionStopped(paths) {
  const configuration = path.join(paths.config, "session.json");
  if (!(await exists(configuration))) return;
  await rejectSymlink(configuration);
  const configStat = await lstat(configuration);
  if (!configStat.isFile() || configStat.uid !== process.getuid() || (configStat.mode & 0o077)) throw new Error("Session configuration must be an owned private regular file before changing the installation");
  const { sessionPaths, sameProcess } = await import("./linux-chatgpt.mjs");
  const defaults = sessionPaths({ ...process.env, XDG_DATA_HOME: path.dirname(paths.data), XDG_CONFIG_HOME: path.dirname(paths.config), XDG_STATE_HOME: path.dirname(paths.state) }, paths.home);
  const config = await json(configuration);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid ChatGPT session configuration; inspect it before changing the installation");
  const runtime = config.runtimeDir === undefined ? defaults.runtime : absolute(config.runtimeDir, "session runtimeDir");
  const lock = path.join(runtime, "chatgpt-session.lock");
  if (!(await exists(lock))) return;
  const lockStat = await lstat(lock);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.uid !== process.getuid() || (lockStat.mode & 0o077)) throw new Error("Unsafe ChatGPT session lock; inspect it before changing the installation");
  const ownerPath = path.join(lock, "owner.json");
  if (!(await exists(ownerPath))) {
    if (Date.now() - lockStat.mtimeMs < 5000) throw new Error("ChatGPT session is starting; run codexless-linux-chatgpt stop before changing the installation");
    return;
  }
  const ownerStat = await lstat(ownerPath);
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== process.getuid() || (ownerStat.mode & 0o077)) throw new Error("Unsafe ChatGPT session owner metadata; inspect it before changing the installation");
  const owner = await json(ownerPath);
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.startTime !== "string" || !/^\d+$/.test(owner.startTime)) throw new Error("Invalid ChatGPT session owner metadata; inspect it before changing the installation");
  if (await sameProcess(owner)) throw new Error("ChatGPT session is running; run codexless-linux-chatgpt stop before changing the installation. This stops the bridge and Tunnel without closing ChatGPT.");
}
async function requireStartConfirmation(paths, options) {
  const marker = path.join(paths.state, "service-start-approved.json");
  if (!(await exists(marker))) {
    if (!options["confirm-start"]) throw new Error("First background service start requires user confirmation: rerun with --confirm-start");
    await atomicJson(marker, { applicationId: ID, confirmedAt: new Date().toISOString() });
  }
}
async function serve(paths, command) {
  await ownership(paths);
  const config = await loadConfig(paths);
  const env = runtimeEnvironment(paths, config);
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(config.defaultCwd);
  if (command === "stdio") await import(pathToUrl(path.join(paths.app, "src", "mcp-stdio-public.mjs")));
  else await import(pathToUrl(path.join(paths.app, "src", "mcp-http-public.mjs")));
}
function pathToUrl(value) { return pathToFileURL(value).href; }

async function doctor(paths, options) {
  const checks = [{ name: "linux", ok: process.platform === "linux", detail: `${process.platform}/${process.arch}` }, { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version }];
  const receipt = await ownership(paths, { required: false });
  checks.push({ name: "installation", ok: Boolean(receipt), detail: receipt?.version ?? "not installed" });
  if (!receipt) return { ok: false, applicationId: ID, checks, paths };
  const config = await loadConfig(paths);
  await access(path.join(paths.runtime, "bin", "node"), constants.X_OK);
  let upstream = null;
  if (!options["lifecycle-only"]) {
    const result = await run(path.join(paths.runtime, "bin", "node"), [path.join(paths.app, "scripts", "doctor.mjs"), "--json", "--cwd", config.defaultCwd], { env: runtimeEnvironment(paths, config), cwd: paths.app, timeout: 90_000 });
    try { upstream = JSON.parse(result.stdout); } catch { upstream = { status: "error", reason: result.timedOut ? "doctor_timeout" : "doctor_failed", exitCode: result.code }; }
    checks.push({ name: "upstream-doctor", ok: result.code === 0 && upstream.status !== "error", detail: upstream.status });
  }
  let health = null;
  try {
    const response = await fetch(`http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    health = await response.json();
    checks.push({ name: "running-health", ok: response.ok && health.ok === true && health.serverName === ID, detail: health.serverName ?? health.service });
  } catch { health = { status: "not_running" }; }
  return { ok: checks.every(check => check.ok), applicationId: ID, paths, checks, upstream, health, chatgptEndToEnd: "not_verified" };
}

async function uninstall(paths) {
  await assertSessionStopped(paths);
  if (await exists(path.join(paths.config, "desktop-integration.json"))) throw new Error(`Restore the ChatGPT desktop launcher before uninstalling: python3 ${shellQuote(path.join(paths.app, "scripts", "linux-desktop.py"))} restore. The session configuration and credential are preserved.`);
  const receipt = await ownership(paths, { required: false });
  if (!receipt) return { ok: true, action: "already_uninstalled", applicationId: ID, configurationPreserved: true };
  await assertStopped();
  await assertUnmodified(paths, receipt);
  await ensureManagedUnit(paths);
  // Enabled units must be disabled explicitly before removal; never leave dangling autostart.
  try { const enabled = await service(["is-enabled", `${ID}.service`]); if (enabled.code === 0) throw new Error("Disable autostart before uninstalling: codexless-linux-disable"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const name of [ID, ...COMMANDS.map(command => `${ID}-${command}`)]) {
    const target = path.join(paths.bin, name);
    if (await exists(target) && (await lstat(target)).isSymbolicLink() && await readlink(target) === path.join(paths.app, "bin", name)) await rm(target);
  }
  await rm(paths.unit, { force: true });
  await rm(paths.app, { recursive: true });
  await rm(paths.runtime, { recursive: true });
  await rm(paths.ownership);
  return { ok: true, action: "uninstalled", applicationId: ID, configurationPreserved: true, statePreserved: true, backupsPreserved: true };
}

async function requireRealDirectory(target, label) {
  const stat = await lstat(target).catch(error => { throw new Error(`${label} is unavailable (${error.code})`); });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

async function validateRollbackBackup(paths, backup, previous) {
  if (previous.schemaVersion !== 1 || previous.applicationId !== ID || previous.app !== paths.app || previous.runtime !== paths.runtime || !previous.files || typeof previous.files !== "object" || Array.isArray(previous.files)) throw new Error("Backup ownership mismatch");
  const backupApp = path.join(backup, "app"), backupRuntime = path.join(backup, "runtime");
  await requireRealDirectory(backupApp, "Rollback backup app");
  await requireRealDirectory(backupRuntime, "Rollback backup runtime");
  try {
    // Older unverified backups must not replace a known working installation.
    if (!previous.runtimeFiles || !previous.dependencyFiles) throw new Error("Rollback backup has no complete runtime/dependency integrity snapshot; create a fresh backup with update first");
    await assertUnmodified({ app: backupApp, runtime: backupRuntime }, previous);
  }
  catch (error) { throw new Error(`Rollback backup failed integrity validation: ${error.message}`); }
  const packageInfo = await json(path.join(backupApp, "package.json"));
  if (!["codexless", ID].includes(packageInfo.name) || packageInfo.version !== previous.version) throw new Error("Rollback backup package identity/version does not match its receipt");
  // Required production dependencies must still be present; digestTree deliberately omits node_modules.
  for (const dependency of Object.keys(packageInfo.dependencies ?? {})) {
    if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(dependency)) throw new Error("Invalid dependency name in rollback package");
    const dependencyRoot = path.join(backupApp, "node_modules", ...dependency.split("/"));
    await requireRealDirectory(dependencyRoot, `Rollback dependency ${dependency}`);
    const dependencyPackage = await json(path.join(dependencyRoot, "package.json"));
    if (dependencyPackage.name !== dependency) throw new Error(`Rollback dependency identity mismatch: ${dependency}`);
  }
  await requireRealDirectory(path.join(backupRuntime, "bin"), "Rollback runtime bin");
  const node = path.join(backupRuntime, "bin", "node");
  const nodeStat = await lstat(node).catch(error => { throw new Error(`Rollback Node executable is unavailable (${error.code})`); });
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || !(nodeStat.mode & 0o111)) throw new Error("Rollback Node must be a regular executable native binary");
  await access(node, constants.X_OK);
  const handle = await open(node, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, magic.length, 0);
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error("Rollback Node is not a native Linux ELF executable");
  } finally { await handle.close(); }
  const probe = await run(node, ["--version"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
  if (probe.code !== 0 || !/^v(?:2[2-9]|[3-9][0-9])\.\d+\.\d+\s*$/.test(probe.stdout)) throw new Error("Rollback Node executable failed its Node.js 22+ version probe");
  // --copy-deps deliberately provisions no npm; ordinary installs include npm and need it for updates.
  const npmRoot = path.join(backupRuntime, "lib", "node_modules", "npm");
  const hasNpm = await exists(path.join(backupRuntime, "bin", "npm")) || await exists(path.join(backupRuntime, "lib"));
  if (hasNpm) {
    for (const directory of [path.join(backupRuntime, "lib"), path.join(backupRuntime, "lib", "node_modules"), npmRoot, path.join(npmRoot, "bin")]) await requireRealDirectory(directory, "Rollback npm directory");
    if ((await json(path.join(npmRoot, "package.json"))).name !== "npm") throw new Error("Rollback npm package is invalid");
    const npmCli = path.join(npmRoot, "bin", "npm-cli.js");
    if (!(await lstat(npmCli)).isFile() || await realpath(path.join(backupRuntime, "bin", "npm")) !== npmCli) throw new Error("Rollback npm CLI is missing or points outside its runtime");
    await access(npmCli, constants.R_OK);
  }
}

// The optional adapters let the isolated lifecycle tests exercise mid-switch I/O failures.
// CLI callers always use the native filesystem operations.
export async function rollbackInstallation(paths, { move = rename, commitReceipt = atomicJson } = {}) {
  await assertSessionStopped(paths);
  const current = await ownership(paths);
  await assertStopped(); await assertUnmodified(paths, current);
  if (!current.previousBackup) throw new Error("No previous installation backup exists");
  const backup = absolute(current.previousBackup, "previousBackup");
  const backupRoot = path.join(paths.data, "backups");
  if (path.dirname(backup) !== backupRoot) throw new Error("Backup is outside the owned backup directory");
  await requireRealDirectory(backupRoot, "Rollback backup root");
  await requireRealDirectory(backup, "Rollback backup");
  const backupReceipt = path.join(backup, "installation.json");
  await rejectSymlink(backupReceipt);
  const previous = await json(path.join(backup, "installation.json"));
  // Complete validation happens before either working directory is moved.
  await validateRollbackBackup(paths, backup, previous);
  const originalReceipt = await readFile(paths.ownership);
  const retained = path.join(paths.data, "backups", `${Date.now()}-${randomUUID()}`);
  await mkdir(retained, { mode: 0o700 });
  let currentAppMoved = false, currentRuntimeMoved = false, previousAppMoved = false, previousRuntimeMoved = false;
  try {
    await atomicJson(path.join(retained, "installation.json"), current);
    await move(paths.app, path.join(retained, "app")); currentAppMoved = true;
    await move(paths.runtime, path.join(retained, "runtime")); currentRuntimeMoved = true;
    await move(path.join(backup, "app"), paths.app); previousAppMoved = true;
    await move(path.join(backup, "runtime"), paths.runtime); previousRuntimeMoved = true;
    await commitReceipt(paths.ownership, { ...previous, previousBackup: retained });
  } catch (error) {
    const recoveryErrors = [];
    const recover = async (operation, label) => { try { await operation(); } catch (recoveryError) { recoveryErrors.push(`${label}: ${recoveryError.code ?? recoveryError.message}`); } };
    if (previousRuntimeMoved) await recover(() => move(paths.runtime, path.join(backup, "runtime")), "return backup runtime");
    if (previousAppMoved) await recover(() => move(paths.app, path.join(backup, "app")), "return backup app");
    if (currentRuntimeMoved) await recover(() => move(path.join(retained, "runtime"), paths.runtime), "restore current runtime");
    if (currentAppMoved) await recover(() => move(path.join(retained, "app"), paths.app), "restore current app");
    await recover(() => atomicFile(paths.ownership, originalReceipt), "restore installation receipt");
    if (recoveryErrors.length) throw new Error(`Rollback failed; recovery needs attention. Retained installation: ${retained}; backup: ${backup}; ${recoveryErrors.join("; ")}`);
    await rm(retained, { recursive: true });
    throw new Error(`Rollback failed; the working installation and receipt were restored: ${error.message}`);
  }
  return { ok: true, action: "rolled_back", applicationId: ID, version: previous.version, serviceStarted: false, configurationPreserved: true };
}

function parseArgs(argv) {
  const command = argv[0] ?? "help", options = {};
  const booleans = new Set(["copy-deps", "confirm-start", "confirm-autostart", "lifecycle-only", "json", "follow", "trust-project"]);
  const strings = new Set(["source", "node", "npm", "codex", "port", "cwd", "lines"]);
  for (let index = 1; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, "");
    if (!argv[index].startsWith("--") || (!booleans.has(key) && !strings.has(key))) throw new Error(`Unknown argument: ${argv[index]}`);
    if (booleans.has(key)) options[key] = true;
    else { if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`--${key} requires a value`); options[key] = argv[++index]; }
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2), paths = linuxPaths()) {
  if (argv[0] === "chatgpt") {
    const { main: chatgptMain } = await import("./linux-chatgpt.mjs");
    process.exitCode = await chatgptMain(argv.slice(1));
    return null;
  }
  if (argv[0] === "tunnel") {
    const { main: tunnelMain } = await import("./linux-tunnel.mjs");
    process.exitCode = await tunnelMain(argv.slice(1));
    return null;
  }
  const { command, options } = parseArgs(argv);
  if (command === "help" || command === "--help") {
    return { applicationId: ID, commands: COMMANDS, install: "codexless-linux-install --node /absolute/node --npm /absolute/npm [--codex /absolute/codex] [--cwd /project] [--trust-project]", start: "codexless-linux-start --confirm-start", autostart: "codexless-linux-enable --confirm-autostart", update: "codexless-linux-update --source /reviewed/checkout", notes: "Original ~/.codex, Windows plugin and Tunnel are untouched. A separate Codex home is used; --trust-project explicitly trusts only defaultCwd in that isolated home. install never starts or enables services. Configuration and logs survive uninstall." };
  }
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command: ${command}`);
  if (process.platform !== "linux") throw new Error("codexless-linux lifecycle commands require Linux");
  if (process.getuid?.() === 0) throw new Error("Run codexless-linux as your regular user, without sudo");
  if (command === "install" || command === "update") return await withLifecycleLock(paths, () => install(paths, options, command === "update"));
  if (command === "doctor") return await doctor(paths, options);
  if (command === "uninstall") return await withLifecycleLock(paths, () => uninstall(paths));
  if (command === "rollback") return await withLifecycleLock(paths, () => rollbackInstallation(paths));
  if (command === "http" || command === "stdio") { await serve(paths, command); return null; }
  if (command === "login") {
    await ownership(paths);
    const config = await loadConfig(paths), env = runtimeEnvironment(paths, config);
    const { resolveCodexExecutable } = await import(pathToUrl(path.join(paths.app, "src", "codex-bin.mjs")));
    const executable = config.codexBin ?? (await resolveCodexExecutable({ env })).path;
    // Login is an explicit foreground interaction; no credential is read or copied here.
    const child = spawn(executable, ["login", "--device-auth"], { env, cwd: config.defaultCwd, stdio: "inherit" });
    const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
    process.exitCode = exitCode;
    return null;
  }
  if (command === "status") {
    let result; try { result = await service(["show", `${ID}.service`, "--property=ActiveState,SubState,UnitFileState,MainPID", "--no-pager"]); } catch (error) { result = { code: 1, stdout: "", stderr: error.code }; }
    return { ok: true, applicationId: ID, installed: Boolean(await ownership(paths, { required: false })), systemdAvailable: result.code === 0, service: result.stdout.trim() || "unavailable", paths, chatgptEndToEnd: "not_verified" };
  }
  await ownership(paths);
  await ensureManagedUnit(paths);
  if (command === "logs") {
    const lines = Number(options.lines ?? 80);
    if (!Number.isInteger(lines) || lines < 1 || lines > 10000) throw new Error("--lines must be 1..10000");
    if (!(await exists(paths.log))) return { ok: true, applicationId: ID, log: paths.log, message: "No service log exists yet" };
    const result = await run("tail", ["-n", String(lines), ...(options.follow ? ["-f"] : []), paths.log], { inherit: true, timeout: options.follow ? 43_200_000 : 10_000 });
    return { ok: result.code === 0, applicationId: ID, log: paths.log };
  }
  if (command === "start" || command === "restart") {
    await requireStartConfirmation(paths, options);
    const reload = await service(["daemon-reload"]);
    if (reload.code !== 0) throw new Error("systemd --user is unavailable; run codexless-linux-http in the foreground or start a user session");
  }
  if (command === "enable" && !options["confirm-autostart"]) throw new Error("Enabling autostart requires explicit user confirmation: rerun with --confirm-autostart");
  if (command === "enable") { const result = await service(["daemon-reload"]); if (result.code !== 0) throw new Error("systemd --user is unavailable"); }
  const result = await service([command, `${ID}.service`]);
  if (result.code !== 0) throw new Error(`systemd --user ${command} failed (exit ${result.code}); inspect codexless-linux-status`);
  return { ok: true, applicationId: ID, action: command, autostartStartedService: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(); if (result !== null) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (result?.ok === false) process.exitCode = 1; } }
  catch (error) { process.stderr.write(`${JSON.stringify({ ok: false, applicationId: ID, error: error.message })}\n`); process.exitCode = 1; }
}
