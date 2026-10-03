import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultCodexlessStateRoot } from "./runtime-routing-policy.mjs";

const SCHEMA = 1;
const MAX_FILES = 12000;
const MAX_BYTES = 2 * 1024 ** 3;
const ROLES = ["browser", "chrome", "codex", "node"];
const canonical = (value) => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const samePath = (a, b) => process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const within = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
function failure(component, reason = "browser_snapshot_integrity_failed") {
  const error = new Error(reason);
  error.code = reason;
  error.changedComponents = [ROLES.includes(component) ? component : "snapshot"];
  return error;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true; // Unknown ownership must never authorize cleanup.
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function directory(dir, { create = false } = {}) {
  const resolved = path.resolve(dir);
  const { root } = path.parse(resolved);
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("snapshot", "browser_snapshot_path_untrusted");
  }
  if (!samePath(await realpath(resolved), resolved)) throw failure("snapshot", "browser_snapshot_path_untrusted");
  return resolved;
}
async function inventory(roots) {
  const files = [];
  let bytes = 0;
  async function visit(role, root, dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, item.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw failure(role, "browser_snapshot_path_untrusted");
      if (stat.isDirectory()) { await visit(role, root, file); continue; }
      if (!stat.isFile() || !within(root, await realpath(file))) throw failure(role, "browser_snapshot_path_untrusted");
      bytes += stat.size;
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) throw failure(role, "browser_snapshot_size_limit");
      files.push({ path: `${role}/${path.relative(root, file).split(path.sep).join("/")}`, bytes: stat.size, sha256: await fileHash(file) });
    }
  }
  for (const role of ROLES) { await directory(roots[role]); await visit(role, roots[role], roots[role]); }
  return files;
}
async function locked(store, action) {
  await directory(store, { create: true });
  const lock = path.join(store, "transaction.lock");
  const token = randomUUID();
  const owner = canonical({ pid: process.pid, token });
  const deadline = Date.now() + 120000;
  for (;;) {
    if (Date.now() >= deadline) throw failure("snapshot", "browser_snapshot_store_busy");
    const claim = path.join(store, `.lock-claim-${process.pid}-${randomUUID()}`);
    await directory(claim, { create: true });
    const receipt = path.join(claim, "owner.json");
    const handle = await open(receipt, "wx", 0o600);
    try { await handle.writeFile(owner); await handle.sync(); } finally { await handle.close(); }
    try {
      await rename(claim, lock); // A nonempty owned lock cannot be overwritten.
      break;
    } catch (error) {
      await unlink(receipt); await rmdir(claim);
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
      try { await directory(lock); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const file = path.join(lock, "owner.json");
      let stat;
      try { stat = await lstat(file); } catch (error) { if (error.code === "ENOENT") { await new Promise(resolve => setTimeout(resolve, 100)); continue; } throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure("snapshot", "browser_snapshot_path_untrusted");
      const text = await readFile(file, "utf8").catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
      if (text === null) continue;
      const prior = JSON.parse(text);
      if (!/^[a-f0-9-]{36}$/.test(prior.token ?? "")) throw failure("snapshot", "browser_snapshot_path_untrusted");
      if (!alive(prior.pid) && await readFile(file, "utf8") === text) {
        // Retain a nonce tombstone, like the installer lifecycle lock. Another
        // reclaimer holding the stale receipt can never rename a new owner's lock.
        await rename(lock, path.join(store, `.reclaimed-lock-${prior.token}`)).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw failure("snapshot", "browser_snapshot_store_busy");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await action(); }
  finally {
    const file = path.join(lock, "owner.json");
    if (await readFile(file, "utf8").catch(() => null) === owner) { await unlink(file); await rmdir(lock); }
  }
}
async function json(file, value) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  const handle = await open(tmp, "wx", 0o600);
  try { await handle.writeFile(canonical(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, file);
}
export function defaultBrowserSnapshotStore(stateRoot = defaultCodexlessStateRoot()) {
  return path.join(path.resolve(stateRoot), "browser-snapshots", "v1");
}
function sourceBinding(compatibility, nodeReplConfig, codexBin) {
  if (compatibility?.status !== "ok" || !nodeReplConfig || (nodeReplConfig.args ?? []).length) throw failure("node", "browser_snapshot_coherence_failed");
  const nodeRoot = path.dirname(path.resolve(nodeReplConfig.command));
  const nodeEnv = nodeReplConfig.env ?? {};
  const trusted = JSON.parse(nodeEnv.NODE_REPL_TRUSTED_SERVICES ?? "{}");
  if (nodeEnv.BROWSER_USE_CODEX_APP_VERSION !== compatibility.build || !samePath(trusted.browser ?? "", compatibility.browserServicePath)
    || typeof nodeEnv.NODE_REPL_NODE_PATH !== "string" || !within(nodeRoot, path.resolve(nodeEnv.NODE_REPL_NODE_PATH))
    || typeof nodeEnv.NODE_REPL_NODE_MODULE_DIRS !== "string") throw failure("node", "browser_snapshot_coherence_failed");
  const moduleDirs = nodeEnv.NODE_REPL_NODE_MODULE_DIRS.split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  if (!moduleDirs.length || moduleDirs.some((dir) => !within(nodeRoot, dir))) throw failure("node", "browser_snapshot_coherence_failed");
  const roots = {
    chrome: compatibility.chromePluginRoot,
    browser: path.dirname(path.dirname(compatibility.browserServicePath)),
    node: nodeRoot,
    codex: path.dirname(path.resolve(codexBin)),
  };
  // Preserve the official trusted-code boundary. Only relocate code already admitted
  // by the source configuration, narrowing broad roots to the copied dependency trees.
  const sourceTrusted = (nodeEnv.NODE_REPL_TRUSTED_CODE_PATHS ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  const admitted = [roots.chrome, roots.browser, ...moduleDirs];
  if (!sourceTrusted.length || admitted.some((dir) => !sourceTrusted.some((root) => within(root, path.resolve(dir))))) {
    throw failure("node", "browser_snapshot_untrusted_source");
  }
  function relative(file) {
    for (const role of ROLES) if (within(roots[role], path.resolve(file))) return `${role}/${path.relative(roots[role], path.resolve(file)).split(path.sep).join("/")}`;
    throw failure("node", "browser_snapshot_external_dependency");
  }
  // Optional explicit WASM overrides must belong to the copied set, never silently stay source-bound.
  const wasm = nodeEnv.BROWSER_USE_ACCESSIBILITY_CORE_WASM_PATH;
  const identity = {
    schema: SCHEMA, platform: process.platform, arch: process.arch, build: compatibility.build,
    entrypoints: { client: relative(compatibility.browserClientPath), service: relative(compatibility.browserServicePath),
      codex: relative(codexBin), nodeRepl: relative(nodeReplConfig.command), node: relative(nodeEnv.NODE_REPL_NODE_PATH) },
    moduleDirs: moduleDirs.map(relative), ...(wasm ? { wasm: relative(wasm) } : {}),
    trustedCodePaths: [...new Set(admitted.map(relative))].sort(),
    ...(nodeEnv.CUA_REPL_NODE_REPL_PATH ? { cuaNodeRepl: relative(nodeEnv.CUA_REPL_NODE_REPL_PATH) } : {}),
  };
  return { roots, identity };
}
async function verifyTree(root, manifest, manifestHash) {
  await directory(root);
  const manifestFile = path.join(root, "manifest.json");
  const stat = await lstat(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || await fileHash(manifestFile) !== manifestHash) throw failure("snapshot");
  const roots = Object.fromEntries(ROLES.map((role) => [role, path.join(root, role)]));
  const actual = await inventory(roots);
  if (canonical(actual) !== canonical(manifest.identity.files)) {
    const expected = new Map(manifest.identity.files.map((file) => [file.path, canonical(file)]));
    const changed = actual.find((file) => expected.get(file.path) !== canonical(file));
    const missing = manifest.identity.files.find((file) => !actual.some((item) => item.path === file.path));
    throw failure((changed ?? missing)?.path.split("/")[0]);
  }
}
async function lease(store, id) {
  const dir = await directory(path.join(store, "leases"), { create: true });
  const file = path.join(dir, `${id}-${process.pid}-${randomUUID()}.json`);
  await writeFile(file, canonical({ id, pid: process.pid }), { flag: "wx", mode: 0o600 });
  return async () => { await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; }); };
}
async function verifyOwnedStage(root) {
  await directory(root);
  let count = 0;
  async function visit(dir) {
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name), stat = await lstat(file);
      if (++count > MAX_FILES + 4096 || stat.isSymbolicLink() || !within(root, await realpath(file))) throw failure("snapshot", "browser_snapshot_path_untrusted");
      if (stat.isDirectory()) await visit(file);
      else if (!stat.isFile()) throw failure("snapshot", "browser_snapshot_path_untrusted");
    }
  }
  await visit(root);
}
async function ownedJson(file, missing = null) {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === "ENOENT") return missing; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("snapshot", "browser_snapshot_path_untrusted");
  return JSON.parse(await readFile(file, "utf8"));
}
async function pruneLocked(store, { maxDelete = 2 } = {}) {
  if (!Number.isInteger(maxDelete) || maxDelete < 0 || maxDelete > 2) throw failure("snapshot", "browser_snapshot_cleanup_limit");
  const keep = new Set();
  const historyFile = path.join(store, "history.json");
  const history = await ownedJson(historyFile);
  // Without valid rollback ownership evidence, retain every generation.
  if (history === null) return { deleted: 0, stagesDeleted: 0 };
  if (!/^[a-f0-9]{64}$/.test(history.current ?? "") || (history.previous !== null && !/^[a-f0-9]{64}$/.test(history.previous ?? ""))) throw failure("snapshot", "browser_snapshot_cleanup_ownership_unknown");
  for (const id of [history.current, history.previous]) if (id) keep.add(id);
  const leaseDir = await directory(path.join(store, "leases"), { create: true });
  for (const name of await readdir(leaseDir)) {
    const file = path.join(leaseDir, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("snapshot", "browser_snapshot_path_untrusted");
    const item = JSON.parse(await readFile(file, "utf8"));
    if (!/^[a-f0-9]{64}$/.test(item.id ?? "") || !Number.isInteger(item.pid) || item.pid < 1 || !name.startsWith(`${item.id}-${item.pid}-`)) throw failure("snapshot", "browser_snapshot_cleanup_ownership_unknown");
    if (alive(item.pid)) keep.add(item.id); else await unlink(file);
  }
  let deleted = 0;
  for (const name of (await readdir(store)).sort()) {
    if (!/^[a-f0-9]{64}$/.test(name) || keep.has(name) || deleted >= maxDelete) continue;
    const root = path.join(store, name);
    if (!within(store, root) || path.dirname(root) !== store) throw failure("snapshot", "browser_snapshot_path_untrusted");
    await directory(root);
    const text = await readFile(path.join(root, "manifest.json"), "utf8");
    const manifest = JSON.parse(text);
    if (manifest.schema !== SCHEMA || digest(canonical(manifest.identity)) !== name) throw failure("snapshot");
    await verifyTree(root, manifest, digest(text));
    // Only complete owned, verified, unleased snapshots are deletion candidates.
    await rm(root, { recursive: true });
    deleted++;
  }
  let stagesDeleted = 0;
  for (const name of (await readdir(store)).sort()) {
    const match = name.match(/^\.staging-(\d+)-([a-f0-9-]{36})$/);
    if (!match || alive(Number(match[1])) || stagesDeleted >= maxDelete) continue;
    const root = path.join(store, name);
    if (path.dirname(root) !== store) throw failure("snapshot", "browser_snapshot_path_untrusted");
    await verifyOwnedStage(root);
    const receipt = JSON.parse(await readFile(path.join(root, "stage-owner.json"), "utf8"));
    if (receipt.schema !== SCHEMA || receipt.pid !== Number(match[1]) || receipt.token !== match[2]) throw failure("snapshot", "browser_snapshot_path_untrusted");
    await rm(root, { recursive: true });
    stagesDeleted++;
  }
  return { deleted, stagesDeleted };
}
export async function pruneBrowserSnapshots(store, options) {
  store = path.resolve(store);
  return locked(store, () => pruneLocked(store, options));
}
export async function createBrowserDependencySnapshot({ compatibility, nodeReplConfig, codexBin, store = defaultBrowserSnapshotStore(), prune = true } = {}) {
  store = path.resolve(store);
  const { roots, identity } = sourceBinding(compatibility, nodeReplConfig, codexBin);
  return locked(store, async () => {
    for (const role of ROLES) roots[role] = await realpath(await directory(roots[role]));
    identity.files = await inventory(roots);
    const client = identity.files.find((file) => file.path === identity.entrypoints.client);
    if (client?.sha256 !== compatibility.browserClientSha256) throw failure("chrome", "browser_snapshot_source_changed");
    for (const file of Object.values(identity.entrypoints)) if (!identity.files.some((entry) => entry.path === file)) throw failure("snapshot", "browser_snapshot_incomplete");
    const required = ["browser/docs/api.json", "browser/docs/browser-safety.md", "browser/scripts/browser-accessibility.wasm.br",
      "browser/scripts/zxing_reader.wasm", "browser/node_modules/classic-level.mjs", "node/node_modules/@oai/sky/package.json"];
    if (process.platform === "win32") required.push("codex/codex-command-runner.exe", "codex/codex-windows-sandbox-setup.exe", "codex/codex-code-mode-host.exe");
    for (const file of required) if (!identity.files.some((entry) => entry.path === file)) throw failure(file.split("/")[0], "browser_snapshot_incomplete");
    for (const role of ["chrome", "browser"]) {
      const manifest = JSON.parse(await readFile(path.join(roots[role], ".codex-plugin", "plugin.json"), "utf8"));
      if (manifest.name !== role || manifest.version !== identity.build) throw failure(role, "browser_snapshot_coherence_failed");
    }
    const id = digest(canonical(identity));
    const root = path.join(store, id);
    let reused = false;
    let manifest;
    let manifestText;
    try {
      await directory(root);
      const cachedManifest = await lstat(path.join(root, "manifest.json"));
      if (!cachedManifest.isFile() || cachedManifest.isSymbolicLink()) throw failure("snapshot", "browser_snapshot_path_untrusted");
      manifestText = await readFile(path.join(root, "manifest.json"), "utf8");
      manifest = JSON.parse(manifestText);
      if (manifest.schema !== SCHEMA || canonical(manifest.identity) !== canonical(identity)) throw failure("snapshot");
      await verifyTree(root, manifest, digest(manifestText));
      reused = true;
    } catch (error) {
      if (error.code !== "ENOENT" || await lstat(root).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) throw error;
      const token = randomUUID();
      const stage = path.join(store, `.staging-${process.pid}-${token}`);
      await directory(stage, { create: true });
      await writeFile(path.join(stage, "stage-owner.json"), canonical({ schema: SCHEMA, pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      for (const role of ROLES) await directory(path.join(stage, role), { create: true });
      for (const file of identity.files) {
        const [role, ...parts] = file.path.split("/");
        const from = path.join(roots[role], ...parts);
        const to = path.join(stage, role, ...parts);
        if (!(await lstat(from)).isFile() || !within(roots[role], await realpath(from))) throw failure(role, "browser_snapshot_source_changed");
        await directory(path.dirname(to), { create: true });
        await copyFile(from, to);
      }
      manifest = { schema: SCHEMA, id, createdAt: new Date().toISOString(), sourceRoots: roots, snapshotRoot: root, identity };
      manifestText = canonical(manifest) + "\n";
      await writeFile(path.join(stage, "manifest.json"), manifestText, { flag: "wx", mode: 0o600 });
      await verifyTree(stage, manifest, digest(manifestText));
      if (canonical(await inventory(roots)) !== canonical(identity.files)) throw failure("snapshot", "browser_snapshot_source_changed");
      await unlink(path.join(stage, "stage-owner.json"));
      await rename(stage, root);
    }
    const release = await lease(store, id);
    try {
      // Unrelated cleanup damage must not invalidate a complete verified binding. Retain anything uncertain.
      if (prune) await pruneLocked(store).catch(() => {});
      const at = (relative) => path.join(root, ...relative.split("/"));
      const config = structuredClone(nodeReplConfig);
      config.command = at(identity.entrypoints.nodeRepl);
      config.env.NODE_REPL_NODE_PATH = at(identity.entrypoints.node);
      config.env.NODE_REPL_NODE_MODULE_DIRS = identity.moduleDirs.map(at).join(path.delimiter);
      config.env.NODE_REPL_TRUSTED_CODE_PATHS = identity.trustedCodePaths.map(at).join(path.delimiter);
      config.env.CODEX_CLI_PATH = at(identity.entrypoints.codex);
      if (identity.cuaNodeRepl) config.env.CUA_REPL_NODE_REPL_PATH = at(identity.cuaNodeRepl);
      if (identity.wasm) config.env.BROWSER_USE_ACCESSIBILITY_CORE_WASM_PATH = at(identity.wasm);
      const resolved = {
        ...compatibility, chromePluginRoot: path.join(root, "chrome"), chromeSkillPath: compatibility.chromeSkillPath
          ? path.join(root, "chrome", path.relative(roots.chrome, compatibility.chromeSkillPath)) : null,
        browserClientPath: at(identity.entrypoints.client), browserServicePath: at(identity.entrypoints.service),
        chromeManifestPath: path.join(root, "chrome", ".codex-plugin", "plugin.json"), browserManifestPath: path.join(root, "browser", ".codex-plugin", "plugin.json"),
        snapshot: { id, root, manifestSha256: digest(manifestText) },
      };
      const trusted = JSON.stringify({ browser: resolved.browserServicePath.replaceAll("\\", "/"), sky: "@oai/sky/service" });
      resolved.overrides = [
        `mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION=${JSON.stringify(identity.build)}`,
        `mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES=${JSON.stringify(trusted)}`,
        `mcp_servers.node_repl.env.CODEX_CLI_PATH=${JSON.stringify(at(identity.entrypoints.codex))}`,
        `shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S=${JSON.stringify(client.sha256)}`,
      ];
      let ready = false;
      const markReady = async () => {
        if (ready) return;
        await locked(store, async () => {
          await verifyTree(root, manifest, digest(manifestText));
          const historyFile = path.join(store, "history.json");
          const prior = await ownedJson(historyFile);
          if (prior && (!/^[a-f0-9]{64}$/.test(prior.current ?? "") || (prior.previous !== null && !/^[a-f0-9]{64}$/.test(prior.previous ?? "")))) throw failure("snapshot", "browser_snapshot_cleanup_ownership_unknown");
          if (prior?.current !== id) await json(historyFile, { current: id, previous: prior?.current ?? null });
          ready = true;
        });
      };
      return { compatibility: resolved, nodeReplConfig: config, codexBin: at(identity.entrypoints.codex), release, markReady, reused };
    } catch (error) { await release(); throw error; }
  });
}
export async function verifyBrowserDependencySnapshot(binding) {
  try {
    const snapshot = binding.snapshot;
    if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot.id)) throw failure("snapshot");
    await directory(snapshot.root);
    const manifestStat = await lstat(path.join(snapshot.root, "manifest.json"));
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw failure("snapshot", "browser_snapshot_path_untrusted");
    const manifestText = await readFile(path.join(snapshot.root, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    if (digest(manifestText) !== snapshot.manifestSha256 || digest(canonical(manifest.identity)) !== snapshot.id) throw failure("snapshot");
    await verifyTree(snapshot.root, manifest, snapshot.manifestSha256);
    return binding;
  } catch (error) {
    return { status: "unavailable", reason: "browser_snapshot_integrity_failed", changedComponents: error.changedComponents ?? ["snapshot"], overrides: [] };
  }
}
