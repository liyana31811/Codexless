import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export class CodexExecutableResolutionError extends Error {
  constructor(message, { checked = [] } = {}) {
    super(message);
    this.name = "CodexExecutableResolutionError";
    this.code = "CODEX_EXECUTABLE_NOT_FOUND";
    this.checked = checked;
  }
}

export async function resolveCodexExecutable({ env = process.env } = {}) {
  const checked = [];
  const explicit = env.CODEX_BIN?.trim();
  if (explicit) {
    checked.push("CODEX_BIN");
    const normalized = process.platform === "win32"
      ? await normalizeWindowsCandidate(explicit, { source: "CODEX_BIN", checked })
      : await normalizePosixCandidate(explicit, { source: "CODEX_BIN" });
    if (normalized) {
      const probe = await probeCodexExecutable(normalized.path).catch(() => null);
      if (probe?.ok && probe.version) return { ...normalized, version: probe.version };
    }
    throw new CodexExecutableResolutionError(
      process.platform === "win32"
        ? "CODEX_BIN does not resolve to a directly launchable Codex executable with a readable codex-cli version. Point it at codex.exe rather than an npm shim."
        : "CODEX_BIN does not resolve to an executable Codex binary with a readable codex-cli version.",
      { checked }
    );
  }

  const candidates = process.platform === "win32"
    ? await windowsCodexCandidates(env)
    : await posixCodexCandidates(env);
  const selected = await newestUsableCodexCandidate(candidates, checked);
  if (selected) return selected;

  throw new CodexExecutableResolutionError(
    "No usable Codex CLI/runtime could be resolved. Codexless requires a working Codex CLI/runtime with App Server; Codex Desktop is optional. Automatic discovery checks known standalone/current installs, Codex Desktop/ChatGPT bundled runtimes when present, native Codex on PATH, and npm-installed Codex. Set CODEX_BIN only when you intentionally want to override automatic selection.",
    { checked }
  );
}

export async function probeCodexExecutable(target, { cwd = process.cwd(), timeoutMs = 10_000 } = {}) {
  await access(target, process.platform === "linux" ? constants.X_OK : constants.F_OK);
  const result = spawnSync(target, ["--version"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0 && Boolean(text),
    status: result.status,
    versionText: text || null,
    version: parseCodexVersion(text),
    error: result.error?.message ?? null,
  };
}

export function parseCodexVersion(text) {
  return String(text ?? "").match(/codex-cli\s+([^\s]+)/i)?.[1] ?? null;
}

export function redactHomePath(value) {
  if (typeof value !== "string" || !value) return value ?? null;
  const home = os.homedir();
  if (!home) return value;
  const normalizedValue = path.resolve(value);
  const normalizedHome = path.resolve(home);
  const comparableValue = process.platform === "win32" ? normalizedValue.toLowerCase() : normalizedValue;
  const comparableHome = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;
  const homeToken = process.platform === "win32" ? "%USERPROFILE%" : "$HOME";
  if (comparableValue === comparableHome) return homeToken;
  if (comparableValue.startsWith(`${comparableHome}${path.sep}`)) return `${homeToken}${normalizedValue.slice(normalizedHome.length)}`;
  return normalizedValue;
}

export function compareCodexVersions(left, right) {
  const a = parseComparableVersion(left);
  const b = parseComparableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.pre.length && b.pre.length) return 1;
  if (a.pre.length && !b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.pre.length) return -1;
    if (index >= b.pre.length) return 1;
    const av = a.pre[index];
    const bv = b.pre[index];
    if (av === bv) continue;
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) return an - bn;
    if (an !== null) return -1;
    if (bn !== null) return 1;
    return av.localeCompare(bv);
  }
  return 0;
}

async function windowsCodexCandidates(env) {
  const candidates = [];
  const desktopCliPath = env.CODEX_CLI_PATH?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();
  const appData = env.APPDATA?.trim();

  if (desktopCliPath) {
    candidates.push({ path: desktopCliPath, source: "CODEX_CLI_PATH", label: "CODEX_CLI_PATH" });
  }
  if (localAppData) {
    candidates.push({
      path: path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      source: "codex-desktop-programs",
      label: "LOCALAPPDATA:Programs/OpenAI/Codex",
    });
    const runtimeRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    for (const candidate of await childCodexExecutables(runtimeRoot)) {
      candidates.push({ path: candidate, source: "codex-desktop-runtime-cache", label: "LOCALAPPDATA:OpenAI/Codex/bin" });
    }
    candidates.push({
      path: path.join(runtimeRoot, "codex.exe"),
      source: "codex-desktop-runtime-cache",
      label: "LOCALAPPDATA:OpenAI/Codex/bin",
    });
  }
  if (userProfile) {
    candidates.push({
      path: path.join(userProfile, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
      source: "codex-standalone-current",
      label: "USERPROFILE:.codex/standalone/current",
    });
  }
  for (const candidate of whereAll("codex.exe")) {
    candidates.push({ path: candidate, source: "PATH", label: "PATH:codex.exe" });
  }
  for (const candidate of whereAll("codex")) {
    candidates.push({
      path: candidate,
      source: "PATH",
      label: `PATH:${path.extname(candidate).toLowerCase() || "bare"}`,
    });
  }
  if (appData) {
    const packageRoot = path.join(appData, "npm", "node_modules", "@openai", "codex");
    const native = await findNativeCodexUnderPackage(packageRoot);
    if (native) {
      candidates.push({ path: native, source: "npm-global-package", label: "APPDATA:npm-package" });
    }
  }
  return candidates;
}

async function posixCodexCandidates(env) {
  const candidates = [];
  const cliPath = env.CODEX_CLI_PATH?.trim();
  if (cliPath) candidates.push({ path: cliPath, source: "CODEX_CLI_PATH", label: "CODEX_CLI_PATH" });

  const home = env.HOME?.trim() || os.homedir();
  if (home) {
    candidates.push({
      path: path.join(home, ".codex", "packages", "standalone", "current", "bin", "codex"),
      source: "codex-standalone-current",
      label: "HOME:.codex/standalone/current",
    });
  }
  if (process.platform === "darwin") {
    candidates.push({
      path: "/Applications/ChatGPT.app/Contents/Resources/codex",
      source: "chatgpt-app-bundled",
      label: "ChatGPT.app:bundled-codex",
    });
  }
  const found = process.platform === "linux" ? await findPosixExecutable("codex", env) : whichFirst("codex");
  if (found) candidates.push({ path: found, source: "PATH", label: "PATH:codex" });
  return candidates;
}

async function newestUsableCodexCandidate(candidates, checked) {
  const valid = [];
  const seen = new Set();
  for (const candidate of candidates) {
    checked.push(candidate.label);
    const normalized = process.platform === "win32"
      ? await normalizeWindowsCandidate(candidate.path, { source: candidate.source, checked })
      : await normalizePosixCandidate(candidate.path, { source: candidate.source });
    if (!normalized) continue;

    const comparablePath = process.platform === "win32"
      ? path.resolve(normalized.path).toLowerCase()
      : path.resolve(normalized.path);
    if (seen.has(comparablePath)) continue;
    seen.add(comparablePath);

    const probe = await probeCodexExecutable(normalized.path).catch(() => null);
    if (!probe?.ok || !probe.version) {
      checked.push(`${candidate.source}:unprobeable-version`);
      continue;
    }
    valid.push({ ...normalized, version: probe.version });
  }
  valid.sort((a, b) => compareCodexVersions(b.version, a.version));
  return valid[0] ?? null;
}

async function normalizePosixCandidate(candidate, { source }) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const resolved = path.resolve(candidate.trim());
  try { await access(resolved); } catch { return null; }
  const probe = await probeCodexExecutable(resolved).catch(() => null);
  return probe?.ok ? { path: resolved, source, version: probe.version } : null;
}

async function normalizeWindowsCandidate(candidate, { source, checked }) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const resolved = path.resolve(candidate.trim());
  try { await access(resolved); } catch { return null; }
  const extension = path.extname(resolved).toLowerCase();
  if (WINDOWS_NATIVE_EXTENSIONS.has(extension)) return { path: resolved, source };
  if (WINDOWS_SHIM_EXTENSIONS.has(extension) || !extension) {
    const packageRoot = inferNpmCodexPackageRoot(resolved);
    if (packageRoot) {
      checked.push("npm-shim:native-package");
      const native = await findNativeCodexUnderPackage(packageRoot);
      if (native) return { path: native, source: `${source}-npm-native` };
    }
  }
  return null;
}

function inferNpmCodexPackageRoot(candidate) {
  const basename = path.basename(candidate).toLowerCase();
  if (!["codex", "codex.cmd", "codex.ps1", "codex.bat"].includes(basename)) return null;
  return path.join(path.dirname(candidate), "node_modules", "@openai", "codex");
}

async function findNativeCodexUnderPackage(packageRoot) {
  try { await access(packageRoot); } catch { return null; }
  for (const candidate of buildDirectNpmNativeCandidates(packageRoot)) {
    try { await access(candidate); return path.resolve(candidate); } catch {}
  }
  try {
    const entries = await readdir(packageRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.toLowerCase() !== "codex.exe") continue;
      const parent = entry.parentPath ?? entry.path;
      const candidate = path.join(parent, entry.name);
      if (candidate.toLowerCase().includes(`${path.sep}vendor${path.sep}`)) return path.resolve(candidate);
    }
  } catch {}
  return null;
}

function buildDirectNpmNativeCandidates(packageRoot) {
  const platformPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const roots = [
    path.join(packageRoot, "node_modules", "@openai", platformPackage),
    path.join(path.dirname(packageRoot), platformPackage),
  ];
  return roots.flatMap((root) => [
    path.join(root, "vendor", triple, "codex", "codex.exe"),
    path.join(root, "vendor", triple, "bin", "codex.exe"),
    path.join(root, "vendor", triple, "codex.exe"),
  ]);
}

async function childCodexExecutables(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "codex.exe"));
  } catch {
    return [];
  }
}

function whereAll(name) {
  const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 3_000 });
  if (result.status !== 0) return [];
  return String(result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

// macOS retains its accepted discovery behavior; Linux does not require `which`.
function whichFirst(name) {
  const result = spawnSync("which", [name], { encoding: "utf8", timeout: 3_000 });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
}

export async function findPosixExecutable(name, env = process.env) {
  if (typeof name !== "string" || !name || name.includes("/")) return null;
  for (const entry of String(env.PATH ?? "").split(path.delimiter)) {
    // Ignore implicit current-directory PATH entries for a remote bridge.
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function parseComparableVersion(version) {
  const [coreText, ...rest] = String(version ?? "0.0.0").split("-");
  const core = coreText.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  while (core.length < 3) core.push(0);
  const pre = rest.join("-").split(".").filter(Boolean);
  return { core, pre };
}
