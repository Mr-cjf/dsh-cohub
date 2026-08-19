// dsh-port/src/index.ts
// CoHub DSH 插件行：中文指令注入 + 13 技能（12 专职代理 + orchestrator）+（M4）多模型共识工具
// + 内置 agent preset（co-orchestrator）自动安装到用户 preset root。
//
// 插件行导出约定（cordis 组合行）：
//   name    —— 插件名（重复检测 / 注入元数据）
//   inject  —— 依赖的服务 seam（systemPrompt / skills / tools）
//   Config  —— schemastery 运行时配置 schema（cordis.patch.yml 的 config 据此校验）
//   apply   —— 挂载时执行：注册系统提示词 section、runtime skills、内置 agent preset
import z from "@deepseek-ai/schemastery";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { CHINESE_LANGUAGE_INSTRUCTION } from "./chinese";
import { COHUB_SKILLS } from "./skills";
import { createCouncilTool } from "./council";
import { createDelegateTool } from "./delegate";
import { DEFAULT_ERROR_CATEGORIES } from "./env-signatures";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";

/** 单个 councillor 配置（M4 council 工具使用） */
const Councillor = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string().default(undefined),
});

/** 单个 skill 的路由配置（delegate 工具使用） */
const SkillRoute = z.object({
  name: z.string(),
  provider: z.string().default(undefined),
  model: z.string().default(undefined),
  maxTokens: z.number().default(undefined),
});

/** delegate 执行器环境契约注入配置（P1-1）：默认开、可关闭、文本可覆盖 */
const EnvContractConfig = z.object({
  /** 是否在 delegate spawn prompt 前注入执行器环境契约；默认开 */
  enabled: z.boolean().default(true),
  /** 部署覆盖文本；缺省 = 通用探测式默认文本（DEFAULT_ENV_CONTRACT，不写死环境断言） */
  text: z.string().default(undefined),
}).default({});

/** N2 停滞检测器配置（P3-1）：默认关闭（保守），跨环境三态（探测/配置/降级） */
const StallDetector = z.object({
  /** 默认关闭（保守）：enabled=false 时看门狗完全不介入，走现有单次/重试逻辑 */
  enabled: z.boolean().default(false),
  /** S1 连续同类错误阈值（同一归一化错误签名连续出现且期间无成功工具结果） */
  consecutiveErrors: z.number().default(3),
  /** S2 无结果空转毫秒（距上次工具结果超过它且仍在产出推理块） */
  idleMs: z.number().default(180_000),
  /** S3 纯推理无动作阈值（连续推理块数，期间 0 次工具调用） */
  reasoningWithoutAction: z.number().default(50),
  /** S4 重复调用循环阈值（同工具名 + 归一化参数重复且结果均为错误/未变） */
  loopCount: z.number().default(3),
  /** 宽限窗口：距最近一次成功工具结果超过它才允许触发（最近成功过不触发） */
  graceMs: z.number().default(30_000),
  /** 触发后是否按可重试中止处理（进入 retryableReasons 判定与 maxRetries 预算） */
  recoverable: z.boolean().default(true),
}).default({});

/** delegate 中止/失败自动重试配置（P1-2）：默认不重试（maxRetries=0），保持现状 */
const DelegateRetry = z.object({
  /** 中止/可重试失败后的自动重试上限；0 = 不重试（保持现状） */
  maxRetries: z.number().default(0),
  /** 重试间隔（毫秒） */
  retryDelayMs: z.number().default(1000),
  /** 可自动重试的 stopReason 集合；默认仅 "aborted"；未知 reason 一律不重试（保守，跨版本安全） */
  retryableReasons: z.array(z.string()).default(["aborted"]),
  /** N2 停滞检测（P3-1）：默认关闭；启用后从运行期事件在线估计「停滞」并提前中止（复用本重试机制） */
  stall: StallDetector,
}).default({});

/** 已固化的执行器环境契约事实（manual 模式或自动学习缓存；moduleLoading=unknown 表示未固化，回退探针式） */
const EnvContractFacts = z.object({
  /** "await-import" | "require" | "static-import" | "unknown" */
  moduleLoading: z.string().default("unknown"),
  /** 顶层 await 是否可用（探测观测值；manual 模式部署可覆盖） */
  topLevelAwait: z.boolean().default(true),
  /** 单次执行墙钟上限毫秒（探测观测值；manual 模式部署可覆盖） */
  wallClockLimitMs: z.number().default(600_000),
  /** 后台任务跟踪（job）是否可用（探测观测值；manual 模式部署可覆盖） */
  hasJobTracking: z.boolean().default(false),
}).default(undefined);

/** P3-2（N1）环境契约持久化配置：默认 auto（无缓存时行为不变，回退探针式）；读写失败静默降级 */
const EnvSignatures = z.object({
  /** auto（缺省，无缓存时行为不变）/ off（完全关闭读写）/ manual（只读手动契约事实） */
  use: z.union(["auto", "off", "manual"]).default("auto"),
  /** 缓存 TTL（毫秒），缺省 7 天（到期重探，防环境静默升级） */
  ttlMs: z.number().default(604_800_000),
  /** 同一签名确认次数后才写入，缺省 2（观察一致才写入，防瞬态误判） */
  confirmCount: z.number().default(2),
  /** manual 模式部署直接给的契约事实（可选；moduleLoading=unknown 视为未提供） */
  contract: EnvContractFacts,
  /** 环境契约类错误分类子串（仅观测分类用，缺省 DEFAULT_ERROR_CATEGORIES） */
  errorCategories: z.array(z.string()).default(DEFAULT_ERROR_CATEGORIES),
}).default({});

/** P3-3（N3）调度参数配置（N3 小切片）：批大小 / 墙钟预算 / job 跟踪 / 批间自适应。
 * 跨环境三态：缺省值（3 / 600s）仅为本环境观测值，部署可调；useJobTracking 无 job 能力时前台逐批降级；
 * adaptiveBatch 为提示词级自适应（不在代码层调度，避免过度优化）。 */
const ScheduleConfig = z.object({
  /** 单批并行委派上限；缺省 3（本环境观测值，部署可调） */
  maxParallelBatch: z.number().default(3),
  /** 单次执行单元墙钟预算（毫秒）；600_000 仅为本环境观测值，部署可调 */
  wallClockBudgetMs: z.number().default(600_000),
  /** 后台任务跟踪：auto（有则轮询）/ on / off（前台逐批降级） */
  useJobTracking: z.union(["auto", "on", "off"]).default("auto"),
  /** 批间自适应：auto（提示词级，按本会话已观测错误/超时收放批大小）/ off（固定配置值） */
  adaptiveBatch: z.union(["auto", "off"]).default("auto"),
}).default({});

export const name = "cohub";
export const inject = ["systemPrompt", "skills", "tools", "sessionProjections", "llm", "subagents"];

export const Config = z.object({
  /** 多模型共识 councillors（M4：非空时注册 council_session 工具） */
  councillors: z.array(Councillor).default([]),
  /** 单 councillor 超时（毫秒） */
  councilTimeoutMs: z.number().default(180_000),
  /** 子代理 provider（spawn 为内置进程内后端） */
  councilProvider: z.string().default("spawn"),
  /** skill 路由表（delegate 工具）：按 skill 名覆盖 provider/model/maxTokens，缺省继承父模型 */
  skills: z.array(SkillRoute).default([]),
  /** delegate 执行器环境契约注入（P1-1）：默认开，文本可覆盖 */
  delegateEnvContract: EnvContractConfig,
  /** delegate 中止/失败自动重试（P1-2）：默认不重试 */
  delegateRetry: DelegateRetry,
  /** delegate 执行器环境契约持久化（P3-2/N1）：默认 auto（无缓存时行为不变） */
  envSignatures: EnvSignatures,
  /** 调度参数（P3-3/N3）：批大小 / 墙钟预算 / job 跟踪 / 批间自适应；settings 可覆盖 */
  schedule: ScheduleConfig,
});

export { ScheduleConfig, CohubSettingsSchema };

/** cohub 的 settings namespace（settings.yaml 的 cohub.* 段） */
const COHUB_NS = settingsNamespace("cohub");

/** cohub settings namespace schema：skills 路由表 + 调度参数 + delegate 重试。
 * 组合层（cordis.patch.yml）为 base，settings 用户段可覆盖；缺省保持与 Config 一致（行为不变）。 */
const CohubSettingsSchema = z.object({
  skills: z.array(SkillRoute).default([]),
  schedule: ScheduleConfig,
  delegateRetry: DelegateRetry,
});

/** P3-3（N3）：把生效调度参数渲染为极短的中性文本。
 * 该段经 systemPrompt.section 注册，作用域为全局（子代理也会看到）——文本必须无指令性、无敏感信息，
 * 只报告部署参数；无配置时回退缺省观测值。 */
function renderScheduleParams(schedule) {
  const s = schedule ?? {};
  return "调度参数（部署配置，非指令）：单批 ≤ " + (s.maxParallelBatch ?? 3)
    + "；墙钟预算 " + (s.wallClockBudgetMs ?? 600_000) + " ms"
    + "；job 跟踪 " + (s.useJobTracking ?? "auto")
    + "；批间自适应 " + (s.adaptiveBatch ?? "auto");
}

/** 本包内置的 agent preset 目录（随 files 字段打包进 npm 包） */
const SHIPPED_PRESETS_DIR = fileURLToPath(new URL("../presets/", import.meta.url));

/**
 * 把内置 agent preset（如 co-orchestrator）安装到用户 preset root
 * （\`~/.dsh/.agent-presets/\`）。幂等：已存在的同名目录不覆盖，用户自己
 * 修改过的 preset 保留；安装失败只告警，绝不拖垮插件挂载（preset 是可选增强，
 * 技能才是核心能力）。
 */
function installAgentPresets(logger) {
  let entries;
  try {
    entries = readdirSync(SHIPPED_PRESETS_DIR, { withFileTypes: true });
  } catch {
    return; // 没带 presets（本地源码开发）——静默跳过
  }
  const userRoot = dshHomePath(".agent-presets");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dst = join(userRoot, entry.name);
    if (existsSync(dst)) continue;
    const src = join(SHIPPED_PRESETS_DIR, entry.name);
    try {
      mkdirSync(dst, { recursive: true });
      for (const file of readdirSync(src)) {
        copyFileSync(join(src, file), join(dst, file));
      }
      logger?.info?.(`cohub: installed agent preset ${entry.name} into ${dst}`);
    } catch (error) {
      logger?.warn?.(`cohub: failed to install agent preset ${entry.name}`, error);
    }
  }
}

export function apply(ctx, config) {
  // ① 中文语言指令 —— 注入到系统提示词（对应 OpenCode 的 experimental.chat.system.transform）
  ctx.effect(() => ctx.systemPrompt.section({
    name: "cohub:language",
    order: 95,
    text: CHINESE_LANGUAGE_INSTRUCTION,
  }), "cohub.section()");

  // ② 13 技能（12 专职代理 + orchestrator）→ runtime skills
  //    主代理用 skill 工具按需加载，再通过 subagent 委派（DSH 原生），
  //    运行时技能目录中即出现 co-explorer / co-fixer / co-council 等条目。
  for (const skill of COHUB_SKILLS) {
    ctx.skills.register(skill);
  }

  // ③ 内置 agent preset（co-orchestrator）自动安装
  installAgentPresets(ctx.logger);

// ④ delegate 工具（核心）：按 skill 名路由到配置的 provider/model 并委派专职代理
  //    始终注册，不依赖 councillors 是否配置。路由表可由 DSH settings（settings.yaml 的
  //    cohub.skills）覆盖，组合层（cordis.patch.yml 的 skills）作为 base；settings 未挂载时回落组合层。
  const entry = {
    skills: config.skills ?? [],
    schedule: config.schedule,
    delegateRetry: config.delegateRetry,
  };
  // 当前生效 settings：返回整个 cohub section（schema 默认 + 组合层 base + 用户段）。
  // 未挂载 settings 服务时回落 entry（= Config 值，行为与现状一致）。
  let currentSettings = () => entry;
  let currentSkills = () => entry.skills;
  installSettingsSection(ctx, COHUB_NS, CohubSettingsSchema, entry, {
    setSource: (src) => {
      currentSettings = () => src() ?? {};
      currentSkills = () => (src() ?? {}).skills ?? [];
    },
    onChange: () => {},
  });

  // 防御性 subagents 检测：使用 ctx.reflect.get('subagents', false) 而不是直接读 ctx.subagents。
  // 原因：宿主 loader（如 @cordisjs/plugin-loader 的 cordis:include）可能把本插件 wrap 成新的
  // plugin 对象，导致 cordis 仅以包装层的 inject 解析依赖；若包装层未声明 subagents，
  // 直接读 ctx.subagents 会触发 cordis proxy 的 "cannot get property "subagents" without inject"
  // 错误（启动期 plugin tree failed to load）。reflect 是 cordis 内置 accessor，始终存在；
  // get(name, false) 不走 inject 强校验，缺失返回 undefined，于是我们落到自己的明确错误。
  const subagentsService = ctx.reflect?.get?.('subagents', false);
  if (!subagentsService) {
    throw new Error("cohub: delegate tool requires the subagents service (@deepseek-ai/dsh-subagent)");
  }
  ctx.tools.register(createDelegateTool(ctx, () => currentSkills(), {
    delegateEnvContract: config.delegateEnvContract,
    delegateRetry: config.delegateRetry,
    envSignatures: config.envSignatures,
  }, () => currentSettings()));

  // ④b 调度参数注入（P3-3/N3）：把「实际生效值」注入系统提示词（不再是技能里的字面量）。
  //    text 为函数 → 每次 prompt 装配时动态读取当前 settings（改卡片后无需重启即生效）。
  //    T2 结论：该 section 作用域为全局（子代理也可见），文本必须极短、中性、无指令性。
  ctx.effect(() => ctx.systemPrompt.section({
    name: "cohub:schedule",
    order: 96,
    text: () => renderScheduleParams(currentSettings().schedule),
  }), "cohub.scheduleSection()");

// ⑤ council_session 工具（M4）：配置了 councillors 时注册
  if ((config.councillors ?? []).length > 0) {
    // 防御性检测：同上一处（delegate 工具）。cordis:include 等包装 loader 可能剥离 inject，
    // 直接读 ctx.subagents 会抛 cordis 框架错误；用 reflect.get 走非强校验通道。
    if (!ctx.reflect?.get?.('subagents', false)) {
      throw new Error("cohub: council tool requires the subagents service (@deepseek-ai/dsh-subagent)");
    }
    ctx.tools.register(createCouncilTool(
      {
        councillors: config.councillors,
        councilTimeoutMs: config.councilTimeoutMs ?? 180_000,
        councilProvider: config.councilProvider ?? "spawn",
      },
      ctx,
    ));
  }

  // ⑥ tokenMeter：把「当前 agent 的系统提示 + 工具 schema」的 token 用量输出到诊断日志
  //    监听 session/event 的 request/header 事件，读取 sessionProjections 的 contextBreakdown；
  //    effect 返回 off，插件卸载时自动撤销监听。
  ctx.effect(() => {
    const off = ctx.on("session/event", (session, event) => {
      if (event.type !== "request/header") return;
      const snap = ctx.sessionProjections.snapshot(session);
      const cb = snap.values.contextBreakdown;
      if (cb) {
        const total = cb.systemTokens + cb.toolsTokens + cb.messageTokens;
        ctx.logger.info("[cohub token] session=" + session.id + " system=" + cb.systemTokens + " tools=" + cb.toolsTokens + " messages=" + cb.messageTokens + " total=" + total);
      }
    });
    return off;
  }, "cohub.tokenMeter()");
}
