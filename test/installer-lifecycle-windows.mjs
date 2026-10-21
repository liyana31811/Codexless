import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReleaseManifest, readReleaseManifest } from "../src/release-identity.mjs";
import { canonicalInstallDirIdentity, OWNERSHIP_MARKER_PREFIX, validateLifecycleReceipt } from "../src/lifecycle-contract.mjs";
import { readBootstrapPointer } from "../src/bootstrap-persistence.mjs";

if (process.platform !== "win32") {
  process.stdout.write("installer lifecycle Windows E2E SKIP (not win32)\n");
  process.exit(0);
}

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const version = packageJson.version;
const root = await mkdtemp(path.join(os.tmpdir(), "codexless-installer-lifecycle-"));
const fakeTools = path.join(root, "fake-tools");
const stateHome = path.join(root, "home");
const stateDir = path.join(stateHome, ".config", "codexless");
const defaultBootstrapRoot = path.join(stateDir, "bootstrap");
const secret = "SUPER_SECRET_FIXTURE_MUST_NOT_LEAK";

try {
  await mkdir(fakeTools, { recursive: true });
  await writeFile(path.join(fakeTools, "npm.cmd"), "@echo off\r\necho added noisy npm fixture output\r\necho npm notice from fixture 1>&2\r\nexit /b 0\r\n", "utf8");
  await mkdir(stateDir, { recursive: true });
  const recentState = path.join(stateDir, "recent-calls.json");
  const taskState = path.join(stateDir, "agent-task-cards.json");
  const managedHome = path.join(stateDir, "managed-codex-home");
  const managedAuthState = path.join(managedHome, "auth-sentinel.json");
  const callProfileState = path.join(stateDir, "codex-call-profile.md");
  const recentBytes = JSON.stringify({ version: 1, receipts: [], sentinel: secret });
  const taskBytes = JSON.stringify({ version: 1, records: [], sentinel: secret });
  const managedAuthBytes = JSON.stringify({ fixture: "managed-user-state", sentinel: secret });
  const callProfileBytes = `fixture-profile-${secret}\n`;
  await mkdir(managedHome, { recursive: true });
  await writeFile(recentState, recentBytes, "utf8");
  await writeFile(taskState, taskBytes, "utf8");
  await writeFile(managedAuthState, managedAuthBytes, "utf8");
  await writeFile(callProfileState, callProfileBytes, "utf8");

  const releaseA = await createFixtureRelease("release-a", "payload-A", "host-v1");
  const releaseB = await createFixtureRelease("release-b", "payload-B", "host-v1");
  const releaseC = await createFixtureRelease("release-c", "payload-C", "host-v2");
  const releaseIncompatible = await createFixtureRelease("release-incompatible", "payload-D", "host-v2", { incompatibleState: true });

  const mainParent = path.join(root, "main-parent");
  const mainInstall = path.join(mainParent, "Codexless");

  const fresh = runInstaller(releaseA, mainInstall);
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  const freshReceipt = parseReceipt(fresh.stdout);
  validateLifecycleReceipt(freshReceipt, { expectOk: true });
  assert.equal(freshReceipt.action, "installed");
  assert.equal(freshReceipt.from, null);
  assert.equal(freshReceipt.rollback.backupRetained, false);
  assert.equal(freshReceipt.runtimeInstall.mode, "recommended");
  assert.equal(freshReceipt.runtimeInstall.recommendedDualInsurance, true);
  assert.equal(freshReceipt.runtimeInstall.managedProvisioned, true);
  assert.equal(freshReceipt.runtimeInstall.managedActivation, "existing_only_pending_managed");
  assert.equal(freshReceipt.runtimeInstall.managedOnboardingRequired, true);
  assert.match(freshReceipt.runtimeInstall.managedOnboardingCommand ?? "", /^node ".*managed-codex-login\.mjs"$/i);
  assert.equal(freshReceipt.runtimeInstall.noSilentFallback, true);
  assert.equal(freshReceipt.requiresRuntimeRestart, false);
  assert.equal(freshReceipt.requiresHostRefresh, false);
  const markerAfterA = await readMarker(mainInstall);
  assert.equal(markerAfterA.productId, "codexless");
  assert.equal(markerAfterA.lastKnownBuildId, freshReceipt.artifactBuildId);
  assert.equal(markerAfterA.lastKnownVersion, freshReceipt.to.version);
  assertMarkerSafe(markerAfterA, mainInstall);
  await assertBootstrapPointsTo(defaultBootstrapRoot, freshReceipt.artifactBuildId, "fresh one-command install");

  const advancedInstall = path.join(root, "advanced-existing-only", "Codexless");
  const advancedExistingOnly = runInstaller(releaseA, advancedInstall, { existingOnly: true });
  assert.equal(advancedExistingOnly.status, 0, advancedExistingOnly.stderr || advancedExistingOnly.stdout);
  const advancedReceipt = parseReceipt(advancedExistingOnly.stdout);
  validateLifecycleReceipt(advancedReceipt, { expectOk: true });
  assert.equal(advancedReceipt.runtimeInstall.mode, "existing");
  assert.equal(advancedReceipt.runtimeInstall.recommendedDualInsurance, false);
  assert.equal(advancedReceipt.runtimeInstall.managedProvisioned, false);
  assert.equal(advancedReceipt.runtimeInstall.managedActivation, null);
  assert.equal(advancedReceipt.runtimeInstall.managedOnboardingRequired, false);
  assert.equal(advancedReceipt.runtimeInstall.managedOnboardingCommand, null);
  assert.equal(advancedReceipt.runtimeInstall.noSilentFallback, true);

  const updateSame = runInstaller(releaseB, mainInstall);
  assert.equal(updateSame.status, 0, updateSame.stderr || updateSame.stdout);
  const sameReceipt = parseReceipt(updateSame.stdout);
  validateLifecycleReceipt(sameReceipt, { expectOk: true });
  assert.equal(sameReceipt.action, "updated");
  assert.equal(sameReceipt.requiresRuntimeRestart, true);
  assert.equal(sameReceipt.requiresHostRefresh, false);
  assert.equal(sameReceipt.rollback.backupRetained, true);
  assert.equal(sameReceipt.rollback.backupPath, path.join(mainParent, "Codexless-previous"));
  const previousAfterB = await readReleaseManifest(path.join(mainParent, "Codexless-previous"));
  assert.equal(previousAfterB.sourceRevision, "release-a");
  await assertExactlyOneRetainedBackup(mainParent);
  const markerAfterB = await readMarker(mainInstall);
  assert.equal(markerAfterB.createdAt, markerAfterA.createdAt, "successful update must preserve marker createdAt");
  assert.notEqual(markerAfterB.lastKnownBuildId, markerAfterA.lastKnownBuildId);
  assert.equal(markerAfterB.lastKnownBuildId, sameReceipt.artifactBuildId);
  await assertBootstrapPointsTo(defaultBootstrapRoot, sameReceipt.artifactBuildId, "ordinary install update");

  const installedFail = runInstaller(releaseC, mainInstall, { doctorFail: "installed" });
  assert.notEqual(installedFail.status, 0);
  const installedFailureReceipt = parseReceipt(installedFail.stdout);
  validateLifecycleReceipt(installedFailureReceipt, { expectOk: false });
  assert.equal(installedFailureReceipt.errorStage, "installed-doctor");
  assert.equal(installedFailureReceipt.rollback.performed, true);
  const markerAfterDoctorRollback = await readMarker(mainInstall);
  assert.deepEqual(markerAfterDoctorRollback, markerAfterB, "installed-doctor rollback must not advance ownership marker to failed target");
  assert.equal((await readReleaseManifest(mainInstall)).sourceRevision, "release-b");
  await assertBootstrapPointsTo(defaultBootstrapRoot, sameReceipt.artifactBuildId, "installed doctor failure");

  const doctorFailureDetail = [
    "doctor line one",
    'quoted \"hello world\"',
    String.raw`backslash C:\fixture\doctor`,
    "Unicode 狐🦊",
  ].join("\n");
  const stageFailure = runInstaller(releaseC, mainInstall, { doctorFail: "stage", doctorFailureDetail });
  assert.notEqual(stageFailure.status, 0);
  const stageFailureReceipt = parseReceipt(stageFailure.stdout);
  validateLifecycleReceipt(stageFailureReceipt, { expectOk: false });
  assert.equal(stageFailureReceipt.errorStage, "staging-doctor");
  assert.equal(stageFailureReceipt.errorCode, "STAGING_DOCTOR_FAILED");
  const expectedDoctorFailure = JSON.stringify({ status: "error", errorClass: "FixtureDoctorError", errorCode: "FIXTURE_DOCTOR_FAILED", message: doctorFailureDetail }, null, 2);
  assert.ok(stageFailureReceipt.error.replace(/\r\n/g, "\n").endsWith(expectedDoctorFailure), stageFailureReceipt.error);
  assert.equal(`${stageFailure.stdout}\n${stageFailure.stderr}`.includes("unexpected lifecycle argument"), false, "multiline doctor failure must not be reparsed as positional lifecycle argv");
  const strayLifecycleArg = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "lifecycle.mjs"), "failure", "unexpected-positional"], { encoding: "utf8", windowsHide: true });
  assert.notEqual(strayLifecycleArg.status, 0, "genuine positional lifecycle argv must remain fail-closed");
  assert.match(strayLifecycleArg.stderr, /unexpected lifecycle argument: unexpected-positional/);
  await assertBootstrapPointsTo(defaultBootstrapRoot, sameReceipt.artifactBuildId, "staging doctor failure");
  const afterStageFailure = runInstaller(releaseC, mainInstall);
  assert.equal(afterStageFailure.status, 0, "a failure/exception path must release the activation lock for the next installer");
  const changedReceipt = parseReceipt(afterStageFailure.stdout);
  assert.equal(changedReceipt.action, "updated");
  assert.equal(changedReceipt.requiresHostRefresh, true);
  const markerAfterC = await readMarker(mainInstall);
  assert.equal(markerAfterC.lastKnownBuildId, changedReceipt.artifactBuildId);
  await assertBootstrapPointsTo(defaultBootstrapRoot, changedReceipt.artifactBuildId, "successful changed-host update");

  const bootstrapFailRoot = path.join(root, "bootstrap-commit-failure-root");
  const bootstrapFailInstall = path.join(root, "bootstrap-commit-failure-parent", "Codexless");
  await mkdir(bootstrapFailRoot, { recursive: true });
  await writeFile(path.join(bootstrapFailRoot, "run.mjs"), "// unsupported launcher protocol\n", "utf8");
  const bootstrapCommitFailure = runInstaller(releaseA, bootstrapFailInstall, { bootstrapRoot: bootstrapFailRoot });
  assert.notEqual(bootstrapCommitFailure.status, 0, "bootstrap commit failure must fail the app install transaction");
  const bootstrapCommitFailureReceipt = parseReceipt(bootstrapCommitFailure.stdout);
  validateLifecycleReceipt(bootstrapCommitFailureReceipt, { expectOk: false });
  assert.equal(bootstrapCommitFailureReceipt.errorStage, "bootstrap-commit");
  assert.equal(await exists(bootstrapFailInstall), false, "fresh app install must roll back when bootstrap commit fails");
  assert.equal(await markerExists(bootstrapFailInstall), false, "fresh marker must roll back when bootstrap commit fails");
  assert.equal(await exists(path.join(bootstrapFailRoot, "current.json")), false, "bootstrap pointer must not advance on commit failure");
  assert.equal((await readdir(bootstrapFailRoot)).some((name) => name.startsWith(".pending-")), false, "failed bootstrap commit must discard pending generation");

  const updateCommitFailParent = path.join(root, "update-bootstrap-commit-failure-parent");
  const updateCommitFailInstall = path.join(updateCommitFailParent, "Codexless");
  const updateCommitFailBootstrap = path.join(root, "update-bootstrap-commit-failure-root");
  const updateCommitSeedA = runInstaller(releaseA, updateCommitFailInstall, { bootstrapRoot: updateCommitFailBootstrap });
  assert.equal(updateCommitSeedA.status, 0, updateCommitSeedA.stderr || updateCommitSeedA.stdout);
  const updateCommitB = runInstaller(releaseB, updateCommitFailInstall, { bootstrapRoot: updateCommitFailBootstrap });
  assert.equal(updateCommitB.status, 0, updateCommitB.stderr || updateCommitB.stdout);
  const updateCommitBReceipt = parseReceipt(updateCommitB.stdout);
  const updateCommitBMarker = await readMarker(updateCommitFailInstall);
  assert.equal((await readReleaseManifest(path.join(updateCommitFailParent, "Codexless-previous"))).sourceRevision, "release-a", "seed B update must retain A as previous");
  const currentBBeforeFailure = await readFile(path.join(updateCommitFailInstall, "src", "fixture-payload.txt"));
  const previousABeforeFailure = await readFile(path.join(updateCommitFailParent, "Codexless-previous", "src", "fixture-payload.txt"));
  const markerBBeforeFailure = await readFile(await markerFilePath(updateCommitFailInstall));
  const pointerBBeforeFailure = await readFile(path.join(updateCommitFailBootstrap, "current.json"));
  const stableLauncher = await readFile(path.join(updateCommitFailBootstrap, "run.mjs"), "utf8");
  await writeFile(path.join(updateCommitFailBootstrap, "run.mjs"), "// unsupported launcher protocol\n", "utf8");
  const updateCommitFailure = runInstaller(releaseC, updateCommitFailInstall, { bootstrapRoot: updateCommitFailBootstrap });
  assert.notEqual(updateCommitFailure.status, 0, "C bootstrap commit failure must roll back current and previous rotation inside the installer transaction");
  const updateCommitFailureReceipt = parseReceipt(updateCommitFailure.stdout);
  validateLifecycleReceipt(updateCommitFailureReceipt, { expectOk: false });
  assert.equal(updateCommitFailureReceipt.errorStage, "bootstrap-commit");
  assert.equal(updateCommitFailureReceipt.rollback.performed, true);
  assert.equal((await readReleaseManifest(updateCommitFailInstall)).sourceRevision, "release-b", "bootstrap commit failure must restore B as current app");
  assert.equal((await readMarker(updateCommitFailInstall)).lastKnownBuildId, updateCommitBMarker.lastKnownBuildId, "bootstrap commit failure must restore B ownership marker");
  assert.equal((await readBootstrapPointer(updateCommitFailBootstrap)).buildId, updateCommitBReceipt.artifactBuildId, "bootstrap commit failure must leave B bootstrap pointer unchanged");
  assert.equal((await readReleaseManifest(path.join(updateCommitFailParent, "Codexless-previous"))).sourceRevision, "release-a", "bootstrap commit failure must restore A as retained previous");
  assert.deepEqual(await readFile(path.join(updateCommitFailInstall, "src", "fixture-payload.txt")), currentBBeforeFailure, "current app payload must be byte-equivalent to pre-transaction B after rollback");
  assert.deepEqual(await readFile(path.join(updateCommitFailParent, "Codexless-previous", "src", "fixture-payload.txt")), previousABeforeFailure, "retained previous payload must be byte-equivalent to pre-transaction A after rollback");
  assert.deepEqual(await readFile(await markerFilePath(updateCommitFailInstall)), markerBBeforeFailure, "ownership marker bytes must be restored exactly after bootstrap commit failure");
  assert.deepEqual(await readFile(path.join(updateCommitFailBootstrap, "current.json")), pointerBBeforeFailure, "bootstrap pointer bytes must remain exactly unchanged after failed commit");
  assert.equal(await exists(path.join(updateCommitFailBootstrap, "generations", (await readReleaseManifest(releaseC)).buildId)), false, "failed C generation must not remain committed");
  assert.equal((await readdir(updateCommitFailBootstrap)).some((name) => name.startsWith(".pending-")), false, "update bootstrap commit failure must discard C pending generation");
  await assertNoTransactionDebris(updateCommitFailParent, "bootstrap commit rollback with existing previous");

  await writeFile(path.join(updateCommitFailBootstrap, "run.mjs"), stableLauncher, "utf8");
  const updateCommitC = runInstaller(releaseC, updateCommitFailInstall, { bootstrapRoot: updateCommitFailBootstrap });
  assert.equal(updateCommitC.status, 0, updateCommitC.stderr || updateCommitC.stdout);
  const updateCommitCReceipt = parseReceipt(updateCommitC.stdout);
  assert.equal((await readReleaseManifest(updateCommitFailInstall)).sourceRevision, "release-c", "successful retry must install C");
  assert.equal((await readReleaseManifest(path.join(updateCommitFailParent, "Codexless-previous"))).sourceRevision, "release-b", "successful C update must retire A and retain B as exactly one previous");
  await assertBootstrapPointsTo(updateCommitFailBootstrap, updateCommitCReceipt.artifactBuildId, "successful C retry after previous rollback");
  await assertExactlyOneRetainedBackup(updateCommitFailParent);
  await assertNoTransactionDebris(updateCommitFailParent, "successful previous rotation");

  const markerFailParent = path.join(root, "marker-failure-parent");
  const markerFailInstall = path.join(markerFailParent, "Codexless");
  const markerFailBootstrap = path.join(root, "marker-failure-bootstrap");
  const markerSeedA = runInstaller(releaseA, markerFailInstall, { bootstrapRoot: markerFailBootstrap });
  assert.equal(markerSeedA.status, 0, markerSeedA.stderr || markerSeedA.stdout);
  const markerSeedB = runInstaller(releaseB, markerFailInstall, { bootstrapRoot: markerFailBootstrap });
  assert.equal(markerSeedB.status, 0, markerSeedB.stderr || markerSeedB.stdout);
  const markerSeedBReceipt = parseReceipt(markerSeedB.stdout);
  assert.equal((await readReleaseManifest(path.join(markerFailParent, "Codexless-previous"))).sourceRevision, "release-a", "marker failure fixture must begin with A retained behind B");
  const markerPath = await markerFilePath(markerFailInstall);
  await rm(markerPath, { force: true });
  await mkdir(markerPath, { recursive: false });
  const markerFailure = runInstaller(releaseC, markerFailInstall, { bootstrapRoot: markerFailBootstrap });
  assert.notEqual(markerFailure.status, 0, "ownership marker write failure must fail the C app transaction");
  const markerFailureReceipt = parseReceipt(markerFailure.stdout);
  validateLifecycleReceipt(markerFailureReceipt, { expectOk: false });
  assert.equal(markerFailureReceipt.errorStage, "ownership-marker");
  assert.equal((await readReleaseManifest(markerFailInstall)).sourceRevision, "release-b", "marker failure must restore B as current app");
  assert.equal((await readReleaseManifest(path.join(markerFailParent, "Codexless-previous"))).sourceRevision, "release-a", "marker failure must preserve A as retained previous");
  await assertBootstrapPointsTo(markerFailBootstrap, markerSeedBReceipt.artifactBuildId, "ownership marker failure with existing previous");
  assert.equal((await readdir(markerFailBootstrap)).some((name) => name.startsWith(".pending-")), false, "marker failure must discard prepared bootstrap generation");
  assert.equal(await exists(path.join(markerFailBootstrap, "generations", (await readReleaseManifest(releaseC)).buildId)), false, "marker failure must not commit C bootstrap generation");
  await assertNoTransactionDebris(markerFailParent, "marker rollback with existing previous");

  const repairParent = path.join(root, "repair-parent");
  const repairInstall = path.join(repairParent, "Codexless");
  const repairSeed = runInstaller(releaseA, repairInstall);
  assert.equal(repairSeed.status, 0);
  const repairSeedReceipt = parseReceipt(repairSeed.stdout);
  const repairSeedMarker = await readMarker(repairInstall);
  await corruptInstallOwnershipEvidence(repairInstall);
  const ordinaryUpdate = runInstaller(releaseB, repairInstall);
  assert.notEqual(ordinaryUpdate.status, 0, "normal update must not use marker-only ownership recovery");
  const ordinaryFailure = parseReceipt(ordinaryUpdate.stdout);
  assert.equal(ordinaryFailure.errorCode, "INSTALLED_IDENTITY_UNAVAILABLE");
  assert.equal((await readMarker(repairInstall)).lastKnownBuildId, repairSeedMarker.lastKnownBuildId);
  assert.equal((await readdir(repairParent)).includes("Codexless-previous"), false, "failed marker-only normal update must fail before backup/activate");
  await assertBootstrapPointsTo(defaultBootstrapRoot, repairSeedReceipt.artifactBuildId, "ordinary update must not use repair marker");

  const repaired = runInstaller(releaseB, repairInstall, { repair: true });
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
  const repairReceipt = parseReceipt(repaired.stdout);
  validateLifecycleReceipt(repairReceipt, { expectOk: true });
  assert.equal(repairReceipt.action, "repaired");
  assert.equal(repairReceipt.from.buildId, repairSeedMarker.lastKnownBuildId);
  assert.equal((await readReleaseManifest(repairInstall)).sourceRevision, "release-b");
  const repairMarker = await readMarker(repairInstall);
  assert.equal(repairMarker.lastKnownBuildId, repairReceipt.artifactBuildId);
  assertMarkerSafe(repairMarker, repairInstall);
  await assertBootstrapPointsTo(defaultBootstrapRoot, repairReceipt.artifactBuildId, "explicit repair");

  const incompatibleParent = path.join(root, "repair-incompatible-parent");
  const incompatibleInstall = path.join(incompatibleParent, "Codexless");
  const incompatibleSeed = runInstaller(releaseA, incompatibleInstall);
  assert.equal(incompatibleSeed.status, 0);
  const incompatibleSeedReceipt = parseReceipt(incompatibleSeed.stdout);
  const incompatibleMarker = await readMarker(incompatibleInstall);
  await corruptInstallOwnershipEvidence(incompatibleInstall);
  const corruptSentinel = await readFile(path.join(incompatibleInstall, "package.json"), "utf8");
  const incompatible = runInstaller(releaseIncompatible, incompatibleInstall, { repair: true });
  assert.notEqual(incompatible.status, 0, "repair target with incompatible state contract must fail");
  const incompatibleReceipt = parseReceipt(incompatible.stdout);
  validateLifecycleReceipt(incompatibleReceipt, { expectOk: false });
  assert.equal(incompatibleReceipt.errorStage, "state-compatibility");
  assert.equal(incompatibleReceipt.errorCode, "STATE_INCOMPATIBLE");
  assert.equal(await readFile(path.join(incompatibleInstall, "package.json"), "utf8"), corruptSentinel, "state incompatibility must fail before moving the damaged install");
  assert.deepEqual(await readMarker(incompatibleInstall), incompatibleMarker, "state-incompatible repair must not update marker");
  assert.equal((await readdir(incompatibleParent)).includes("Codexless-previous"), false);
  await assertBootstrapPointsTo(defaultBootstrapRoot, incompatibleSeedReceipt.artifactBuildId, "state-incompatible repair");

  const concurrencyParent = path.join(root, `concurrency-${secret}`);
  const concurrencyInstall = path.join(concurrencyParent, `Codexless-${secret}`);
  assert.equal(runInstaller(releaseA, concurrencyInstall).status, 0);
  const contenders = await Promise.all([
    runInstallerAsync(releaseB, concurrencyInstall, { doctorDelayMs: 500 }),
    runInstallerAsync(releaseC, concurrencyInstall, { doctorDelayMs: 500 }),
  ]);
  const winners = contenders.filter((result) => result.status === 0);
  const losers = contenders.filter((result) => result.status !== 0);
  assert.equal(winners.length, 1, `exactly one concurrent installer must win: ${JSON.stringify(contenders.map(({ status, stdout, stderr }) => ({ status, stdout, stderr })))}`);
  assert.equal(losers.length, 1);
  const busy = parseReceipt(losers[0].stdout);
  assert.equal(busy.errorCode, "INSTALLER_BUSY");
  const busyText = JSON.stringify(busy);
  assert.equal(busyText.includes(concurrencyInstall), false, "busy lock error must not leak install path");
  assert.equal(busyText.includes(secret), false, "busy lock error must not leak secret-like path material");
  assert.equal((await readReleaseManifest(path.join(concurrencyParent, "Codexless-previous"))).sourceRevision, "release-a", "loser must not move the old install; winner alone creates the previous backup");
  const concurrencyEntries = await readdir(concurrencyParent);
  assert.equal(concurrencyEntries.filter((name) => name.startsWith("Codexless-backup-")).length, 0, "concurrency loser/winner must leave no transaction backup");
  assert.equal(concurrencyEntries.filter((name) => name.startsWith("Codexless-stage-")).length, 0, "busy loser must not create staging material");
  const concurrencyWinner = parseReceipt(winners[0].stdout);
  await assertBootstrapPointsTo(defaultBootstrapRoot, concurrencyWinner.artifactBuildId, "concurrent installer winner");

  assert.equal(await readFile(recentState, "utf8"), recentBytes, "recent-call state must remain byte-for-byte untouched");
  assert.equal(await readFile(taskState, "utf8"), taskBytes, "agent task-card state must remain byte-for-byte untouched");
  assert.equal(await readFile(managedAuthState, "utf8"), managedAuthBytes, "Managed CODEX_HOME/login state must remain byte-for-byte untouched");
  assert.equal(await readFile(callProfileState, "utf8"), callProfileBytes, "Codex Call Profile must remain byte-for-byte untouched");

  process.stdout.write(`installer lifecycle Windows E2E PASS ${changedReceipt.artifactBuildId}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createFixtureRelease(name, marker, hostContractVersion, { incompatibleState = false } = {}) {
  const releaseRoot = path.join(root, name);
  for (const directory of ["src", "config", "scripts", "skills/codexless-browser-repair", "bin"]) await mkdir(path.join(releaseRoot, directory), { recursive: true });

  for (const file of [
    "release-identity.mjs",
    "lifecycle-contract.mjs",
    "release-discovery.mjs",
    "platform-support.mjs",
    "bootstrap-persistence.mjs",
    "bootstrap-archive.mjs",
    "bootstrap-updater.mjs",
  ]) {
    await copyFile(path.join(projectRoot, "src", file), path.join(releaseRoot, "src", file));
  }
  await writeFile(path.join(releaseRoot, "src", "fixture-payload.txt"), `${marker}\n`, "utf8");
  for (const file of [
    "install.ps1",
    "install.sh",
    "lifecycle.mjs",
    "materialize-bootstrap.mjs",
    "bootstrap.mjs",
    "bootstrap-archive.ps1",
    "bootstrap-archive.sh",
  ]) {
    await copyFile(path.join(projectRoot, "scripts", file), path.join(releaseRoot, "scripts", file));
  }

  await writeFile(path.join(releaseRoot, "scripts", "runtime-install-state.mjs"), [
    "import process from 'node:process';",
    "const command = process.argv[2] || 'status';",
    "let value;",
    "if (command === 'status') value = {ok:true,preference:{mode:null,persisted:false,updatedAt:null},routing:{activation:'existing_only_pending_managed',managedReady:false,persisted:false,updatedAt:null}};",
    "else if (command === 'verify-managed') value = {ok:true,action:'managed-runtime-provisioned',activationChanged:false,activation:'existing_only_pending_managed',managedReady:false,managed:{packageName:'@openai/codex',packageVersion:'0.147.0',platformPackageName:'@openai/codex-win32-x64',platformPackageVersion:'0.147.0-win32-x64',binarySha256:'f'.repeat(64),codexHome:'fixture-managed-home',source:'fixture'},officialLoginRequiredBeforeFirstDualActivation:true,noExistingCredentialCopy:true,noExistingCodexHomeCopy:true,noSilentFallback:true};",
    "else value = {ok:true,action:command,mode:process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : null};",
    "process.stdout.write(JSON.stringify(value) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "sync-codex-skills.mjs"), [
    "import process from 'node:process';",
    "process.stdout.write(JSON.stringify({ok:true,status:'current',action:'no-op',targetLane:'existing',transactionId:null}) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "skills", "codexless-browser-repair", "SKILL.md"), "---\nname: codexless-browser-repair\ndescription: fixture\n---\n", "utf8");

  await writeFile(path.join(releaseRoot, "scripts", "resolve-codex.mjs"), [
    "import process from 'node:process';",
    "process.stdout.write(JSON.stringify({ok:true,path:process.execPath,version:'fixture-codex',source:'fixture'}) + '\\n');",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "doctor.mjs"), [
    "import process from 'node:process';",
    "const mode = process.env.CODEXLESS_FIXTURE_DOCTOR_FAIL || '';",
    "const delay = Number(process.env.CODEXLESS_FIXTURE_DOCTOR_DELAY_MS || '0');",
    "if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
    "const stage = process.cwd().toLowerCase().includes('codexless-stage-');",
    "const fail = (mode === 'stage' && stage) || (mode === 'installed' && !stage);",
    "const detail = process.env.CODEXLESS_FIXTURE_DOCTOR_DETAIL || '';",
    "const payload = fail ? {status:'error',errorClass:'FixtureDoctorError',errorCode:'FIXTURE_DOCTOR_FAILED',message:detail} : {status:'ok'};",
    "process.stdout.write(JSON.stringify(payload, null, fail ? 2 : 0) + '\\n');",
    "process.exitCode = fail ? 1 : 0;",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "uninstall.ps1"), "# fixture\n", "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "uninstall.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await writeFile(path.join(releaseRoot, "scripts", "launch.mjs"), "// fixture\n", "utf8");
  await writeFile(path.join(releaseRoot, "bin", "fixture.txt"), "fixture\n", "utf8");
  await writeFile(path.join(releaseRoot, "config", "toolbox-method-registry.json"), "{}\n", "utf8");

  const packageBody = {
    name: "codexless",
    version,
    private: true,
    type: "module",
  };
  await writeFile(path.join(releaseRoot, "package.json"), `${JSON.stringify(packageBody, null, 2)}\n`, "utf8");
  await writeFile(path.join(releaseRoot, "npm-shrinkwrap.json"), `${JSON.stringify({
    name: "codexless",
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "codexless", version } },
  }, null, 2)}\n`, "utf8");

  for (const file of ["README.md", "README.zh-CN.md", "README.linux.md", "SECURITY.md", "EXPORT_SYNC.md", "THIRD_PARTY_NOTICES.md", "LICENSE"]) {
    await writeFile(path.join(releaseRoot, file), `${file} fixture ${name}\n`, "utf8");
  }

  const manifest = await buildReleaseManifest({
    root: releaseRoot,
    serverVersion: version,
    hostContractVersion,
    sourceRevision: name,
  });
  if (incompatibleState) manifest.stateCompatibility.stores["recent-calls"].schemaVersion = 2;
  if (incompatibleState) manifest.buildId = computeBuildIdForIncompatibleFixture(manifest);
  await writeFile(path.join(releaseRoot, "config", "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return releaseRoot;
}

function computeBuildIdForIncompatibleFixture(manifest) {
  void manifest;
  return "f".repeat(64);
}

function installerEnv({ doctorFail = "", doctorFailureDetail = "", doctorDelayMs = 0, bootstrapRoot = null } = {}) {
  const env = {
    ...process.env,
    PATH: `${fakeTools}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: stateHome,
    USERPROFILE: stateHome,
    CODEXLESS_FIXTURE_DOCTOR_FAIL: doctorFail,
    CODEXLESS_FIXTURE_DOCTOR_DETAIL: doctorFailureDetail,
    CODEXLESS_FIXTURE_DOCTOR_DELAY_MS: String(doctorDelayMs),
    CODEXLESS_TEST_SECRET: secret,
  };
  if (bootstrapRoot) env.CODEXLESS_BOOTSTRAP_ROOT = bootstrapRoot;
  else delete env.CODEXLESS_BOOTSTRAP_ROOT;
  delete env.CODEXLESS_BOOTSTRAP_PREPARED_BUILD_ID;
  delete env.CODEXLESS_BOOTSTRAP_PREPARED_REUSED;
  delete env.CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR;
  return env;
}

function installerArgs(releaseRoot, installDir, { repair = false, existingOnly = false, recommended = false } = {}) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(releaseRoot, "scripts", "install.ps1"),
    "-InstallDir", installDir,
    "-Json",
  ];
  if (repair) args.push("-Repair");
  if (existingOnly) args.push("-ExistingOnly");
  if (recommended) args.push("-Recommended");
  return args;
}

function runInstaller(releaseRoot, installDir, options = {}) {
  return spawnSync("powershell.exe", installerArgs(releaseRoot, installDir, options), {
    encoding: "utf8",
    env: installerEnv(options),
    windowsHide: true,
    timeout: 30_000,
  });
}

function runInstallerAsync(releaseRoot, installDir, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", installerArgs(releaseRoot, installDir, options), {
      env: installerEnv(options),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("concurrent installer fixture timed out"));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function parseReceipt(stdout) {
  const text = String(stdout ?? "").trim();
  assert.ok(text, "installer must emit a JSON receipt");
  return JSON.parse(text);
}

async function markerFilePath(installDir) {
  const identity = await canonicalInstallDirIdentity(installDir);
  return path.join(stateDir, `${OWNERSHIP_MARKER_PREFIX}${identity.sha256}.json`);
}

async function readMarker(installDir) {
  return JSON.parse(await readFile(await markerFilePath(installDir), "utf8"));
}

async function markerExists(installDir) {
  return exists(await markerFilePath(installDir));
}

function assertMarkerSafe(marker, installDir) {
  const serialized = JSON.stringify(marker);
  assert.equal(serialized.includes(path.resolve(installDir)), false, "ownership marker must not contain an absolute install path");
  assert.equal(serialized.includes(secret), false, "ownership marker must not contain secret-like install path material");
  assert.deepEqual(Object.keys(marker.installDirIdentity).sort(), ["algorithm", "sha256"]);
  assert.equal(Object.hasOwn(marker, "auth"), false);
  assert.equal(Object.hasOwn(marker, "tunnel"), false);
  assert.equal(Object.hasOwn(marker, "trustedRoots"), false);
}

async function assertBootstrapPointsTo(bootstrapRoot, expectedBuildId, label) {
  const pointer = await readBootstrapPointer(bootstrapRoot);
  assert.equal(pointer.buildId, expectedBuildId, `${label}: external bootstrap pointer must match installed build`);
  assert.equal(await exists(path.join(bootstrapRoot, "run.mjs")), true, `${label}: stable external run.mjs must exist`);
  assert.equal(await exists(path.join(bootstrapRoot, "generations", expectedBuildId, "generation.json")), true, `${label}: generation metadata must exist`);
  assert.equal(await exists(path.join(bootstrapRoot, "generations", expectedBuildId, "scripts", "bootstrap.mjs")), true, `${label}: generation bootstrap entry must exist`);
}

async function corruptInstallOwnershipEvidence(installDir) {
  await writeFile(path.join(installDir, "package.json"), `{damaged-${secret}`, "utf8");
  await writeFile(path.join(installDir, "config", "release-manifest.json"), `{damaged-${secret}`, "utf8");
}

async function assertExactlyOneRetainedBackup(parent) {
  const entries = await readdir(parent, { withFileTypes: true });
  const retained = entries.filter((entry) => entry.isDirectory() && entry.name === "Codexless-previous");
  const transaction = entries.filter((entry) => entry.name.startsWith("Codexless-backup-"));
  const stashes = entries.filter((entry) => entry.name.startsWith("Codexless-previous.rollback-"));
  assert.equal(retained.length, 1, "successful update must retain exactly one previous backup");
  assert.equal(transaction.length, 0, "successful update must not leave transaction backup directories behind");
  assert.equal(stashes.length, 0, "successful update must not leave previous rollback stashes behind");
}

async function assertNoTransactionDebris(parent, label) {
  const entries = await readdir(parent);
  assert.equal(entries.some((name) => name.startsWith("Codexless-backup-")), false, `${label}: transaction backup must be cleaned`);
  assert.equal(entries.some((name) => name.startsWith("Codexless-stage-")), false, `${label}: staging directory must be cleaned`);
  assert.equal(entries.some((name) => name.startsWith("Codexless-previous.rollback-")), false, `${label}: previous rollback stash must be cleaned/restored`);
}

async function exists(target) {
  return Boolean(await stat(target).catch(() => null));
}
