/**
 * 构建辅助脚本：将 skills/*.md 转换为 src/skills.ts（runtime skill 定义）
 * 用法：bun run scripts/generate-skills.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

interface SkillDef {
  file: string;        // skills/<file>.md
  name: string;        // DSH runtime skill 名（kebab-case）
  description: string; // 非空描述（技能目录展示 + 模型选择依据）
}

const SKILLS: SkillDef[] = [
  { file: 'orchestrator', name: 'co-orchestrator', description: '纯调度——分析需求→委派→审核（禁止直接文件操作）' },
  { file: 'oracle', name: 'co-oracle', description: '架构审查 / 代码审查 / YAGNI 简化 / 复杂调试（只读）' },
  { file: 'explorer', name: 'co-explorer', description: '代码库搜索定位——grep / glob / AST（只读）' },
  { file: 'librarian', name: 'co-librarian', description: '官方文档 / API / GitHub 研究（只读+Web）' },
  { file: 'designer', name: 'co-designer', description: 'UI/UX 设计实现 / 视觉润色 / 响应式布局（读写）' },
  { file: 'fixer', name: 'co-fixer', description: '代码修改 / 构建 / 测试执行（读写+Bash）' },
  { file: 'observer', name: 'co-observer', description: '图片 / PDF / 截图视觉分析（只读）' },
  { file: 'council', name: 'co-council', description: '多模型并行共识（不可逆决策用）' },
  { file: 'rule-user', name: 'co-rule-user', description: '用户级 AGENTS.md 规范分析' },
  { file: 'rule-project', name: 'co-rule-project', description: '项目 AGENTS.md 规范分析' },
  { file: 'rule-app', name: 'co-rule-app', description: '应用级规则文件分析' },
  { file: 'planner', name: 'co-planner', description: '方案制定——综合需求+信息+规范输出任务分解' },
];

const entries: string[] = [];
let generated = 0;

for (const { file, name, description } of SKILLS) {
  const mdPath = path.join(SKILLS_DIR, `${file}.md`);

  if (!fs.existsSync(mdPath)) {
    console.error(`❌ 缺少源文件: ${mdPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(mdPath, 'utf-8');

  // 转义：反斜杠、反引号、美元符号（防止模板字符串插值）
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  entries.push([
    '  {',
    `    name: '${name}',`,
    `    description: ${JSON.stringify(description)},`,
    "    source: 'dsh-cohub',",
    `    content: \`${escaped}\`,`,
    '  },',
  ].join('\n'));
  generated++;
}

const tsContent = [
  '// 自动生成，请勿手动编辑。源文件：skills/*.md',
  '// 运行 scripts/generate-skills.ts 重新生成',
  '',
  'export interface CoHubSkill {',
  '  name: string;',
  '  description: string;',
  '  source: string;',
  '  content: string;',
  '}',
  '',
  'export const COHUB_SKILLS: CoHubSkill[] = [',
  ...entries,
  '];',
  '',
].join('\n');

const outPath = path.resolve(__dirname, '..', 'src', 'skills.ts');
fs.writeFileSync(outPath, tsContent, 'utf-8');

console.log(`✅ 已生成 ${generated} 个 skill 定义到 src/skills.ts`);
