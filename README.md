# 商舟 AI · MerchantDesk

基于 **Craft Agents 0.11.4** 的电商 AI 工作台。复用上游多模型 Agent、Electron 桌面端、Web 后台、CLI 和会话管理，以小范围增量实现电商工具、执行审计及成本归因。

> 当前电商后端是可运行的本地演示商店，使用虚构商品和订单。退款不转移真实资金；没有接入真实交易平台。模型问答需要自行配置模型连接。此项目不是 Craft 官方产品。

## 能做什么

- **商品文案与推荐**：查询商品事实、价格和实时演示库存，再由已连接的模型生成描述或按预算推荐。
- **客服问答**：根据店铺政策和授权订单回答，缺失事实或超出权限时转人工。
- **订单、退款、库存**：订单范围绑定运行时会话；退款采用整数金额、累计授权额度和幂等键；库存采用版本检查，防止并发覆盖。
- **质量审计**：执行事件按 JSONL 追加，统计工具失败、权限请求、错误和待确认工具，配合原有会话记录进行人工或模型辅助审阅。
- **成本归因**：按会话、模型连接和模型统计供应商上报的 token 与美元费用；未上报价格标为未知，工具调用次数不冒充费用。
- **中断恢复**：重放日志恢复执行状态，并在下一轮提示检查业务状态；退款、库存写操作不会自动重放。
- **多端与多模型**：保留 Craft 的 `AgentBackend`、`AgentEvent`、`SessionToolContext`、统一 RPC/WebSocket、工作区和模型切换能力。

## 快速体验

环境：Bun **1.3.10**、Node.js **22+**；Windows 桌面开发还需要 Git Bash。首次安装需要下载 Electron 等依赖。

```bash
git clone https://github.com/2gg-bit/merchantdesk-ai.git
cd merchantdesk-ai
bun install --frozen-lockfile
bun run commerce:demo
```

演示不需要 API Key，自动创建临时工作区，依次验证商品查询、政策查询、授权订单、越权拒绝、退款、相同请求重试和业务审计，最后输出数据路径。不会读取真实店铺数据。

启动桌面工作台：

```bash
bun run electron:start
```

在应用中配置模型连接并创建工作区、会话，然后按 [电商使用指南](docs/commerce.md) 初始化商店和分配会话权限。

## Web 后台与 CLI

Web 和桌面使用同一套后端及电商工具。以下为 PowerShell 示例，端口默认为 `9100`：

```powershell
bun run server:build:subprocess
bun run webui:build
$env:CRAFT_SERVER_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:CRAFT_WEBUI_DIR = (Resolve-Path apps/webui/dist).Path
$env:CRAFT_BUNDLED_ASSETS_ROOT = (Resolve-Path apps/electron).Path
bun run server:start
```

打开 `http://127.0.0.1:9100`，用服务端 token 登录。生产网络部署需要 TLS 和自己的访问控制；默认仅监听本机。Linux/macOS 命令见 [使用指南](docs/commerce.md#web-与-cli)。

```bash
bun run apps/cli/src/index.ts --help
```

CLI 接入说明见 [CLI 文档](docs/cli.md)。内部 `@craft-agent/*` 包名、`CRAFT_*` 环境变量和原有配置目录保留，以减少兼容性改动；产品名称、应用图标及打包标识已独立。

## 验证与实现

```bash
bun run validate:commerce
bun run typecheck:all
bun run webui:build
bun run electron:build
```

权限、跨会话隔离、退款幂等、并发更新、日志损坏与成本归因都有自动化测试。完整说明见 [需求对照与架构](docs/architecture.md) 和 [验证记录](docs/validation.md)。

| 目录 | 用途 |
| --- | --- |
| `packages/session-tools-core/src/commerce/` | 电商工具、授权、业务账本、执行日志与测试 |
| `packages/server-core/src/sessions/SessionManager.ts` | 复用会话生命周期，挂接审计与恢复提示 |
| `packages/shared/src/prompts/system.ts` | 电商事实依据、操作与恢复规则 |
| `scripts/commerce.ts` | 演示、初始化、管理员授权、审计导出 |
| `examples/commerce/seed.json` | 虚构商品、订单与店铺政策 |
| `apps/electron` / `apps/webui` / `apps/cli` | 共用后端的桌面、Web 和命令行入口 |

## 当前边界

这是单机或可信团队部署的参考实现。授权校验保护电商工具接口，不是操作系统沙箱：拥有本机文件、终端或共享服务端管理权限的人仍能读取或修改数据。JSONL 重放和进程锁验证了并发正确性，不代表已经完成大促流量压测、分布式调度或生产 SLA 验证。

真实支付/订单平台需要在业务执行边界接入服务端鉴权、独立凭据、审批和支付渠道幂等机制。模型切换复用上游会话设置，当前没有新增自动跨供应商无损故障切换。详见 [安全边界](SECURITY.md)。

本分支默认不使用上游自动更新或公共会话分享服务。自建服务可以配置 `MERCHANTDESK_UPDATE_URL`、`MERCHANTDESK_VERSIONS_URL`、`MERCHANTDESK_VIEWER_URL`；没有配置时保持关闭。

## 来源与许可

基于 Craft Agents 开源源码（0.11.4），遵循 [Apache-2.0](LICENSE)。保留 [NOTICE](NOTICE) 和 [上游商标政策](TRADEMARK.md)，不主张独立创作上游已有架构。MerchantDesk 增量和验证范围在架构文档中分别列明。仓库不包含需求来源中的个人简历、联系方式、照片或任何真实客户数据。
