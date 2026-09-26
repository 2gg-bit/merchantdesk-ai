# 验证记录

验证环境：Windows x64、Bun 1.3.10、Node.js 25.8.2。记录日期：2026-09-26。

## 已验证

| 检查 | 结果 |
| --- | --- |
| `bun run test:commerce` | 27 项通过：授权、输入校验、工作区隔离、退款预算/幂等、库存版本、并发和 JSONL 恢复/费用 |
| `bun run test:commerce:integration` | 22 项通过：真实 MCP stdio 调用、订单隔离、幂等重试、Explore 权限、Claude/Pi 注册一致性、系统提示和项目上下文 |
| `bun run commerce:demo` | 虚构商店完整流程；重复退款只追加一笔记录 |
| `bun run typecheck:all` | 全部指定包通过 TypeScript 检查 |
| `bun run lint:i18n:parity` / `lint:i18n:sorted` | 翻译键一致且排序正确 |
| `bun run webui:build` | Vite 生产构建成功 |
| Electron main、preload、renderer、resources、assets | 源码构建成功；包含 Session MCP、Pi Agent 和现有 WhatsApp 子进程构建 |
| 本机 Web 运行检查 | 使用隔离的临时配置启动 headless server；浏览器 token 登录成功，模型引导页和工作台正常显示新名称与图标 |

业务并发测试包含 40 个相同请求、20 个不同退款请求和 6 个独立进程同时提交同一退款。检查的是无重复退款、无超退及版本冲突处理，不是吞吐量或大促容量压测。

## 复现

```bash
bun install --frozen-lockfile
bun run validate:commerce
bun run typecheck:all
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run webui:build
bun run electron:build
```

集成测试会创建临时配置、复制仓库默认配置，并在结束后清理；不要求开发者事先启动应用，也不会使用个人工作区。CI 执行电商验证、全包类型检查、翻译检查和 Web 构建。

## 限制与构建说明

- 未配置真实模型凭据，未验证真实供应商生成质量、线上支付或真实商户数据。商品文案/推荐通过已接入模型使用事实查询工具生成。
- 没有制作签名安装包、macOS/Windows 发布包，也没有声称通过完整上游测试矩阵。已构建 Electron 源码，未进行本机 Electron GUI 的完整业务回归。
- Vite 保留上游体积告警（部分 chunk 超过 500 kB），构建成功；本次未进行无关的前端拆包重构。
- 原始源码缺少 `tsconfig.base.json`，已补齐；原始 lockfile 与工作区不一致，已重新生成并检查冻结安装。
- 当前网络首次下载 Electron 二进制失败，依赖校验使用了 `bun install --ignore-scripts`。这足以运行本次测试与源码构建；真正启动 Electron 前需让正常安装脚本完成二进制下载。
- Windows 若通过 npm 安装 Bun，请确保真实 `bun.exe` 所在目录位于 PATH；仅有 `.cmd` 包装可能使上游构建脚本中的子进程 `spawn('bun')` 失败。
