import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { codexlessIdentity, codexlessPaths } from "../src/linux-identity.mjs";
import { boundLinuxPermissionProfile, findTrustedAncestor } from "../src/codex-authority-executor.mjs";
import { findPosixExecutable, probeCodexExecutable } from "../src/codex-bin.mjs";
import { preciseEditAuthorized, readManyAuthorized } from "../src/construction-tools.mjs";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

assert.equal(codexlessIdentity({ platform: "linux", env: {} }).name, "codexless-linux");
assert.equal(codexlessIdentity({ platform: "win32", env: {} }).name, "codexless");
assert.throws(() => codexlessIdentity({ platform: "linux", env: { CODEXLESS_SERVER_NAME: "codexless" } }));
assert.deepEqual(codexlessPaths({ platform: "linux", env: { HOME: "/test", XDG_CONFIG_HOME: "relative", XDG_DATA_HOME: "/data", XDG_STATE_HOME: "/state" } }), {
  config: "/test/.config/codexless-linux", data: "/data/codexless-linux", state: "/state/codexless-linux",
});
assert.equal(codexlessPaths({ platform: "linux", env: { HOME: "/test", CODEXLESS_STATE_ROOT: "/independent" } }).state, "/independent");
const profiles = [":read-only", ":workspace", ":danger-full-access"];
assert.equal(boundLinuxPermissionProfile(":danger-full-access", { platform: "linux", allowedProfiles: profiles }), ":workspace");
assert.equal(boundLinuxPermissionProfile(":read-only", { platform: "linux", allowedProfiles: profiles }), ":read-only");
assert.equal(boundLinuxPermissionProfile(":workspace", { platform: "linux", access: "readOnly", allowedProfiles: profiles }), ":read-only");
assert.throws(() => boundLinuxPermissionProfile("custom-unverified", { platform: "linux", access: "readOnly", allowedProfiles: profiles }));

if (process.platform !== "linux") {
  console.log("Linux core identity tests passed; POSIX security checks skipped on this host");
  process.exit(0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "codexless-linux-security-"));
try {
  const project = path.join(temp, "Project");
  const caseDistinct = path.join(temp, "project");
  await mkdir(project);
  await mkdir(caseDistinct);
  const config = { projects: { [project]: { trust_level: "trusted" } } };
  assert.equal(findTrustedAncestor(config, path.join(project, "nested")).root, project);
  assert.equal(findTrustedAncestor(config, caseDistinct), null);
  assert.equal(findTrustedAncestor(config, `${project}-other`), null);
  assert.equal(findTrustedAncestor({ projects: { "/": { trust_level: "trusted" } } }, project).root, "/");

  const nonExecutable = path.join(temp, "codex");
  await writeFile(nonExecutable, "#!/bin/sh\nprintf 'codex-cli 0.0.0\\n'\n", { mode: 0o600 });
  assert.equal(await findPosixExecutable("codex", { PATH: temp }), null);
  await assert.rejects(probeCodexExecutable(nonExecutable));
  await chmod(nonExecutable, 0o700);
  assert.equal(await findPosixExecutable("codex", { PATH: `:relative:${temp}` }), nonExecutable);
  assert.equal((await probeCodexExecutable(nonExecutable)).version, "0.0.0");
  const shadow = path.join(temp, "shadow");
  await mkdir(path.join(shadow, "codex"), { recursive: true });
  assert.equal(await findPosixExecutable("codex", { PATH: `${shadow}:${temp}` }), nonExecutable, "an executable directory must not shadow a real binary later on PATH");

  const file = path.join(project, "example.txt");
  const outside = path.join(temp, "outside.txt");
  await writeFile(file, "before\n");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(project, "escape.txt"));
  let writeDispatches = 0;
  const authority = {
    async resolveAuthority() { return { effectiveCwd: project, trustedAncestor: project, permissionProfile: ":workspace" }; },
    async exec({ command }) {
      writeDispatches += 1;
      const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
  await assert.rejects(readManyAuthorized({ authorityExecutor: authority, paths: ["escape.txt"], cwd: project }), /outside trusted root/);
  await assert.rejects(preciseEditAuthorized({ authorityExecutor: authority, path: "escape.txt", expectedText: "outside", replacementText: "changed", cwd: project }), /outside trusted root/);
  const readOnly = { ...authority, async resolveAuthority() { return { effectiveCwd: project, trustedAncestor: project, permissionProfile: ":read-only" }; } };
  await assert.rejects(preciseEditAuthorized({ authorityExecutor: readOnly, path: file, expectedText: "before", replacementText: "after", cwd: project }), /read-only/);
  assert.equal(writeDispatches, 0);
  assert.equal(await readFile(file, "utf8"), "before\n");
  const edited = await preciseEditAuthorized({ authorityExecutor: authority, path: file, expectedText: "before", replacementText: "after", cwd: project });
  assert.equal(edited.status, "applied");
  assert.equal(writeDispatches, 1);
  assert.equal(await readFile(file, "utf8"), "after\n");

  // Exercise real OS argv limits and Unicode encoding, not a mocked receipt.
  const largeFile = path.join(project, "large.txt");
  const expectedLarge = randomBytes(100_000).toString("hex");
  const replacementLarge = "😀".repeat(100_000);
  await writeFile(largeFile, expectedLarge);
  await preciseEditAuthorized({ authorityExecutor: authority, path: largeFile, expectedText: expectedLarge, replacementText: replacementLarge, cwd: project });
  assert.equal(await readFile(largeFile, "utf8"), replacementLarge);
  const linked = path.join(project, "linked.txt");
  await link(largeFile, linked);
  await assert.rejects(preciseEditAuthorized({ authorityExecutor: authority, path: largeFile, expectedText: "😀", replacementText: "x", expectedOccurrences: 100_000, cwd: project }), /hard links/);
  assert.equal(await readFile(linked, "utf8"), replacementLarge);

  // This dummy server ignores EOF/SIGTERM, exercising the final POSIX kill.
  const stubborn = path.join(temp, "stubborn.mjs");
  const pidFile = path.join(temp, "pid");
  await writeFile(stubborn, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM',()=>{});\nprocess.stdin.on('data', chunk => { for (const line of String(chunk).trim().split('\\n')) { const message=JSON.parse(line); if(message.id) process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\\n'); } });\nsetInterval(()=>{},1000);\n`);
  const client = new CodexAppServerClient({ bin: process.execPath, cwd: project, launch: () => ({ command: process.execPath, args: [stubborn] }), stderrHandler: () => {} });
  await client.start();
  const childPid = Number(await readFile(pidFile, "utf8"));
  await client.close();
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  console.log("Linux core security passed: identity/XDG, case-sensitive trust, executable mode, symlink boundary, read-only edit, sandboxed edit dispatch, POSIX cleanup");
} finally {
  await rm(temp, { recursive: true, force: true });
}
