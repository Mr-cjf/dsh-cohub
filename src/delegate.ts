// dsh-port/src/delegate.ts —— 专职代理委派工具（核心）
// 按 skill 名路由到配置的 provider/model，并自动拼接该 skill 的完整指令后 spawn 子代理。
// 子代理不继承父上下文，因此 prompt 必须自包含（skill 完整指令 + 用户具体任务）。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { COHUB_SKILLS } from "./skills";

/** 单个 skill 的路由配置（来自组合层 cordis.patch.yml 或 DSH settings 的 cohub.skills） */
export interface SkillRouteConfig {
  name: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
}

/** delegate 工具运行时路由源：返回当前生效的 skill 路由表 */
export type SkillRouteSource = () => SkillRouteConfig[];

/** 提取 ContentBlock 输出中的文本 */
function contentText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output
    .filter((b): b is { type: string; text?: string } =>
      !!b && typeof b === "object" && (b as { type?: string }).type === "text" && typeof (b as { text?: unknown }).text === "string",
    )
    .map(b => b.text as string)
    .join("\n\n");
}

/**
 * 创建 delegate 工具。
 * 按 skill 名精确匹配 COHUB_SKILLS，拼接该 skill 的完整指令 + 用户具体任务；
 * 通过 ctx.subagents.start("spawn", ...) 自包含地 spawn 子代理。
 * 路由经 getRoutes() 读取（组合层或 settings 解析后的当前值）；仅当该 skill 配置了可用
 * 的 provider 时才用 agentOptions 覆盖，provider 不可用或未配置则继承父/会话模型。
 */
export function createDelegateTool(ctx: any, getRoutes: SkillRouteSource) {
  return defineTool({
    name: "delegate",
    description: "把任务委派给指定专职代理：按 skill 名路由到配置的 provider/model，并自动拼接该技能的完整指令后 spawn 子代理。",

    parameters: {
      skill: {
        type: "string",
        required: true,
        description: "专职代理技能名，如 co-fixer/co-explorer/co-oracle",
      },
      prompt: {
        type: "string",
        required: true,
        description: "给该代理的具体任务",
      },
    },

    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [{ type: "text", text: String(value) }],
    },

    isConcurrencySafe: () => true,

    async execute(args: { skill: string; prompt: string }, exec: any) {
      const parent = exec?.agent;
      if (!parent) throw new Error("delegate requires a calling agent (exec.agent was undefined)");

      // ① 按 skill 名精确匹配技能
      const skill = COHUB_SKILLS.find(s => s.name === args.skill);
      if (!skill) throw new Error('delegate: unknown skill "' + args.skill + '"');

      // ② 查找该 skill 的路由配置（找不到则继承父模型）
      const route = (getRoutes() ?? []).find(s => s.name === args.skill);

      // ③ 拼接完整 skill 指令 + 用户具体任务（spawn 不继承父上下文，必须自包含）
      const promptText = skill.content + "\n\n--- 你的具体任务 ---\n\n" + args.prompt;

      // ④ 构造 agentOptions：仅当路由配置了 provider 且该 provider 在可用集合中才覆盖；
      //    provider 不可用或未配置则不传（继承父/会话模型，即兜底）。
      let agentOptions: Record<string, unknown> | undefined;
      if (route?.provider) {
        const available = new Set(ctx.llm.listProviders().map(p => p.id));
        if (available.has(route.provider)) {
          agentOptions = {
            provider: route.provider,
            ...(route.model ? { model: route.model } : {}),
            ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
          };
        }
      }

      // ⑤ spawn 子代理（第一个参数是 transport provider 名，固定 "spawn"；
      //    agentOptions.provider 才是 LLM 供应商名，两者不同，别搞混）
      const run = await ctx.subagents.start("spawn", {
        label: "delegate:" + args.skill,
        prompt: [{ type: "text", text: promptText }],
        parent,
        persona: "你是被委派的专职代理，严格遵循任务消息中的角色定义与工具指令。",
        ...(agentOptions ? { agentOptions } : {}),
        signal: exec.signal,
      });

      // ⑥ 收集结果并 dispose
      run.result.catch(() => {}); // dispose 后的拒绝不产生 unhandledRejection
      try {
        const outcome = await run.result;
        if (outcome.stopReason !== "completed") {
          throw new Error('delegate: subagent stopped with reason "' + outcome.stopReason + '"');
        }
        return contentText(outcome.output);
      } finally {
        try { run.dispose(); } catch { /* 已释放 */ }
      }
    },
  });
}
