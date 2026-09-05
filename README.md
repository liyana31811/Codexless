<div align="center">

# Codexless

### ChatGPT just started doing Codex's work.

**Give ChatGPT the local Codex toolbox already on your computer — through a supported ChatGPT app/MCP connection.**

[中文](README.zh-CN.md)

![Technical Preview](https://img.shields.io/badge/status-technical_preview-6b7280)
![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows11&logoColor=white)
![Apple Silicon macOS](https://img.shields.io/badge/macOS-Apple_Silicon-111111?logo=apple&logoColor=white)
[![Apache-2.0 License](https://img.shields.io/badge/license-Apache--2.0-22c55e.svg)](LICENSE)

**Stay in ChatGPT. Work on your local machine. Bring in Codex only when you actually need it.**

</div>

Codexless lets the ChatGPT you already use call a reviewed set of local tools backed by the Codex environment on your machine. The default entry is ordinary Chat: inspect a project, edit files, run commands, work in Chrome or Edge, and control an already-connected Excel workbook without moving the whole task into another app.

When a task genuinely needs the Codex model, Codexless can call Codex explicitly. Ordinary supported local-tool actions do not call the Codex model and therefore do not create Codex model usage.

> Give this repository to the ChatGPT you already use and ask it to check your machine, explain the setup, and tell you which capabilities will be available.

---

## Codex and Codexless

### How much of the local toolbox is available?

| Capability family | Codex | Codexless 0.1.2 Preview |
| --- | :---: | :---: |
| Local files / Git / bounded terminal commands | ✅ | ✅ |
| Chrome / Edge Browser | ✅ | ✅ |
| Live Excel / Document Control | ✅ | ✅ |
| Skills / project rules | ✅ | ✅ Direct reuse |
| Windows Computer Use / CUA | ✅ | — Not public yet |

**✅ means the main user path for that capability family is available. It does not mean every internal Codex primitive is exposed 1:1.** Long-tail capabilities are promoted only after they have been reviewed and tested for the public surface.

### The workflow is different

| Workflow | Codex | Codexless |
| --- | --- | --- |
| Main entry | Codex App / CLI / Remote | **ChatGPT Chat on a supported surface** |
| Everyday workspace | Codex | **Your current Chat** |
| Local tool execution | Inside the Codex workflow | **Called directly from normal Chat** |
| Skills / project environment | Native | **Reuses the existing Codex environment** |
| When the Codex model is needed | Normal execution path | **Called explicitly when needed** |

**Codex: enter Codex to work.**

**Codexless: stay in normal Chat and use much of the local toolbox from there.**

Codexless is not trying to rebuild a second Codex. The point is to make useful local capabilities available from the ChatGPT conversation you already use.

---

## What can it do?

### Local project work

ChatGPT can inspect projects, read and edit files, run bounded commands, use Git and local CLIs, and verify results. Project rules and Codex Skills can be reused instead of maintaining a second set of instructions.

### Chrome and Edge Browser

The public Browser surface supports both **Chrome and Edge**:

- tab and page reads plus viewport screenshots;
- open, close, and navigation;
- semantic clicks and text entry;
- bounded scrolling and `Enter` / `Tab` / `Escape`;
- prepared uploads and downloads.

Browser work uses the selected local browser profile and its existing site login state. Local file upload additionally requires the ChatGPT browser extension's **Allow access to file URLs** setting.

Codexless does **not** expose arbitrary JavaScript, raw selectors, arbitrary coordinates, unrestricted keyboard input, generic CDP, or automatic Computer Use fallback on the public surface.

### Live Excel / Document Control

0.1.2 adds a bounded public Excel Preview for an already-connected workbook:

- `excel_status`
- `excel_read_sheets_metadata`
- `excel_read_ranges`
- `excel_search_workbook`
- `excel_write_range`
- `excel_format_range`

The broader dynamic Excel gateway remains internal for now. Public Excel does not expose generic Office scripting, a raw MCP executor, or the wider dynamic tool surface.

For writes and formatting, a successful dispatch is not automatically treated as business completion. Codexless keeps dispatch evidence and workbook verification distinct and avoids blind replay when a mutation result is uncertain.

### Call Codex when the model is actually needed

Before a metered Codex call, normal Chat shows a compact **text approval** with the task, model/reasoning information, current quota context, and an exact Task ID, then asks for **Yes / No**.

If approved, the task runs in the background. When it reaches a terminal state, Codexless returns a compact text Result with the outcome, mutation/verification evidence, any remaining blocker, quota context, and the same Task ID.

The underlying task binding remains single-use and replay-safe: a stale or already-consumed approval cannot be reused to start the task again.

---

## Before you install

- **Platforms:** Windows and **Apple Silicon macOS (`arm64`)** Technical Preview. Intel Mac is not supported yet.
- **Prerequisites:** **Node.js 22+** and one working local **Codex** installation. Codex Desktop is optional if a working CLI/runtime is available.
- **Recommended dual runtime:** Recommended setup can also prepare a pinned official Codex runtime as an independent path for supported file/command work. It does not replace your existing local Codex and uses an isolated login.
- **Browser:** Chrome or Edge plus the ChatGPT browser extension, connected in the profile you want to use.
- **Excel:** the workbook must already be connected through the supported Document Control / Excel Add-in path. Codexless does not use CUA as the normal public Excel path.
- **ChatGPT-side availability (as of this release):** OpenAI currently documents full write/modify custom MCP support for Business, Enterprise and Edu on ChatGPT web; Pro developer mode can connect read/fetch MCPs, and MCP apps are not currently available on mobile. Codexless is not currently a Plugin Directory listing. Check current OpenAI availability before installing because this surface changes independently of Codexless.
- **How local access works:** ChatGPT does not connect directly to `localhost`. A typical path is **local Codexless → authenticated Tunnel / remote MCP endpoint → a ChatGPT custom app / developer-mode MCP connection**.
- **Independent project:** Codexless is not an OpenAI product and does not imply OpenAI endorsement.

---

## Install

Use the source tree from the release/tag you want to install. The installer checks Node.js and your existing local Codex; it does not install Node/npm or replace that local Codex.

### Windows

```powershell
.\bin\codexless-install.cmd
```

Default install directory:

```text
%LOCALAPPDATA%\Codexless
```

Check a project:

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-doctor.cmd" --cwd "C:\path\to\your\project"
```

Start HTTP:

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-http.cmd"
```

Uninstall:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Codexless\scripts\uninstall.ps1"
```

### Apple Silicon macOS

```sh
sh ./bin/codexless-install.sh
```

Default install directory:

```text
~/Library/Application Support/Codexless/app
```

Check a project:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-doctor.sh" --cwd "/path/to/your/project"
```

Start HTTP:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-http.sh"
```

Uninstall:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-uninstall.sh"
```

To upgrade or reinstall, get the newer release/tag and run the same installer again. User state stored outside the install tree is preserved. Codexless does not silently widen Codex trust, configure your Tunnel, or change browser file permissions for you.

---

## FAQ

### Does Codexless consume Codex quota?

Supported model-free local tool actions do not call the Codex model, so they do not create Codex model usage. When Codexless actually calls the Codex model, normal Codex usage rules apply.

Codexless does **not** increase, reset, transfer, merge, or bypass Codex usage limits or plan rules.

### What if Codex quota reaches 0%?

Model-free capabilities can continue to work. Operations that actually require a Codex model call cannot run until the applicable Codex usage is available again.

### How much local access does it get?

The permission ceiling follows effective local Codex authorization. Codexless may downscope an operation further; a remote caller cannot silently select a stronger local permission profile. Real permission/trust denials fail visibly. See [`SECURITY.md`](SECURITY.md).

### Does ChatGPT get everything Codex can do?

No. The **0.1.2 public contract is 44 tools**, selected and tested as a public surface. Internal or household-only capabilities are not automatically promoted.

### Do I need to change my existing ChatGPT → Codex workflow?

No. Keep planning and discussing work in ChatGPT, let normal Chat use the local tools when they are enough, and call Codex explicitly when the model is genuinely needed.

### Why can ChatGPT reach my local machine at all?

ChatGPT receives only the Codexless tools exposed through an authenticated MCP path, for example:

> **local Codexless → authenticated Tunnel / remote MCP endpoint → ChatGPT custom app / developer-mode MCP connection**

Do not put Tunnel or endpoint credentials in the repository or public screenshots.

---

## For people who want the internals

- The exact public service contract is fixed in `src/surface-contracts.mjs` and covered by public contract tests.
- The 0.1.2 public surface contains **44 tools**. Call Codex uses fixed-text Approval / Result in normal Chat; neutral `agent_commit(taskId)` / `agent_decline(taskId)` remain part of the authoritative task path.
- Public Excel contains the six typed tools listed above. The schema-reader and dynamic Excel gateway remain household-only in this release.
- Browser exposes reviewed user-intent actions rather than raw browser internals.
- Codex remains the local permission/trust authority; Codexless can downscope but not silently widen it.
- Codexless uses Codex App Server and ChatGPT app/MCP integration surfaces rather than reverse-engineering a private UI.

Run the public contract:

```sh
npm test
```

Run from source:

```sh
npm ci
npm run start:stdio
```

HTTP:

```sh
npm run start:http
```

If automatic discovery cannot find an accepted Codex executable, `CODEX_BIN` can be set explicitly. On Windows, do not point it at an npm `.cmd` / `.ps1` shim.

---

## For AI assistants

If a user sends you this repository and asks whether they need it or whether it is safe, inspect the actual repository and the current machine first.

Start with these facts: Codexless exposes a reviewed subset of local capabilities; it does not increase or bypass Codex usage; the permission ceiling comes from effective local Codex authorization; Browser is bounded rather than raw control; Excel public access is a six-tool typed Preview; and Codexless is an independent project rather than an OpenAI product.

---

> **Stay in ChatGPT. Work on your local machine. Bring in Codex when you actually need it.**
