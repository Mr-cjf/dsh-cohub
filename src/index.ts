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

/** delegate 中止/失败自动重试配置（P1-2）：默认不重试（maxRetries=0），保持现状 */
const DelegateRetry = z.object({
  /** 中止/可重试失败后的自动重试上限；0 = 不重试（保持现状） */
  maxRetries: z.number().default(0),
  /** 重试间隔（毫秒） */
  retryDelayMs: z.number().default(1000),
  /** 可自动重试的 stopReason 集合；默认仅 "aborted"；未知 reason 一律不重试（保守，跨版本安全） */
  retryableReasons: z.array(z.string()).default(["aborted"]),
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
});

/** cohub 的 settings namespace（settings.yaml 的 cohub.* 段） */
const COHUB_NS = settingsNamespace("cohub");

/** cohub settings namespace schema：skills 路由表（组合层 cordis.patch.yml 为默认值） */
const CohubSettingsSchema = z.object({
  skills: z.array(SkillRoute).default([]),
});

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
  const entry = { skills: config.skills ?? [] };
  let currentSkills = () => entry.skills;
  installSettingsSection(ctx, COHUB_NS, CohubSettingsSchema, entry, {
    setSource: (src) => { currentSkills = () => (src() ?? {}).skills ?? []; },
    onChange: () => {},
  });

  if (!ctx.subagents) {
    throw new Error("cohub: delegate tool requires the subagents service (@deepseek-ai/dsh-subagent)");
  }
  ctx.tools.register(createDelegateTool(ctx, () => currentSkills(), {
    delegateEnvContract: config.delegateEnvContract,
    delegateRetry: config.delegateRetry,
  }));

  // ⑤ council_session 工具（M4）：配置了 councillors 时注册
  if ((config.councillors ?? []).length > 0) {
    if (!ctx.subagents) {
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
