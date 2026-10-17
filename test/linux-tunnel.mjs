import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedTunnelEnv, tunnelPaths, validateTunnelId, loopbackUrl, KEY_ENV } from "../scripts/linux-tunnel.mjs";

test("Linux profile ignores unrelated global OpenAI and tunnel overrides", () => {
  const env = isolatedTunnelEnv({
    HOME: "/home/test", PATH: "/usr/bin", CODEX_BIN: "/usr/bin/codex", CODEX_HOME: "/original-codex-home",
    [KEY_ENV]: "test-key-that-is-never-printed", OPENAI_API_KEY: "unrelated-key",
    OPENAI_ADMIN_KEY: "unrelated-admin", CONTROL_PLANE_TUNNEL_ID: "windows-id",
    TUNNEL_CLIENT_CONFIG: "/windows/config", MCP_SERVER_URL: "https://unrelated.invalid",
    HEALTH_LISTEN_ADDR: "0.0.0.0:8080", LOG_HTTP_RAW_UNSAFE: "true", ALLOW_REMOTE_UI: "true",
  });
  assert.equal(env[KEY_ENV], "test-key-that-is-never-printed");
  assert.equal(env.CODEX_BIN, "/usr/bin/codex");
  assert.equal(path.resolve(env.CODEX_HOME), "/home/test/.local/state/codexless-linux/codex-home");
  for (const key of ["OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "CONTROL_PLANE_TUNNEL_ID", "TUNNEL_CLIENT_CONFIG", "MCP_SERVER_URL", "HEALTH_LISTEN_ADDR", "LOG_HTTP_RAW_UNSAFE", "ALLOW_REMOTE_UI"]) {
    assert.equal(env[key], undefined, key);
  }
});

test("only loopback plaintext MCP and health URLs can be selected", () => {
  for (const value of ["http://127.0.0.1:7691/mcp", "http://[::1]:8080/", "http://localhost:8080/"]) assert.ok(loopbackUrl(value));
  for (const value of ["http://0.0.0.0:8080", "https://example.com/mcp", "http://127.0.0.1.example.com", "http://user:pass@127.0.0.1", "file:///tmp/health", "http://127.0.0.1/?key=secret"]) assert.throws(() => loopbackUrl(value));
});

test("independent XDG paths and complete official tunnel IDs", () => {
  const paths = tunnelPaths({ XDG_CONFIG_HOME: "/tmp/cfg", XDG_DATA_HOME: "/tmp/data", XDG_STATE_HOME: "/tmp/state" }, "/tmp/user");
  assert.equal(paths.profile, "/tmp/cfg/codexless-linux/tunnel/profiles/codexless-linux.yaml");
  assert.equal(paths.client, "/tmp/data/codexless-linux/tunnel-client/current/tunnel-client");
  assert.equal(paths.healthUrl, "/tmp/state/codexless-linux/tunnel/health-url");
  assert.equal(tunnelPaths({ XDG_CONFIG_HOME: "relative" }, "/tmp/user").config, "/tmp/user/.config/codexless-linux/tunnel/profiles");
  assert.equal(validateTunnelId("tunnel_" + "a".repeat(32)), "tunnel_" + "a".repeat(32));
  assert.ok(validateTunnelId("tunnel_ab12_" + "a".repeat(32)));
  for (const value of ["tunnel_abc", "windows", "tunnel_" + "A".repeat(32), "tunnel_" + "a".repeat(31)]) assert.throws(() => validateTunnelId(value));
});

test("readiness alone does not report observed tool discovery", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codexless-linux-tunnel-health-"));
  let discovery = false;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/health/mcp"
      ? { state: discovery ? "discovered" : "not_observed", details: { tools_list: { ok: discovery, complete: discovery } } }
      : { ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fs.writeFile(path.join(temporary, "health-url"), `http://127.0.0.1:${server.address().port}`);
    const runStatus = async () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/linux-tunnel.mjs", import.meta.url)), "status", "--state-dir", temporary], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      const [code] = await once(child, "close");
      return { code, value: JSON.parse(output) };
    };
    const unobserved = await runStatus();
    assert.equal(unobserved.code, 3);
    assert.equal(unobserved.value.toolDiscoveryVerified, false);
    discovery = true;
    const discovered = await runStatus();
    assert.equal(discovered.code, 0);
    assert.equal(discovered.value.toolDiscoveryVerified, true);
    assert.match(discovered.value.chatgptEndToEnd, /requires a real ChatGPT tool call/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

const officialClient = process.env.CODEXLESS_TEST_TUNNEL_CLIENT;
test("official Linux client creates an isolated profile without credentials; repeat leaves it unchanged", { skip: !officialClient }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codexless-linux-tunnel-test-"));
  try {
    const script = fileURLToPath(new URL("../scripts/linux-tunnel.mjs", import.meta.url));
    const profileDir = path.join(temporary, "profiles");
    const args = [script, "init", "--client", officialClient, "--profile-dir", profileDir,
      "--tunnel-id", "tunnel_" + "0".repeat(32), "--mcp-command", "/usr/bin/printf no-network-test"];
    const env = isolatedTunnelEnv({ ...process.env, HOME: temporary });
    delete env[KEY_ENV];
    const initialized = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(initialized.status, 0, initialized.stderr);
    const profile = path.join(profileDir, "codexless-linux.yaml");
    const before = await fs.readFile(profile, "utf8");
    assert.ok(before.includes(`env:${KEY_ENV}`));
    assert.equal((await fs.stat(profile)).mode & 0o777, 0o600);
    const repeated = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /already exists; left unchanged/);
    assert.equal(await fs.readFile(profile, "utf8"), before);
    const doctor = spawnSync(process.execPath, [script, "doctor", "--client", officialClient, "--profile-dir", profileDir], { env, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(doctor.status, 0);
    assert.match(doctor.stderr, /Enter the restricted runtime key/);
    await fs.chmod(profile, 0o644);
    const exposedProfile = spawnSync(process.execPath, [script, "doctor", "--client", officialClient, "--profile-dir", profileDir], {
      env: { ...env, [KEY_ENV]: "local-test-not-a-real-key" }, encoding: "utf8", timeout: 10_000,
    });
    assert.notEqual(exposedProfile.status, 0);
    assert.match(exposedProfile.stderr, /chmod 600/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
