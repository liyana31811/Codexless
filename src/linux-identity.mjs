import os from "node:os";
import path from "node:path";

// A service/MCP identity is independent of the ChatGPT plugin id and Tunnel id.
// Keep the upstream identity on its existing platforms.
export function codexlessIdentity({ env = process.env, platform = process.platform } = {}) {
  const name = env.CODEXLESS_SERVER_NAME?.trim() || (platform === "linux" ? "codexless-linux" : "codexless");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || (platform === "linux" && name !== "codexless-linux")) {
    throw new Error("Linux service identity must be codexless-linux; service names must contain only letters, numbers, hyphens or underscores");
  }
  return { name, title: name === "codexless-linux" ? "Codexless Linux" : "Codexless" };
}

export function codexlessPaths({ env = process.env, platform = process.platform, home = platform === "linux" ? env.HOME || os.homedir() : os.homedir() } = {}) {
  const legacyRoot = path.join(home, ".config", "codexless");
  if (platform !== "linux") {
    return { config: legacyRoot, data: legacyRoot, state: absoluteOverride(env.CODEXLESS_STATE_ROOT) || legacyRoot };
  }
  return {
    config: path.join(absoluteOverride(env.XDG_CONFIG_HOME) || path.join(home, ".config"), "codexless-linux"),
    data: path.join(absoluteOverride(env.XDG_DATA_HOME) || path.join(home, ".local", "share"), "codexless-linux"),
    state: absoluteOverride(env.CODEXLESS_STATE_ROOT) || path.join(absoluteOverride(env.XDG_STATE_HOME) || path.join(home, ".local", "state"), "codexless-linux"),
  };
}

function absoluteOverride(value) {
  // XDG explicitly requires absolute paths; ignore relative environment values.
  return typeof value === "string" && value.trim() && path.isAbsolute(value.trim()) ? path.resolve(value.trim()) : null;
}
