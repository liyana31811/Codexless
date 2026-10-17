import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const RELEASE_MANIFEST_VERSION = 1;
export const RELEASE_MANIFEST_RELATIVE_PATH = "config/release-manifest.json";
export const RELEASE_PRODUCT_ID = "codexless";
export const RELEASE_BUILD_ID_ALGORITHM = "sha256-release-identity-v1";
export const RELEASE_FILE_HASH_ALGORITHM = "sha256-raw-file-v1";

// Mirrors the source tree staged by scripts/install.ps1 and scripts/install.sh.
// The frozen lockfile is selected separately: npm-shrinkwrap.json wins over package-lock.json.
export const RELEASE_TREE_ENTRIES = Object.freeze([
  "src",
  "config",
  "scripts",
  "skills",
  "bin",
  "package.json",
  "README.md",
  "README.zh-CN.md",
  "README.linux.md",
  "README.linux-tunnel.zh-CN.md",
  "SECURITY.md",
  "EXPORT_SYNC.md",
  "THIRD_PARTY_NOTICES.md",
  "LICENSE",
]);

export const RELEASE_STATE_COMPATIBILITY = Object.freeze({
  migration: "none",
  stores: Object.freeze({
    "recent-calls": Object.freeze({ schemaVersion: 1 }),
    "agent-task-cards": Object.freeze({ schemaVersion: 1 }),
  }),
});

export async function buildReleaseManifest({
  root,
  serverVersion,
  hostContractVersion,
  sourceRevision = null,
} = {}) {
  const releaseRoot = requireRoot(root);
  const packageJson = JSON.parse(await readFile(path.join(releaseRoot, "package.json"), "utf8"));
  if (packageJson?.name !== RELEASE_PRODUCT_ID) {
    throw new Error(`release package name must be ${RELEASE_PRODUCT_ID}`);
  }
  const version = requireString(packageJson?.version, "package.json.version");
  assertReleaseVersionConsistency({ packageVersion: version, serverVersion });
  const normalizedHostContractVersion = requireString(hostContractVersion, "hostContractVersion");
  const normalizedSourceRevision = normalizeSourceRevision(sourceRevision);
  const stateCompatibility = cloneStateCompatibility();
  const files = await collectReleaseFiles(releaseRoot);
  const identity = {
    manifestVersion: RELEASE_MANIFEST_VERSION,
    productId: RELEASE_PRODUCT_ID,
    version,
    buildIdAlgorithm: RELEASE_BUILD_ID_ALGORITHM,
    fileHashAlgorithm: RELEASE_FILE_HASH_ALGORITHM,
    sourceRevision: normalizedSourceRevision,
    hostContractVersion: normalizedHostContractVersion,
    stateCompatibility,
  };
  const buildId = computeReleaseBuildId({ ...identity, files });

  return {
    ...identity,
    buildId,
    files,
  };
}

export async function collectReleaseFiles(root, { entries = RELEASE_TREE_ENTRIES } = {}) {
  const releaseRoot = requireRoot(root);
  if (!Array.isArray(entries) || !entries.length) throw new Error("release entries must be a non-empty array");
  const selectedEntries = [...entries];
  selectedEntries.push(await selectFrozenLockfile(releaseRoot));

  const files = [];
  for (const entry of selectedEntries) {
    const relative = normalizeReleasePath(entry);
    await collectPath(releaseRoot, relative, files);
  }
  files.sort(compareReleaseFiles);
  assertUniquePaths(files);
  return files;
}

export function hashReleaseFileBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return sha256(bytes);
}

export function computeReleaseBuildId({
  productId = RELEASE_PRODUCT_ID,
  manifestVersion = RELEASE_MANIFEST_VERSION,
  version,
  sourceRevision = null,
  hostContractVersion,
  stateCompatibility = RELEASE_STATE_COMPATIBILITY,
  buildIdAlgorithm = RELEASE_BUILD_ID_ALGORITHM,
  fileHashAlgorithm = RELEASE_FILE_HASH_ALGORITHM,
  files,
} = {}) {
  if (productId !== RELEASE_PRODUCT_ID) throw new Error(`release build productId must be ${RELEASE_PRODUCT_ID}`);
  if (manifestVersion !== RELEASE_MANIFEST_VERSION) throw new Error(`unsupported release manifest version ${String(manifestVersion)}`);
  const normalizedVersion = requireString(version, "release build version");
  const normalizedSourceRevision = normalizeSourceRevision(sourceRevision);
  const normalizedHostContractVersion = requireString(hostContractVersion, "release build hostContractVersion");
  const normalizedStateCompatibility = normalizeStateCompatibility(stateCompatibility);
  if (buildIdAlgorithm !== RELEASE_BUILD_ID_ALGORITHM) throw new Error(`unsupported buildId algorithm ${String(buildIdAlgorithm)}`);
  if (fileHashAlgorithm !== RELEASE_FILE_HASH_ALGORITHM) throw new Error(`unsupported file hash algorithm ${String(fileHashAlgorithm)}`);
  if (!Array.isArray(files)) throw new Error("release files must be an array");
  const canonicalFiles = files.map((entry) => {
    const releasePath = normalizeReleasePath(entry?.path);
    const digest = requireSha256(entry?.sha256, `sha256 for ${releasePath}`);
    return { path: releasePath, sha256: digest };
  }).sort(compareReleaseFiles);
  assertUniquePaths(canonicalFiles);

  const preimage = JSON.stringify({
    productId: RELEASE_PRODUCT_ID,
    manifestVersion: RELEASE_MANIFEST_VERSION,
    version: normalizedVersion,
    sourceRevision: normalizedSourceRevision,
    hostContractVersion: normalizedHostContractVersion,
    stateCompatibility: normalizedStateCompatibility,
    buildIdAlgorithm: RELEASE_BUILD_ID_ALGORITHM,
    fileHashAlgorithm: RELEASE_FILE_HASH_ALGORITHM,
    files: canonicalFiles.map(({ path: releasePath, sha256: digest }) => [releasePath, digest]),
  });
  return sha256(Buffer.from(`${preimage}\n`, "utf8"));
}

export async function readReleaseManifest(root) {
  const releaseRoot = requireRoot(root);
  const target = path.join(releaseRoot, ...RELEASE_MANIFEST_RELATIVE_PATH.split("/"));
  const parsed = JSON.parse(await readFile(target, "utf8"));
  return validateReleaseManifest(parsed);
}

export async function readReleaseIdentity(root) {
  const manifest = await readReleaseManifest(root);
  return {
    productId: manifest.productId,
    version: manifest.version,
    buildId: manifest.buildId,
    sourceRevision: manifest.sourceRevision,
    hostContractVersion: manifest.hostContractVersion,
    stateCompatibility: structuredClone(manifest.stateCompatibility),
  };
}

export function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("release manifest must be an object");
  if (manifest.manifestVersion !== RELEASE_MANIFEST_VERSION) throw new Error(`unsupported release manifest version ${String(manifest.manifestVersion)}`);
  if (manifest.productId !== RELEASE_PRODUCT_ID) throw new Error(`release manifest productId must be ${RELEASE_PRODUCT_ID}`);
  requireString(manifest.version, "release manifest version");
  requireSha256(manifest.buildId, "release manifest buildId");
  if (manifest.buildIdAlgorithm !== RELEASE_BUILD_ID_ALGORITHM) throw new Error(`unsupported buildId algorithm ${String(manifest.buildIdAlgorithm)}`);
  if (manifest.fileHashAlgorithm !== RELEASE_FILE_HASH_ALGORITHM) throw new Error(`unsupported file hash algorithm ${String(manifest.fileHashAlgorithm)}`);
  if (manifest.sourceRevision !== null) requireString(manifest.sourceRevision, "release manifest sourceRevision");
  const normalizedHostContractVersion = requireString(manifest.hostContractVersion, "release manifest hostContractVersion");
  const normalizedStateCompatibility = normalizeStateCompatibility(manifest.stateCompatibility);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("release manifest files must be a non-empty array");
  const normalizedFiles = manifest.files.map((entry) => ({
    path: normalizeReleasePath(entry?.path),
    sha256: requireSha256(entry?.sha256, `sha256 for ${String(entry?.path ?? "unknown")}`),
  })).sort(compareReleaseFiles);
  assertUniquePaths(normalizedFiles);
  if (normalizedFiles.some((entry) => entry.path === RELEASE_MANIFEST_RELATIVE_PATH)) {
    throw new Error("release manifest must not hash itself");
  }
  const recomputedBuildId = computeReleaseBuildId({
    productId: manifest.productId,
    manifestVersion: manifest.manifestVersion,
    version: manifest.version,
    sourceRevision: manifest.sourceRevision,
    hostContractVersion: normalizedHostContractVersion,
    stateCompatibility: normalizedStateCompatibility,
    buildIdAlgorithm: manifest.buildIdAlgorithm,
    fileHashAlgorithm: manifest.fileHashAlgorithm,
    files: normalizedFiles,
  });
  if (recomputedBuildId !== manifest.buildId) {
    throw new Error("release manifest buildId does not match its identity metadata and file manifest");
  }
  return {
    ...structuredClone(manifest),
    hostContractVersion: normalizedHostContractVersion,
    stateCompatibility: normalizedStateCompatibility,
    files: normalizedFiles,
  };
}

export function assertReleaseVersionConsistency({ packageVersion, serverVersion } = {}) {
  const packageValue = requireString(packageVersion, "packageVersion");
  const serverValue = requireString(serverVersion, "serverVersion");
  if (packageValue !== serverValue) {
    throw new Error(`release version mismatch: package.json=${packageValue}, PUBLIC_SERVER_VERSION=${serverValue}`);
  }
  return packageValue;
}

export function serializeReleaseManifest(manifest) {
  const validated = validateReleaseManifest(manifest);
  const { files, ...identity } = validated;
  const base = JSON.stringify({ ...identity, files: [] }, null, 2);
  const fileLines = files.map(({ path: releasePath, sha256: digest }) =>
    `    { "path": ${JSON.stringify(releasePath)}, "sha256": ${JSON.stringify(digest)} }`
  );
  return `${base.replace('  "files": []\n}', `  "files": [\n${fileLines.join(",\n")}\n  ]\n}`)}\n`;
}

async function collectPath(root, relativePath, files) {
  if (relativePath === RELEASE_MANIFEST_RELATIVE_PATH) return;
  const absolute = path.join(root, ...relativePath.split("/"));
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`release tree may not contain symbolic links: ${relativePath}`);
  if (info.isFile()) {
    files.push({ path: relativePath, sha256: hashReleaseFileBytes(await readFile(absolute)) });
    return;
  }
  if (!info.isDirectory()) throw new Error(`unsupported release tree entry type: ${relativePath}`);

  const children = await readdir(absolute, { withFileTypes: true });
  children.sort((left, right) => compareStrings(left.name, right.name));
  for (const child of children) {
    const childRelative = normalizeReleasePath(`${relativePath}/${child.name}`);
    if (childRelative === RELEASE_MANIFEST_RELATIVE_PATH) continue;
    if (child.isSymbolicLink()) throw new Error(`release tree may not contain symbolic links: ${childRelative}`);
    if (child.isDirectory()) await collectPath(root, childRelative, files);
    else if (child.isFile()) files.push({ path: childRelative, sha256: hashReleaseFileBytes(await readFile(path.join(absolute, child.name))) });
    else throw new Error(`unsupported release tree entry type: ${childRelative}`);
  }
}

async function selectFrozenLockfile(root) {
  for (const candidate of ["npm-shrinkwrap.json", "package-lock.json"]) {
    try {
      const info = await lstat(path.join(root, candidate));
      if (info.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("release source is missing a frozen npm lockfile: npm-shrinkwrap.json or package-lock.json");
}

function normalizeStateCompatibility(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("stateCompatibility must be an object");
  if (value.migration !== "none") throw new Error("stateCompatibility migration must be none for this release contract");
  const recentCalls = value.stores?.["recent-calls"];
  const agentTaskCards = value.stores?.["agent-task-cards"];
  if (recentCalls?.schemaVersion !== 1) throw new Error("recent-calls state compatibility must be schema v1");
  if (agentTaskCards?.schemaVersion !== 1) throw new Error("agent-task-cards state compatibility must be schema v1");
  return {
    migration: "none",
    stores: {
      "recent-calls": { schemaVersion: 1 },
      "agent-task-cards": { schemaVersion: 1 },
    },
  };
}

function cloneStateCompatibility() {
  return {
    migration: RELEASE_STATE_COMPATIBILITY.migration,
    stores: {
      "recent-calls": { ...RELEASE_STATE_COMPATIBILITY.stores["recent-calls"] },
      "agent-task-cards": { ...RELEASE_STATE_COMPATIBILITY.stores["agent-task-cards"] },
    },
  };
}

function normalizeSourceRevision(value) {
  if (value === null || value === undefined) return null;
  return requireString(value, "sourceRevision");
}

function normalizeReleasePath(value) {
  const text = requireString(value, "release path").replace(/\\/g, "/").normalize("NFC");
  const normalized = path.posix.normalize(text);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`invalid release path: ${text}`);
  }
  return normalized;
}

function requireRoot(root) {
  return path.resolve(requireString(root, "release root"));
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requireSha256(value, label) {
  const text = requireString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  return text;
}

function compareReleaseFiles(left, right) {
  return compareStrings(left.path, right.path);
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertUniquePaths(files) {
  let previous = null;
  for (const entry of files) {
    if (entry.path === previous) throw new Error(`duplicate release file path: ${entry.path}`);
    previous = entry.path;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
