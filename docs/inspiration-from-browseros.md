# 来自 BrowserOS 的借鉴

> 基于 BrowserOS（[github.com/browseros-ai/BrowserOS](https://github.com/browseros-ai/BrowserOS)，AGPL v3）源码 + 官方 docs 的扫描（2026-04-24）。
> 目的：在 agent-browser（Electron + CogniRefract）路线图里吸收 BrowserOS 已验证的设计，避免重复踩坑。

---

## 1. 两者定位差异（读前必看）

| 维度 | BrowserOS | agent-browser |
|---|---|---|
| 底座 | **Chromium fork**（AGPL v3） | **Electron shell + Chromium**（通过 BrowserView） |
| Agent 运行时 | apps/server Bun + Vercel AI SDK `ToolLoopAgent` | 自研 AgentHost + CogniRefract step loop |
| 工具来源 | 扩展 + Chromium 原生桥 | `@agent-browser/browser-tools`（CDP 层） |
| LLM 接入 | 多 provider 直连 + Ollama/LM Studio | 多 provider fallback 链（Gemini → Claude → DeepSeek → Qwen） |
| 分发 | dmg / exe / AppImage / deb | electron-builder 三平台 |
| 许可证 | AGPL v3 | 我们私有 |

**结论**：BrowserOS 的 *底座决策*（fork Chromium 以打开 MV2/uBlock Origin、以 native 扩展挂工具）不直接适用；我们应**借鉴上层设计**（Agent 编排、Memory 分层、SOUL、Skills、Workflows、调度），底座保持 Electron。

---

## 2. 高价值借鉴（按落地优先级排）

### 2.1 二层 Memory（CORE.md + daily）—— **强烈推荐**

**BrowserOS 实现**：
- `~/.browseros/memory/` 下多个 `.md` 文件
- `CORE.md`：永久事实（名字、项目、偏好），仅用户手动删
- 按日期的 `YYYY-MM-DD.md`：会话笔记 + 临时上下文，**30 天自动清理**
- 检索用 Fuse.js 模糊匹配；按 `##` 章节分段 + 行级，返回 top-10
- 工具：`memory_write / memory_search / memory_read_*`；Agent 对话前**主动搜索**相关记忆

**对我们的启发**：
- 我们现有 `history-index.ts`（语义索引）和 `history.ts` 已经提供了"遍历过的 URL"式记忆。但缺一个**结构化长期事实层**。
- 建议新增 Stage：agent-browser 的 `memory` 模块 = `CORE.md`（用户偏好、常用工具、别名）+ `daily/*.md`（每日对话摘要），纯本地 markdown + FTS5 或 transformers.js 嵌入。
- 与 SOUL/persona 明确分离：**Memory 记事实，SOUL 定风格**（下节）。

### 2.2 SOUL.md —— 可复用的人格演化机制

**BrowserOS 实现**：
- 单个 `SOUL.md`（~150 行），每次对话开始注入 system prompt
- 初始为默认模板 → Agent 在对话中根据用户反馈**自主修改这个文件**（"下次别未经同意发邮件" → SOUL.md 新增 boundary 条款）
- 明确区分 SOUL（**如何行为**）和 Memory（**了解什么**）

**对我们的启发**：
- 我们已有 `persona` front-matter（domains / allowedTools / contentMd），是"角色"维度。SOUL 是"用户给自己 Agent 的边界"维度，**层级更高**，跨所有 persona 生效。
- 建议在 `apps/main/src/prompts/` 下加 `soul.md` 模板 + 一个 `memory_write` 工具让 Agent 能**自修改 SOUL.md**（高危，要过 confirmation hook）。
- **关键设计决策**：SOUL.md 的修改动作应进 AuditLog，便于回溯"是什么时候 Agent 写入了这条边界"。

### 2.3 Skills（SKILL.md）—— 对齐 Agent Skills 开放规范

**BrowserOS 实现**：
- `~/.browseros/skills/<slug>/SKILL.md`：YAML front matter + Markdown 正文
- 附属 `scripts/`、`references/`、`assets/` 目录
- 启动时 `loadSkills()` → `buildSkillsCatalog()` 生成 XML 注入 system prompt
- 13 个内置 skill（Extract Data、Report Research 等）

**对我们的启发**：
- 格式和我们的 persona front-matter 非常像，但**尺度更细**（一个 persona 可以包含多个 skill）。
- 建议 `packages/browser-tools` 之外加一层 `skills` 包：Agent 在看到"提取表格"这种任务时激活 Extract Data skill，skill 提供**多阶段 prompt + 可选 script**。
- 对齐开放规范（`display-name / enabled / version` 等 metadata）有助于未来从 BrowserOS 或其他生态**复用社区 skill**。

### 2.4 Workflows（可视化有向图）—— 最有价值的产品差异化

**BrowserOS 实现**：
- 用户用自然语言描述流程 → Agent 生成有向图（支持并行、条件分支）
- 拖拽节点编辑 + Test Run 验证；保存后可手动或定时触发
- 定位："把不稳定的对话转化为可靠的可编程流程"

**对我们的启发**：
- 我们 PLAN 里没有明确的 Workflow 阶段，但这是**对标 Atlas/Comet/Dia 的关键产品点**。
- 建议：P2 之后追加一个 Stage —— `workflows/*.yaml` 声明节点（tool 调用）+ 边（条件），复用现有 browser-tools + AgentHost 作为节点执行器。
- 最低可行版：YAML 编辑（无 GUI），Stage 后期补可视化编辑。

### 2.5 Scheduled Tasks —— 我们已有 RoutinesEngine，校准细节

**BrowserOS 实现**：
- 扩展侧用 `chrome.alarms`（不是 setInterval）— 系统级调度，精度稳
- 触发后 HTTP POST `/chat` 带 `isScheduledTask=true` 标志
- **10 分钟 stale timeout**；每 job 最多 15 条运行记录

**对我们的启发**：
- P1-10 RoutinesEngine 已在我们项目里。要补齐：
  - **stale timeout** 机制（超时自动标失败，避免卡死线程）
  - **per-job run history 上限**（避免无限增长）
  - 调度任务的 Agent 要**在受限工具集下运行**（BrowserOS 用 `isScheduledTask` 标志限制工具，避免后台任务乱操作）

### 2.6 MCP Server 内置（已有 P2-17，但可借鉴深度）

**BrowserOS 实现**：
- `@hono/mcp` 挂载 `/mcp` HTTP 路由，内置不外置
- `mcp-transport-detect.ts`：SSE / HTTP 自适应
- 同时作为 MCP **client** 连接外部 servers（Klavis Strata 等），把 40+ app tools 合入 ToolSet

**对我们的启发**：
- 我们 P2-17 已做 MCP server 暴露。**还没做 MCP client 这一面**。
- 建议补：`mcp-config.ts` 里读外部 MCP server 列表 → 启动时连接 → 把它们的 tool 注入 AgentHost skills 列表。一下就有了"40+ 集成"的基础能力。
- Transport 自适应值得抄（SSE 失败降级 HTTP）。

### 2.7 Cowork（浏览器 + 本地文件）—— 差异化能力，值得补

**BrowserOS 实现**：
- 7 个 filesystem tools（read/write/edit/grep/find/ls/bash）**严格沙箱**到用户选定文件夹
- 同一 Agent 会话混用 browser + filesystem tools；`ToolContext` 持有 `browser` + `directories`
- Chat Mode 下 filesystem 禁用（只读浏览器工具）

**对我们的启发**：
- 我们当前工具集只有 5 个 browser-tool。加 `filesystem` skill 包很自然。
- **关键安全点**：BrowserOS 的 "选定目录" 沙箱值得完整抄 —— 用户对话开始时 pick 一个工作目录，该会话仅此目录可写；路径遍历阻止。
- 我们的 AdminPolicy 已有 URL whitelist，再加 `filesystem.allowedDirs[]` 是对称扩展。

### 2.8 LLM provider 抽象 —— 统一工厂，补本地模型

**BrowserOS 实现**：
- `provider-factory.ts` 支持 Anthropic / OpenAI / Google / OpenRouter / Azure / Bedrock
- **本地模型**：LM Studio / Ollama 通过 `createOpenAICompatible()` 统一包装
- `createLanguageModel(provider)` 工厂 + `baseUrl` 自定义

**对我们的启发**：
- 我们 `llm/` 已有 Gemini / Claude / DeepSeek / Qwen fallback 链。Ollama/LM Studio 尚缺。
- 按 PLAN D5 决策（embedding 默认 transformers.js，可切 Ollama），推理链也应支持本地降级。做法同 BrowserOS：`openai-compatible` 形态 + `baseUrl` 指向 `http://localhost:11434/v1`。

---

## 3. 中价值借鉴（值得记录，按需落地）

### 3.1 ACL 分级 + 高危操作守卫
BrowserOS 有 `ToolApprovalCategoryId` 体系：每个 tool 声明自己的审批类别；`acl-guard.ts` 运行时检查 site pattern / text match / 风险元素（password field、download、cross-origin）。

对比我们：已有 `AdminPolicy.forceConfirmActions` 和 `flagHighRisk`，粒度稍粗。可以参考 BrowserOS 把**风险判定从 act.ts 分离出独立 guard 模块**，便于扩展。

### 3.2 LLM Hub（多模型并排对比）
单页面 1/2/3 分窗，同 prompt 并行调用多 provider。`Cmd+Shift+U` 呼出。

定位：**偏消费向能力**，企业场景价值低；但对我们的调试 / persona 效果验证**有用**。可以作为 P2 之后的 extra feature（不影响主路线）。

### 3.3 Smart Nudges（上下文感知建议）
两种场景：
- **App Connection Nudge**：任务前检测到未连接的 app，弹卡片
- **Schedule Suggestion**：任务完成后识别可自动化，建议转为定时任务

对我们启发：是个**运营技巧**不是架构问题。把当前功能做扎实后可作为用户粘性增长项。

### 3.4 Cloud Sync 的分层策略
BrowserOS 严格分类：
- **同步**：会话历史、LLM provider 配置、scheduled tasks 配置
- **不同步**：**API 密钥（永不离设备）、Memory、SOUL.md、Theme、Workflows、task 执行结果**

我们 P1-16 已做书签 + 历史 E2E 同步，合适时机按同样粒度定义 "什么上云、什么本地"。**AuthVault 永不同步**这条我们已经执行，可以文档化成显式策略。

---

## 4. 不建议借鉴（架构不匹配或与我们定位冲突）

| 项 | 原因 |
|---|---|
| **Chromium fork** | 我们是 Electron，fork Chromium 是巨额工程 + 维护成本；Electron + Wujie-style 扩展已满足 |
| **MV2 uBlock Origin 完整版** | Electron 只能用 MV3 扩展；PLAN D6 已决策"MV3 最小子集"。Ad Blocker 用其他方案（host list / EasyList） |
| **Vertical Tabs** | UI 偏好，与我们 sidebar-agent 定位冲突；标签数不是当前瓶颈 |
| **40+ App Integrations 自建** | 应**经 MCP client 接入外部 MCP server**（§2.6），不要自己维护 Gmail/Slack 适配器 |
| **Bun 运行时** | Electron main process 必须 Node，不切 Bun |

---

## 5. 路线图增量建议

在现有 PLAN（已完成 P0 + P1 + P2-17/18/19）基础上，吸收 BrowserOS 借鉴加入：

| 顺序 | Stage | 来源 | 工作量估计 |
|---|---|---|---|
| **紧接 P2-20** | 二层 Memory（CORE.md + daily）+ memory_* tools | §2.1 | 1 周 |
| **紧接** | SOUL.md + Agent 自修改能力（进 AuditLog） | §2.2 | 3 天 |
| **紧接** | MCP **client** 接入外部 servers（对接 §2.6） | §2.6 | 4 天 |
| **并行** | Filesystem sandbox tools（read/write/grep + 目录 ACL） | §2.7 | 1 周 |
| **P3** | Skills 包对齐开放规范 + 迁移现有 persona.contentMd 到 skill 结构 | §2.3 | 1 周 |
| **P3** | Workflows（YAML 声明 → 可视化编辑） | §2.4 | 2–3 周 |
| **校准** | RoutinesEngine 加 stale timeout + run history 上限 + 受限工具集 | §2.5 | 2 天 |
| **校准** | LLM provider 增加 Ollama/LM Studio（openai-compatible 包装） | §2.8 | 1 天 |

---

## 6. 关键文件路径（BrowserOS 侧，便于深入读源）

| 模块 | 路径 |
|---|---|
| Agent step loop | `packages/browseros-agent/apps/server/src/agent/ai-sdk-agent.ts` |
| Tool framework | `.../tools/framework.ts` · `.../tools/tool-registry.ts` |
| ACL guard | `.../tools/acl/acl-guard.ts` |
| Memory search | `.../tools/memory/search.ts`（Fuse.js 分段 + 行级） |
| Skills loader | `.../skills/loader.ts` · `.../skills/catalog.ts` |
| SOUL 管理 | `.../lib/soul.ts` |
| MCP builder | `.../agent/mcp-builder.ts` · `.../agent/mcp-transport-detect.ts` |
| Provider factory | `.../agent/provider-factory.ts` |
| Scheduled Tasks | `packages/browseros-agent/apps/agent/entrypoints/background/scheduledJobRuns.ts` |
| HTTP server | `.../api/server.ts` · `.../api/routes/chat.ts` |

---

## 7. License 注意

BrowserOS 是 **AGPL v3**。
- ✅ **读源码学设计** — 合规
- ✅ **按自己的代码重新实现** — 合规
- ❌ **直接复制粘贴其代码到闭源项目** — 违规
- ❌ **fork 它再闭源分发** — 违规

本文档的所有借鉴项都应在 agent-browser 独立实现，不引入 BrowserOS 的源文件。
