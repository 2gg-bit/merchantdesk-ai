# MerchantDesk 电商使用指南

适用于当前 MerchantDesk 分支；商品、订单和退款均为本地演示数据。

## 1. 配置模型和工作区

执行 `bun install --frozen-lockfile`、`bun run electron:start`，在引导页配置自己可用的模型连接，然后创建工作区。客服简单问答和复杂售后分析可在会话中选择不同模型；上游 API 失败后可以人工切换连接重试。

工作区应包含 `config.json`、`sessions/` 等目录。可从工作区设置找到路径。创建会话后发送“使用 get_session_info 告诉我当前会话 ID”，或通过 CLI 的 `sessions` 命令获取 ID。以下占位路径和 ID 要替换为自己的值。

## 2. 初始化演示商店

```bash
bun run commerce:init --workspace "你的工作区绝对路径"
```

该命令只写入 `commerce/seed.json` 和授权目录，不覆盖已有商店，也不自动赋予任何会话访问权限。

## 3. 管理员显式授权

在应用外的终端执行：

```bash
bun run commerce:grant --workspace "你的工作区绝对路径" --session "实际会话ID" --orders DEMO-1001 --role support --refund-limit-cents 8900 --expires-hours 8
```

| 角色 | 商品/政策 | 授权订单 | 演示退款 | 库存调整 |
| --- | --- | --- | --- | --- |
| `support` | 可读 | 可读 | 累计不超过授权额度 | 拒绝 |
| `operations` | 可读 | 可读 | 累计不超过授权额度 | 可操作 |
| `analyst` | 可读 | 可读 | 拒绝 | 拒绝 |

`--orders` 是逗号分隔的订单 ID 白名单；省略表示不允许读取任何订单。`--refund-limit-cents` 单位为人民币分，默认 `0`；额度对整个会话累计，不是每次退款限额。默认授权有效期 8 小时。授权文件必须由可信管理员管理，不能让模型自行授权。

授权保存在 `commerce/grants/<sessionId>.json`。命令拒绝覆盖已有授权。撤销时由管理员删除对应授权文件；替换时先撤销，再执行命令。重新授权不会清零已经使用的退款额度。每次调用都重新检查授权，进程锁取得后再次检查写权限与到期时间。

演示订单 `DEMO-1001` 实付 89 元，`DEMO-1002` 实付 159 元；它们属于不同的演示业务范围。按需授权，不要为了演示方便给所有会话相同订单列表。

## 4. 交互示例

- 商品文案：“查询便携保温杯的商品事实，为商品详情页写一段 100 字介绍；不要添加目录中没有的性能或认证。”
- 推荐：“预算 150 元，推荐一件有库存的通勤商品，说明商品 ID、价格和依据。”
- 客服：“查询 DEMO-1001 和店铺售后政策，起草退货咨询答复，说明需要人工确认的条件。”
- 退款：“为 DEMO-1001 记录 10 元演示补偿，先展示金额和原因，使用请求 ID aftersale-1001-01。”
- 审计：“用 commerce_audit 汇总本会话的失败工具、执行状态和模型费用，并结合对话检查是否存在无事实依据的承诺。”

应用仍使用 Explore / Ask / Auto 三种权限模式。新工作区默认 Ask。Explore 下退款与库存工具被拦截；切换写模式不会绕过订单范围、角色或额度校验。无论模式如何，本地演示都不会产生真实支付。

## 工具接口

| 工具 | 参数要点 | 输出 |
| --- | --- | --- |
| `commerce_search_products` | `query`、`maxPriceCents`、`inStockOnly`、`limit` | 产品事实、价格、库存、`version` |
| `commerce_get_policy` | 无 | 店铺规则及规则 ID |
| `commerce_get_order` | `orderId` | 订单状态、实付与累计已退款金额 |
| `commerce_refund_order` | `orderId`、`amountCents`、`reason`、`requestId` | 演示退款记录和重试标记 |
| `commerce_adjust_inventory` | `productId`、`delta`、`expectedVersion`、`reason`、`requestId` | 库存变更与新版本 |
| `commerce_audit` | 无 | 当前会话执行摘要、供应商费用、业务变更 |

所有输入均在处理器中再次通过 Zod 校验。模型不能通过参数改变 `sessionId`、`workspacePath` 或角色。

## 幂等、并发与故障恢复

退款与库存请求的幂等范围是 `(workspace, session, requestId)`。网络异常后使用完全相同的请求 ID 和业务参数重试，会返回原始成功结果；复用请求 ID 但更改金额、对象或原因会返回冲突。相同退款返回后不重复扣减额度。库存更新先读取 `version`；版本冲突后先核实实际库存，重新确认调整方案，再发出新业务请求。

业务状态由初始数据和 `commerce/ledger.jsonl` 重放得到。一条已同步到磁盘的账本记录同时构成状态变更和审计依据。进程锁覆盖读取、校验、幂等判断和追加。日志内部损坏会拒绝操作；崩溃留下的最后一个未完成行会在下次持锁写入时截断。

崩溃可能遗留 `commerce/ledger.lock`。请求等待最多 10 秒后报忙，系统不会擅自抢锁。管理员应先停止这个工作区的所有服务与 MCP 子进程，检查锁中的 PID 和账本，再删除这个确切的锁文件。不要删除账本来解决锁问题。

执行事件保存在 `sessions/<id>/commerce-events.jsonl`。`incomplete` 表示日志还没有终止记录，可能仍在运行，也可能被崩溃打断；`interrupted` 表示已记录中断。新一轮会读取前一轮状态，并提示模型检查订单/库存和原始幂等键。已保存的会话消息与 SDK 会话 ID 沿用 Craft 的恢复机制。不会自动继续执行一个资金或库存变更。

## 审计与费用导出

```bash
bun run commerce:report --workspace "你的工作区绝对路径" --session "实际会话ID"
```

输出可重定向到 JSON 文件。日志记录执行类型、文本、工具标识、权限请求、结构化错误和完成用量；审计副本不保存工具原始输入、原始结果或权限命令。原有会话记录仍包含对话和工具结果，必须按客户数据管理。

费用为模型供应商上报值，按连接和模型归因；缺少价格的完成轮次记入 `unpricedRuns`。未完成轮次可能没有最终用量，因此该报告不是财务账单。业务退款始终是 CNY 分，模型费用是 USD，两者不合计。工具次数和失败率是审计线索，不能代替人工客服质量判断。

## Web 与 CLI

PowerShell 启动方式见根 README。Linux/macOS：

```bash
bun run server:build:subprocess
bun run webui:build
export CRAFT_SERVER_TOKEN="$(openssl rand -hex 32)"
export CRAFT_WEBUI_DIR="$PWD/apps/webui/dist"
export CRAFT_BUNDLED_ASSETS_ROOT="$PWD/apps/electron"
bun run server:start
```

浏览器打开 `http://127.0.0.1:9100`，使用启动 token 登录。CLI 在另一个已设置相同 token 的终端运行：

```bash
export CRAFT_SERVER_URL=ws://127.0.0.1:9100
bun run apps/cli/src/index.ts workspaces
bun run apps/cli/src/index.ts sessions
bun run apps/cli/src/index.ts send <session-id> "根据本会话授权查询订单"
```

多端会话选择、状态和工具调用复用原有 RPC 协议。共享服务端 token 是管理凭据，并非面向不同商户的租户认证系统。

## 接入真实平台

当前读写实现位于 `packages/session-tools-core/src/commerce/`，无需重写 UI 或模型后端。生产适配时应将可信授权和账本放在独立服务端，使用客户/商户身份验证、渠道凭据、审批、事务存储与支付渠道幂等键，并处理部分退款、退货入库、取消订单等真实业务规则。不能直接把演示商品数据换成真实订单，就宣称具备生产级权限隔离。
