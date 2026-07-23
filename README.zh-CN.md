# Codex Fallback Router（中文说明）

**[English](README.md) | 中文**

一个面向 Windows 上 Codex Desktop 的实验性、无 GUI 备用路由插件。支持额度耗尽自动切换，以及持久化的手动备用、强制官方三种路由模式；账号与非模型接口始终保持在官方 ChatGPT 登录态。

> [!IMPORTANT]
> 本项目不是 OpenAI 的产品。它会修改 Codex 的后端路由设置，并在故障转移时把当前任务上下文发送给第三方服务商。安装前请阅读威胁模型与服务商条款。

## 状态

- 已测试的 Codex Desktop 版本：`26.715.7063.0`
- 运行环境：Windows、Node.js 22 或更高
- 许可证：Apache-2.0
- 界面：仅命令行
- 传输：仅监听本机回环 `127.0.0.1`
- 发布门槛：必须通过真实服务商 smoke test；模拟测试不能替代

除已测试版本外，其他版本默认拒绝安装，除非使用者在确认兼容性后显式传入 `--allow-untested-version`。

## 行为保证

- `auto` 模式下，正常的 Responses 请求优先走官方 ChatGPT 后端。
- 手动 `fallback` 模式把新的 Responses 请求直接发往已配置的服务商；手动 `primary` 模式禁用自动故障转移。
- 非模型的 Codex 后端接口永远只走官方后端。
- 只对可识别的 Plus/工作区额度耗尽错误进行切换；普通限速、鉴权错误、网络故障、服务端 5xx 不会触发。
- 如果官方流已经输出了非配额事件，路由器会继续该流，绝不产生重复的备用回复。
- 除非显式配置 `--fallback-model`，否则保留原模型名。
- 发往备用服务前会移除 ChatGPT 的 Cookie、令牌、账号头和 OpenAI 作用域头；Authorization 替换为备用密钥。
- 请求正文、ChatGPT 令牌和备用密钥永远不会写入路由器日志。
- 备用请求强制 `store: false`，且 Codex 会被配置为 `disable_response_storage = true`。

## 会话连续性

备用 API key **不会**获得 ChatGPT 账号历史的读取权限。连续性之所以成立，是因为 Codex 通常会在 Responses API 的 `input` 中携带可移植的当前任务上下文，包括历史消息、工具定义、工具结果、指令和压缩上下文。

路由器在切换前会校验这一点：凡依赖 `previous_response_id`、服务端 `conversation` 对象、缺少可移植 input 或缺少模型名的请求，一律拒绝发送——报错，而不是静默丢失历史。

服务商兼容性仍然重要：备用服务商必须接受与 Codex 发出的相同的 Responses API 模型名、输入项类型、工具以及加密/压缩上下文。

## 从源码安装

在 PowerShell 中执行：

```powershell
git clone <repository-url> codex-fallback-router
Set-Location .\codex-fallback-router
git config core.hooksPath .githooks

Set-Location .\plugins\codex-fallback-router
npm ci
npm test
```

把服务商密钥复制到剪贴板，然后配置（密钥不会进入 shell 历史）：

```powershell
Get-Clipboard | node .\dist\cli.mjs config set --base-url https://fallback.example.com --api-key-stdin
node .\dist\cli.mjs smoke-test
node .\dist\cli.mjs install
```

安装后重启 Codex Desktop 一次。安装器会：

1. 校验受支持的 Codex 版本；
2. 备份 `%USERPROFILE%\.codex\config.toml`；
3. 注册并安装本地插件；
4. 启动回环 daemon；
5. 以上全部健康后，才把 `chatgpt_base_url` 指向本地路由器。

安装是事务性的：插件错误、配置错误、端口冲突或 daemon 启动失败，都会恢复原 Codex 配置并清理安装产物。

## 命令

安装后，命令 shim 放在 `%USERPROFILE%\.local\bin`（与 Codex CLI 通常的位置一致）：

```text
codex-fallback config set --base-url <https-url> (--api-key-stdin | --reuse-api-key) [--responses-path <path>] [--fallback-model <id>] [--port <port>] [--upstream-proxy <url>]
codex-fallback mode auto
codex-fallback mode fallback [--check]
codex-fallback mode primary
codex-fallback install [--allow-untested-version]
codex-fallback start [--quiet]
codex-fallback stop
codex-fallback status
codex-fallback check
codex-fallback autostart on|off|status
codex-fallback smoke-test [--model <id>]
codex-fallback uninstall [--keep-secret]
```

安全的一行配置：

```powershell
Get-Clipboard | codex-fallback config set --base-url https://fallback.example.com --api-key-stdin
```

URL 按根地址解析，默认解析为 `/v1/responses`；以 `/v1` 结尾的地址解析为 `/responses`。只有当服务商要求不同路径时才使用 `--responses-path`。

`config set` 会重启正在运行的 daemon；若新 daemon 无法恢复健康，则回滚配置与加密凭证。不传 `--fallback-model` 则保留当前 Codex 任务中选择的模型。

如果 Codex 走了本机 Clash/Mihomo 类代理而 Node.js 没有，可传入其回环 HTTP CONNECT 入口，例如 `--upstream-proxy http://127.0.0.1:7890`。远程地址和带凭证的代理 URL 会被拒绝。

在 Windows 上，启用代理的安装会把当前 Node 运行时复制到仓库外的 `%LOCALAPPDATA%\codex-fallback-router\bin\codex.exe`，daemon 和 `codex-fallback` 命令都使用它，使按进程名的代理规则能与 Codex 走相同路由。卸载时删除该副本。

已有 DPAPI 凭证时，后续修改 URL、路径、模型、端口或代理等非密钥项可使用 `--reuse-api-key`。

路由模式是一行命令、持久生效的切换，从下一条新模型请求起生效，无需重启 daemon，也不打断正在输出的回复：

```powershell
codex-fallback mode fallback
codex-fallback mode primary
codex-fallback mode auto
```

`fallback` 只把 Responses 模型请求路由到已配置的服务商；ChatGPT 账号及其他非模型接口仍走官方。加 `--check` 可在切换前先验证备用 Responses API。`primary` 永不切换，即使遇到配额错误。`auto` 恢复默认的官方优先配额行为。`status` 同时报告配置的 `routingMode` 和当前实际生效的 `mode`。

`check` 一条命令报告：daemon 状态、真实备用 smoke test、官方后端连通性探测（无凭证），并打印确切的切回命令。注意：连通性不等于账号额度已恢复；`auto` 模式每条消息都会用真实请求验证额度，是最省心的选择。

## 备用链路韧性

- 备用请求在收到任何响应头之前发生传输层失败（TLS 重置、CONNECT 失败、超时）时，按 2s/5s/10s 退避自动重试，最多 `fallbackRetries` 次（默认 3）。一旦有字节流向 Codex 就绝不重试，回复不会重复。
- `ECONNREFUSED` 快速失败、不再退避：连接被拒说明服务商（或本机代理）是"关了"而不是"抖了"。
- Codex 客户端一断开，重试立即停止；绝不往已断开的客户端写字节。
- 上游 socket 超时只在收到响应头之前生效，长 SSE 流不会在"长思考"途中被截断。
- daemon 吸收每连接及意外错误（记为 `daemon_uncaught` 日志，含脱敏错误码）而不是崩溃——路由器是本地可用性依赖，必须活着。
- 登录看门狗（HKCU Run 键，无需管理员权限）在每次 Windows 登录时拉起路由器并每 60 秒复查一次，重启和 daemon 意外死亡都能自愈，不再依赖 Codex 的 SessionStart 钩子。用 `codex-fallback autostart on|off|status` 管理；`install` 时自动注册，`uninstall` 时自动移除。
- 每条 `upstream_retry`/`upstream_error` 日志都带脱敏网络错误码（如 `ECONNRESET`），便于快速定位。

## 故障转移策略

```text
Codex 请求
  -> 本机回环路由器
     -> 手动 fallback：校验可移植上下文后直接使用备用
     -> 手动 primary：使用官方 ChatGPT 并原样返回
     -> auto：先走官方 ChatGPT
        -> 成功或普通错误：原样返回
        -> 已产生可见 SSE 输出：只继续官方流
        -> 输出前确认额度耗尽：激活备用锁存并原请求重试一次
```

如果官方错误中包含未来的重置时间，路由器在该时间前一直使用备用；否则锁存 15 分钟后重新探测官方。

## 隐私与安全

凭证使用 Windows DPAPI `CurrentUser` 加密，存放在仓库外的 `%LOCALAPPDATA%\codex-fallback-router`，其他 Windows 账号无法解密。非密钥配置、状态、备份、PID 文件和仅含元数据的日志也位于同一目录。

故障转移期间，已配置的服务商会收到当前任务输入、指令、工具 schema、工具结果及必要的请求元数据。`store: false` 只是对服务商的请求，不能替代对服务商隐私与留存政策的审查。

威胁模型见 [SECURITY.md](SECURITY.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 恢复与卸载

正常卸载：

```powershell
codex-fallback uninstall
```

这会停止 daemon、仅恢复安装器改动过的 Codex 根配置项、移除插件注册和命令 shim，并删除加密密钥（除非使用 `--keep-secret`）。

如果路由器不可用导致 Codex 无法连接，按 [docs/RECOVERY.md](docs/RECOVERY.md) 处理——最常见的是 `codex-fallback status` 显示未运行，此时 `codex-fallback start` 拉起即可，无需重启 Codex。备份保留在 `%LOCALAPPDATA%\codex-fallback-router\backups`。

## 开发

```powershell
Set-Location .\plugins\codex-fallback-router
npm ci
npm test
npm run test:install
npm run secret-scan
```

构建产物为单个打包文件 `dist/cli.mjs` 及 source map。生成物不入库，必须由审查过的源码重新构建。CI 在 Windows 上运行并拉取完整 Git 历史，以便历史感知的密钥扫描器检查每一个提交。

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/RELEASING.md](docs/RELEASING.md)。

## 限制

- Codex Desktop 内部实现可能无预警变化，兼容性策略刻意"失败即关闭"。
- 安装期间路由器是本地可用性依赖：若它停止，启动它或卸载即可恢复官方直连。
- 备用失败在有界的重试预算耗尽后返回一个脱敏错误；不会自动切换模型。
- 项目无法保证第三方可用性、模型兼容性、账号历史访问或未来的 Codex 兼容性。
- 真实的额度耗尽事件难以安全复现。mock 集成测试与真实服务商 smoke test 各验证系统的不同部分，两者都必须通过。
- 手动模式切换在每条新 Responses 请求开始时采样；已在输出的回复继续使用原服务商。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
