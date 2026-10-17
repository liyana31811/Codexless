import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { findAppProcesses, parseProcStat, processIdentity, sameProcess, sessionPaths } from "../scripts/linux-chatgpt.mjs";

const script = fileURLToPath(new URL("../scripts/linux-chatgpt.mjs", import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(check, explanation, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  assert.fail(explanation);
}

async function run(args, options = {}) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexless-linux-chatgpt-"));
  const executable = path.join(root, "fake-chatgpt");
  const originalPython = await fs.realpath("/usr/bin/python3");
  await fs.copyFile(originalPython, executable);
  await fs.chmod(executable, 0o700);
  const config = path.join(root, "session.json");
  const runtime = path.join(root, "runtime");
  const app = spawn(executable, ["-c", "import time; time.sleep(90)"], { stdio: "ignore" });
  await once(app, "spawn");
  const appInfo = await processIdentity(app.pid);
  const renderer = spawn(executable, ["-c", "import time; time.sleep(90)", "--type=renderer"], { stdio: "ignore" });
  await once(renderer, "spawn");
  const helper = path.join(root, "credential.py");
  const tunnel = path.join(root, "fake-tunnel");
  const launcher = path.join(root, "original-proxy");
  const launchArgs = path.join(root, "launch-args.json");
  const spawned = path.join(root, "spawned.json");
  const profileDir = path.join(root, "profiles");
  await fs.mkdir(profileDir, { mode: 0o700 });
  await fs.writeFile(path.join(profileDir, "codexless-linux.yaml"), "# local test profile\n", { mode: 0o600 });
  await fs.writeFile(helper, "import os,sys\nos.write(3,b'fake-key-that-must-not-be-logged')\n", { mode: 0o700 });
  await fs.writeFile(launcher, `#!/usr/bin/python3\nimport json,sys\njson.dump(sys.argv[1:], open(${JSON.stringify(launchArgs)}, 'w'))\n`, { mode: 0o700 });
  const detachedCode = "import os,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(90)";
  const intermediateCode = `import json,subprocess,os\np=subprocess.Popen(['/usr/bin/python3','-c',${JSON.stringify(detachedCode)}],start_new_session=True)\njson.dump({'pid':p.pid},open(${JSON.stringify(path.join(root, "orphan.json"))},'w'))\n`;
  await fs.writeFile(tunnel, `#!/usr/bin/python3
import json,os,signal,subprocess,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
# This parent exits immediately, forcing the detached child to be adopted by
# the session subreaper before the monitor's next /proc polling interval.
p=subprocess.Popen(['/usr/bin/python3','-c',${JSON.stringify(intermediateCode)}])
p.wait()
json.dump({'pid':os.getpid(),'keyReceived':os.environ.get('CODEXLESS_LINUX_TUNNEL_API_KEY') == 'fake-key-that-must-not-be-logged'},open(${JSON.stringify(spawned)},'w'))
while True: time.sleep(1)
`, { mode: 0o700 });
  const value = {
    launcher, appExecutable: executable, tunnelId: "tunnel_" + "b".repeat(32),
    runtimeDir: runtime, logFile: path.join(root, "session.log"), tunnelBinary: tunnel,
    profileDir, tunnelStateDir: path.join(root, "tunnel-state"), credentialHelper: helper,
    pollMs: 75, appStartupMs: 500, stopTimeoutMs: 150,
  };
  await fs.writeFile(config, JSON.stringify(value), { mode: 0o600 });
  return {
    root, executable, config, runtime, app, appInfo, renderer, value, spawned, launchArgs, helper,
    command: (action, args = []) => run([action, "--config", config, ...args]),
    async cleanup() {
      await run(["stop", "--config", config]);
      for (const child of [app, renderer]) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("session uses isolated XDG directories and exact pid/start-time identity", async () => {
  assert.equal(sessionPaths({ XDG_RUNTIME_DIR: "/run/user/77", XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/state" }, "/home/user").lock,
    "/run/user/77/codexless-linux/chatgpt-session.lock");
  assert.equal(sessionPaths({ XDG_RUNTIME_DIR: "relative" }, "/home/user").runtime,
    "/home/user/.local/state/codexless-linux/session-runtime");
  const actual = await processIdentity(process.pid);
  assert.equal(await sameProcess(actual), true);
  assert.equal(await sameProcess({ ...actual, startTime: "0" }), false);
  assert.equal(await processIdentity(-1), null);
  const weird = parseProcStat("23 (name ) with ( parentheses) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 12345 99", 23);
  assert.equal(weird.ppid, 1);
  assert.equal(weird.startTime, "12345");
});

test("only native main executable is detected; renderer and unrelated Python remain excluded", async () => {
  const f = await fixture();
  try {
    const apps = await findAppProcesses(f.executable);
    assert.deepEqual(apps.map(v => v.pid), [f.app.pid]);
    assert.ok(await sameProcess(f.appInfo));
  } finally { await f.cleanup(); }
});

test("Electron process.title hiding argv still excludes same-executable descendants through helper parents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexless-linux-electron-title-"));
  const executable = path.join(root, "fake-electron");
  const appScript = path.join(root, "app.mjs");
  const childReady = path.join(root, "child.json");
  const grandchildReady = path.join(root, "grandchild.json");
  await fs.copyFile(process.execPath, executable, fs.constants.COPYFILE_FICLONE);
  await fs.chmod(executable, 0o700);
  const python = `import subprocess\np = subprocess.Popen([${JSON.stringify(executable)},${JSON.stringify(appScript)},'grandchild'])\np.wait()\n`;
  await fs.writeFile(appScript, `import fs from 'node:fs';
import {spawn} from 'node:child_process';
const role = process.argv[2];
process.title = 'ChatGPT';
if (role === 'main') {
  spawn(process.execPath, [${JSON.stringify(appScript)}, 'child', '--type=renderer'], {stdio:'ignore'});
  spawn('/usr/bin/python3', ['-c', ${JSON.stringify(python)}], {stdio:'ignore'});
} else {
  fs.writeFileSync(role === 'child' ? ${JSON.stringify(childReady)} : ${JSON.stringify(grandchildReady)}, JSON.stringify({pid:process.pid}));
}
setInterval(()=>{}, 1000);
`);
  let app;
  let children = [];
  try {
    app = spawn(executable, [appScript, "main"], { stdio: "ignore" });
    await once(app, "spawn");
    const identities = await eventually(async () => {
      try {
        return [JSON.parse(await fs.readFile(childReady, "utf8")), JSON.parse(await fs.readFile(grandchildReady, "utf8"))];
      } catch { return false; }
    }, "titled Electron children did not start");
    children = await Promise.all(identities.map(item => processIdentity(item.pid)));
    assert.equal(children.every(Boolean), true);
    // Confirm this test actually reproduces the missing --type evidence.
    assert.ok(!(await fs.readFile(`/proc/${children[0].pid}/cmdline`, "utf8")).includes("--type"));
    const grandchildHelper = await processIdentity(children[1].ppid);
    assert.ok(grandchildHelper && grandchildHelper.pid !== app.pid);
    children.push(grandchildHelper);
    const found = await findAppProcesses(executable);
    assert.deepEqual(found.map(item => item.pid), [app.pid]);
  } finally {
    for (const identity of children) if (await sameProcess(identity)) process.kill(identity.pid, "SIGKILL");
    if (app && app.exitCode === null && app.signalCode === null) app.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("two launches forward original URL arguments but create one tunnel; app exit kills detached orphans", async () => {
  const f = await fixture();
  try {
    const first = await f.command("launch", ["--", "chatgpt://open/path?q=with%20space", "literal;$HOME"]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json().started, true);
    await eventually(async () => {
      try { return JSON.parse(await fs.readFile(f.spawned, "utf8")); } catch { return false; }
    }, "fake tunnel did not start");
    const spawned = JSON.parse(await fs.readFile(f.spawned, "utf8"));
    assert.equal(spawned.keyReceived, true);
    const orphan = JSON.parse(await fs.readFile(path.join(f.root, "orphan.json"), "utf8"));
    const orphanIdentity = await processIdentity(orphan.pid);
    assert.ok(orphanIdentity);
    const tunnelIdentity = await processIdentity(spawned.pid);
    const status = (await f.command("status")).json();
    assert.equal(status.running, true);
    assert.equal(status.tunnelPid, spawned.pid);
    assert.equal(status.autostart, false);
    assert.deepEqual(status.appPids, [f.app.pid]);
    assert.deepEqual(JSON.parse(await fs.readFile(f.launchArgs, "utf8")), ["chatgpt://open/path?q=with%20space", "literal;$HOME"]);
    const second = await f.command("launch", ["--", "chatgpt://second"]);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json().alreadyRunning, true);
    assert.equal(second.json().supervisorPid, status.supervisorPid);
    await eventually(async () => JSON.parse(await fs.readFile(f.launchArgs, "utf8"))[0] === "chatgpt://second", "second click did not forward its URL");
    f.app.kill("SIGTERM");
    await eventually(async () => !(await f.command("status")).json().running, "session did not stop after main app exit");
    assert.equal(await sameProcess(tunnelIdentity), false);
    assert.equal(await sameProcess(orphanIdentity), false);
    assert.ok(await processIdentity(f.renderer.pid), "renderer must never be killed by the session");
    const log = await fs.readFile(f.value.logFile, "utf8");
    assert.ok(!log.includes("fake-key-that-must-not-be-logged"));
  } finally { await f.cleanup(); }
});

test("explicit session stop cleans tunnel while keeping user ChatGPT running", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.command("attach")).code, 0);
    await eventually(async () => {
      try { return JSON.parse(await fs.readFile(f.spawned, "utf8")); } catch { return false; }
    }, "fake tunnel did not start");
    const tunnel = await processIdentity(JSON.parse(await fs.readFile(f.spawned, "utf8")).pid);
    const stopped = await f.command("stop");
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(stopped.json().stopped, true);
    assert.equal(await sameProcess(tunnel), false);
    assert.equal(await sameProcess(f.appInfo), true);
    assert.equal((await f.command("stop")).json().alreadyStopped, true);
  } finally { await f.cleanup(); }
});

test("a killed monitor still has its detached processes reaped by its supervisor", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.command("attach")).code, 0);
    await eventually(async () => {
      try { return JSON.parse(await fs.readFile(f.spawned, "utf8")); } catch { return false; }
    }, "fake tunnel did not start");
    const state = JSON.parse(await fs.readFile(path.join(f.runtime, "chatgpt-session.lock", "state.json"), "utf8"));
    const tunnel = await processIdentity(JSON.parse(await fs.readFile(f.spawned, "utf8")).pid);
    const orphan = await processIdentity(JSON.parse(await fs.readFile(path.join(f.root, "orphan.json"), "utf8")).pid);
    process.kill(state.monitorPid, "SIGKILL");
    await eventually(async () => !(await f.command("status")).json().running, "supervisor did not finish after monitor death");
    assert.equal(await sameProcess(tunnel), false);
    assert.equal(await sameProcess(orphan), false);
    assert.equal(await sameProcess(f.appInfo), true);
  } finally { await f.cleanup(); }
});

test("missing key releases the session so later attach can recover and leaves ChatGPT running", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(f.helper, "import sys\nsys.exit(4)\n", { mode: 0o700 });
    assert.equal((await f.command("attach")).code, 0);
    await eventually(async () => !(await f.command("status")).json().running, "missing-key session kept its lock");
    assert.equal(await sameProcess(f.appInfo), true);
    await assert.rejects(fs.stat(f.spawned), { code: "ENOENT" });
    await fs.writeFile(f.helper, "import os\nos.write(3,b'fake-key-that-must-not-be-logged')\n", { mode: 0o700 });
    assert.equal((await f.command("attach")).json().started, true);
    await eventually(async () => {
      try { return JSON.parse(await fs.readFile(f.spawned, "utf8")); } catch { return false; }
    }, "session did not recover after key became available");
  } finally { await f.cleanup(); }
});

test("unsafe session configuration and forged PID identity are rejected", async () => {
  const f = await fixture();
  try {
    await fs.chmod(f.config, 0o644);
    const unsafe = await f.command("attach");
    assert.notEqual(unsafe.code, 0);
    assert.match(unsafe.stderr, /chmod 600/);
    await fs.chmod(f.config, 0o600);
    await fs.mkdir(path.join(f.runtime, "chatgpt-session.lock"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(f.runtime, "chatgpt-session.lock", "owner.json"), JSON.stringify({
      ...f.appInfo, startTime: "0", sessionId: "stale-owner",
    }), { mode: 0o600 });
    assert.equal((await f.command("stop")).json().alreadyStopped, true);
    assert.equal(await sameProcess(f.appInfo), true);
    assert.equal((await f.command("attach")).json().started, true);
    assert.equal(await sameProcess(f.appInfo), true);
  } finally { await f.cleanup(); }
});
