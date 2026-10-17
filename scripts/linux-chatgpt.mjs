#!/usr/bin/env node
// On-demand native ChatGPT lifecycle. No login settings or autostart are changed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROFILE, KEY_ENV, isolatedTunnelEnv, tunnelPaths, validateTunnelId } from "./linux-tunnel.mjs";

const SELF = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function sessionPaths(env = process.env, home = os.homedir()) {
  const xdg = (name, fallback) => env[name] && path.isAbsolute(env[name]) ? env[name] : path.join(home, fallback);
  const state = path.join(xdg("XDG_STATE_HOME", ".local/state"), PROFILE);
  const runtime = env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)
    ? path.join(env.XDG_RUNTIME_DIR, PROFILE) : path.join(state, "session-runtime");
  return {
    config: path.join(xdg("XDG_CONFIG_HOME", ".config"), PROFILE, "session.json"),
    runtime, lock: path.join(runtime, "chatgpt-session.lock"),
    log: path.join(state, "chatgpt-session.log"),
  };
}

async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error("Session directory must be an owned real directory.");
  await fs.chmod(dir, 0o700);
}

async function ownedFile(file, privateMode = true) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid()
      || (privateMode && (st.mode & 0o077))) throw new Error("Session configuration/profile must be an owned regular private file (chmod 600).");
}

export function parseProcStat(text, pid) {
  const end = text.lastIndexOf(")");
  const columns = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || columns.length < 20) return null;
  return { pid: Number(pid), state: columns[0], ppid: Number(columns[1]), startTime: columns[19] };
}

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) return null;
  try {
    const st = await fs.stat(`/proc/${pid}`);
    if (st.uid !== process.getuid()) return null;
    const info = parseProcStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"), pid);
    return info && !["Z", "X"].includes(info.state) ? info : null;
  } catch (error) { if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return null; throw error; }
}

export async function sameProcess(identity) {
  if (!identity) return false;
  const current = await processIdentity(identity.pid);
  return !!current && current.startTime === identity.startTime;
}

export async function findAppProcesses(executable) {
  const found = [];
  const sameExecutable = new Map();
  for (const item of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(item)) continue;
    try {
      const info = await processIdentity(Number(item));
      if (!info || await fs.readlink(`/proc/${item}/exe`) !== executable) continue;
      sameExecutable.set(info.pid, info);
      const argv = (await fs.readFile(`/proc/${item}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (argv.slice(1).some(arg => arg === "--type" || arg.startsWith("--type="))) continue;
      if (await sameProcess(info)) found.push(info);
    } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
  }
  const main = [];
  for (const candidate of found) {
    // Electron may replace its argv storage via process.title, hiding --type.
    // Only the highest same-executable process owns the native app lifecycle;
    // follow the complete ancestor chain, including helper executables.
    let parentPid = candidate.ppid;
    let hasAppAncestor = false;
    const visited = new Set([candidate.pid]);
    while (parentPid > 1 && !visited.has(parentPid)) {
      visited.add(parentPid);
      const parent = await processIdentity(parentPid);
      if (!parent) break;
      const previous = sameExecutable.get(parentPid);
      if (previous && parent.startTime === previous.startTime) {
        hasAppAncestor = true;
        break;
      }
      parentPid = parent.ppid;
    }
    if (!hasAppAncestor && await sameProcess(candidate)) main.push(candidate);
  }
  return main;
}

async function json(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

async function readConfig(configPath) {
  await ownedFile(configPath);
  const cfg = await json(configPath);
  if (!cfg || typeof cfg !== "object") throw new Error("Missing native ChatGPT session configuration.");
  for (const field of ["launcher", "appExecutable"]) {
    if (typeof cfg[field] !== "string" || !path.isAbsolute(cfg[field]) || /[\0\r\n]/.test(cfg[field])) throw new Error(`Session ${field} must be an absolute executable path.`);
  }
  if (cfg.launcherArgs && (!Array.isArray(cfg.launcherArgs) || cfg.launcherArgs.some(v => typeof v !== "string" || v.includes("\0")))) throw new Error("launcherArgs must contain literal arguments.");
  validateTunnelId(cfg.tunnelId);
  const defaults = sessionPaths();
  const tunnel = tunnelPaths();
  const result = {
    ...cfg, configPath, appExecutable: await fs.realpath(cfg.appExecutable),
    runtime: cfg.runtimeDir ?? defaults.runtime, log: cfg.logFile ?? defaults.log,
    tunnelBinary: cfg.tunnelBinary ?? tunnel.client, profileDir: cfg.profileDir ?? tunnel.config,
    tunnelStateDir: cfg.tunnelStateDir ?? tunnel.state,
    python: cfg.python ?? "/usr/bin/python3",
    credentialHelper: cfg.credentialHelper ?? fileURLToPath(new URL("./linux-credential.py", import.meta.url)),
    pollMs: Math.max(50, Math.min(5000, cfg.pollMs ?? 500)),
    stopTimeoutMs: Math.max(100, Math.min(15000, cfg.stopTimeoutMs ?? 3000)),
    appStartupMs: Math.max(250, Math.min(30000, cfg.appStartupMs ?? 15000)),
  };
  for (const field of ["runtime", "log", "tunnelBinary", "profileDir", "tunnelStateDir", "python", "credentialHelper"]) {
    if (typeof result[field] !== "string" || !path.isAbsolute(result[field]) || /[\0\r\n]/.test(result[field])) throw new Error(`Session ${field} must be an absolute path.`);
  }
  result.lock = path.join(result.runtime, "chatgpt-session.lock");
  return result;
}

async function readOwner(cfg) {
  try {
    const st = await fs.lstat(cfg.lock);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error("Unsafe session lock directory.");
    await ownedFile(path.join(cfg.lock, "owner.json"));
    return await json(path.join(cfg.lock, "owner.json"));
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function releaseLock(cfg, sessionId) {
  const owner = await readOwner(cfg);
  if (owner?.sessionId !== sessionId) return;
  for (const name of ["state.json", "owner.json"]) await fs.unlink(path.join(cfg.lock, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  await fs.rmdir(cfg.lock).catch(error => { if (error.code !== "ENOENT") throw error; });
}

async function acquireLock(cfg) {
  await privateDir(cfg.runtime);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.mkdir(cfg.lock, { mode: 0o700 });
      const owner = { ...await processIdentity(process.pid), sessionId: randomUUID(), launching: true, createdAt: new Date().toISOString() };
      await saveJson(path.join(cfg.lock, "owner.json"), owner);
      return owner;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = await readOwner(cfg);
      // mkdir and writing owner are separate; never remove another live launcher's pending lock.
      if (!owner) {
        await delay(150);
        owner = await readOwner(cfg);
        if (!owner) {
          const st = await fs.lstat(cfg.lock);
          if (Date.now() - st.mtimeMs < 5000) return null;
        }
      }
      if (owner && await sameProcess(owner)) return null;
      if (owner) await releaseLock(cfg, owner.sessionId);
      else await fs.rmdir(cfg.lock);
    }
  }
  throw new Error("Could not acquire native ChatGPT session lock.");
}

export async function readCredential(cfg) {
  const env = isolatedTunnelEnv();
  delete env[KEY_ENV];
  return await new Promise((resolve, reject) => {
    const helper = spawn(cfg.python, [cfg.credentialHelper, "get", "--fd", "3", "--tunnel-id", cfg.tunnelId], {
      stdio: ["ignore", "ignore", "ignore", "pipe"], env, shell: false,
    });
    const chunks = [];
    let length = 0;
    const timeout = setTimeout(() => helper.kill("SIGTERM"), 15000);
    helper.stdio[3].on("data", part => {
      length += part.length;
      if (length > 8192) helper.kill("SIGTERM"); else chunks.push(part);
    });
    helper.once("error", () => { clearTimeout(timeout); reject(new Error("Tunnel runtime key is unavailable in the Linux keyring. ChatGPT can still open normally.")); });
    helper.once("close", code => {
      clearTimeout(timeout);
      const value = Buffer.concat(chunks).toString("utf8");
      chunks.forEach(chunk => chunk.fill(0));
      if (code !== 0 || length > 8192 || !value || /[\x00-\x20\x7f]/.test(value)) reject(new Error("Tunnel runtime key is unavailable in the Linux keyring. ChatGPT can still open normally."));
      else resolve(value);
    });
  });
}

// The subreaper is confined to this session. A detached Codex app-server or a
// short-lived parent cannot orphan work outside our cleanup tree. No cgroup,
// persistent service, global process search, /proc environment read or shell is used.
const SUPERVISOR = String.raw`
import ctypes, errno, json, os, signal, subprocess, sys, time
lock, token, node, script, config = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('Cannot create isolated Linux session subreaper')
def ident(pid):
    try:
        fields = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
        if fields[0] in ('Z', 'X'): return None
        return {'pid': pid, 'ppid': int(fields[1]), 'startTime': fields[19]}
    except (OSError, IndexError, ValueError): return None
def current(item):
    now = ident(item['pid'])
    return now and now['startTime'] == item['startTime']
def descendants():
    processes = [ident(int(p)) for p in os.listdir('/proc') if p.isdecimal()]
    found, parents = {}, {os.getpid()}
    while True:
        more = [p for p in processes if p and p['ppid'] in parents and p['pid'] not in found]
        if not more: return list(found.values())
        for p in more: found[p['pid']] = p
        parents.update(p['pid'] for p in more)
def send(items, sig):
    for item in reversed(items):
        if current(item):
            try: os.kill(item['pid'], sig)
            except ProcessLookupError: pass
child, stopping = None, False
def stop(sig, frame):
    global stopping
    stopping = True
    if child and child.poll() is None:
        try: child.send_signal(signal.SIGTERM)
        except ProcessLookupError: pass
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
owner = ident(os.getpid())
owner.update(sessionId=token, launching=False, createdAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
temporary = os.path.join(lock, 'owner.json.%d.tmp' % os.getpid())
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(owner, f)
os.replace(temporary, os.path.join(lock, 'owner.json'))
code = 1
try:
    env = dict(os.environ)
    env['CODEXLESS_LINUX_SESSION_SUPERVISOR_PID'] = str(os.getpid())
    child = subprocess.Popen([node, script, 'monitor', '--config', config, '--session', token], env=env, close_fds=True)
    deadline = None
    while child.poll() is None:
        if stopping:
            if deadline is None: deadline = time.monotonic() + 8
            if time.monotonic() > deadline:
                child.kill()
                break
        time.sleep(0.05)
    code = child.wait()
finally:
    tracked = {p['pid']: p for p in descendants()}
    send(list(tracked.values()), signal.SIGTERM)
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        tracked.update((p['pid'], p) for p in descendants())
        alive = [p for p in tracked.values() if current(p)]
        if not alive: break
        time.sleep(0.05)
    tracked.update((p['pid'], p) for p in descendants())
    send(list(tracked.values()), signal.SIGKILL)
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if pid == 0: break
        except ChildProcessError: break
    try:
        stored = json.load(open(os.path.join(lock, 'owner.json')))
        if stored.get('sessionId') == token and stored.get('pid') == os.getpid():
            for name in ('state.json', 'owner.json'):
                try: os.unlink(os.path.join(lock, name))
                except FileNotFoundError: pass
            os.rmdir(lock)
    except FileNotFoundError: pass
sys.exit(code if code >= 0 else 128-code)
`;

async function notifyFailure() {
  // A best-effort desktop notice contains no configuration, key or command text.
  const child = spawn("notify-send", ["Codexless Linux", "ChatGPT is open; the local Tunnel did not start. Run codexless-linux-chatgpt status and the credential check."], { stdio: "ignore", shell: false });
  child.on("error", () => {});
  child.unref();
}

async function launchApp(cfg, args) {
  const env = { ...process.env };
  delete env[KEY_ENV];
  await new Promise((resolve, reject) => {
    const app = spawn(cfg.launcher, [...(cfg.launcherArgs ?? []), ...args], { env, stdio: "ignore", detached: true, shell: false });
    app.once("error", () => reject(new Error("Could not open the configured native ChatGPT launcher.")));
    app.once("spawn", () => { app.unref(); resolve(); });
  });
}

export async function startSession(cfg, { launch = false, args = [] } = {}) {
  // Repeated clicks must still forward URL arguments to the app's own single-instance IPC.
  if (launch) await launchApp(cfg, args);
  const assertNoMaintenance = async () => {
    try {
      await fs.lstat(path.resolve(cfg.tunnelStateDir, "..", "lifecycle.lock"));
      throw new Error("Codexless Linux maintenance is in progress; ChatGPT can still open. Start its bridge again after maintenance finishes.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  await assertNoMaintenance();
  const owner = await acquireLock(cfg);
  if (!owner) return { started: false, alreadyRunning: true, ...await sessionStatus(cfg) };
  let supervisor;
  try {
    await assertNoMaintenance();
    await privateDir(path.dirname(cfg.log));
    await fs.lstat(cfg.log).then(() => ownedFile(cfg.log)).catch(error => { if (error.code !== "ENOENT") throw error; });
    const log = await fs.open(cfg.log, "a", 0o600);
    const env = isolatedTunnelEnv();
    delete env[KEY_ENV];
    try {
      supervisor = spawn(cfg.python, ["-c", SUPERVISOR, cfg.lock, owner.sessionId, process.execPath, SELF, cfg.configPath], {
        env, detached: true, shell: false, stdio: ["ignore", log.fd, log.fd],
      });
      await new Promise((resolve, reject) => { supervisor.once("spawn", resolve); supervisor.once("error", reject); });
      supervisor.unref();
    } finally { await log.close(); }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await readOwner(cfg);
      if (current?.sessionId === owner.sessionId && current.pid === supervisor.pid && await sameProcess(current)) return { started: true, supervisorPid: current.pid, sessionId: owner.sessionId };
      if (!await processIdentity(supervisor.pid)) break;
      await delay(50);
    }
    throw new Error("The on-demand session could not start. Inspect the private session log.");
  } catch (error) {
    await releaseLock(cfg, owner.sessionId);
    if (launch) await notifyFailure();
    throw error;
  }
}

export async function sessionStatus(cfg) {
  const owner = await readOwner(cfg);
  const running = !!owner && await sameProcess(owner);
  const state = running ? await json(path.join(cfg.lock, "state.json")) : null;
  return {
    running, supervisorPid: running ? owner.pid : null,
    state: state?.state ?? (running ? "starting" : "stopped"),
    appPids: state?.appPids ?? [], tunnelPid: state?.tunnelPid ?? null,
    tunnelId: cfg.tunnelId, autostart: false,
    lifecycle: "Native ChatGPT main process; background/tray instances count as open.",
    log: cfg.log,
  };
}

export async function stopSession(cfg) {
  const owner = await readOwner(cfg);
  if (!owner || !await sameProcess(owner)) return { stopped: true, alreadyStopped: true };
  process.kill(owner.pid, "SIGTERM");
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && await sameProcess(owner)) await delay(50);
  if (await sameProcess(owner)) throw new Error("Session cleanup did not finish; supervisor was left running to avoid orphaning descendants.");
  return { stopped: true };
}

async function ownDescendants(supervisorPid, excludePid) {
  const list = (await Promise.all((await fs.readdir("/proc")).filter(p => /^\d+$/.test(p)).map(p => processIdentity(Number(p))))).filter(Boolean);
  const seen = new Map();
  const parents = new Set([supervisorPid]);
  for (;;) {
    const more = list.filter(p => parents.has(p.ppid) && !seen.has(p.pid));
    if (!more.length) return [...seen.values()].filter(p => p.pid !== excludePid);
    for (const info of more) { seen.set(info.pid, info); parents.add(info.pid); }
  }
}

async function signalIdentities(items, signal) {
  for (const item of [...items].reverse()) if (await sameProcess(item)) {
    try { process.kill(item.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export async function runMonitor(cfg, sessionId, { keyProvider = readCredential } = {}) {
  const owner = await readOwner(cfg);
  const supervisorPid = Number(process.env.CODEXLESS_LINUX_SESSION_SUPERVISOR_PID);
  if (owner?.sessionId !== sessionId || owner.pid !== supervisorPid || !await sameProcess(owner)) throw new Error("Monitor must be started by its isolated session supervisor.");
  let stopping = false;
  let tunnel;
  let tunnelEnded = false;
  let tunnelError = false;
  const tracked = new Map();
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const stateFile = path.join(cfg.lock, "state.json");
  const writeState = async (state, apps = []) => saveJson(stateFile, {
    state, appPids: apps.map(p => p.pid), tunnelPid: tunnel?.pid ?? null,
    monitorPid: process.pid, sessionId, updatedAt: new Date().toISOString(),
  });
  try {
    await writeState("waiting_for_chatgpt");
    let apps = [];
    const deadline = Date.now() + cfg.appStartupMs;
    while (!stopping && !apps.length && Date.now() < deadline) {
      apps = await findAppProcesses(cfg.appExecutable);
      if (!apps.length) await delay(cfg.pollMs);
    }
    if (stopping || !apps.length) return 0;
    await ownedFile(path.join(cfg.profileDir, `${PROFILE}.yaml`));
    let key = await keyProvider(cfg);
    if (stopping) { key = undefined; return 0; }
    await privateDir(cfg.tunnelStateDir);
    const env = isolatedTunnelEnv();
    env.CODEX_HOME = path.resolve(cfg.tunnelStateDir, "..", "codex-home");
    env[KEY_ENV] = key;
    const args = ["run", "--profile", PROFILE, "--profile-dir", cfg.profileDir,
      "--control-plane.tunnel-id", cfg.tunnelId, "--control-plane.api-key", `env:${KEY_ENV}`,
      "--health.listen-addr", "127.0.0.1:0", "--health.url-file", path.join(cfg.tunnelStateDir, "health-url"),
      "--pid.file", path.join(cfg.tunnelStateDir, "tunnel.pid"),
      "--log.level", "info", "--log.http-raw-unsafe=false", "--allow-remote-ui=false", "--open-web-ui=false"];
    tunnel = spawn(cfg.tunnelBinary, args, { env, stdio: ["ignore", "inherit", "inherit"], shell: false });
    delete env[KEY_ENV];
    key = undefined;
    tunnel.once("error", () => { tunnelError = true; tunnelEnded = true; });
    tunnel.once("exit", () => { tunnelEnded = true; });
    await writeState("running", apps);
    while (!stopping && !tunnelEnded) {
      for (const info of await ownDescendants(supervisorPid, process.pid)) tracked.set(info.pid, info);
      apps = (await findAppProcesses(cfg.appExecutable)).filter(p => apps.some(bound => bound.pid === p.pid && bound.startTime === p.startTime));
      if (!apps.length) break;
      await delay(cfg.pollMs);
    }
    if (tunnelError || (tunnelEnded && !stopping && apps.length)) throw new Error("Tunnel exited while ChatGPT was open. No automatic retry was attempted; inspect Doctor and attach again.");
    return 0;
  } finally {
    stopping = true;
    await writeState("stopping").catch(() => {});
    for (const info of await ownDescendants(supervisorPid, process.pid)) tracked.set(info.pid, info);
    await signalIdentities([...tracked.values()], "SIGTERM");
    const deadline = Date.now() + cfg.stopTimeoutMs;
    while (Date.now() < deadline) {
      for (const info of await ownDescendants(supervisorPid, process.pid)) tracked.set(info.pid, info);
      if (!(await Promise.all([...tracked.values()].map(sameProcess))).some(Boolean)) break;
      await delay(50);
    }
    await signalIdentities([...tracked.values()], "SIGKILL");
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

function parseArgs(argv) {
  const values = [...argv];
  let action = "launch";
  if (["launch", "attach", "status", "stop", "restart", "monitor", "help", "--help"].includes(values[0])) action = values.shift();
  let configPath = sessionPaths().config;
  let sessionId;
  let args = [];
  while (values.length) {
    const item = values.shift();
    if (item === "--") { args = values; break; }
    if (item === "--config" && values.length) configPath = path.resolve(values.shift());
    else if (item === "--session" && values.length) sessionId = values.shift();
    else { args = [item, ...values]; break; }
  }
  if (!["launch", "help", "--help"].includes(action) && args.length) throw new Error("Unexpected session arguments.");
  return { action, configPath, sessionId, args };
}

export async function main(argv = process.argv.slice(2)) {
  const { action, configPath, sessionId, args } = parseArgs(argv);
  if (["help", "--help"].includes(action)) {
    console.log("codexless-linux-chatgpt [launch [-- URL...]] | attach | status | stop | restart\nOptional: --config /absolute/private/session.json\nOnly native ChatGPT process lifetime is monitored. Browser tabs and tray-only windows cannot be inferred. No systemd autostart is enabled.");
    return 0;
  }
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Use a regular Linux desktop account without sudo.");
  const cfg = await readConfig(configPath);
  let result;
  if (action === "monitor") return runMonitor(cfg, sessionId);
  if (action === "status") result = await sessionStatus(cfg);
  else if (action === "stop") result = await stopSession(cfg);
  else if (action === "restart") { await stopSession(cfg); result = await startSession(cfg); }
  else result = await startSession(cfg, { launch: action === "launch", args });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(async error => {
    console.error(`codexless-linux ChatGPT session: ${error.message}`);
    if (process.argv.includes("monitor")) await notifyFailure();
    process.exitCode = 1;
  });
}
