// dsh-port/src/index.ts
// CoHub DSH 插件行：中文指令注入 + 12 个专职代理技能 +（M4）多模型共识工具
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

/** 单个 councillor 配置（M4 council 工具使用） */
const Councillor = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string().default(undefined),
});

export const name = "cohub";
export const inject = ["systemPrompt", "skills", "tools"];

export const Config = z.object({
  /** 多模型共识 councillors（M4：非空时注册 council_session 工具） */
  councillors: z.array(Councillor).default([]),
  /** 单 councillor 超时（毫秒） */
  councilTimeoutMs: z.number().default(180_000),
  /** 子代理 provider（spawn 为内置进程内后端） */
  councilProvider: z.string().default("spawn"),
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

  // ② 12 个专职代理 → runtime skills
  //    主代理用 skill 工具按需加载，再通过 subagent 委派（DSH 原生），
  //    运行时技能目录中即出现 co-explorer / co-fixer / co-council 等条目。
  for (const skill of COHUB_SKILLS) {
    ctx.skills.register(skill);
  }

  // ③ 内置 agent preset（co-orchestrator）自动安装
  installAgentPresets(ctx.logger);

  // ④ council_session 工具（M4）：配置了 councillors 时注册
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
}
