# 极简模式分析与 cohub 优化决策记录

## 1. 背景
用户观察到 DSH 的「极简模式」下模型能力"巨幅提升"，且模型思考中几乎不出现 "let me ..." 这类元叙述。本文记录对极简模式的分析结论、其能力提升的机制解释，以及据此对 dsh-cohub 插件所做的优化决策与依据。

## 2. 极简模式是什么
- 定义：仅 2 个工具（持久 bash + str_replace_editor）+ 固定一句话 persona（"You are a helpful software engineer assistant."）+ 无上下文压缩 + 不注入运行时上下文快照。
- 官方公开口径：用于在最小环境里基准测试模型（benchmarking models in a minimal environment）。
- 官方内部定位（Agent Notes）：minimal preset 是「与 Claude SWE 兼容的 RL agent」的完整组合——"the sole Web owner of the RL agent composition"。

## 3. 为什么强（四项机制 + 边界）
1. RL 分布匹配（最根本）：模型很可能在双工具动作空间上做 RL 训练/偏好对齐；极简模式让推理分布 ≈ 训练分布。官方原文出现 "action space" 与 "match the intended training runtime"。
2. 认知负荷收窄：工具多 → 每步多一层"选工具"决策 + token 开销 + 出错面；收敛到双工具后选择退化为几乎无成本的二分（跑环境 bash / 改文件 editor），推理预算回笼主链路。
3. 系统提示词纯度：complete:true 移除所有其它系统提示 token（官方 persona README：complete mode removes every other system-prompt token；KV Cache 前缀稳定）。指令遵循是基准性能第一驱动力。
4. 元能力诱惑归零：subagent/workflow/plan/goal 的工具描述本身是软指令，会诱导"为了用而用"；物理移除 = 能力限制即正则化。
- 最小完备集：bash（持久）= 图灵完备的通用执行器；str_replace_editor = 精确可验证的写入器（不匹配即报错）。两者覆盖"观察执行"与"可控变更"两条不可约能力轴。
- "不会 let me"：元叙述消失 = 决策负担下降的行为指纹（用户观察，公开资料中暂无对应讨论）。
- 应对决策（消除「let me 独自做」的个体叙述）：已将 Orchestrator persona 第 1 句改为「主调度者集群」集体身份——「你是 cohub 中文智能体编排体系的主调度者集群（Orchestrator）——思考时以集群方式协作，调用不同代理集群分工处理，而非以独立个体独自完成」；这是把自我认知从「独立个体」锚定为「集群」，让模型以团队分工思维替代个体独行叙述。
- 边界（反噬场景）：长任务（无压缩→上下文溢出）、多文件大重构（无 plan 脚手架）、检索/联网/视觉、并行扇出、强安全约束。

## 4. 移植到 cohub 的原则
- 不能照搬双工具：cohub 是多工具编排器，subagent/subagent_fork/workflow 是"纯调度"的核心能力面。
- 可移植：persona 纯净、提示词质量、工具面收敛（restrict）、上下文注入最小化。
- 明确不做：toolOrder（code 模式下 native 名无效）、complete:true（会抑制 run_code SDK 声明）、includeHarnessIdentity:false。

## 5. 第一波优化（已完成）
- persona 由三环改六步（对齐工作流），封堵 run_code 内 node:fs 后门，删除重复中文行（由全局 chinese.ts 单源覆盖）。
- skills/orchestrator.md 工具清单补全（含 workflow/ralph/goal/send_message/interrupt_agent），三处"禁止"合并到规则2，封堵 node:fs。
- 5 个长 skill（oracle/designer/council/fixer/rule-app）保守精简为四段式，领域知识全保留。
- 12 个 skill description 单句化（≤30 字）。
- 版本 v0.1.1 → v0.2.0；构建通过。

## 6. 第二波优化（已完成）
- 删除 tool-ralph（低频委派工具）✅
- compaction（自动压缩）❌ 已移除：用户决定不需要自动压缩，长会话不做摘要/压缩
- 新增 tokenMeter 测量点（src/index.ts，inject 加 sessionProjections，监听 session/event 输出 contextBreakdown 诊断日志）✅
- maxParallelSubCalls ❌ 未落地：审查发现全局副作用（影响所有 agent）+ 可能被后置 patch 覆盖失效 + YAGNI，且追加时引入 YAML 缩进错误（P0），已删除该覆盖，保留默认 10。

## 7. 第三波：工具代理（工具与推理分离）

### 背景
用户实验发现：模型使用工具时推理能力下降（工具上下文本身抑制推理深度）。据此把「工具执行」与「深度推理」分离：推理型代理保持无工具的纯净上下文，工具操作统一交给专门的工具代理。

### 已落地（软约束版）
- 新增 co-tool 工具代理（第 13 个 skill）：唯一持有文件/命令操作（node:fs + child_process），补输出截断（8000 字符）、二进制 base64、命令超时（300s）/退出码约束。
- 11 个专职代理去工具化：职责改为「决策/方案/分析」，文件读写/搜索/构建/测试统一 delegate 给 co-tool。
- delegate 工具：按 skill 路由 provider/model（DSH settings 配置 `cohub.skills` 热更新，`cordis.patch.yml` 的 `config.skills` 作为组合层默认值（base））、自动拼 skill 完整指令、中性 persona 覆盖（避免子代理继承调度者的「绝不亲自操作」persona 冲突）。
- provider 可用性校验：委派前用 `ctx.llm.listProviders()` 查已注册供应商，动态判断可用性。
- 兜底：provider 未配置或不可用（不在注册列表）→ 不传 `agentOptions` → 子代理自动继承会话模型，不报错。
- 配置示例（settings.yaml）：
```yaml
# settings.yaml
cohub:
  skills:
    - { name: co-fixer, provider: deepseek-official, model: deepseek-v4-flash }
    - { name: co-oracle, provider: anthropic, model: claude-sonnet-4 }
    # 未配置的 skill 继承会话模型
```
- 数字对齐：13 技能（12 专职代理 + orchestrator）。

### 物理隔离结论（关键，诚实记录）
- 调研发现：cohub 的文件操作实际经 run_code 的 node:fs（mode:code），而 node:fs 是 worker-thread 的固有 JS 能力，**不归 sandbox / toolFilter 管辖**（toolFilter 只管「工具」，管不到 run_code 内部 API）；官方源码明言 run_code 隔离是「containment, not a security boundary」。
- DSH sandbox 只有 read-only（只拒写、读全盘放行），无「无文件访问」模式；SubagentStartRequest 无 sandbox/preset 字段，子代理只能继承父 preset。
- per-child preset/mode 切换 DSH 不支持（spawn 硬编码 composeFrom 继承父 preset；recompose 有竞态与日志失配风险）。
- 结论：**物理隔离在 cohub 插件层面不可行，需改 DSH 源码**（给 ChildComposition/SubagentStartRequest 加 preset 字段并让 applyChildComposition 走 mount）。按用户决策接受软约束。
- 软约束的实际效果：省工具 schema（对「工具抑制推理」有部分缓解）；但 node:fs 挡不住，数据隔离未达成。

## 8. 关键来源
- 官方 Agent Notes（deepseek-ai/deepseek-harness 仓库 .agents/notes/implemented/）：
  - 2026-08-10-minimal-preset-owns-rl-composition.md
  - 2026-08-11-minimal-profiles-bare-two-tool-runtime.md
  - 2026-07-29-persistent-bash-str-replace-editor.md
  - 2026-08-10-default-presets-single-editor.md
- 官方 persona 机制：packages/preset/persona/README.md（complete mode + KV Cache 前缀稳定）
- 官方站：https://www.deepseek.com/harness/en/
- 社区：dev.to "DeepSeek Harness Is Open Source: Everything Is a Plugin"；Hacker News 294 评论帖（作者在场但未正面回答"RL 与推理是否同一 harness"）
- Anthropic 工程博客：multi-agent-research-system（工具设计"质量>数量"）

## 9. 待办 / 未决
- "DSec 沙箱 agent 在 RL 期间用 minimal mode" 系社区粉丝号声称，未经官方确认。
- "不会 let me" 现象无公开讨论，属用户观察，机制上自洽（决策负担下降）。
- 物理隔离（推理型代理无 node:fs、co-tool 有）为 DSH 层限制，需改 DSH 源码才能实现，属独立大需求（当前未做）。
