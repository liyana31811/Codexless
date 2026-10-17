# codexless-linux：Ubuntu 独立部署

Linux Technical Preview 复用 Codexless 的公共实现，提供独立服务与 MCP 身份 `codexless-linux`。npm 源码包仍叫 `codexless`，公共协议仍为 `codexless-public-preview-v1`，45 个工具及其输入输出契约不变。服务名、ChatGPT 插件名、ChatGPT 分配的插件 ID、Tunnel ID、Tunnel profile 是不同概念。

Windows 的 `codexless` 插件、其 Tunnel、Windows 配置及原有 Windows/macOS 启动器保持独立。Linux 可以在 Windows 关机时使用。创建第二个 ChatGPT 插件后，按插件名选择目标环境。

## 依赖与边界

- 已验证 Ubuntu 22.04 x64；其他发行版需要单独验收，arm64 已加入平台分支但尚无真机验收。
- Node.js 22+、npm；本机已有支持 App Server 的 Codex CLI。开发验收组合为 Node 22.23.3、npm 10.9.9、Codex CLI 0.163.0，其他版本须用 Doctor 与集成测试确认。
- 使用普通用户，安装器拒绝 root。无需 sudo、入站端口、防火墙修改、SSH 或代理修改。
- Linux 第一阶段使用 existing Codex **可执行文件**；其 `CODEX_HOME` 独立，不复制原有登录凭据，不使用原有 `~/.codex/config.toml`。不会安装第二套 Codex 来替换用户的 CLI。
- MCP 的普通文件/Git/命令路径调用官方 `command/exec`，不发起模型 turn。模型任务保留 Task ID、显式审批、去重、取消与结果验证；需要独立登录，成功的付费模型 turn 尚未列入 Linux 验收。
- 可选桌面会话集成另需兼容的本地原生客户端、其 `chatgpt.desktop` 启动项、Python 3、GI/libsecret、zenity 和已解锁的 Secret Service。它不要求存在官方 ChatGPT Linux 发行版，也不替用户安装客户端或桌面依赖。

## 隔离目录

| 用途 | 默认路径 |
| --- | --- |
| 应用源码 | `~/.local/share/codexless-linux/app/` |
| 专用 Node/npm | `~/.local/share/codexless-linux/runtime/` |
| 官方 Tunnel Client | `~/.local/share/codexless-linux/tunnel-client/` |
| 服务配置 | `~/.config/codexless-linux/runtime.json` |
| Tunnel profile | `~/.config/codexless-linux/tunnel/profiles/codexless-linux.yaml` |
| ChatGPT 会话配置 | `~/.config/codexless-linux/session.json` |
| ChatGPT 启动项备份 / 回执 | `~/.config/codexless-linux/original-chatgpt.desktop` / `desktop-integration.json` |
| 状态、任务与日志 | `~/.local/state/codexless-linux/` |
| 按需会话日志 | `~/.local/state/codexless-linux/chatgpt-session.log` |
| 独立 Codex Home | `~/.local/state/codexless-linux/codex-home/` |
| 独立 Codex 配置 | `~/.local/state/codexless-linux/codex-home/config.toml` |
| 可选 systemd 用户单元 | `~/.config/systemd/user/codexless-linux.service` |
| 命令 | `~/.local/bin/codexless-linux*` |

支持绝对路径的 `XDG_DATA_HOME`、`XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`。凭据只交给官方登录或本地交互，不写入仓库。独立配置初始使用 `workspace-write` + `on-request`；`--trust-project` 只在全新独立配置中记录所选项目的精确信任，不扩大到整个用户目录，不改已有独立配置。

## 安装

在包含 Linux 支持的已审核源码目录中运行。指定官方 Node/npm 的真实绝对路径；安装器将它们复制到上述专用 runtime，后续无需依赖临时下载目录。

```sh
/path/to/node scripts/linux.mjs install \
  --node /path/to/node --npm /path/to/npm \
  --codex /absolute/path/to/codex \
  --cwd /absolute/path/to/authorized/project --trust-project
```

`--trust-project` 表示明确授权新服务操作该项目。未经授权时省略此项，随后在**独立** Codex Home 中交互设置授权。不要为了修复启动而修改原有 `~/.codex/config.toml`。

安装器先在 staging 目录执行 `npm ci --omit=dev`，激活独立目录并生成用户 unit。它不会启动服务或启用自启动。重复安装/升级保留配置、登录和状态；已安装源码发生本地修改时会拒绝覆盖。正式部署后用 `codexless-linux-doctor` 检查真实 CLI、App Server、项目授权和工具契约。

命令安装到 `~/.local/bin`，安装器不修改 shell 配置或系统 PATH；该目录不在 PATH 时使用 `"$HOME/.local/bin/codexless-linux-doctor"` 等绝对路径。先用 `codexless-linux-stdio` 或 `codexless-linux-http` 验证服务，再配置 Tunnel。stdio 的 stdout 只用于 MCP 协议。

## 可选：跟随本地桌面客户端启动和退出

这是兼容原生 Linux 桌面客户端的可选集成，包括用户自行安装的第三方客户端；不代表 OpenAI 提供或支持某个 Linux 客户端。浏览器使用者可直接采用 [Tunnel 手册](README.linux-tunnel.zh-CN.md) 中的安全前台运行方式，无需此集成。

配置后，点击桌面启动项会启动专属 Tunnel；Tunnel 通过 stdio 启动 `codexless-linux`。指定客户端的主进程退出后，监控器清理本次 Tunnel、MCP 与 Codex 子进程，再退出自身。窗口关闭后如果客户端仍驻留托盘，连接会保留；浏览器网页或标签页关闭不属于此生命周期。须在目标客户端上实际验收退出/重开流程。

确认已满足上述桌面依赖，并找到客户端的真实可执行文件绝对路径。在已安装 Linux 支持的源码目录运行一次：

```sh
python3 scripts/linux-desktop.py install \
  --tunnel-id NEW_UBUNTU_TUNNEL_ID \
  --app-executable /absolute/path/to/desktop-client
python3 scripts/linux-desktop.py status
```

集成读取现有用户 `chatgpt.desktop`，缺少时尝试系统同名启动项；其他命名的客户端启动项需先由用户审阅并准备。它备份启动项，只把主 `Exec` 改为 `~/.local/bin/codexless-linux-chatgpt -- %U`，并生成权限 `0600` 的独立 `session.json`。原启动器及参数保留，URL 按原命令转交；若原启动器是代理 wrapper，也保留其内容。重复安装复用同一配置；若用户随后改动启动项，则拒绝覆盖，需先在本地审阅。

Tunnel runtime key 由 GNOME Secret Service 保存，按独立 Tunnel ID 归属；会话启动时通过私有管道读取，不放在命令参数、profile 或日志中。首次保存或更换 key 时，使用本机隐藏输入窗口：

```sh
python3 scripts/linux-credential.py set --tunnel-id NEW_UBUNTU_TUNNEL_ID
python3 scripts/linux-credential.py check --tunnel-id NEW_UBUNTU_TUNNEL_ID
```

请先确认 Python GI/libsecret、zenity 和桌面 Secret Service 可用；缺少时先由用户决定是否安装系统依赖，或采用手动前台方式。`check` 只返回是否配置；`get` 是内部私有文件描述符接口，不是显示密钥的命令。

平时直接点击 ChatGPT 图标即可；诊断与手动恢复使用：

```sh
codexless-linux-chatgpt status
codexless-linux-tunnel status             # 独立检查 health/readiness/工具发现
codexless-linux-chatgpt stop              # 只停止本次连接，保留 ChatGPT 应用
codexless-linux-chatgpt attach            # ChatGPT 已打开时重新接入
codexless-linux-chatgpt restart           # 重启连接；应用需保持打开
tail -n 80 "$HOME/.local/state/codexless-linux/chatgpt-session.log"
```

会话启动状态不代表 Tunnel 已 ready。缺 key 或连接失败时 ChatGPT 仍可打开，桌面通知提示检查；不会反复自动重试有副作用的操作。修复配置后用 `attach` 恢复。

恢复原 ChatGPT 启动方式：

```sh
codexless-linux-chatgpt stop
python3 scripts/linux-desktop.py restore
```

恢复是幂等操作，保留独立会话配置与 keyring 密钥，不修改代理脚本。

## 其他运行与诊断命令

```sh
codexless-linux-doctor
codexless-linux-status
codexless-linux-logs --lines 80
codexless-linux-logs --follow
codexless-linux-http                    # 前台 loopback HTTP，默认127.0.0.1:7691/mcp
codexless-linux-stdio                   # MCP stdio，仅协议走stdout
```

`codexless-linux-status` / `logs` 对应可选 HTTP 用户服务；按需连接请优先使用上面的 `codexless-linux-chatgpt status` 和会话日志。HTTP 同时校验 loopback Host/Origin；健康端点不包含项目路径。

原有独立 HTTP/systemd 管理命令仍保留。只有用户明确需要后台 HTTP 服务时才使用，stdio 按需连接无需启动它：

```sh
codexless-linux-start --confirm-start
codexless-linux-stop
codexless-linux-restart
```

首次启用登录自启动需要单独确认，只有明确需要时才执行：

```sh
codexless-linux-enable --confirm-autostart
codexless-linux-disable
```

安装器不启用 systemd 或登录自启动。`start` 启动用户服务，不等于 `enable`。可选 systemd 使用 `KillMode=control-group` 清理子进程，不需要 root 或 linger。服务健康不等于 Tunnel 已连接或 ChatGPT 端到端已通过。

## 独立 Codex 登录

文件、Git、受限终端不需要模型登录。需要 Codex 模型时，用户在本机终端执行：

```sh
codexless-linux-login
```

命令调用官方 `codex login --device-auth` 并强制使用独立 `CODEX_HOME`。用户亲自完成网页登录；不要把验证码、令牌或认证文件发到聊天中，也不要复制原有认证文件。原有 Codex 登录不注销、不替换。默认模型不会被本安装器改写。

## 项目权限与核心工具

- `codex.command_exec` 默认 `readOnly`；明确写操作才选 `inherit`，Linux 最高缩限到官方 workspace sandbox，远程请求不能选择任意权限、trusted roots、sandbox 或审批策略。
- `codex.read_many` 接受相对路径与 Ubuntu 绝对路径，canonical realpath 必须位于已授权项目根中。大小写敏感；越界符号链接拒绝。
- `codex.precise_edit` 支持预览、精确匹配、SHA 校验。写入经过官方 Codex sandbox，不直接以 Node 主机权限写文件；只读授权拒绝实际写入，符号链接/硬链接风险与源文件漂移失败可见。
- 创建/搜索/移动/删除文件、Git status/diff/log/branch 等使用原有 argv 命令工具，在本地授权与 sandbox 内执行。`.git` 等 Codex 保护路径的写入可能被拒绝；不绕过保护执行 push/reset/commit。
- `codex.project_context` / `codex.skill_list` / `codex.skill_read` 使用当前独立 Codex 环境的项目规则与 Skills。项目 `AGENTS.md` 可直接读取。原有私有 Skills 不自动复制；如需要，用户自行将允许的 Skills 安装到独立环境。
- 命令有超时、输出上限、stdout/stderr/退出码；关闭时清理 POSIX 进程组。公共工具拒绝直接/已识别包装形式启动 Codex CLI 以绕过模型任务审批。
- Browser、Excel 工具的 schema 保留；本阶段没有配置其运行环境，也未声明可用。

## Tunnel 与 ChatGPT 第二插件

详见 [独立 Tunnel 手册](README.linux-tunnel.zh-CN.md)。使用官方 OpenAI Client、全新 Ubuntu Tunnel ID 和专用运行密钥。优先 stdio 连接，不需要启动 HTTP 后台服务：

```sh
codexless-linux tunnel prepare-client
codexless-linux tunnel init \
  --tunnel-id NEW_UBUNTU_TUNNEL_ID \
  --mcp-command "$HOME/.local/bin/codexless-linux-stdio"
```

可选择手动前台运行，或在满足条件后使用桌面启动项与 GNOME keyring 管理连接，具体步骤见 Tunnel 手册。每次部署需分别验证官方 Doctor、polling、readiness、转发发现与 ChatGPT 调用。然后在 ChatGPT Plugins 中新增 `codexless-linux`，连接新的 Tunnel。不得编辑已有 Windows `codexless` 插件或复用其 Tunnel。只有新插件真实返回 `uname -s` → `Linux` 并读回 Ubuntu 测试文件后，连接验收才通过。

当前仓库不包含真实账户 Tunnel ID、运行密钥或 ChatGPT 插件 ID；这些由账户内官方界面生成，不能由本地服务名推导。

## 更新、恢复与卸载

```sh
codexless-linux-chatgpt stop
codexless-linux-stop
codexless-linux-update --source /absolute/path/to/reviewed/checkout
codexless-linux-doctor
codexless-linux-chatgpt attach             # ChatGPT 正在运行时恢复
# 如需恢复上一个已备份版本：
codexless-linux-chatgpt stop
codexless-linux-stop
codexless-linux-rollback
codexless-linux-doctor
# 卸载前先恢复原 ChatGPT 启动项：
codexless-linux-chatgpt stop
python3 scripts/linux-desktop.py restore
# 若曾用过 HTTP 用户服务，再停止并禁用它：
codexless-linux-stop
codexless-linux-disable
codexless-linux-uninstall
```

更新、回滚前先停止按需会话；若曾使用 HTTP/systemd，也先停止该服务。升级不会自动 fetch、commit、push 或发布源码。配置、keyring 密钥、独立认证、日志和备份默认保留；卸载不会删除项目、Codex CLI、原有配置或 Tunnel 账户资源。若安装目录有本地改动，先保留并审阅改动再升级/卸载。keyring 条目只在用户明确撤除时通过 `python3 scripts/linux-credential.py delete --tunnel-id NEW_UBUNTU_TUNNEL_ID` 删除。

## 可重复测试

```sh
npm ci
npm test
npm run test:linux
# 单独复验按需会话与桌面/密钥管理：
node --test test/linux-chatgpt-session.mjs
python3 -B test/linux-desktop-credential.py
```

`test:linux` 包含 Linux 安全回归、隔离生命周期测试、官方 Tunnel helper、按需会话和桌面/密钥管理测试，以及真实 CLI 与 MCP SDK 的 stdio/HTTP 集成测试。按需测试覆盖重复点击、URL 参数转发、主进程退出清理、手动停止、缺 key 后恢复、PID 身份校验与子进程收养清理；桌面测试使用隔离文件和模拟 Secret Service。测试只在临时目录建立独立 Codex Home，不复制认证，不发起模型 turn，不改原有配置。

官方 Tunnel 原生二进制集成测试可附加：

```sh
CODEXLESS_TEST_TUNNEL_CLIENT=/absolute/official/tunnel-client npm run test:linux
```

Ubuntu 上可运行公共合同与平台分支回归；Windows/macOS 原生安装、信号及沙箱行为仍需对应系统验收，不能由 Linux 测试替代。模型成功调用、真实桌面客户端退出/重开及 Linux arm64 尚待专门验收。共享 canonical helper 的上游镜像验证还需维护者运行 [EXPORT_SYNC.md](EXPORT_SYNC.md) 中的私有源 parity gate。
