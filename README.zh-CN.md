<div align="center">

# Codexless

### ChatGPT 开始干 Codex 的活了。

**让你的 ChatGPT 通过当前支持的 ChatGPT app / MCP 接入，用上你本机已经有的 Codex 工具箱。**

[English](README.md)

![Technical Preview](https://img.shields.io/badge/status-technical_preview-6b7280)
![Windows](https://img.shields.io/badge/Windows-supported-0078D4?logo=windows11&logoColor=white)
![Apple Silicon macOS](https://img.shields.io/badge/macOS-Apple_Silicon-111111?logo=apple&logoColor=white)
[![Apache-2.0 License](https://img.shields.io/badge/license-Apache--2.0-22c55e.svg)](LICENSE)

**留在 ChatGPT。活落在本机。真需要 Codex 时，再调用 Codex。**

</div>

Codexless 让你正在使用的 ChatGPT 调用一组经过验收的本地工具，底层直接复用这台电脑已有的 Codex 环境。默认入口就是普通 Chat：看项目、改文件、跑命令、操作 Chrome / Edge、控制已经连接的 Excel 工作簿，都可以在当前对话继续完成。

真正需要 Codex 模型时，再明确调用 Codex。普通已支持的本地工具动作不会调用 Codex 模型，因此不会产生 Codex 模型用量；真正调用 Codex 时，正常使用规则照常适用。

> 可以直接把这个仓库交给你正在用的 ChatGPT，让它检查当前机器、解释安装条件，并告诉你安装后能用哪些能力。

---

## Codex 和 Codexless，到底差在哪？

### Codex 的核心本地能力，Codexless 已经覆盖多少？

| 能力 | Codex | Codexless 0.1.2 Preview |
| --- | :---: | :---: |
| 本地文件 / Git / 有界 Terminal 命令 | ✅ | ✅ |
| Chrome / Edge Browser | ✅ | ✅ |
| Live Excel / Document Control | ✅ | ✅ |
| Skills / 项目规则 | ✅ | ✅ 直接复用 |
| Windows Computer Use / CUA | ✅ | — 暂未公开 |

**✅ 表示该能力族的主要用户路径已经可用，不表示 Codex 的所有内部 primitive 都以 1:1 形式公开。** 长尾能力只有在完成公开面验收后才会加入。

### 工作方式也不一样

| 工作方式 | Codex | Codexless |
| --- | --- | --- |
| 主要入口 | Codex App / CLI / Remote | **当前支持界面中的 ChatGPT 普通 Chat** |
| 日常工作面 | Codex | **当前普通 Chat** |
| 本地工具执行 | Codex 工作流内 | **从普通 Chat 直接调用** |
| Skills / 项目环境 | 原生使用 | **直接复用现有 Codex 环境** |
| 需要 Codex 模型时 | 正常执行路径 | **明确需要时再调用** |

**Codex：进入 Codex 工作。**

**Codexless：留在普通 Chat，也能使用大部分本地工具。**

Codexless 的重点不是重做一套 Codex，而是让这些本地能力也能从普通 Chat 使用。

---

## 它能做什么？

### 本地项目工作

ChatGPT 可以看项目、读写文件、运行受控命令、使用 Git 和本地 CLI，再自己检查结果。项目规则和 Codex Skills 能复用的就直接复用，不需要维护第二套说明。

### Chrome + Edge Browser

当前公开 Browser 同时支持 **Chrome 和 Edge**：

- 查看标签页、页面内容和 viewport 截图；
- 打开、关闭、跳转页面；
- 语义点击和文本填写；
- 有界滚动，以及 `Enter` / `Tab` / `Escape`；
- prepared 上传和下载。

Browser 使用你选择的本地浏览器 profile 和其中已有的网站登录状态。上传本地文件还需要在 ChatGPT 浏览器扩展中打开 **“允许访问文件网址”**。

公开面不提供任意 JavaScript、raw selector、任意坐标、任意键盘、generic CDP，也不会自动用 Computer Use 兜底。

### Live Excel / Document Control

0.1.2 加入一组面向**已经连接的工作簿**的公开 Excel Preview：

- `excel_status`
- `excel_read_sheets_metadata`
- `excel_read_ranges`
- `excel_search_workbook`
- `excel_write_range`
- `excel_format_range`

更完整的动态 Excel 工具入口目前仍只在内部使用。公开版不提供 generic Office scripting、raw MCP executor，也不会把整套动态 Excel 工具直接暴露出来。

写入和格式修改里，“dispatch 成功”不会自动冒充业务完成。Codexless 会区分调用回执和 workbook verification；结果不确定时不会盲目重放写动作。

### 真需要 Codex 时，再调用 Codex

真正准备调用 Codex 前，普通 Chat 会显示一段紧凑的**固定文字审批**，明确列出任务、模型 / reasoning、当前 quota 信息和 exact Task ID，然后由你回答 **Yes / No**。

确认后任务在后台执行；进入 terminal 状态后，再返回固定文字 Result，包含结果、mutation / verification 证据、剩余 blocker、quota 信息和同一个 Task ID。

底层任务绑定仍是 single-use / no-replay：过期或已经消费过的审批不能拿来重新启动同一任务。

---

## 安装前先确认

- **平台：** Windows + **Apple Silicon macOS（arm64）** Technical Preview。Intel Mac 暂不支持。
- **前提：** 本机已有 **Node.js 22+** 和一套可工作的 **Codex**。Codex Desktop 不是必须项，有可用 CLI/runtime 即可。
- **Recommended 双路径：** 可以额外准备一套固定版本的官方 Codex runtime，用于已经支持的文件 / 命令工作；它不会替换本机 Codex，登录状态也相互隔离。
- **Browser：** 本机需要 Chrome 或 Edge，以及已连接的 ChatGPT 浏览器扩展。
- **Excel：** 工作簿需要先通过受支持的 Document Control / Excel Add-in 路径连接。公开 Excel 正常路径不依赖 CUA。
- **ChatGPT 侧可用性（以本版本发布时为准）：** OpenAI 当前文档将具备写入 / 修改能力的完整自定义 MCP 支持列在 ChatGPT 网页版的 Business、Enterprise 和 Edu；Pro 的 developer mode 自定义 MCP 目前仅支持 read/fetch，MCP apps 当前也不支持移动端。Codexless 目前不是 Plugin Directory 中的公开条目。安装前请再确认 OpenAI 当时的套餐与界面支持，因为这一层会独立于 Codexless 变化。
- **本地怎么连：** ChatGPT 不直接访问 `localhost`。典型链路是 **本机 Codexless → 已认证 Tunnel / remote MCP endpoint → ChatGPT custom app / developer-mode MCP 接入**。
- **身份：** Codexless 是独立项目，不是 OpenAI 产品，也不代表 OpenAI 背书。

---

## 安装

从你准备安装的 release/tag 获取源码。installer 会检查 Node.js 和已有本机 Codex；它不会替你安装 Node/npm，也不会替换本机 Codex。

### Windows

```powershell
.\bin\codexless-install.cmd
```

默认目录：

```text
%LOCALAPPDATA%\Codexless
```

检查项目：

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-doctor.cmd" --cwd "C:\path\to\your\project"
```

启动 HTTP：

```powershell
& "$env:LOCALAPPDATA\Codexless\bin\codexless-http.cmd"
```

卸载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Codexless\scripts\uninstall.ps1"
```

### Apple Silicon macOS

```sh
sh ./bin/codexless-install.sh
```

默认目录：

```text
~/Library/Application Support/Codexless/app
```

检查项目：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-doctor.sh" --cwd "/path/to/your/project"
```

启动 HTTP：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-http.sh"
```

卸载：

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless-uninstall.sh"
```

升级或重装时，获取新的 release/tag 后再次运行同一个 installer 即可。安装目录之外的用户状态会保留。Codexless 不会偷偷扩大 Codex trust，也不会替用户配置 Tunnel 或浏览器文件访问权限。

---

## FAQ

### 用 Codexless 会消耗 Codex 额度吗？

普通已支持的 model-free 本地工具动作不会调用 Codex 模型，因此不会产生 Codex 模型用量。实际调用 Codex 时，正常 Codex 使用规则照常适用。

Codexless **不会增加、刷新、转移、合并或绕过** Codex 使用额度或套餐限制。

### Codex 额度到 0% 以后还能用吗？

Model-free 能力可以继续使用。真正需要 Codex 模型的动作，需要等相应 Codex 使用量恢复后再执行。

### 本地权限有多大？

权限上限跟随本机 Codex 当前有效授权。Codexless 可以对单次动作继续降权；远端调用方不能静默选择更强的本地权限。真正的 permission / trust 拒绝会明确失败。完整边界见 [`SECURITY.md`](SECURITY.md)。

### Codex 会什么，ChatGPT 就全部会了吗？

不会。**0.1.2 的公开合同是 44 个工具**，只包含已经选择并验收进公开面的能力；household / internal 能力不会自动公开。

### 我原来的 ChatGPT → Codex 工作流需要改吗？

不用。你可以继续在 ChatGPT 里讨论和规划；普通 Chat 当前工具够用就直接完成，真正需要 Codex 时再明确调用。

### ChatGPT 为什么能碰到本机？

ChatGPT 拿到的是经过认证 MCP 路径公开出来的 Codexless tools，例如：

> **本机 Codexless → 已认证 Tunnel / remote MCP endpoint → ChatGPT custom app / developer-mode MCP 接入**

不要把 Tunnel / endpoint 凭据写进仓库或公开截图。

---

## 给想看底层的人

- 精确 public service contract 固定在 `src/surface-contracts.mjs`，并由 public contract tests 验收。
- 0.1.2 公开面是 **44 个工具**。普通 Chat 的 Call Codex 使用固定文字 Approval / Result；neutral `agent_commit(taskId)` / `agent_decline(taskId)` 继续属于 authoritative task path。
- Public Excel 只包含上面的六颗 typed tools；schema-reader 和 dynamic Excel gateway 本批继续 household-only。
- Browser 公开的是经过验收的用户动作语义，不是 raw Browser 内部能力。
- Codex 继续是本地 permission / trust 权威；Codexless 可以降权，但不能静默扩大权限。
- Codexless 使用 Codex App Server 和 ChatGPT app/MCP integration surfaces，不依赖逆向私有 UI。

运行公开合同测试：

```sh
npm test
```

从源码运行：

```sh
npm ci
npm run start:stdio
```

HTTP：

```sh
npm run start:http
```

自动发现找不到已接受的 Codex executable 时，可以显式设置 `CODEX_BIN`。Windows 下不要把它指到 npm `.cmd` / `.ps1` shim。

---

## 给 AI 助理

如果用户把这个仓库发给你，问“这是啥、要不要装、安全吗”，先检查实际仓库和当前机器，再给建议。

先确认这些事实：Codexless 公开的是经过验收的本地能力子集；它不增加或绕过 Codex 使用额度；权限上限来自本机 Codex 当前有效授权；Browser 是 bounded user-action surface；Excel 公开面是六颗 typed Preview；Codexless 是独立项目，不是 OpenAI 产品。

---

> **留在 ChatGPT。活落在本机。真需要 Codex 时，再调用 Codex。**
