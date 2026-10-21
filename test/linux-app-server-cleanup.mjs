import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

const linux = process.platform === "linux";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalKill = process.kill;

async function running(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // An orphan may briefly remain a zombie until the host init reaps it.
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function eventually(check, message) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(message);
}

async function fixture(mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexless-app-server-cleanup-"));
  const script = path.join(root, "server.mjs");
  const pidsFile = path.join(root, "pids.json");
  await writeFile(script, `
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({server:process.pid,descendant:child.pid}));
if (${JSON.stringify(mode)} === 'stubborn') process.on('SIGTERM',()=>{});
process.stdin.on('end',()=>{if (${JSON.stringify(mode)} !== 'stubborn') process.exit(0)});
process.stdin.on('data',chunk=>{
  for(const line of String(chunk).trim().split('\\n')) {
    const message=JSON.parse(line);
    if(message.method==='exit-now') {process.exit(19);}
    if(message.id) process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n');
  }
});
setInterval(()=>{},1000);
`);
  let cleanups = 0;
  const client = new CodexAppServerClient({
    cwd: root,
    launch: () => ({ command: process.execPath, args: [script], cleanup: async () => { cleanups += 1; } }),
    stderrHandler: () => {},
  });
  await client.start();
  const pids = JSON.parse(await readFile(pidsFile, "utf8"));
  return {
    client, pids, cleanups: () => cleanups,
    async cleanup() {
      process.kill = originalKill;
      await client.close().catch(() => {});
      for (const pid of Object.values(pids)) {
        if (await running(pid)) { try { originalKill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("unexpected App Server exit immediately cleans its surviving process group", { skip: !linux }, async () => {
  const item = await fixture("normal");
  try {
    const signals = [];
    process.kill = (pid, signal) => {
      if (pid === -item.pids.server) signals.push(signal);
      return originalKill(pid, signal);
    };
    item.client.notify("exit-now", {});
    await eventually(async () => !item.client.running, "App Server did not exit");
    // This must hold before close; a later saved-PGID retry could kill a reused group.
    await eventually(async () => !await running(item.pids.descendant), "descendant survived unexpected server exit");
    await item.client.close();
    await item.client.close();
    assert.equal(item.cleanups(), 1);
    assert.deepEqual(signals, ["SIGKILL"], "a closed group must never be signalled again through its saved PGID");
  } finally { await item.cleanup(); }
});

for (const mode of ["normal", "stubborn"]) {
  test(`${mode} App Server close stops the server and its descendants once`, { skip: !linux }, async () => {
    const item = await fixture(mode);
    try {
      await item.client.close();
      await item.client.close();
      await eventually(async () => !await running(item.pids.server) && !await running(item.pids.descendant), "owned process group survived close");
      assert.equal(item.cleanups(), 1);
    } finally { await item.cleanup(); }
  });
}

test("signal failures still execute launch-factory cleanup", { skip: !linux }, async () => {
  const item = await fixture("stubborn");
  try {
    process.kill = (pid, signal) => {
      if (pid === -item.pids.server) throw Object.assign(new Error("injected signal failure"), { code: "EPERM" });
      return originalKill(pid, signal);
    };
    await assert.rejects(item.client.close(), /injected signal failure|shutdown and cleanup failed/);
    assert.equal(item.cleanups(), 1);
    await item.client.close();
    assert.equal(item.cleanups(), 1);
  } finally { await item.cleanup(); }
});
