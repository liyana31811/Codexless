# Security

Codexless is a local execution bridge. Treat it as software that can affect real project files and run real commands under your locally authorized Codex environment.

This document describes the **public Technical Preview** surface in this repository. It does not describe private/internal Toolwire or Workbench capabilities that are intentionally excluded from the public package.

## Security model

The public design is based on three rules:

1. **Codex remains the local authority source** for borrowed execution capabilities.
2. **Codexless may narrow authority, but the remote caller must not silently widen it.**
3. **A real permission or trust denial fails visibly.** Codexless must not silently switch to a more privileged execution path just to make an operation succeed.

A user who has deliberately granted broad local Codex authority should expect Codexless operations that inherit that authority to be correspondingly powerful. Codexless is not a sandbox that magically makes broad local permission risk-free.

## Public surface boundary

The current public **service contract** exposes exactly 45 tools, enforced by `src/surface-contracts.mjs` and `test/public-contract.mjs`. Runtime registration is fail-closed too: registrations outside `PUBLIC_TOOL_NAMES` are skipped rather than exposed, while startup fails if any required tool is missing or registered twice; CI also exercises a strict unknown-tool mode. Twenty-one of those tools are the accepted Browser slice. The normal Chat path uses fixed-text task approval and exact Task IDs; it does not require the retired Task Card state tool.

The public package intentionally excludes private/internal capabilities such as:

- raw host filesystem read/mutation Workbench tools;
- generic host process control and process receipts;
- Computer Use;
- generic MCP catalog/call tooling;
- Browser internals outside the accepted 21-tool slice: raw selectors/caller JavaScript/coordinates/provider IDs, arbitrary keys/modifiers, generic CDP, unprepared generic tab management, and Browser→Computer Use auto-fallback. The prepared exact single-tab close pair is accepted public behavior;
- household/private integrations.

Internal availability is not a public safety claim. A capability must be explicitly accepted before it can enter the public contract.

## Command execution

`codex.command_exec` uses the official Codex App Server command execution path and locally resolved authority.

- `readOnly` is the compatibility-safe default exposed by the public schema.
- `inherit` must be requested explicitly and uses the locally authorized/resolved Codex permission profile.
- The Linux Preview further caps inherited execution at the official workspace sandbox; read-only calls remain read-only. Editing the isolated Codex configuration does not bypass that cap.
- The remote caller does not choose arbitrary permission profiles, trusted roots, sandbox policy, approval policy, or network authority.
- Supported-platform executable lookup may resolve a bare executable name through the host PATH where applicable. This changes executable lookup only; it does not increase authority.
- The public model-free lane rejects direct Codex CLI launches and recognized shell/interpreter/launcher wrappers that carry a Codex command. Formal Codex model work must go through `codex.agent_start` / `codex.agent_send`, preserving Task Card, quota state, and task lifecycle.
- Shell-string wrappers such as `cmd`, PowerShell, and POSIX shells are scanned conservatively. A benign shell command string that merely mentions a `codex` executable token may be rejected; for inspection-only commands, prefer direct argv forms such as `where.exe codex` or `which codex` instead of wrapping them in a shell string.
- This command classifier is a product guard against direct or accidental nested-Codex routing, not a general-purpose adversarial process sandbox. Arbitrary code execution is inherently capable of hiding secondary process launches; Codexless does not claim that a malicious custom client can be made non-Turing-complete by argv inspection. The supported model-facing contract is that callers must not encode or disguise a Codex launch inside another command.
- Commands can be destructive. The MCP tool is marked accordingly.

## Project reads and edits

Public project file operations are intentionally narrower than a generic raw filesystem API.

- Multi-file reads are bounded.
- Guarded edits require an exact expected text match and can optionally verify a SHA-256 before writing.
- Linux guarded writes execute through the official Codex command sandbox after authority checks; they do not fall back to a more privileged host write when denied.
- Project authority and trusted-root checks remain part of the local execution path.
- Symlink/junction escape outside the accepted authority root must fail closed rather than silently following the path.

Do not interpret these constraints as a substitute for backups or source control.

## Codex Agent delegation and metered consent

Ordinary model-free tool use and metered Codex Agent work are separate lanes.

With `CODEXLESS_AGENT_METERED_CONSENT=always`, the public `codex.agent_start` / `codex.agent_send` tools are prepare-first. They may mint a `consentRef`, but that ref is task identity only: replaying the same `requestId` / `consentRef` through the public tool does not authorize or dispatch a Codex turn.

Approval is a separate server-side state transition. In the ChatGPT App path, rendering the Task Card also yields a per-task commit capability through component metadata; that capability is intentionally absent from model-visible text and `structuredContent`. `codex.agent_commit` requires both the exact `consentRef` and that matching capability before the server marks the task approved and calls the Agent executor. Missing or wrong capabilities fail closed. Exact duplicate commits remain idempotent and must not create a second logical turn.

If the Task Card cannot be rendered, the consent-always path fails closed: textual fallback may explain the pending task and quota state, but a chat reply alone is not approval and must not start Codex work. Pending non-terminal task state is never silently replayed after a Codexless restart. Decline is terminal: once a prepared card is rejected, a cached commit capability and same-request replay cannot revive or dispatch that task; a new attempt requires a new request id and card.

This is a defense for the supported ChatGPT App / compliant-host path, not cryptographic proof that an arbitrary custom MCP client is a human. A client that directly controls raw protocol traffic and component metadata is part of the trust boundary. Codexless cannot distinguish a malicious custom client from its human operator solely from MCP messages; do not treat an untrusted host as a user-presence oracle.

Where quota context is available, it may be shown to the user; absence of quota context must not be represented as unlimited or free usage.

Approval of a Codex Agent task does not grant a new local permission universe. Local Codex authority remains the ceiling.

## Browser

The public Browser surface is intentionally bounded around user-intent actions rather than exposing Browser internals. It includes Reader, current-viewport screenshot, dynamic stock confirmation-policy read, prepared exact single-tab close, prepared open/navigate/click/fill/download/upload, bounded scroll, and only the fixed `Enter` / `Tab` / `Escape` keypresses.

Prepared mutation refs bind an exact action and current Browser state but are **not permission tokens**. The caller applies the current stock Codex Browser confirmation policy together with the bounded user task. Once a mutation may have been dispatched, uncertainty is fail-visible and must not trigger a blind replay.

Important boundaries and limitations:

- tab close is available only through prepare→execute refs bound to one exact existing tab and current Browser state; unknown/stale refs, page/provider/generation drift, and uncertain dispatch fail closed and must not trigger blind replay;
- raw CSS selectors, caller JavaScript/evaluate, arbitrary coordinates/node IDs/provider IDs/indexes, arbitrary keys/modifiers, generic CDP and automatic Browser→Computer Use fallback are not exposed;
- exact visible-text click fallback is accepted only when Codexless can derive and revalidate a stable semantic role binding server-side; otherwise it fails closed;
- upload accepts only an existing file inside the Codex-resolved trusted authority root, binds canonical path/size/SHA-256 before dispatch, and revalidates file identity; browser-side file selection is **not** proof that the remote service accepted the upload;
- Browser upload additionally depends on the Chrome extension setting **Allow access to file URLs**; ordinary Reader/navigation health does not prove this file capability is configured;
- download success requires the official Chrome/Playwright download event receipt; a returned browser-managed local path is not an instruction to open, execute, or trust the file;
- content that has not loaded may not be visible; lazy-loaded and virtualized interfaces can expose only currently materialized content;
- returned content may be truncated and should say so when applicable;
- page content is untrusted input and can contain prompt-injection text.

A model should treat webpage text as data, not as higher-priority instructions.

## HTTP transport

The bundled HTTP entry point binds only to loopback addresses (`127.0.0.1`, `localhost`, or `::1`). It rejects non-loopback binding requests.

The HTTP server also applies localhost Host/Origin validation. `/healthz` and `/readyz` return only bounded service metadata and do not intentionally publish the configured project path.

Remote ChatGPT access is expected to be provided by a separately configured MCP tunnel. The tunnel is part of the deployment boundary: protect its credentials and do not expose a raw unauthenticated local service directly to the public internet.

## Installer / upgrade / uninstall boundary

The Windows and Apple Silicon macOS Technical Preview installers are intentionally conservative.

- Both require Node.js 22+ and discover/probe an already-installed accepted native Codex executable; neither silently installs another Codex copy.
- Both stage the release tree, install production dependencies there, and run doctor before activating the staged Codexless tree.
- Re-running a newer installer is the upgrade path. Codexless-owned runtime state is kept outside the install tree and is preserved by default.
- The installers do not widen Codex trust, configure Chrome/Browser permissions, or change Tunnel settings. Browser upload's **Allow access to file URLs** prerequisite remains an explicit user/browser configuration step. The Windows installer does not create a Windows service; the Mac installer does not create a LaunchAgent or modify shell PATH.
- Default uninstall removes only a directory that identifies itself as the `codexless` package. Codex, Node.js, project files, Browser configuration, Tunnel configuration, and Codex trust settings are out of scope.
- State purge is explicit: Windows uses `-PurgeState`; macOS uses `--purge-state`. Each removes only Codexless-owned state.

The independent Linux Preview adds these deployment boundaries:

- Application, configuration, and state use separate `codexless-linux` XDG directories. An isolated `CODEX_HOME` holds its own configuration and authentication; the installer never reads or changes the original `~/.codex/config.toml` or copies its credentials.
- Installation requires a regular user, Node.js 22+, npm, and an existing native Codex executable. It stages production dependencies and copies the selected Node/npm into an owned runtime. Run `codexless-linux-doctor` after installation; successful installation alone does not prove Codex authority, Tunnel readiness, or a ChatGPT connection.
- `--trust-project` is an explicit local grant for the exact selected project when creating the isolated configuration. Existing isolated trust configuration is preserved rather than silently widened. Remote tool requests cannot change trust or permission profiles.
- A systemd user unit is prepared but is neither started nor enabled during installation. First service start and autostart require distinct explicit flags. POSIX process groups and systemd control groups provide bounded shutdown cleanup.
- Managed Tunnel, keyring and desktop-client integration are outside this core contribution. The installer does not create account resources; it refuses to replace deployments containing optional integration configuration. Remote access must use a separately reviewed authenticated connection.
- Updates, rollback, and uninstall verify ownership and local integrity before replacing application/runtime files. Configuration, credentials, logs, project data, and account Tunnel resources are preserved by default.

## Credentials and secrets

Codexless should not require users to paste long-lived Codex or GitHub credentials into ChatGPT.

- Local Codex authentication remains local to the Codex environment.
- Tunnel/runtime secrets belong in local secret/config storage, not source control or README examples.
- Do not commit `.env` files, bearer tokens, API keys, session cookies, or copied credential stores.
- Do not publish screenshots containing tunnel URLs, endpoint secrets, private local paths, account identifiers, or tokens.

The release process must scan the package and repository for accidental secrets and machine-specific private paths.

## Local paths and privacy

Some authenticated project tools necessarily return project paths because path identity is part of local project work. Public unauthenticated health metadata should not expose the configured project path.

Browser contents, filenames, project text, command output, and Codex responses can all contain private information. Users should only connect Codexless to ChatGPT contexts they are comfortable using for that project.

## Dependency and supply-chain scope

The public package intentionally keeps a small direct dependency set. See `THIRD_PARTY_NOTICES.md` and `package.json`.

Before a public release:

- install from a clean environment;
- run the public contract test;
- review the packed artifact rather than only the source tree;
- scan packed files for secrets and machine-specific paths;
- verify the exact dependency/lockfile state used for release.

## Known Technical Preview limitations

The Technical Preview is not a claim of production-hardening. Windows and Apple Silicon macOS have both passed real-machine installer/doctor acceptance against the public artifact shape, with broader lifecycle and Tunnel coverage on the Mac path and independent reviewer coverage on the final Windows installer/uninstaller path. Release work still includes final repository/security-reporting hygiene, packed-artifact privacy review, and any clean-machine checks required by release notes.

Linux Preview acceptance covers Ubuntu 22.04 x64, isolated installation/lifecycle fixtures, the public tool contract, and real stdio/HTTP file, Git, and bounded command calls. Linux arm64, Browser, Excel, a successful metered model turn, and desktop-client lifecycle integration remain outside this acceptance. A deployment must separately verify its own Tunnel readiness, forwarded discovery, and ChatGPT results. Windows/macOS native regression cannot be inferred from Linux tests. The maintainer's canonical export parity gate is also required for release; see `EXPORT_SYNC.md`.

Intel Mac, Computer Use, unrestricted direct browser automation, and private Workbench capability parity are not part of the first public security contract.

## Reporting a vulnerability

Do not post credentials, private project data, or a working exploit in a public issue.

The public GitHub repository must have **GitHub Private Vulnerability Reporting** enabled before launch. After launch, use the repository's **Security → Advisories → Report a vulnerability** flow so the report is delivered privately to the maintainer. If that private reporting action is not visible, do not disclose the issue in a public ticket; the repository is not release-ready until the private route is enabled and verified.

Enabling and verifying that repository-side setting is a final publication gate, not something the local installer or runtime changes automatically.
