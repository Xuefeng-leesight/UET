import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/code-graph');
const cli = path.join(root, 'node_modules/@lemonberrylabs/codegraph/dist/bin/codegraph.js');
const languages = ['typescript', 'python'];
const summaries = [];
const diagrams = [];

function moduleName(file) {
  const parts = file.split('/');
  if (parts[0] === 'backend') return parts.slice(0, 2).join('/');
  if (parts[0] === 'services') return parts.slice(0, -1).slice(0, 3).join('/');
  if (parts[0] === 'src' && parts[1] === 'features') return parts.slice(0, 3).join('/');
  return parts.slice(0, -1).slice(0, 2).join('/') || parts[0];
}

for (const language of languages) {
  execFileSync(process.execPath, [cli, 'analyze', '-c', `docs/code-graph/${language}.config.json`], {
    cwd: root, stdio: 'inherit',
  });
  const filename = path.join(output, `${language}.json`);
  // Keep snapshots portable: upstream embeds absolute paths in metadata/call sites.
  const graph = JSON.parse(fs.readFileSync(filename, 'utf8').split(root + path.sep).join('').split(root).join('.'));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const modules = new Map();
  const calls = new Map();
  let resolved = 0;
  let external = 0;
  let omitted = 0;
  for (const node of graph.nodes) {
    if (!fs.existsSync(path.join(root, node.filePath))) throw new Error(`Missing source: ${node.filePath}`);
    const name = moduleName(node.filePath);
    modules.set(name, (modules.get(name) || 0) + 1);
  }
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) { external++; continue; }
    resolved++;
    if (language === 'python' && source.filePath.split('/').slice(0, 2).join('/') !== target.filePath.split('/').slice(0, 2).join('/')) {
      omitted++;
      continue;
    }
    const from = moduleName(source.filePath);
    const to = moduleName(target.filePath);
    if (from !== to) {
      const key = `${from}\t${to}`;
      calls.set(key, (calls.get(key) || 0) + 1);
    }
  }
  const names = [...modules.keys()].sort();
  const ids = new Map(names.map((name, i) => [name, `n${i}`]));
  const lines = ['flowchart LR', ...names.map(name => `  ${ids.get(name)}["${name} (${modules.get(name)} functions)"]`)];
  for (const [key, count] of [...calls].sort(([a], [b]) => a.localeCompare(b))) {
    const [from, to] = key.split('\t');
    lines.push(`  ${ids.get(from)} -->|"${count}"| ${ids.get(to)}`);
  }
  fs.writeFileSync(filename, JSON.stringify(graph, null, 2) + '\n');
  fs.writeFileSync(path.join(output, `${language}.mmd`), lines.join('\n') + '\n');
  summaries.push(`| ${language} | ${graph.metadata.totalFiles} | ${graph.nodes.length} | ${graph.edges.length} | ${resolved} | ${external} |`);
  const caveat = language === 'python'
    ? `\n\n注意：Python 上游按方法名称猜测目标，不是精确的类型/import 解析。以下仅为候选调用图；已从图中排除 ${omitted} 条跨独立服务的候选边，原始 JSON 保留。服务内部也可能存在同名误匹配。`
    : '';
  diagrams.push(`## ${language} 模块调用图\n\n箭头表示调用方 → 被调用方，数字是扫描得到的跨模块调用边数；模块内部调用省略。无跨模块边的模块仍保留。${caveat}\n\n\`\`\`mermaid\n${lines.join('\n')}\n\`\`\`\n`);
}

fs.writeFileSync(path.join(output, 'SUMMARY.md'), `# 自动生成的代码调用图\n\n运行 \`npm run docs:codegraph\` 更新。扫描当前工作区，包括未提交的源码；这不是运行时跟踪，也不是完整 import 依赖图。\n\n| 语言 | 扫描文件 | 函数节点 | 原始调用边 | 两端有节点的边 | 外部或缺失端点边 |\n|---|---:|---:|---:|---:|---:|\n${summaries.join('\n')}\n\n${diagrams.join('\n')}\n`);
console.log('Code graphs and source-path validation complete: docs/code-graph/SUMMARY.md');
