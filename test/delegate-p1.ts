// dsh-port/test/delegate-p1.ts —— P1 单测（fake subagents + fake ctx，无需 LLM）
// 覆盖：环境契约注入（enabled/text）、可配置重试（maxRetries/未知 reason）、
//       delegate 路由不回归（agentOptions 覆盖 / provider 不可用继承父模型）。
// 用法：bun run test/delegate-p1.ts（或 node test/delegate-p1.ts，node >= 24 类型剥离）
import { createDelegateTool } from "../src/delegate.ts";

/** delegate 注入的特有标记：技能内容里 P0 已有「## 执行器环境契约」段落，故用带围栏的「--- … ---」区分 */
const DELEGATE_CONTRACT_MARKER = "--- 执行器环境契约（通用原则 + 探测式自适应） ---";

/** fake ctx：只提供 delegate 用到的 subagents.start / llm.listProviders */
function makeCtx(startImpl: (req: any) => any, providers: any[] = []) {
  return {
    llm: { listProviders: () => providers },
    subagents: {
      async start(_transport: string, req: any) {
        return startImpl(req);
      },
    },
  };
}

function makeExec() {
  return { agent: { id: "parent-1" }, signal: new AbortController().signal };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++; else fail++;
}

// ---- 用例 1：环境契约注入 ----
{
  console.log("===== 用例 1：环境契约注入 =====");
  let captured: string[] = [];
  const start = (req: any) => {
    captured.push(req.prompt[0].text);
    return { id: "c1", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const ctx = makeCtx(start, [{ id: "deepseek-official" }]);

  // enabled=true（默认）
  const toolOn = createDelegateTool(ctx, () => [{ name: "co-fixer", provider: "deepseek-official", model: "m1" }]);
  await toolOn.execute({ skill: "co-fixer", prompt: "测试任务" }, makeExec());
  check("enabled=true 注入 delegate 契约标记", captured[0].includes(DELEGATE_CONTRACT_MARKER));
  check("enabled=true 注入「先验证再批量」", captured[0].includes("先验证再批量"));
  check("enabled=true 注入「探测流程」", captured[0].includes("探测流程"));

  // enabled=false：技能内容本身（P0）可能已含契约段落，只要求不含 delegate 注入标记
  captured = [];
  const toolOff = createDelegateTool(ctx, () => [], { delegateEnvContract: { enabled: false } });
  await toolOff.execute({ skill: "co-fixer", prompt: "测试任务" }, makeExec());
  check("enabled=false 不含 delegate 契约标记", !captured[0].includes(DELEGATE_CONTRACT_MARKER));
  check("enabled=false 不含「--- 你的具体任务 ---」外的额外分隔（任务正常拼接）", captured[0].includes("--- 你的具体任务 ---"));

  // text 覆盖
  captured = [];
  const toolCustom = createDelegateTool(ctx, () => [], {
    delegateEnvContract: { enabled: true, text: "部署自定义契约文本 ABC123" },
  });
  await toolCustom.execute({ skill: "co-fixer", prompt: "测试任务" }, makeExec());
  check("text 覆盖生效（不再用默认探测文本）", captured[0].includes("部署自定义契约文本 ABC123"));
  check("text 覆盖后不含默认探测短语", !captured[0].includes("最小探针依次尝试候选写法"));
}

// ---- 用例 2：maxRetries=0 中止即抛错且 cause.stopReason 存在 ----
{
  console.log("===== 用例 2：maxRetries=0 中止即抛错（保持现状） =====");
  let spawnCount = 0;
  const start = () => {
    spawnCount++;
    return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "partial work" }], stopReason: "aborted" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 0 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("抛错", !!err);
  check("spawn 次数 = 1（不重试）", spawnCount === 1);
  check("err.cause.stopReason === aborted", err?.cause?.stopReason === "aborted");
  check("err.cause.skill === co-fixer", err?.cause?.skill === "co-fixer");
  check("err.cause.retries === 0", err?.cause?.retries === 0);
  check("err.cause.partial 含已完成部分", typeof err?.cause?.partial === "string" && err.cause.partial.includes("partial work"));
}

// ---- 用例 3：maxRetries=2 中止重试 ≤2 次，重试 prompt 含 [重试 #n] ----
{
  console.log("===== 用例 3：maxRetries=2 自动重试 =====");
  let spawnCount = 0;
  const prompts: string[] = [];
  const start = (req: any) => {
    spawnCount++;
    prompts.push(req.prompt[0].text);
    return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "partial-" + spawnCount }], stopReason: "aborted" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 2, retryDelayMs: 1 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("spawn 次数 = 3（1 初始 + 2 重试）", spawnCount === 3);
  check("重试 prompt #1 含 [重试 #1]", prompts[1]?.includes("[重试 #1]"));
  check("重试 prompt #2 含 [重试 #2]", prompts[2]?.includes("[重试 #2]"));
  check("重试 prompt 含原因 aborted", prompts[1]?.includes("aborted") && prompts[2]?.includes("aborted"));
  check("重试 prompt 含已完成部分", prompts[1]?.includes("partial-1") && prompts[2]?.includes("partial-2"));
  check("err.cause.retries === 2", err?.cause?.retries === 2);
}

// ---- 用例 4：未知 reason 即使 maxRetries>0 也不重试 ----
{
  console.log("===== 用例 4：未知 reason 不重试（保守） =====");
  let spawnCount = 0;
  const start = () => {
    spawnCount++;
    return { id: "r" + spawnCount, result: Promise.resolve({ output: [{ type: "text", text: "x" }], stopReason: "error" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => [], { delegateRetry: { maxRetries: 3, retryDelayMs: 1 } });
  let err: any = null;
  try { await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec()); } catch (e) { err = e; }
  check("spawn 次数 = 1（未知 reason 不重试）", spawnCount === 1);
  check("err.cause.stopReason === error", err?.cause?.stopReason === "error");
  check("err.cause.retries === 0", err?.cause?.retries === 0);
}

// ---- 用例 5：completed 正常返回（不回归） ----
{
  console.log("===== 用例 5：completed 正常返回 =====");
  const start = (req: any) => {
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "完成结果" }], stopReason: "completed" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start), () => []);
  const out = await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("返回完成结果", out === "完成结果");
}

// ---- 用例 6：agentOptions 路由不回归 ----
{
  console.log("===== 用例 6：agentOptions 路由不回归 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions, label: req.label, persona: req.persona };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start, [{ id: "deepseek-official" }]), () => [
    { name: "co-fixer", provider: "deepseek-official", model: "deepseek-v4-flash", maxTokens: 4000 },
  ]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("agentOptions.provider 覆盖", captured?.agentOptions?.provider === "deepseek-official");
  check("agentOptions.model 覆盖", captured?.agentOptions?.model === "deepseek-v4-flash");
  check("agentOptions.maxTokens 覆盖", captured?.agentOptions?.maxTokens === 4000);
  check("label = delegate:co-fixer", captured?.label === "delegate:co-fixer");
}

// ---- 用例 7：provider 不可用则继承父模型（不回归） ----
{
  console.log("===== 用例 7：provider 不可用则继承父模型 =====");
  let captured: any = null;
  const start = (req: any) => {
    captured = { agentOptions: req.agentOptions };
    return { id: "ok", result: Promise.resolve({ output: [{ type: "text", text: "OK" }], stopReason: "completed" }), dispose() {} };
  };
  const tool = createDelegateTool(makeCtx(start, [{ id: "other-provider" }]), () => [
    { name: "co-fixer", provider: "not-available", model: "m1" },
  ]);
  await tool.execute({ skill: "co-fixer", prompt: "任务" }, makeExec());
  check("provider 不可用 → 不传 agentOptions（继承父模型）", captured?.agentOptions === undefined);
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
