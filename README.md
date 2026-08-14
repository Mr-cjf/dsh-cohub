# dsh-cohub

DeepSeek Harness 版 [oh-my-opencode-cohub](https://github.com/Mr-cjf/oh-my-opencode-cohub)：中文智能体编排插件。
把「纯调度模式 + 12 专职代理 + 多模型共识」移植到 DSH 原生能力之上。

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
| CLI 安装器 | dsh plugin add（删除） |

## 技能清单（12 个）

co-orchestrator（调度）/ co-planner（方案）/ co-oracle（审查）/
co-explorer（搜索）/ co-librarian（研究）/ co-observer（视觉）/
co-fixer（执行）/ co-designer（UI）/ co-council（共识）/
co-rule-user / co-rule-project / co-rule-app（规范分析）

## 构建

前置：系统 bun（与主仓库一致）。

```bash
cd dsh-port
npm run build   # generate-skills.ts 生成 src/skills.ts → bun build → lib/index.js
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
  "dependencies": { "dsh-cohub": "file:../dsh-port" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-cohub"] } }
}
```

## 配置（profile 的 cordis.patch.yml，按行 id "cohub" 覆盖）

```yaml
- id: cohub
  name: 'dsh-cohub'
  config:
    councillors: []          # 为空则不注册 council_session 工具
    councilTimeoutMs: 180000
    councilProvider: spawn
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

council_session 由配置了 councillors 的部署自动提供给模型；模型端约定由 co-council 技能使用。

## 使用

1. 主会话中让模型加载 co-orchestrator 技能（skill 工具）
2. 按提示词流程：信息收集（并行 subagent）→ co-planner 方案 → 审核 → 执行 → 验证
3. 子代理统一通过 DSH 原生 subagent 工具委派，后台任务走 job board

## co-orchestrator agent preset（Phase 2）

`presets/co-orchestrator/` 提供调度者主代理身份（persona + 调度工具面：subagent/fork/workflow/ralph/skill/todo/jobs/ask-user/goal）。安装：

```bash
mkdir -p ~/.dsh/.agent-presets/co-orchestrator
cp presets/co-orchestrator/* ~/.dsh/.agent-presets/co-orchestrator/
```

在 GUI 的 agent preset 选择器中切换。注意（rc.6 限制）：子代理继承父代理的 preset 组合且 toolFilter 只能收窄，因此 preset 不硬性移除文件工具——「绝不亲自操作文件」由 co-orchestrator 技能在提示词层约束（与 OpenCode 原版一致）。

## 目录

```
skills/          提示词源文件（.md，人工编辑）
scripts/         generate-skills.ts（.md → src/skills.ts）
src/             插件行入口 + 生成物（council.ts = M4 共识工具）
presets/         co-orchestrator agent preset（Phase 2）
test/            unit.ts 运行时单测（node test/unit.ts，无需 LLM）
cordis.patch.yml bundle patch（挂载本包到 profile 组合）
```

> DSH 处于 0.1.0-rc 阶段，本包 peerDependencies 锁定 rc.6。
