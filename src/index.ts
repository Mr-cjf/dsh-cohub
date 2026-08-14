// dsh-port/src/index.ts
// CoHub DSH 插件行：中文指令注入 + 12 个专职代理技能 +（M4）多模型共识工具。
//
// 插件行导出约定（cordis 组合行）：
//   name    —— 插件名（重复检测 / 注入元数据）
//   inject  —— 依赖的服务 seam（systemPrompt / skills / tools）
//   Config  —— schemastery 运行时配置 schema（cordis.patch.yml 的 config 据此校验）
//   apply   —— 挂载时执行：注册系统提示词 section 与 runtime skills
import z from "@deepseek-ai/schemastery";
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

export function apply(ctx: any, config: any) {
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

  // ③ council_session 工具（M4）：配置了 councillors 时注册
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
