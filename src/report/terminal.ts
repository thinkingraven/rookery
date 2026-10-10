import type { ScanResult, Severity } from '../types.js';
import { CATEGORY_LABELS } from '../categories.js';

export interface TerminalOptions { color: boolean; verbose: boolean; htmlPath?: string }

const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini', windsurf: 'Windsurf', 'agent-skills': 'Agent Skills', mcp: 'MCP',
};
const KIND_LABEL: Record<string, string> = {
  skill: 'skills', command: 'commands', subagent: 'subagents', rules: 'rules files', settings: 'settings files', 'mcp-config': 'MCP configs', plugin: 'plugin manifests',
};

export function renderTerminal(r: ScanResult, o: TerminalOptions): string {
  const c = (code: string) => (s: string | number) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const bold = c('1'), dim = c('2'), amber = c('38;5;214'), red = c('31'), redB = c('1;31'), yellow = c('33'), cyan = c('36'), green = c('32');
  const sevColor: Record<Severity, (s: string | number) => string> = { critical: redB, high: red, medium: yellow, low: cyan, info: dim };
  const out: string[] = [];
  const h = (title: string, meta = '') => out.push('', `${bold(title)}${meta ? '  ' + dim(meta) : ''}`);
  const n = (x: number) => x.toLocaleString('en-US');

  out.push(`${bold('rookery')}${amber('.')} ${dim(`v${r.tool.version}`)}  ${dim('·')}  ${n(r.repos.length)} repo${r.repos.length === 1 ? '' : 's'}  ${dim('·')}  ${n(r.stats.filesScanned)} files  ${dim('·')}  ${(r.stats.durationMs / 1000).toFixed(1)}s${r.stats.worktreesSkipped ? dim(`  ·  ${r.stats.worktreesSkipped} git worktree${r.stats.worktreesSkipped === 1 ? '' : 's'} skipped (--worktrees to include)`) : ''}`);

  if (!r.artifacts.length) {
    out.push('', `No agent skills, rules or configs found. Rookery looks for ${dim('.claude/, AGENTS.md, .cursor/, .github/copilot-instructions.md, SKILL.md, .mcp.json')} and more.`);
    return out.join('\n') + '\n';
  }

  h('INVENTORY', `${n(r.stats.artifacts)} agent artifacts · ~${n(r.stats.totalTokens)} tokens`);
  out.push('  ' + Object.entries(r.stats.byAgent).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${AGENT_LABEL[k] ?? k} ${bold(v)}`).join(dim('  ·  ')));
  out.push('  ' + Object.entries(r.stats.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${v === 1 ? (KIND_LABEL[k] ?? k).replace(/s$/, '') : KIND_LABEL[k] ?? k}`).join(dim('  ·  ')));

  if (r.categories.length) {
    h('WHAT TEAMS KEEP BUILDING', 'skills, commands, subagents and rules by purpose');
    const max = Math.max(...r.categories.map((x) => x.count));
    const width = Math.max(...r.categories.map((x) => (CATEGORY_LABELS[x.category] ?? x.category).length));
    for (const cat of r.categories.slice(0, o.verbose ? 50 : 10)) {
      const label = (CATEGORY_LABELS[cat.category] ?? cat.category).padEnd(width);
      const bar = '█'.repeat(Math.max(1, Math.round((cat.count / max) * 18)));
      out.push(`  ${label}  ${amber(bar)} ${bold(cat.count)} ${dim(`in ${cat.repos} repo${cat.repos === 1 ? '' : 's'}`)}`);
    }
  }

  h('NEAR-DUPLICATES', r.clusters.length ? `${r.clusters.length} cluster${r.clusters.length === 1 ? '' : 's'} · ${r.stats.duplicateArtifacts} artifacts could be ${r.clusters.length}` : 'none found');
  for (const cl of r.clusters.slice(0, o.verbose ? 100 : 8)) {
    const tag = cl.exact ? green('identical') : `${Math.round(cl.similarity * 100)}% similar`;
    out.push(`  ${amber('●')} ${bold(`"${cl.label}"`)} ×${cl.members.length}  ${dim(tag)}  ${dim(CATEGORY_LABELS[cl.category] ?? cl.category)}`);
    const shown = cl.members.slice(0, o.verbose ? 50 : 4);
    for (const m of shown) out.push(`      ${dim('–')} ${m.repo}/${m.relPath} ${dim(`(${AGENT_LABEL[m.agent] ?? m.agent})`)}`);
    if (cl.members.length > shown.length) out.push(dim(`      … and ${cl.members.length - shown.length} more`));
  }
  if (r.clusters.length > 8 && !o.verbose) out.push(dim(`  … ${r.clusters.length - 8} more clusters (use --verbose)`));

  const s = r.stats.findingsBySeverity;
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  const sure = r.findings.filter((f) => f.confidence === 'high');
  const unsure = r.findings.length - sure.length;
  const sev = (list: typeof r.findings) => (['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((k) => [k, list.filter((f) => f.severity === k).length] as const).filter(([, v]) => v);
  h('SECURITY', total ? `${sev(sure).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no high-confidence findings'}${unsure ? `  +${unsure} low-confidence` : ''}` : 'no findings');
  const visible = (o.verbose ? r.findings : sure.filter((f) => f.severity !== 'info' && f.severity !== 'low'));
  const limit = o.verbose ? 1000 : 15;
  for (const f of visible.slice(0, limit)) {
    out.push(`  ${sevColor[f.severity](f.severity.toUpperCase().padEnd(8))} ${dim(f.ruleId)}  ${f.title}${f.confidence === 'low' ? dim(`  (low confidence: ${f.context})`) : ''}`);
    out.push(`           ${f.repo}/${f.relPath}${dim(':' + f.line)}  ${dim(f.snippet)}`);
  }
  if (visible.length > limit) out.push(dim(`  … ${visible.length - limit} more (use --verbose or --html)`));
  if (!o.verbose && unsure) out.push(dim(`  ${unsure} low-confidence finding${unsure === 1 ? '' : 's'} hidden: patterns inside tests, examples, security docs or scanner code (use --verbose).`));

  h('NEXT STEPS');
  const steps: string[] = [];
  const sc = sure.filter((f) => f.severity === 'critical').length, sh = sure.filter((f) => f.severity === 'high').length;
  if (sc) steps.push(`Fix ${redB(sc + ' critical')} finding${sc === 1 ? '' : 's'} first: likely secrets or exfiltration.`);
  if (r.clusters.length) steps.push(`Consolidate ${r.clusters.length} duplicate cluster${r.clusters.length === 1 ? '' : 's'} into shared skills (${r.stats.duplicateArtifacts} → ${r.clusters.length}).`);
  if (sh) steps.push(`Review ${red(sh + ' high')} finding${sh === 1 ? '' : 's'}: permission bypasses, piped installs, risky hooks.`);
  const mcp = r.findings.filter((f) => f.ruleId === 'RK-MCP-001').length;
  if (mcp) steps.push(`Pin versions for ${mcp} MCP server${mcp === 1 ? '' : 's'}.`);
  if (!steps.length) steps.push('Looks clean. Run rookery in CI with --fail-on high to keep it that way.');
  for (const st of steps) out.push(`  ${amber('→')} ${st}`);
  out.push(o.htmlPath ? `  ${amber('→')} Full report: ${bold(o.htmlPath)}` : dim('  Tip: add --html rookery-report.html for a shareable report.'));
  return out.join('\n') + '\n';
}
