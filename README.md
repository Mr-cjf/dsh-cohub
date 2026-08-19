# dsh-cohub

DeepSeek Harness 版 [oh-my-opencode-cohub](https://github.com/Mr-cjf/oh-my-opencode-cohub)：中文智能体编排插件。
把「纯调度模式 + 12 专职代理 + 多模型共识 + 运行期调度韧性」移植到 DSH 原生能力之上。

## 与 OpenCode 版的机制映射

| OpenCode 版（oh-my-opencode-cohub） | DSH 版（本包） |
|---|---|
| 12 个 agent 注册（双重注册 + config hook） | 12 个 runtime skills（本插件 apply 时注册） |
| 中文注入 experimental.chat.system.transform | ctx.systemPrompt.section |
| task 工具 + 并行派发 | DSH 原生 subagent 工具（后台/续聊） |
| todowrite | DSH 原生 todo_write |
| Background Job Board（消息注入） | DSH 原生 job board（删除） |
| ContextEngine 上下文提取 | subagent_fork 继承会话（删除） |
| council_session 工具 | M4：workflow 并行 + provider/model 覆盖 |
| TUI 面板 | DSH Web GUI 原生面板（删除） |
| CLI 安装器 | dsh plugin add（转发 pnpm） |
| **M2/M3/M4 调度韧性**（N2 停滞检测 / N3 调度参数） | **P3-1/P3-3 切片**（stall 检测器 + schedule 配置 + systemPrompt 段） |
| **环境契约一次学习持续使用**（N1） | **P3-2 切片**（envSignatures 模块 + 缓存到 `~/.dsh/cohub/env-signatures.json`） |

> 注：`dsh plugin add` 不是 CLI 独立子命令，而是把参数转发给 profile 目录内的 `pnpm`（`dsh plugin --profile <name> add <pkg>` ≡ 在该 profile 执行 `pnpm add <pkg>`），安装后自动把声明 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`。

## 技能清单（12 个）

co-orchestrator（调度）/ co-planner（方案）/ co-oracle（审查）/
co-explorer（搜索）/ co-librarian（研究）/ co-observer（视觉）/
co-fixer（执行）/ co-designer（UI）/ co-council（共识）/
co-rule-user / co-rule-project / co-rule-app（规范分析）

## 构建

前置：系统 bun（与主仓库一致）。

```bash
cd dsh-cohub
npm run build
# 等价于：
#   bun run scripts/generate-skills.ts   # 生成 src/skills.ts
#   bun build src/index.ts --outdir lib --target node --format esm \
#     --external @deepseek-ai/cordis --external @deepseek-ai/schemastery \
#     --external @deepseek-ai/dsh-tools --external @deepseek-ai/dsh-system-prompt \
#     --external @deepseek-ai/dsh-skill --external @deepseek-ai/dsh-home-paths \
#     --external @deepseek-ai/dsh-settings
#   bun run scripts/build-client.js       # src/client/index.js → lib/client.js
```

## 安装到 profile

```bash
dsh plugin --profile web add dsh-cohub
```

本地开发安装：

```bash
dsh plugin --profile web add C:\Users\14023\Desktop\dsh-cohub
```

或手动：profile 的 package.json

```json
{
  "dependencies": { "dsh-cohub": "file:../dsh-cohub" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-cohub"] } }
}
```

## 配置（profile 的 cordis.patch.yml，按行 id "cohub" 覆盖）

最小配置（不开 council）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors: []          # 为空则不注册 council_session 工具
    councilTimeoutMs: 180000
    skills: []               # delegate 委派路由（可用 settings.yaml 的 cohub.skills 覆盖）
```

**M4 启用 council**（councillors 非空时自动注册 council_session 工具）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors:
      - { name: expert1, provider: deepseek-official, model: deepseek-v4-flash }
      - { name: expert2, provider: pi-ai, model: pi-ai-large }
      - { name: expert3, provider: deepseek-official, model: deepseek-v4-pro, prompt: 你是首席架构师，先列风险再给结论 }
```

**P3 完整配置**（cordis.patch.yml 第 18 行起所有注释块都是可选 profile 覆盖）：

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    # delegateEnvContract：环境契约注入（默认开）。部署已知环境可覆盖 text 跳过探测：
    delegateEnvContract: { enabled: true }
    # delegateRetry：中止/失败自动重试。默认不重试（保持现状）。
    # P3-1 N2 停滞检测：默认关闭（enabled=false），启用后在 spawn 子代理时挂 StallWatchdog，
    # 按 session/event 在线估计 S1-S4 信号并提前中止（复用 delegateRetry 重试预算）。
    delegateRetry:
      maxRetries: 2
      retryDelayMs: 1500
      retryableReasons: ["aborted"]
      stall:
        enabled: true
        consecutiveErrors: 3      # S1 连续同类错误阈值
        idleMs: 180000            # S2 无结果空转毫秒
        reasoningWithoutAction: 50 # S3 纯推理无动作阈值
        loopCount: 3              # S4 同工具名 + 同参数重复次数
        graceMs: 30000            # 宽限窗口
        recoverable: true         # 触发后按 retryableReasons 判定
    # P3-2 N1 环境契约持久化：默认 auto（无缓存时行为不变）。
    # 累计同一归一化签名达 confirmCount 次后写入 dshHomePath("cohub","env-signatures.json")。
    envSignatures:
      use: auto                  # auto / off / manual
      ttlMs: 604800000           # 7 天
      confirmCount: 2
    # P3-3 N3 调度参数：通过 systemPrompt.section 注入实际生效值（cohub:schedule），子代理可见。
    schedule:
      maxParallelBatch: 3
      wallClockBudgetMs: 600000
      useJobTracking: auto       # auto / on / off
      adaptiveBatch: auto        # auto / off
```

完整字段含义与缺省见 [`cordis.patch.yml`](cordis.patch.yml) 顶部注释块。

## 使用

1. 主会话中让模型加载 co-orchestrator 技能（skill 工具）
2. 按提示词流程：信息收集（并行 subagent）→ co-planner 方案 → 审核 → 执行 → 验证
3. 子代理统一通过 DSH 原生 subagent 工具委派，后台任务走 job board

### settings 卡片

`npm run build` 后重启 DSH，打开设置 → **插件** 标签，可看到「CoHub 代理模型」卡片：

- **12 个 skill 行**（每个独立配置 provider / model）
- **调度参数（可选）**：批大小 / 墙钟预算 / Job 跟踪 / 批间自适应
- **委派重试 / 重试间隔**：maxRetries / retryDelayMs / 可重试原因（逗号分隔）
- **停滞检测（可选）**：启用复选框 + 5 个阈值 + 可重试复选框（未启用时数字输入框 disabled）
- **环境契约持久化（可选）**：契约模式（auto/off/manual）/ 缓存 TTL / 确认次数

改卡片后无需重启即生效（`text` 是函数，每次 prompt 装配时动态读取当前 settings）。

### 环境契约持久化

`envSignatures.use="auto"` 时：

- 累计同一归一化错误签名（`err:<msg>#`）出现 ≥ `confirmCount`（缺省 2）次
- 写入 `~/.dsh/cohub/env-signatures.json`（插件自管，不依赖 settings）
- 下次 spawn 命中缓存（指纹一致 + TTL 内）→ 用确定性契约文本前馈注入，跳过探针

`use="off"` 不读不写，每次都走 DEFAULT_ENV_CONTRACT 探针式。
`use="manual"` 只读 manual 配置（schema 中 `contract` 字段，部署可静态指定），不学习。

### 停滞检测

`delegateRetry.stall.enabled=true` 时启用：

- 通过 `ctx.on("session/event")` 监听 session/event 全局事件总线，按 `run.id` 归属子代理事件
- 四类噪声信号：S1 连续同类错误 / S2 无结果空转 / S3 纯推理无动作 / S4 重复调用循环
- 触发条件：`S1 ∪ (S2 ∪ S3 ∪ S4)` **且**距最近一次成功工具结果超过 `graceMs`（最近成功过不触发）
- 触发后 `ac.abort()` 提前中止，复用 `delegateRetry` 重试预算（`recoverable=true`）
- T3：父 `exec.signal` 中止通过内部 `AbortController` 转发到子代理
- 降级：若 `ctx.on` 缺失（无事件源），自动降级关闭，看门狗完全不介入（维持现状）
- `error.cause.stall` 写入结构化信息 `{ signals: [...], diagnostics: "..." }`

无事件源的部署会自动降级，不会因缺失 session/event 而崩。

### 会话审计

会话导出目录（含根 `session.jsonl` + `subagents/.../session.jsonl`）可跑：

```bash
npm run audit -- <sessionDir> [--rules <json>] [--rules-file <path>] [--json <out>]
```

输出工具调用/结果/错误、错误类别、通用"重复盲试"、委派树、墙钟超时与环境签名。完整规则与退出码见 `scripts/audit-session.mjs` 顶部注释。

## co-orchestrator agent preset（Phase 2）

`presets/co-orchestrator/` 提供调度者主代理身份（persona + 调度工具面：subagent/fork/workflow/skill/todo/jobs/ask-user/goal）。

**自动安装**：本包在 `apply` 时会把内置 preset 复制到 `~/.dsh/.agent-presets/co-orchestrator/`（幂等，不覆盖你已修改的同名 preset）。`dsh plugin --profile web add dsh-cohub` 装完重启后，即可在 GUI 的 agent preset 选择器中切换，无需手动操作。

若 preset 未出现（例如本地源码开发、或想手动摆放），可兜底执行：

```bash
mkdir -p ~/.dsh/.agent-presets/co-orchestrator
cp presets/co-orchestrator/* ~/.dsh/.agent-presets/co-orchestrator/
```

在 GUI 的 agent preset 选择器中切换。注意（rc.6 限制）：子代理继承父代理的 preset 组合且 toolFilter 只能收窄，因此 preset 不硬性移除文件工具——「绝不亲自操作文件」由 co-orchestrator 技能在提示词层约束（与 OpenCode 原版一致）。

## 测试

```bash
node test/unit.ts          # 基础集成（12 技能 + 内容 + brief + delegate 注入 + M4 council）
node test/delegate-p1.ts   # P1：环境契约注入 + 重试
node test/stall-p3.ts      # P3-1 N2 停滞检测（35 用例）
node test/schedule-p3.ts   # P3-3 N3 调度参数（24 用例）
node test/env-sig-p3.ts    # P3-2 N1 环境契约持久化（50 用例）
```

基线合计 **137 用例全 PASS / 0 FAIL**（node >= 24）。无需 LLM，单测纯本地模拟。

## 目录

```
skills/            提示词源文件（.md，人工编辑；scripts/generate-skills.ts 据此生成 src/skills.ts）
scripts/
  generate-skills.ts    .md → src/skills.ts（必须先跑）
  build-client.js       src/client/index.js → lib/client.js
  audit-session.mjs     会话导出目录审计 / 回归
src/
  index.ts              插件行入口（apply、Config schema、P3 三切片 schema）
  delegate.ts           delegate 工具 + P3-1 StallWatchdog
  env-signatures.ts     P3-2 环境契约持久化（EnvSignatureLearner + 缓存）
  skills.ts             generate-skills.ts 生成物（禁止手编）
  client/index.js       settings 卡片（i18n + 12 个 P3 控件）
presets/co-orchestrator/  内置 agent preset（Phase 2）
test/
  unit.ts               基础集成
  delegate-p1.ts        P1 环境契约注入 + 重试
  stall-p3.ts           P3-1 N2 停滞检测
  schedule-p3.ts        P3-3 N3 调度参数
  env-sig-p3.ts         P3-2 N1 环境契约持久化
cordis.patch.yml        bundle patch（含 P1/P3 全部 profile 字段示例）
```

> DSH 处于 0.1.0-rc 阶段，本包 peerDependencies 锁定 rc.6。