# CLAUDE.md — agent-browser

本文件给 Claude Code 在这个子项目里工作时提供导航。agent-browser 的详细架构、路线图、每个 Stage 的落地细则都在 **[PLAN.md](./PLAN.md)**（~1500 行，附录 A–L），不要重新设计，先读对应章节。

---

## 项目一句话

隐私优先的 agentic 浏览器：Electron + Chromium (BrowserView) + CogniRefract，默认本地、最小信任、管理员策略边界。对标 Atlas / Comet / Dia / Fellou，但规避 prompt injection 与数据泄漏。

## 关键入口文档

| 文档 | 用途 |
|---|---|
| [PLAN.md](./PLAN.md) | **单一真相源**。P0–P2 所有 Stage、12 个附录（AdminPolicy schema / server SQL / CDP 执行链 / Auth Vault / TabManager / AgentHost loop 等） |
| [README.md](./README.md) | Stage 完成度 + 常用命令 |
| [docs/USER.md](./docs/USER.md) | 终端用户安装 & 使用 |
| [docs/ADMIN.md](./docs/ADMIN.md) | AdminPolicy 配置参考 |
| [docs/SECURITY-CHECKLIST.md](./docs/SECURITY-CHECKLIST.md) | 威胁模型 + 验证矩阵 |
| [docs/stage-2-notes.md](./docs/stage-2-notes.md) | Stage 2 实现偏差 |
| [docs/inspiration-from-browseros.md](./docs/inspiration-from-browseros.md) | 来自 BrowserOS 源码的借鉴清单（二层 Memory / SOUL.md / Skills / Workflows / MCP client 等） |

## 已落地进度

- ✅ **P0 0–8**：项目脚手架 · Electron shell + CDP · 5 browser-tools + ref registry · AgentHost + mock LLM stream · persona + domain matcher · AdminPolicy + 三档自主度 · RedactionPipeline + audit log · TaskStateStore + slash commands · electron-builder + e2e
- ✅ **P1 9–16**：Auth Vault · RoutinesEngine · 历史语义索引（transformers.js）· 多 profile + 隐私模式 · 阅读模式 · Trace viewer · Chrome 扩展（MV3 最小子集）· E2E 加密书签/历史同步（含 tombstone）
- ✅ **P2 17–19**：MCP server · 多 tab Agent 协作 · 多 source personas（团队 + 公共市场，失败隔离）
- ✅ **P2 20–21**：企业 MDM 远程拉取 · A11y / i18n（zh+en，admin>user>system 解析，prefers-reduced-motion）

## 开发规范（PLAN 里的关键约束摘要）

- **四道数据防线**：Cookie / 历史永不进 LLM。任何新工具引入前检查是否可能绕过这四道。
- **Prompt injection 假定存在**：content boundary + untrusted tag + 闸门组合是必要防御。
- **Renderer 全走 IPC**：不 `nodeIntegration`，不 `enableRemoteModule`，敏感操作一律主进程持有。
- **persona 声明 domains**：domain matcher 是自动切换 persona 的关键，persona 文件必须带 front matter。
- **下载强制确认**：无论 autonomy 档都弹窗。
- **Embedding 默认 transformers.js** (Xenova/all-MiniLM-L6-v2)，可切 Ollama。

## 常用命令

```bash
pnpm install
pnpm dev:renderer       # Vite dev server
pnpm dev:main           # Electron main（需 RENDERER_URL env）
pnpm test               # vitest 单测
pnpm e2e                # end-to-end acceptance（PLAN §Verification 12 场景）
pnpm check              # biome lint + format check（CI 严格）
pnpm format             # biome format --write
pnpm build:main         # tsc 编译主进程
pnpm build:renderer     # Vite 产物
```

提交前务必 `pnpm check`（CI 把 format 当 error），`pnpm test` 绿。

## Review 流程惯例

项目已形成稳定的 **gemini review 循环**：
1. 开 PR 后发 `/gemini review` 触发 `gemini-code-assist[bot]`
2. 每轮读行内评论；合理的反馈改代码 + 补测试 + 推送
3. 通常 5 轮左右收敛

合并到 main 必须**用户明确授权**（auto mode 也不豁免）。

## 开发工作流

在修改任何功能前，先读取相关现有实现，列出：1) 当前文件结构，2) 现有路由/端点，3) 涉及的数据模型。然后提出方案，等待确认后再动手。
