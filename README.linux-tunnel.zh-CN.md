# codexless-linux：独立 Secure MCP Tunnel 与 ChatGPT 连接

此文档使用 OpenAI 官方 `openai/tunnel-client`，不会创建非官方公网代理。Linux MCP 保持 stdio 或 loopback HTTP；无需开放入站端口。Ubuntu 配置不会引用、覆盖、注销或重绑定 Windows `codexless`。需要账户登录、创建 Tunnel、输入密钥、安装长期服务或首次启用自启时，应先由用户确认。

## Preview 支持范围

Linux helper 已使用官方 Linux amd64 `tunnel-client` v0.0.16 验证 `help quickstart`、初始化、Doctor、前台运行及 loopback 健康接口。下载器按官方 latest release 选择构建，并验证官方摘要；文档中的验证版本不是未来下载版本的保证。Linux arm64 构建选择已有实现，尚无真机验收。

仓库不附带账户 Tunnel、profile、keyring 条目或已注册插件；每位用户须完成自己的账户准备与验收。**Doctor 配置检查、健康、readiness、工具发现与 ChatGPT 实际调用是不同证据。** 只有 ChatGPT 从新插件调用 `uname -s` 返回 `Linux` 并读取 Ubuntu 验证文件，才能宣布端到端连接成功。

## 五种身份

| 概念 | Ubuntu 的值或来源 |
| --- | --- |
| Node 服务 / 安装实例 | 独立 `codexless-linux` 安装与 XDG 目录 |
| MCP server identity | `initialize` 返回的 `codexless-linux` |
| ChatGPT 私有插件显示名 | 新建为 `codexless-linux` |
| Tunnel ID | 在 Platform **新建 Ubuntu 专属 Tunnel** 后得到的完整 `tunnel_...` |
| ChatGPT 实际插件 ID | ChatGPT 新建成功后生成，不能从名称或 Tunnel ID 推导 |

本地 profile 名固定为 `codexless-linux`，只是本机配置名称。它不是 Tunnel ID，也不是 ChatGPT 插件 ID。原来的 Windows 名称、Tunnel ID、插件 ID 均保持原状。

## 独立目录与命令

默认使用 XDG（绝对路径环境变量可覆盖 XDG 根）：

```text
~/.local/share/codexless-linux/tunnel-client/<官方版本>/
~/.local/share/codexless-linux/tunnel-client/current/tunnel-client
~/.config/codexless-linux/tunnel/profiles/codexless-linux.yaml
~/.config/codexless-linux/session.json
~/.config/codexless-linux/original-chatgpt.desktop
~/.config/codexless-linux/desktop-integration.json
~/.local/state/codexless-linux/tunnel/health-url
~/.local/state/codexless-linux/tunnel/tunnel.pid
~/.local/state/codexless-linux/chatgpt-session.log
```

配置与状态目录权限 `0700`，profile 与会话配置权限 `0600`。profile 只存 `env:CODEXLESS_LINUX_TUNNEL_API_KEY` 引用，不存密钥文本。按需会话从 GNOME Secret Service 经私有文件描述符读取 key，只传给 Tunnel 子进程的专用环境变量，不输出 stdout。wrapper 显式去掉通用 `OPENAI_API_KEY`、admin key、其他 Tunnel profile、MCP endpoint、远程 UI 和原始 HTTP 日志环境覆盖，防止把旧连接带入 Ubuntu 实例。即使直接执行此 Tunnel 脚本，也强制把 `CODEX_HOME` 指向独立的 `~/.local/state/codexless-linux/codex-home`，防止官方 doctor 的可选 Codex 插件检查接触原有 Codex home；没有复制原登录凭据。

仓库入口（其中 `node` 需为可用 Node.js 22+，也可用绝对路径）：

```bash
node scripts/linux-tunnel.mjs info
node scripts/linux-tunnel.mjs prepare-client
node scripts/linux-tunnel.mjs init --tunnel-id NEW_UBUNTU_TUNNEL_ID --mcp-command /absolute/path/to/codexless-linux-stdio
node scripts/linux-tunnel.mjs doctor
node scripts/linux-tunnel.mjs run
node scripts/linux-tunnel.mjs status
```

Linux 安装器安装后，可通过 `codexless-linux-tunnel <操作>` 使用相同功能，也可通过 `codexless-linux tunnel <操作>`。`prepare-client` 依赖 `curl` 与 Python 3，按当前架构下载**官方最新** Linux amd64/arm64 ZIP，比较官方 release digest、官方 `SHA256SUMS.txt` 与下载文件 SHA256，安全解压到独立应用目录，并切换自身 `current` 软链接。重复执行会验证并复用同版本；不会改系统 PATH、原有全局 Tunnel Client 或 Codex 配置。下载地址始终从官方 latest-release 解析，不固定未来版本。命令不使用 `sudo`。

在源码目录测试可加：

```bash
node scripts/linux-tunnel.mjs init \
  --client /absolute/path/to/official/tunnel-client \
  --profile-dir /absolute/path/to/isolated/profiles \
  --tunnel-id NEW_UBUNTU_TUNNEL_ID \
  --mcp-command /absolute/path/to/codexless-linux-stdio
```

`--client`、`--client-dir`、`--profile-dir`、`--state-dir` 也适用于其他操作。profile 已存在时 `init` 明确退出并保留原文件；不会自动覆盖或重新绑定。如果已正确初始化，直接继续 `doctor`，不必再次 `init`。修改 Tunnel 绑定应先停止当前前台进程，手工备份并审阅自己的独立 Linux profile 后再处理。

## 新机器的账户准备

首次部署按以下步骤创建独立资源。已配置的 profile 与 keyring 条目可以复用，无需重复初始化；更换绑定前应先停止连接并备份审阅配置。

1. 打开 [Platform Tunnel settings](https://platform.openai.com/settings/organization/tunnels)，选定本人的 Platform organization。**创建新的 Ubuntu Tunnel**，可使用说明名 `codexless-linux-ubuntu`；不要选择或修改 Windows Tunnel。
2. 记录服务返回的完整 Tunnel ID，确认与 Windows Tunnel 不同。关联需要使用此插件的 ChatGPT workspace；同一个 OpenAI 账号不自动代表 organization/workspace 已关联。
3. 创建或使用专门供这个 Ubuntu Tunnel 运行的受限 runtime API key。runtime key principal 需 Tunnels **Read + Use**；创建/修改 Tunnel 需 **Read + Manage**。ChatGPT 自定义 MCP 插件权限单独由 workspace 控制。
4. 不要向聊天、命令参数、profile、仓库、截图或报告粘贴密钥；不要把 admin key 给运行时。Codex 登录凭据不能代替 Tunnel runtime key。

不需要为此安装 `tunnel-client codex plugin`。那个命令管理 Codex 的插件，不等于本任务中的 ChatGPT `codexless-linux`，还可能改变已有 Codex 配置。

## 可选：跟随本地桌面客户端按需运行

这一方式适用于用户已安装的兼容原生 Linux 桌面客户端，包括第三方客户端；不代表 OpenAI 提供某种 Linux 客户端，也不要求为了 Tunnel 安装第三方客户端。浏览器用户可跳过此节，使用下节的手动安全前台连接。

集成不安装长期 Tunnel 服务、不启用 systemd 或登录自启动。点击配置的桌面图标时启动专属 Tunnel，Tunnel 通过 stdio 启动本机 MCP；指定客户端主进程退出时，清理此次 Tunnel、MCP、Codex 子进程并停止监控。真实退出/重开需在所选客户端上另行验收。

需要现有用户或系统 `chatgpt.desktop` 启动项、客户端真实可执行文件绝对路径、Python 3、GI/libsecret、zenity，以及已解锁的桌面 Secret Service。其他命名的启动项需要先由用户审阅并准备。集成保留原启动命令及参数（包括已有代理 wrapper），备份原 desktop entry，只修改主 `Exec`，并记录独立 `session.json`。在已安装 Linux 支持的源码目录执行：

```bash
python3 scripts/linux-desktop.py install \
  --tunnel-id NEW_UBUNTU_TUNNEL_ID \
  --app-executable /absolute/path/to/desktop-client
python3 scripts/linux-desktop.py status
```

重复执行幂等；如 desktop entry 被用户后续修改，安装器拒绝覆盖，需先本地审阅。新 `Exec` 指向 `~/.local/bin/codexless-linux-chatgpt -- %U`，再次点击图标仍向原启动器转交 URL，不会重复创建 Tunnel。此集成不改原 Codex 配置、系统代理或原代理脚本。

首次保存或更换 key 使用桌面隐藏输入窗口：

```bash
python3 scripts/linux-credential.py set --tunnel-id NEW_UBUNTU_TUNNEL_ID
python3 scripts/linux-credential.py check --tunnel-id NEW_UBUNTU_TUNNEL_ID
```

`set` 调用 zenity 密码框，把 key 保存到按 application/purpose/Tunnel ID 区分的 GNOME Secret Service 条目；`check` 只报告存在状态。`get` 只供内部私有管道接口使用，不可用于终端打印 key。请先检查上述桌面依赖；安装器不会自动安装系统包，缺少时可选择手动前台模式。

日常点击 ChatGPT 图标即可。应用已打开、更新后恢复或处理失败时使用：

```bash
codexless-linux-chatgpt status
codexless-linux-chatgpt attach
codexless-linux-chatgpt restart
codexless-linux-chatgpt stop
tail -n 80 "$HOME/.local/state/codexless-linux/chatgpt-session.log"
codexless-linux-tunnel status
```

`attach` / `restart` 需要原生 ChatGPT 已在运行；`stop` 只停连接，不关闭 ChatGPT。`running` 只说明会话监控器存在，实际 Tunnel readiness 与发现另用 `tunnel status` 检查。缺 key 或连接退出会提示本机通知，ChatGPT 仍可使用；修复后显式 `attach`，不会持续自动重试。

**关闭窗口不一定等于退出应用。** 如果 ChatGPT 主进程仍驻留托盘，连接会保留；从应用菜单真正退出后才停止。这个实现不监测任意浏览器网页或标签页。无需 root、linger 或常驻 systemd watcher。

## 手动初始化与安全前台连接

这是无需桌面客户端和 keyring 集成的基础运行方式，也适用于诊断。与按需会话互斥使用；若已配置并运行桌面会话，先执行 `codexless-linux-chatgpt stop`，避免同一个 Tunnel 被两个客户端同时使用。

先完成 Linux 本地安装和 MCP 测试。stdio 模式由 Tunnel Client 自行启动独立 MCP 子进程，不需要另开一个 HTTP 服务：

```bash
read -r -p '新的 Ubuntu Tunnel ID: ' CODEXLESS_LINUX_TUNNEL_ID
codexless-linux-tunnel init \
  --tunnel-id "$CODEXLESS_LINUX_TUNNEL_ID" \
  --mcp-command "\"$HOME/.local/bin/codexless-linux-stdio\""
unset CODEXLESS_LINUX_TUNNEL_ID
```

如果 XDG 或安装目标自定义，应将 `--mcp-command` 换为实际 wrapper 的绝对路径。路径含空格时保留传给官方命令解析器的引号；命令和配置内不放密钥。

在用户自己的本地终端，使用隐藏输入，并把密钥限制在本次子 shell 生命周期：

```bash
(
  read -r -s -p 'Ubuntu Tunnel runtime API key（不会显示）: ' CODEXLESS_LINUX_TUNNEL_API_KEY
  printf '\n'
  export CODEXLESS_LINUX_TUNNEL_API_KEY
  if codexless-linux-tunnel doctor; then
    codexless-linux-tunnel run
  fi
)
```

`doctor` 与 `run` 使用同一独立 profile 和专用 key。上述隐藏输入子 shell 是前台诊断方式；日常桌面启动从 keyring 读取，无需反复输入。`run` 连接官方控制平面，保持本地前台进程；Ctrl+C 停止，并转发 POSIX 退出信号。它不启用后台服务或自启，也不读取原来 `~/.codex` 的登录/模型设置。Linux 模型调用使用独立 Codex home，应另外登录；普通本地文件与受限命令工具无需模型登录。

HTTP 模式仅允许 loopback：

```bash
read -r -p '新的 Ubuntu Tunnel ID: ' CODEXLESS_LINUX_TUNNEL_ID
codexless-linux-tunnel init \
  --tunnel-id "$CODEXLESS_LINUX_TUNNEL_ID" \
  --mcp-server-url http://127.0.0.1:7691/mcp
unset CODEXLESS_LINUX_TUNNEL_ID
```

以上 HTTP 端口只是示例，应与实际 Linux HTTP listener 的端口一致。不要将 `0.0.0.0` 或公网地址用于本地 MCP。不要同时用 stdio/HTTP 初始化同一个已有 profile。

## 检查真实健康、连接和工具发现

保持 ChatGPT 按需会话或手动前台 Tunnel 运行，在终端执行：

```bash
codexless-linux-tunnel status
```

wrapper 从自己的私有 `health-url` 发现随机 loopback 端口，只访问 `/healthz`、`/readyz`、`/health/mcp`，拒绝外部地址和重定向。退出码含义：`0` 为 healthy + ready 且已观测完整工具发现，`2` 为健康/readiness 失败，`3` 为 ready 但工具发现尚未观测；其他启动/配置错误为 `1`。即使 `0` 也不能替代 ChatGPT 真正调用验证。

若需查看 active polling、队列与 MCP 组件细节，在本机浏览器打开状态中 `url` 加 `/ui`，或手工读取同一 loopback base 的 `/health?details=true`。`/health/mcp` 的 `state: not_observed` 表示此诊断接口尚未记录完整发现证据，不能据此单独判断没有转发请求；即使队列或日志显示请求已转发，也应保留此诊断未完成状态。完整发现预期包含 `details.tools_list.ok=true`、`complete=true` 与初始化身份 `codexless-linux`。stdio 关注 `evidence: same_child`，而不是另起测试进程的发现结果。

readiness 是连接前提，不能仅凭 PID、`/healthz` 成功或启动日志宣布连接成功。`401/403` 应检查受限 runtime key 与 Tunnel **Read + Use**，不要换成 admin key。Tunnel 在 ChatGPT 看不到时，应检查目标 ChatGPT workspace 关联及用户权限，而不是改动 Windows 插件。

## 在 ChatGPT 新建第二个私有插件

按照 [最新官方 Secure MCP Tunnel 文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，打开具有私有插件权限的 ChatGPT 页面或客户端，并确认 Ubuntu Tunnel ready。界面文字可能随账户/版本变化，以官方页面为准：

1. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，选择加号，再选 **Add custom MCP server**。
2. 填写独立名称 **codexless-linux**。在 **Connection** 选择 **Tunnel**，选择或粘贴新的 Ubuntu Tunnel ID。
3. 按 MCP 服务实际认证方式配置。当前仅 loopback/stdio 的 Codexless 未提供额外 OAuth 时，选择界面对应的无额外 MCP 认证方式；Tunnel 控制平面认证与 ChatGPT workspace 访问限制仍存在。**不要把 Tunnel runtime key 填进插件认证或自定义 header。**
4. 阅读风险提示并确认 **I understand and want to continue**，再选择 **Create as a plugin**。这是新建；不要打开 Windows 插件的编辑/重绑定流程。
5. 记录 ChatGPT 返回的实际插件 ID，确认插件列表同时保留 Windows `codexless` 与 Ubuntu `codexless-linux`。

若页面不可操作、账号无插件权限或 Tunnel 未关联目标工作区，则状态保持“等待用户最终注册/验证”，不能宣称已安装。Secure MCP Tunnel 支持私有连接，不是公共插件发布途径。

## ChatGPT 最终验收

在 Linux 允许访问的隔离测试项目中，先建立一个验证文件，例如项目内 `ubuntu-verification.txt`，内容包含 `codexless-linux ubuntu verification`。只允许新插件操作该项目。

随后在 ChatGPT 明确选择 **codexless-linux**，发送：

```text
请仅使用 codexless-linux：在已授权的 Ubuntu 验证项目执行 uname -s 和 pwd，
再读取此项目中的 ubuntu-verification.txt，返回实际输出与绝对路径。
不要使用 Windows codexless，不要调用 Codex 模型。
```

保留三类证据：ChatGPT 新插件实际工具调用返回 `Linux`；文件内容/绝对路径与 Ubuntu 文件匹配；本机 Tunnel 的工具发现与 readiness 诊断。若 `/health/mcp` 仍未观测完整发现，准确记录这一诊断限制，并保留真实调用与转发证据，不能补写为发现已通过。命令调用使用独立 argv 数组，不将 `uname` 与 `pwd` 拼成组合 shell 命令；不能为验证扩大 sandbox 或项目 trust。

## 恢复、更新与卸载

- 日常停止：从原生 ChatGPT 真正退出，或 `codexless-linux-chatgpt stop`；手动前台模式用 Ctrl+C。无须注销 Tunnel 或删除插件。
- 恢复：重新点击 ChatGPT 图标；应用已打开时执行 `codexless-linux-chatgpt attach`。沿用已有 Linux profile 和 keyring 条目。
- 更新或回滚应用前：先 `codexless-linux-chatgpt stop`，若以前使用过 HTTP/systemd 服务，再 `codexless-linux-stop`；随后按 [Linux 安装手册](README.linux.md) 操作。更新不会自动重启会话，完成后点击图标或 `attach`。
- 更新官方客户端：先停止按需会话或手动 Tunnel，再执行 `codexless-linux-tunnel prepare-client`。旧版本目录保留，便于审阅后回退；不会触碰 Windows。
- 卸载前：先停会话，再从源码目录执行 `python3 scripts/linux-desktop.py restore`，恢复备份的原 ChatGPT desktop entry；接着停止/禁用曾启用的 HTTP 用户服务，再卸载应用。`restore` 可重复执行，保留 session 配置、keyring 条目及代理脚本。
- 默认卸载保留 key/config。若用户明确撤除 Linux runtime key，使用 `python3 scripts/linux-credential.py delete --tunnel-id NEW_UBUNTU_TUNNEL_ID`；撤销账户资源与删除配置需单独确认，不影响 Windows 资源。

按需会话及桌面集成可单独复验：

```bash
node --test test/linux-chatgpt-session.mjs
python3 -B test/linux-desktop-credential.py
```

这些测试使用临时目录、模拟应用和模拟 Secret Service；不读取真实 key、不改用户的实际 desktop entry，也不能替代真实 Tunnel 与 ChatGPT 的验收。

## 官方依据

- [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [官方 Tunnel Client latest release](https://github.com/openai/tunnel-client/releases/latest)
- [官方 onboarding](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md)
- [官方 configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
- [官方 health contract](https://github.com/openai/tunnel-client/blob/master/docs/health.md)

实际参数以已安装版本的 `tunnel-client help quickstart`、`init --help`、`doctor --help` 和 `run --help` 为准。
