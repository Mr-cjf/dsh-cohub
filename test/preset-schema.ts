// dsh-port/test/preset-schema.ts —— 内置 preset 的结构断言（无需 LLM、无需 YAML 依赖）
//
// 背景：v0.4.9 之前，两个 preset 的 persona 行用的是旧字段 `text:`，而
// @deepseek-ai/dsh-persona 的 schema 要求 `prefix`（required）。结果是整行挂载失败：
//   [preset-tree] Error: failed to apply loader entry persona: invalid config:
//     - $.prefix missing required value (at prefix)
// preset 不可用 → 以它为默认 preset 时新会话无法创建。属于"文件里看不出来、只有挂载时才炸"
// 的错误，因此在这里做静态断言，把这类字段级不兼容挡在发布之前。
//
// 用法：node test/preset-schema.ts（node >= 24）
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${name}: ${cond ? "PASS" : "FAIL"}`);
  if (cond) pass++; else fail++;
}

const presetsDir = join(import.meta.dirname, "..", "presets");

/** 按 `- id:` 行把组合文本切成顶层条目块 */
function rowsOf(text: string): { id: string; block: string }[] {
  const lines = text.split(/\r?\n/);
  const rows: { id: string; block: string }[] = [];
  let current: { id: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^-\s+id:\s*(\S+)\s*$/.exec(line);
    if (m) {
      if (current) rows.push({ id: current.id, block: current.lines.join("\n") });
      current = { id: m[1].replace(/^['"]|['"]$/g, ""), lines: [] };
      continue;
    }
    if (current && /^\s/.test(line)) current.lines.push(line);
  }
  if (current) rows.push({ id: current.id, block: current.lines.join("\n") });
  return rows;
}

/** 取一份 YAML 块标量的文本内容（用于判断 prefix 是否为空） */
function blockScalarText(block: string, field: string): string | null {
  const lines = block.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${field}:\\s*[|>]`).test(l));
  if (idx < 0) {
    const single = lines.find((l) => new RegExp(`^\\s*${field}:\\s*\\S`).test(l));
    return single ? single.replace(new RegExp(`^\\s*${field}:\\s*`), "") : null;
  }
  const body: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (!/^\s{6,}/.test(lines[i]) && lines[i].trim() !== "") break;
    body.push(lines[i]);
  }
  return body.join("\n");
}

const presetNames = readdirSync(presetsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

console.log("===== 内置 preset 清单 =====");
check("至少存在 co-orchestrator 与 cohub-cordis", ["co-orchestrator", "cohub-cordis"].every((n) => presetNames.includes(n)));
check("cohub-standard 已被移除", !presetNames.includes("cohub-standard"));

for (const name of presetNames) {
  const dir = join(presetsDir, name);
  console.log(`===== ${name} =====`);
  const presetYml = join(dir, "preset.yml");
  const agentYml = join(dir, "agent.cordis.yml");
  check("存在 preset.yml", existsSync(presetYml));
  check("存在 agent.cordis.yml", existsSync(agentYml));
  if (!existsSync(agentYml)) continue;

  const text = readFileSync(agentYml, "utf8");
  const rows = rowsOf(text);
  check("能解析出顶层条目", rows.length > 0);
  check("不含制表符缩进（YAML 非法）", !/^\t/m.test(text));

  const byId = new Map(rows.map((r) => [r.id, r.block]));

  // ① persona 行：必须是 prefix/suffix，且 prefix 非空（本次故障的直接原因）
  const persona = byId.get("persona");
  check("存在 persona 行", persona !== undefined);
  if (persona) {
    check("persona 不再使用旧字段 text:", !/^\s*text:\s*[|>]?/m.test(persona));
    check("persona 配置 prefix 字段", /^\s*prefix:\s*/m.test(persona));
    const body = blockScalarText(persona, "prefix");
    check("prefix 内容非空", typeof body === "string" && body.trim().length > 20);
  }

  // ② 关键工具行必须在（缺行会让 preset 功能静默缺失）
  for (const id of ["tool-fs", "tool-skill", "tool-todo"]) {
    check(`含 ${id} 行`, byId.has(id));
  }
  // ③ 至少一行 shell 工具（平台门控）
  check("含 shell 工具行（tool-bash 或 tool-pwsh）", byId.has("tool-bash") || byId.has("tool-pwsh"));
}

console.log("");
const allOk = fail === 0;
console.log(`结果: ${pass} PASS / ${fail} FAIL`);
console.log(allOk ? "✅ 全部 PASS" : "❌ 存在 FAIL");
process.exit(allOk ? 0 : 1);
