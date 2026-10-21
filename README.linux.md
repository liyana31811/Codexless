# codexless-linux：Linux 核心预览

复用 Codexless 公共实现，在 Linux 上提供独立的 `codexless-linux` 服务身份。npm 包和发布产品仍为 `codexless`；45个公共 MCP 工具及输入输出 schema 不变。此贡献只包含核心文件、Git、命令、项目规则和 Codex 任务通道，以及本机安装管理。

Tunnel Client 自动管理、密钥环及桌面应用联动另行贡献，不是本核心版本的安装依赖。Windows/macOS 的既有插件与连接保持独立。

## 依赖和验证范围

- 已验证 Ubuntu 22.04 x64，Node.js 22.23.3、npm 10.9.9、Codex CLI 0.163.0。
- 需要 Node.js 22+、npm、支持 App Server 的现有 Codex CLI。安装器拒绝 root，不执行 sudo，不替换 Codex。
- Linux arm64 只有未验收的运行分支，不在已接纳的预览支持范围内；其他发行版需单独验证。
- 普通文件/Git/命令通过官方 App Server `command/exec`，不会发起 Codex 模型 turn。模型任务保留准确 Task ID、审批、防重放和验证机制，需另行独立登录。
- Browser/Excel schema 保留，Linux 运行环境及成功的模型 turn 尚未验收。

## 独立目录

| 用途 | 默认目录 |
| --- | --- |
| 应用 | `~/.local/share/codexless-linux/app/` |
| 专用 Node/npm | `~/.local/share/codexless-linux/runtime/` |
| 服务配置 | `~/.config/codexless-linux/runtime.json` |
| 状态和日志 | `~/.local/state/codexless-linux/` |
| 独立 Codex Home | `~/.local/state/codexless-linux/codex-home/` |
| 独立 Codex 配置 | `~/.local/state/codexless-linux/codex-home/config.toml` |
| 可选用户服务 | `~/.config/systemd/user/codexless-linux.service` |
| 管理命令 | `~/.local/bin/codexless-linux*` |

支持绝对路径的 `XDG_DATA_HOME`、`XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`。运行时强制使用独立 `CODEX_HOME`，不读改原有 `~/.codex/config.toml`，不复制原有认证文件。独立配置初始为 `workspace-write` 与 `on-request`。

## 安装

在已审核的源码根目录执行：

```sh
node scripts/linux.mjs install \
  --node /absolute/path/to/node --npm /absolute/path/to/npm \
  --codex /absolute/path/to/codex \
  --cwd /absolute/path/to/project --trust-project
"$HOME/.local/bin/codexless-linux-doctor"
```

`--node` 默认当前 Node；`--npm` 可从所选 Node 的同目录或 PATH 中找到时省略。`--trust-project` 是本机明确授权，仅在创建新独立配置时信任所选项目；已有配置不会自动扩大信任。未经授权时省略该项，并在独立 Codex 环境中设置项目授权。

安装器在 staging 运行 `npm ci --omit=dev`，复制所选 Node/npm，再激活应用。它只准备可选 systemd 用户单元，不启动、不启用自启、不修改 shell 配置。`~/.local/bin` 不在 PATH 时请使用命令绝对路径。

核心安装器拒绝覆盖带有 Tunnel/桌面联动配置的完整部署，以免移除其依赖的启动器。此类安装继续使用完整集成版本维护；不要为了升级而删除这些标记或凭据。

## 启动与诊断

```sh
codexless-linux-stdio             # 前台 MCP stdio，stdout仅承载协议
codexless-linux-http              # 前台HTTP，默认127.0.0.1:7691/mcp
codexless-linux-doctor
codexless-linux-status
codexless-linux-logs --lines 80
codexless-linux-logs --follow
```

HTTP 仅接受 loopback 绑定并校验 Host/Origin；健康端点不发布项目目录。stdio 可直接作为外部 MCP 客户端的本地命令，无需启动后台 HTTP 服务。

只有明确需要后台 HTTP 时使用：

```sh
codexless-linux-start --confirm-start
codexless-linux-stop
codexless-linux-restart
# 明确决定启用登录自启时：
codexless-linux-enable --confirm-autostart
codexless-linux-disable
```

首次后台启动和自启分别确认，不使用 root 或 linger。关闭服务会清理它拥有的 Linux 进程组/控制组。`status`/`logs` 对应 HTTP 用户服务，不是账户 Tunnel 或 ChatGPT 连接状态。

## 权限、工具及登录

- `codex.command_exec` 默认 `readOnly`；明确的写操作才选 `inherit`，Linux 最高限于本机授权的官方 workspace sandbox。远程调用不能指定新的 profile、trust、sandbox 或审批策略。
- 文件读取支持 Ubuntu 绝对路径和相对路径，必须位于已授权项目的 canonical root 内；符号链接越界拒绝。
- Linux 精确编辑复用上游 canonical helper 的校验和预览，在独立平台适配层中执行官方 sandbox 写入及结果哈希核对。只读、链接、漂移和不确定写入均失败可见，不改走主机写入。
- 文件创建/搜索/移动/删除和 Git status/diff/log/branch 使用有界 argv。Codex 保护目录的写入可能被拒绝，不通过另一条高权限通道重放。
- 项目 `AGENTS.md` 和独立 Codex 环境中的 Skills 继续生效；不自动复制原有私有 Skills。
- 命令有超时、输出上限、stdout/stderr/退出状态。公共工具拒绝已识别的嵌套 Codex 启动以保留模型任务审批。

需要模型时，在本机交互执行：

```sh
codexless-linux-login
```

该命令调用官方设备登录并强制独立 `CODEX_HOME`。用户亲自完成授权；不把验证码、令牌或认证文件发送到聊天或仓库。普通本地工具不要求完成模型登录。

## ChatGPT 接入边界

本核心包只提供 stdio 和 loopback HTTP。远程 ChatGPT 连接需用户另外按 [官方 Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 配置受认证的通道，不将本地服务直接暴露到公网。

需要保留 Windows `codexless` 时，请创建独立 Linux Tunnel 和独立 ChatGPT 插件 `codexless-linux`，不要重命名或重绑已有 Windows 插件。服务名、账户 Tunnel ID、ChatGPT 插件 ID 是不同标识。只有通过新插件真实调用 `uname -s` 返回 `Linux` 并读回指定测试文件，才算完成该部署的连接验收；服务启动或本地发现不等于远程已连接。

## 更新、回滚与卸载

```sh
codexless-linux-stop
codexless-linux-update --source /absolute/path/to/reviewed/checkout
codexless-linux-doctor
# 需要恢复上一次完整备份时：
codexless-linux-rollback
# 卸载前先停止并禁用已启用的用户服务：
codexless-linux-stop
codexless-linux-disable
codexless-linux-uninstall
```

安装/更新/回滚/卸载先检查所有权、本地改动和完整性。失败时恢复原应用/runtime/回执；不会丢弃用户的安装目录修改。配置、认证、日志、项目、CLI和账户资源保留。脚本不 fetch、commit、push 或发布代码。

## 测试与发布条件

```sh
npm ci
npm test
npm run test:linux
npm run test:platform
```

Linux 测试在临时目录建立独立 Codex Home，覆盖安全边界、安装/升级/回滚、App Server 清理及真实 stdio/HTTP 工具调用，不借用真实登录或项目配置，不发起模型 turn。

`test:platform` 使用临时原生进程和文件验证共享行为，可由 Ubuntu、Windows、macOS 的 CI 分别运行；Linux 上通过不代表另外两个系统已通过。真实 CI 结果需在 PR 检查中查看，首次贡献的工作流可能需要维护者批准运行。

`construction-tools.mjs`、`browser-tools.mjs` 和 `codex-browser-executor.mjs` 与本次公开上游基线保持字节一致；Linux 特例由单独适配层承载。这项公开源码比较不等于维护者私有 canonical export parity gate 已通过，该 gate 仍是发布前提，详见 [EXPORT_SYNC.md](EXPORT_SYNC.md)。
