#!/usr/bin/env node
// Isolated configuration and lifecycle wrapper around the official OpenAI client.
// This does not create an account tunnel, register a plugin, or change Codex settings.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PROFILE = "codexless-linux";
export const KEY_ENV = "CODEXLESS_LINUX_TUNNEL_API_KEY";

export function tunnelPaths(env = process.env, home = os.homedir()) {
  const xdg = (name, fallback) => env[name] && path.isAbsolute(env[name]) ? env[name] : path.join(home, fallback);
  const config = path.join(xdg("XDG_CONFIG_HOME", ".config"), PROFILE, "tunnel", "profiles");
  const state = path.join(xdg("XDG_STATE_HOME", ".local/state"), PROFILE, "tunnel");
  const clientDir = path.join(xdg("XDG_DATA_HOME", ".local/share"), PROFILE, "tunnel-client");
  return {
    config, state, clientDir, codexHome: path.join(state, "..", "codex-home"),
    profile: path.join(config, `${PROFILE}.yaml`),
    client: path.join(clientDir, "current", "tunnel-client"),
    healthUrl: path.join(state, "health-url"),
    pid: path.join(state, "tunnel.pid"),
  };
}

// Remove ambient tunnel/config/credential overrides. A Windows or unrelated
// profile, OPENAI_API_KEY, MCP target, or raw-HTTP logging setting cannot win.
export function isolatedTunnelEnv(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) =>
    !/^(TUNNEL_CLIENT_|CONTROL_PLANE_|MCP_|HEALTH_|HARPOON_|CLOUDFLARED_|ADMIN_UI_|LOG_)/.test(name)
    && !["OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPEN_WEB_UI", "ALLOW_REMOTE_UI", "PID_FILE"].includes(name)
  ));
  env.CODEX_HOME = tunnelPaths(source, source.HOME || os.homedir()).codexHome;
  return env;
}

export function validateTunnelId(value) {
  if (!/^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/.test(value ?? "")) {
    throw new Error("Use the complete NEW Ubuntu tunnel ID returned by Platform; expected tunnel_<32 lowercase letters/digits> or tunnel_<4 lowercase letters/digits>_<32 lowercase letters/digits>.");
  }
  return value;
}

export function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) {
    throw new Error("Only a plain loopback HTTP URL is allowed.");
  }
  return url;
}

async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Private directory must be an owned real directory: ${dir}`);
  }
  await fs.chmod(dir, 0o700);
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function parseArgs(argv) {
  const action = argv.shift() ?? "info";
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--client", "--client-dir", "--profile-dir", "--state-dir", "--tunnel-id", "--mcp-command", "--mcp-server-url"].includes(argv[i]) || !argv[i + 1]) {
      throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    }
    if (options[argv[i]]) throw new Error(`Duplicate option: ${argv[i]}`);
    options[argv[i]] = argv[i + 1];
  }
  return { action, options };
}

function resolvedPaths(options) {
  const defaults = tunnelPaths();
  const config = path.resolve(options["--profile-dir"] ?? defaults.config);
  const state = path.resolve(options["--state-dir"] ?? defaults.state);
  const clientDir = path.resolve(options["--client-dir"] ?? defaults.clientDir);
  return {
    ...defaults, config, state, clientDir, codexHome: path.resolve(state, "..", "codex-home"),
    client: path.resolve(options["--client"] ?? path.join(clientDir, "current", "tunnel-client")),
    profile: path.join(config, `${PROFILE}.yaml`),
    healthUrl: path.join(state, "health-url"), pid: path.join(state, "tunnel.pid"),
  };
}

export async function invokeClient(client, args, env = isolatedTunnelEnv()) {
  return await new Promise((resolve, reject) => {
    const child = spawn(client, args, { stdio: "inherit", env, shell: false });
    const handlers = ["SIGINT", "SIGTERM"].map(signal => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    const cleanup = () => handlers.forEach(([signal, handler]) => process.removeListener(signal, handler));
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal === "SIGINT" ? 130 : 143)); });
  });
}

async function fetchChecked(url, kind = "json") {
  // curl follows the host's HTTPS_PROXY/CA settings consistently. --disable
  // prevents an unrelated user curlrc from adding auth or logging options.
  const data = await new Promise((resolve, reject) => {
    const child = spawn("curl", ["--disable", "--fail", "--silent", "--show-error", "--location",
      "--max-time", "120", "--max-filesize", "262144000", "--proto", "=https", "--proto-redir", "=https",
      "--user-agent", PROFILE, url], { env: isolatedTunnelEnv(), stdio: ["ignore", "pipe", "ignore"], shell: false });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 250 * 1024 * 1024) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    child.once("error", () => reject(new Error("Official download requires curl on PATH.")));
    child.once("exit", code => code === 0 && bytes <= 250 * 1024 * 1024
      ? resolve(Buffer.concat(chunks)) : reject(new Error("Official HTTPS download failed; check outbound access, proxy/CA, and GitHub rate limits. No credentials were requested.")));
  });
  if (kind === "json") return JSON.parse(data.toString("utf8"));
  if (kind === "text") return data.toString("utf8");
  return data;
}

async function prepareClient(paths) {
  if (process.platform !== "linux") throw new Error("Official Linux client installation requires Linux.");
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!arch) throw new Error(`No supported official build selected for ${process.arch}.`);
  const metadata = await fetchChecked("https://api.github.com/repos/openai/tunnel-client/releases/latest");
  if (!/^v\d+\.\d+\.\d+$/.test(metadata.tag_name)) throw new Error("Unexpected official release tag.");
  const filename = `tunnel-client-${metadata.tag_name}-linux-${arch}.zip`;
  const asset = metadata.assets.find(item => item.name === filename);
  const sums = metadata.assets.find(item => item.name === "SHA256SUMS.txt");
  const prefix = `https://github.com/openai/tunnel-client/releases/download/${metadata.tag_name}/`;
  if (!asset || !sums || asset.browser_download_url !== prefix + filename || sums.browser_download_url !== prefix + "SHA256SUMS.txt") {
    throw new Error("Official release is missing the expected archive/checksums.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) throw new Error("Official release metadata has no valid SHA256 digest.");
  const checksumText = await fetchChecked(sums.browser_download_url, "text");
  const expected = asset.digest.slice(7);
  const checksumLine = checksumText.split(/\r?\n/).find(line => line.trim().endsWith(filename));
  if (!checksumLine || checksumLine.trim().split(/\s+/)[0] !== expected) throw new Error("Official checksum sources disagree.");
  await privateDir(paths.clientDir);
  const target = path.join(paths.clientDir, metadata.tag_name);
  const current = path.join(paths.clientDir, "current");
  if (await exists(current) && !(await fs.lstat(current)).isSymbolicLink()) throw new Error("Refusing to replace a non-symlink client/current.");
  if (await exists(target)) {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing a non-directory or symlinked version installation.");
    const record = JSON.parse(await fs.readFile(path.join(target, "verified-release.json"), "utf8"));
    const binaryDigest = createHash("sha256").update(await fs.readFile(path.join(target, "tunnel-client"))).digest("hex");
    const companionDigest = createHash("sha256").update(await fs.readFile(path.join(target, "cloudflared"))).digest("hex");
    if (record.archiveSha256 !== expected || record.binarySha256 !== binaryDigest || record.companionSha256 !== companionDigest) throw new Error("Existing client verification differs; inspect it before reinstalling.");
  } else {
    const data = await fetchChecked(asset.browser_download_url, "buffer");
    if (createHash("sha256").update(data).digest("hex") !== expected) throw new Error("Downloaded archive SHA256 mismatch.");
    const temporary = await fs.mkdtemp(path.join(paths.clientDir, ".download-"));
    try {
      const archive = path.join(temporary, "release.zip");
      const extracted = path.join(temporary, "release");
      await fs.writeFile(archive, data, { mode: 0o600 });
      const python = spawnSync("python3", ["-c", [
        "import sys,zipfile,pathlib,stat",
        "out=pathlib.Path(sys.argv[2]);out.mkdir(mode=0o700)",
        "with zipfile.ZipFile(sys.argv[1]) as z:",
        " if sum(i.file_size for i in z.infolist()) > 250*1024*1024: raise ValueError('Oversized release archive')",
        " for i in z.infolist():",
        "  if '/' in i.filename or '\\\\' in i.filename or i.filename in ('','.','..') or stat.S_ISLNK(i.external_attr >> 16): raise ValueError('Unsafe release archive member')",
        "  if i.file_size > 250*1024*1024: raise ValueError('Oversized release archive member')",
        " z.extractall(out)",
      ].join("\n"), archive, extracted], { encoding: "utf8", timeout: 30_000 });
      if (python.error || python.status !== 0) throw new Error("Safe archive extraction failed; Python 3 is required.");
      for (const filename of ["tunnel-client", "cloudflared"]) await fs.chmod(path.join(extracted, filename), 0o700);
      const binaryDigest = createHash("sha256").update(await fs.readFile(path.join(extracted, "tunnel-client"))).digest("hex");
      const companionDigest = createHash("sha256").update(await fs.readFile(path.join(extracted, "cloudflared"))).digest("hex");
      await fs.writeFile(path.join(extracted, "verified-release.json"), JSON.stringify({
        version: metadata.tag_name, archive: filename, archiveSha256: expected, binarySha256: binaryDigest, companionSha256: companionDigest,
        source: asset.browser_download_url, verifiedAt: new Date().toISOString(),
      }, null, 2) + "\n", { mode: 0o600 });
      await fs.rename(extracted, target);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  const temporaryLink = path.join(paths.clientDir, `.current-${process.pid}`);
  await fs.symlink(metadata.tag_name, temporaryLink);
  await fs.rename(temporaryLink, current);
  console.log(JSON.stringify({ installed: true, client: path.join(current, "tunnel-client"), version: metadata.tag_name, archiveSha256: expected }));
  return 0;
}

async function initialize(paths, options) {
  validateTunnelId(options["--tunnel-id"]);
  const command = options["--mcp-command"];
  const serverUrl = options["--mcp-server-url"];
  if (!!command === !!serverUrl) throw new Error("Supply exactly one --mcp-command or --mcp-server-url.");
  if (serverUrl) loopbackUrl(serverUrl);
  if (command && /[\r\n\0]/.test(command)) throw new Error("The stdio command must be a single line.");
  await privateDir(paths.config);
  if (await exists(paths.profile)) throw new Error(`Profile already exists; left unchanged: ${paths.profile}. Inspect it locally before choosing a different Tunnel.`);
  const args = ["init", "--profile", PROFILE, "--profile-dir", paths.config,
    "--tunnel-id", options["--tunnel-id"], "--control-plane-api-key-ref", `env:${KEY_ENV}`,
    "--health-listen-addr", "127.0.0.1:0",
    "--sample", command ? "sample_mcp_stdio_local" : "sample_mcp_remote_no_auth",
    command ? "--mcp-command" : "--mcp-server-url", command ?? serverUrl];
  const result = await invokeClient(paths.client, args, { ...isolatedTunnelEnv(), CODEX_HOME: paths.codexHome });
  if (result === 0) await fs.chmod(paths.profile, 0o600);
  return result;
}

async function inspectStatus(paths) {
  let base;
  try { base = loopbackUrl((await fs.readFile(paths.healthUrl, "utf8")).trim()); }
  catch (error) { throw new Error(`No usable private health URL; client has not started or its run ended (${error.code ?? error.message}).`); }
  const result = {};
  for (const [name, route] of [["health", "/healthz"], ["readiness", "/readyz"], ["mcp", "/health/mcp"]]) {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(3_000), redirect: "error" });
    const text = await response.text();
    let details;
    try { details = JSON.parse(text); } catch { details = text.slice(0, 256); }
    result[name] = { ok: response.ok, status: response.status, details };
  }
  const toolsList = result.mcp.details?.details?.tools_list;
  const toolDiscoveryVerified = result.mcp.ok && toolsList?.ok === true && toolsList?.complete === true;
  console.log(JSON.stringify({ profile: PROFILE, url: base.origin, toolDiscoveryVerified,
    chatgptEndToEnd: "requires a real ChatGPT tool call", ...result }, null, 2));
  if (!result.health.ok || !result.readiness.ok) return 2;
  return toolDiscoveryVerified ? 0 : 3;
}

export async function main(argv = process.argv.slice(2)) {
  const { action, options } = parseArgs([...argv]);
  const paths = resolvedPaths(options);
  if (["info", "help", "--help"].includes(action)) {
    console.log(JSON.stringify({ profile: PROFILE, keyEnvironment: KEY_ENV, paths,
      commands: ["prepare-client", "init --tunnel-id NEW_UBUNTU_ID --mcp-command /absolute/path/codexless-linux-stdio", "doctor", "run", "status"],
      note: "run is foreground only. No account Tunnel, plugin registration, service installation, autostart or Codex setting is created by this wrapper." }, null, 2));
    return 0;
  }
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Run as a regular Linux user, without sudo.");
  if (action === "prepare-client") return prepareClient(paths);
  if (action === "init") return initialize(paths, options);
  if (action === "status") return inspectStatus(paths);
  if (!["doctor", "run"].includes(action)) throw new Error(`Unknown action: ${action}`);
  const env = isolatedTunnelEnv();
  env.CODEX_HOME = paths.codexHome;
  if (!env[KEY_ENV]) throw new Error(`Enter the restricted runtime key in the local terminal as ${KEY_ENV}; no key was read from Codex or global OpenAI settings.`);
  const profileStat = await fs.lstat(paths.profile);
  if (!profileStat.isFile() || profileStat.isSymbolicLink() || profileStat.uid !== process.getuid() || (profileStat.mode & 0o077) !== 0) {
    throw new Error("Linux Tunnel profile must be an owned regular file with no group/other permissions (chmod 600).");
  }
  const args = [action, "--profile", PROFILE, "--profile-dir", paths.config,
    "--control-plane.api-key", `env:${KEY_ENV}`, "--health.listen-addr", "127.0.0.1:0",
    "--log.level", "info", "--log.http-raw-unsafe=false", "--allow-remote-ui=false", "--open-web-ui=false"];
  if (action === "doctor") args.push("--explain");
  else {
    await privateDir(paths.state);
    args.push("--health.url-file", paths.healthUrl, "--pid.file", paths.pid);
  }
  return invokeClient(paths.client, args, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`codexless-linux tunnel: ${error.message}`); process.exitCode = 1; });
}
