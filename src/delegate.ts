// dsh-port/src/delegate.ts —— 专职代理委派工具（核心）
// 按 skill 名路由到配置的 provider/model，并自动注入该 skill 的精简指令（brief）后 spawn 子代理。
// 子代理不继承父上下文，因此 prompt 必须自包含（skill 精简指令 + 执行器环境契约（可选）+ 用户具体任务）。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { COHUB_SKILLS } from "./skills.ts";
import { DEFAULT_ENV_CONTRACT } from "./env-contract.ts";

/** 单个 skill 的路由配置（来自组合层 cordis.patch.yml 或 DSH settings 的 cohub.skills） */
export interface SkillRouteConfig {
  name: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
}

/** delegate 工具运行时路由源：返回当前生效的 skill 路由表 */
export type SkillRouteSource = () => SkillRouteConfig[];

/** delegate 工具配置（来自插件 Config 的 delegateEnvContract / delegateRetry；未配置时用内置保守默认） */
export interface DelegateConfig {
  /** P1-1 执行器环境契约注入：默认开、可关闭、文本可覆盖 */
  delegateEnvContract?: {
    enabled?: boolean;
    text?: string;
  };
  /** P1-2 中止/失败自动重试：默认不重试（maxRetries=0），保持现状 */
  delegateRetry?: {
    maxRetries?: number;
    retryDelayMs?: number;
    retryableReasons?: string[];
  };
}

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
 * 按 skill 名精确匹配 COHUB_SKILLS，注入该 skill 的精简指令（brief）+（可选）执行器环境契约 + 用户具体任务；
 * 通过 ctx.subagents.start("spawn", ...) 自包含地 spawn 子代理。
 * 路由经 getRoutes() 读取（组合层或 settings 解析后的当前值）；仅当该 skill 配置了可用
 * 的 provider 时才用 agentOptions 覆盖，provider 不可用或未配置则继承父/会话模型。
 *
 * P1-1：config.delegateEnvContract.enabled=true（默认）时，在 skill 内容与任务之间插入
 *       「--- 执行器环境契约 ---」+ 通用原则/探测流程文本（text 可覆盖，缺省 DEFAULT_ENV_CONTRACT），
 *       让子代理在陌生执行环境里「带地图干活」而非现场盲试；文本不写死任何环境断言。
 * P1-2：config.delegateRetry 控制中止/失败后的自动重试。默认 maxRetries=0（一次尝试，失败即抛错，
 *       且带结构化 cause）；>0 时仅对 retryableReasons 中的 reason 重试（未知 reason 一律不重试，保守），
 *       重试 prompt 追加原因 + 已完成部分，提示从中断处继续。
 */
export function createDelegateTool(ctx: any, getRoutes: SkillRouteSource, config: DelegateConfig = {}) {
  // 生效的注入/重试配置（防御式默认，未配置或配置为 undefined 时回落保守默认）
  const envContract = {
    enabled: config.delegateEnvContract?.enabled ?? true,
    text: config.delegateEnvContract?.text ?? DEFAULT_ENV_CONTRACT,
  };
  const retry = {
    maxRetries: Math.max(0, Math.trunc(config.delegateRetry?.maxRetries ?? 0)),
    retryDelayMs: Math.max(0, config.delegateRetry?.retryDelayMs ?? 1000),
    retryableReasons: config.delegateRetry?.retryableReasons ?? ["aborted"],
  };
  const RETRYABLE = new Set(retry.retryableReasons);

  return defineTool({
    name: "delegate",
    description: "把任务委派给指定专职代理：按 skill 名路由 provider/model，自动注入该代理的精简指令后 spawn 子代理。",

    parameters: {
      skill: {
        type: "string",
        required: true,
        description: "专职代理技能名，如 co-fixer/co-explorer/co-oracle",
      },
      prompt: {
        type: "string",
        required: true,
        description: "给该代理的具体任务（写全目标、相关文件路径、约束、期望输出格式）",
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

      // ③ 注入该 skill 的精简指令（brief）+ 用户具体任务（spawn 不继承父上下文，必须自包含）
      const brief = skill.brief?.trim();
      if (!brief) {
        ctx.logger?.warn?.(`delegate: skill "${args.skill}" 缺少 brief，回退完整 content`);
      }

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

      // ⑤ 执行器环境契约注入（P1-1）：enabled=true 时在 skill 内容与任务之间插入通用探测式文本，
      //    避免子代理在陌生执行环境里盲试；文本可由部署覆盖（text），缺省为通用探测式默认。
      const contractText = envContract.enabled
        ? "\n\n--- 执行器环境契约（通用原则 + 探测式自适应） ---\n\n" + envContract.text
        : "";

      // ⑥ 中止/失败重试循环（P1-2）：默认 maxRetries=0 → 单次尝试，失败即抛错（带结构化 cause）；
      //    可配置重试，重试 prompt 追加原因 + 已完成部分，提示从中断处继续。
      let lastReason = "unknown";
      let lastPartial = "";
      let retries = 0;

      for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
        const retryNote = attempt > 0
          ? "\n\n[重试 #" + attempt + "] 上一次执行中止，原因：" + lastReason
            + "；已完成部分：" + (lastPartial || "（无）")
            + "。请从中断处继续，不要重复已完成步骤。"
          : "";
        const promptText = (brief || skill.content) + contractText + "\n\n--- 你的具体任务 ---\n\n" + args.prompt + retryNote;

        // ⑦ spawn 子代理（第一个参数是 transport provider 名，固定 "spawn"；
        //    agentOptions.provider 才是 LLM 供应商名，两者不同，别搞混）
        const run = await ctx.subagents.start("spawn", {
          label: "delegate:" + args.skill,
          prompt: [{ type: "text", text: promptText }],
          parent,
          persona: "你是被委派的专职代理：严格遵循任务消息中的角色定义、关键约束、输出格式与工具指令，并完成末尾的具体任务。",
          ...(agentOptions ? { agentOptions } : {}),
          signal: exec.signal,
        });
        run.result.catch(() => {}); // dispose 后的拒绝不产生 unhandledRejection
        let outcome: any;
        try {
          outcome = await run.result;
        } finally {
          try { run.dispose(); } catch { /* 已释放 */ }
        }

        if (outcome?.stopReason === "completed") return contentText(outcome.output);
        lastReason = String(outcome?.stopReason ?? "unknown");
        lastPartial = contentText(outcome?.output ?? []).slice(0, 500);
        if (!RETRYABLE.has(lastReason) || attempt >= retry.maxRetries) break;
        retries++;
        await new Promise(r => setTimeout(r, retry.retryDelayMs));
      }

      // ⑧ 重试耗尽（或不可重试）：抛错并回传结构化 cause（通用，不依赖任何环境枚举）
      const err: any = new Error(
        'delegate: subagent stopped with reason "' + lastReason + '" after ' + retries + ' retry(ies); partial: ' + lastPartial,
      );
      err.cause = { stopReason: lastReason, partial: lastPartial, skill: args.skill, retries };
      throw err;
    },
  });
}
