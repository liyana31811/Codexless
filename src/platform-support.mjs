export function codexlessPlatformSupport({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) {
    return { status: "supported", platform, arch, product: `Linux ${arch}`, scope: "core-files-git-terminal-codex" };
  }
  if (platform === "win32" && arch === "x64") {
    return { status: "supported", platform, arch, product: "Windows x64" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { status: "supported", platform, arch, product: "Apple Silicon macOS arm64" };
  }
  if (platform === "win32" && arch === "arm64") {
    return {
      status: "unsupported",
      platform,
      arch,
      product: "Windows ARM64",
      reason: "Windows ARM64 has no accepted Codexless artifact/install/Browser acceptance evidence; win32 runtime branches must not be treated as a support claim.",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      status: "unsupported",
      platform,
      arch,
      product: "Intel macOS x64",
      reason: "Intel macOS is outside the current Codexless public support contract; only Apple Silicon macOS arm64 is accepted.",
    };
  }
  return {
    status: "unsupported",
    platform,
    arch,
    product: `${platform}/${arch}`,
    reason: `Codexless does not publish or accept this platform/architecture: ${platform}/${arch}.`,
  };
}
