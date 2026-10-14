import type { PolicyResult, ScanResult, Severity } from '../types.js';
import { CATEGORY_LABELS } from '../categories.js';
import { isQuality } from '../quality.js';
import { AGENT_LABEL, MANAGER_LABEL, linkTargets, linkText, provenanceText, shortSource, sourceGroups } from './sources.js';

export interface TerminalOptions { color: boolean; verbose: boolean; htmlPath?: string }

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

  const teamRepos = r.repos.filter((x) => x !== '~').length;
  const empty = r.stats.reposWithoutArtifacts ? dim(` (+${n(r.stats.reposWithoutArtifacts)} with no agent files)`) : '';
  const scope = [teamRepos || !r.repos.includes('~') ? `${n(teamRepos)} repo${teamRepos === 1 ? '' : 's'}${empty}` : '', r.repos.includes('~') ? 'your home folder' : ''].filter(Boolean).join(' + ');
  out.push(`${bold('rookery')}${amber('.')} ${dim(`v${r.tool.version}`)}  ${dim('·')}  ${scope}  ${dim('·')}  ${n(r.stats.filesScanned)} files  ${dim('·')}  ${(r.stats.durationMs / 1000).toFixed(1)}s${r.stats.worktreesSkipped ? dim(`  ·  ${r.stats.worktreesSkipped} git worktree${r.stats.worktreesSkipped === 1 ? '' : 's'} skipped (--worktrees to include)`) : ''}`);

  if (!r.artifacts.length) {
    out.push('', `No agent skills, rules or configs found. Rookery looks for ${dim('.claude/, AGENTS.md, .cursor/, .github/copilot-instructions.md, SKILL.md, .mcp.json')} and more.`);
    if (r.policy) out.push(...policySection(r.policy, { bold, dim, red, yellow, green, amber }, o.verbose));
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

  const sources = sourceGroups(r.artifacts);
  const targets = linkTargets(r.artifacts);
  if (sources.length || targets.length) {
    const managed = Object.values(r.stats.managed).reduce((a, b) => a + b, 0);
    h('WHERE SKILLS COME FROM', [managed && `${managed} installed by a skill manager`, r.stats.linkedArtifacts && `${r.stats.linkedArtifacts} linked into other tools`, r.stats.modifiedSinceInstall && `${r.stats.modifiedSinceInstall} edited since install`].filter(Boolean).join(' · '));
    const width = Math.max(11, ...sources.map((g) => (MANAGER_LABEL[g.manager] ?? g.manager).length));
    for (const manager of [...new Set(sources.map((g) => g.manager))]) {
      const groups = sources.filter((g) => g.manager === manager);
      const shown = groups.slice(0, o.verbose ? 50 : 5).map((g) => `${g.source} ${bold(g.count)}`).join(dim('  ·  '));
      out.push(`  ${(MANAGER_LABEL[manager] ?? manager).padEnd(width)}  ${shown}${groups.length > 5 && !o.verbose ? dim(`  · ${groups.length - 5} more`) : ''}`);
    }
    if (targets.length) out.push(`  ${'Linked into'.padEnd(width)}  ${targets.map((t) => linkText(t)).join(dim('  ·  '))}`);
    const edited = r.artifacts.filter((a) => a.provenance?.modified);
    for (const a of edited.slice(0, o.verbose ? 100 : 5)) out.push(`  ${yellow('✎')} ${a.name} ${dim(`edited since install (${provenanceText(a.provenance!)})`)}`);
    if (edited.length > 5 && !o.verbose) out.push(dim(`    … ${edited.length - 5} more edited (use --verbose)`));
  }

  const dupes = r.clusters.filter((c) => !c.syncedFrom);
  const dupeArtifacts = dupes.reduce((n, c) => n + c.members.length, 0);
  const synced = r.clusters.length - dupes.length;
  h('NEAR-DUPLICATES', r.clusters.length ? `${dupes.length ? `${dupes.length} cluster${dupes.length === 1 ? '' : 's'} · ${dupeArtifacts} artifacts could be ${dupes.length}` : 'none to consolidate'}${synced ? ` · ${synced} cop${synced === 1 ? 'y' : 'ies'} of installed skills` : ''}` : 'none found');
  for (const cl of r.clusters.slice(0, o.verbose ? 100 : 8)) {
    const tag = cl.syncedFrom ? green(`copies of installed ${shortSource(cl.syncedFrom)}`) : cl.exact ? green('identical') : `${Math.round(cl.similarity * 100)}% similar`;
    out.push(`  ${amber('●')} ${bold(`"${cl.label}"`)} ×${cl.members.length}  ${dim(tag)}  ${dim(CATEGORY_LABELS[cl.category] ?? cl.category)}`);
    const shown = cl.members.slice(0, o.verbose ? 50 : 4);
    for (const m of shown) out.push(`      ${dim('–')} ${m.repo}/${m.relPath} ${dim(`(${AGENT_LABEL[m.agent] ?? m.agent})`)}`);
    if (cl.members.length > shown.length) out.push(dim(`      … and ${cl.members.length - shown.length} more`));
  }
  if (r.clusters.length > 8 && !o.verbose) out.push(dim(`  … ${r.clusters.length - 8} more clusters (use --verbose)`));

  const quality = r.findings.filter((f) => isQuality(f.ruleId));
  const security = r.findings.filter((f) => !isQuality(f.ruleId));
  const qualityFiles = new Set(quality.map((f) => `${f.repo}/${f.relPath}`)).size;
  h('QUALITY', quality.length ? `${n(quality.length)} issue${quality.length === 1 ? '' : 's'} in ${n(qualityFiles)} file${qualityFiles === 1 ? '' : 's'}: names, descriptions and links agents rely on` : 'no issues found');
  const byRule = new Map<string, typeof quality>();
  for (const f of quality) byRule.set(f.ruleId, [...(byRule.get(f.ruleId) ?? []), f]);
  for (const [ruleId, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`  ${cyan('●')} ${list[0].title}${list.length > 1 ? ` ${bold('×' + list.length)}` : ''}  ${dim(ruleId)}`);
    const shown = list.slice(0, o.verbose ? 1000 : 3);
    for (const f of shown) out.push(`      ${f.repo}/${f.relPath}${dim(':' + f.line)}  ${dim(f.snippet)}`);
    if (list.length > shown.length) out.push(dim(`      … ${list.length - shown.length} more (use --verbose or --html)`));
  }

  const total = security.length;
  const sure = security.filter((f) => f.confidence === 'high');
  const unsure = security.length - sure.length;
  const sev = (list: typeof r.findings) => (['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((k) => [k, list.filter((f) => f.severity === k).length] as const).filter(([, v]) => v);
  h('SECURITY', total ? `${sev(sure).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no high-confidence findings'}${unsure ? `  +${unsure} low-confidence` : ''}` : 'no findings');
  const visible = (o.verbose ? security : sure.filter((f) => f.severity !== 'info' && f.severity !== 'low'));
  const limit = o.verbose ? 1000 : 15;
  for (const f of visible.slice(0, limit)) {
    out.push(`  ${sevColor[f.severity](f.severity.toUpperCase().padEnd(8))} ${dim(f.ruleId)}  ${f.title}${f.confidence === 'low' ? dim(`  (low confidence: ${f.context})`) : ''}`);
    out.push(`           ${f.repo}/${f.relPath}${dim(':' + f.line)}  ${dim(f.snippet)}`);
  }
  if (visible.length > limit) out.push(dim(`  … ${visible.length - limit} more (use --verbose or --html)`));
  if (!o.verbose && unsure) out.push(dim(`  ${unsure} low-confidence finding${unsure === 1 ? '' : 's'} hidden: patterns inside tests, examples, security docs or scanner code (use --verbose).`));

  if (r.policy) out.push(...policySection(r.policy, { bold, dim, red, yellow, green, amber }, o.verbose));

  h('NEXT STEPS');
  const steps: string[] = [];
  const pol = r.policy;
  if (pol && !pol.source) steps.push(`Run ${bold('rookery policy init')} to turn these warnings into a policy this repo enforces.`);
  const polErrors = pol?.violations.filter((v) => v.level === 'error').length ?? 0;
  if (polErrors) steps.push(`Fix ${red(polErrors + ' policy error' + (polErrors === 1 ? '' : 's'))}, or add reviewed exceptions to ${pol!.source ? 'the policy' : '.rookery.yml'}.`);
  const sc = sure.filter((f) => f.severity === 'critical').length, sh = sure.filter((f) => f.severity === 'high').length;
  if (sc) steps.push(`Fix ${redB(sc + ' critical')} finding${sc === 1 ? '' : 's'} first: likely secrets or exfiltration.`);
  if (dupes.length) steps.push(`Consolidate ${dupes.length} duplicate cluster${dupes.length === 1 ? '' : 's'} into shared skills (${dupeArtifacts} → ${dupes.length}).`);
  if (r.stats.modifiedSinceInstall) steps.push(`Review ${r.stats.modifiedSinceInstall} installed skill${r.stats.modifiedSinceInstall === 1 ? '' : 's'} edited since install: they no longer match their source.`);
  if (sh) steps.push(`Review ${red(sh + ' high')} finding${sh === 1 ? '' : 's'}: permission bypasses, piped installs, risky hooks.`);
  if (quality.length) steps.push(`Fix ${quality.length} skill quality issue${quality.length === 1 ? '' : 's'} so agents can find and use those skills.`);
  const mcp = security.filter((f) => f.ruleId === 'RK-MCP-001').length;
  if (mcp) steps.push(`Pin versions for ${mcp} MCP server${mcp === 1 ? '' : 's'}.`);
  if (!steps.length) steps.push(pol ? 'Passes the policy. Run rookery check in CI to keep it that way.' : 'Looks clean. Run rookery in CI with --fail-on high to keep it that way.');
  for (const st of steps) out.push(`  ${amber('→')} ${st}`);
  out.push(o.htmlPath ? `  ${amber('→')} Full report: ${bold(o.htmlPath)}` : dim('  Tip: add --html rookery-report.html for a shareable report.'));
  return out.join('\n') + '\n';
}

type Paint = Record<'bold' | 'dim' | 'red' | 'yellow' | 'green' | 'amber', (s: string | number) => string>;

/** The POLICY section of `rookery check`. */
function policySection(p: PolicyResult, c: Paint, verbose: boolean): string[] {
  const out: string[] = [''];
  const errors = p.violations.filter((v) => v.level === 'error');
  const warnings = p.violations.filter((v) => v.level === 'warning');
  const counts = [errors.length && c.red(`${errors.length} error${errors.length === 1 ? '' : 's'}`), warnings.length && c.yellow(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`)].filter(Boolean).join(c.dim(' · ')) || c.green('no violations');
  const where = p.source ? `${p.source.split('/').pop()} · extends ${p.preset}` : `no .rookery.yml · what the ${p.preset} preset would flag, as warnings only`;
  out.push(`${c.bold('POLICY')}  ${c.dim(where)}  ${counts}`);

  const groups = new Map<string, typeof p.violations>();
  for (const v of p.violations) groups.set(v.ruleId, [...(groups.get(v.ruleId) ?? []), v]);
  for (const [id, list] of groups) {
    const v0 = list[0];
    const mark = v0.level === 'error' ? c.red('✗') : c.yellow('!');
    out.push(`  ${mark} ${c.dim(id)}  ${v0.title}  ${c.dim(`(${v0.key})`)}  ${c.dim(`${list.length} place${list.length === 1 ? '' : 's'}`)}`);
    for (const v of list.slice(0, verbose ? 1000 : 5)) out.push(`       ${v.repo}/${v.relPath}${c.dim(':' + v.line)}  ${c.dim(v.snippet)}`);
    if (list.length > 5 && !verbose) out.push(c.dim(`       … ${list.length - 5} more (use --verbose)`));
  }
  if (p.excepted.length || p.exceptions.length) {
    const st = (k: string) => p.exceptions.filter((e) => e.status === k);
    out.push(`  ${c.dim('Exceptions:')} ${[`${p.excepted.length} violation${p.excepted.length === 1 ? '' : 's'} excepted`, st('unused').length && c.yellow(`${st('unused').length} unused`), st('expired').length && c.red(`${st('expired').length} expired`)].filter(Boolean).join(c.dim(' · '))}`);
    for (const e of [...st('expired'), ...st('unused')]) out.push(`       ${e.status === 'expired' ? c.red('expired') : c.yellow('unused')}  ${e.path} ${c.dim(`[${e.rules.join(', ')}]${e.expires ? ` expires ${e.expires}` : ''}`)}`);
  }
  if (p.failOn !== 'none') out.push(`  ${p.findingsAtOrAbove ? c.red('✗') : c.green('✓')} ${p.findingsAtOrAbove} scan finding${p.findingsAtOrAbove === 1 ? '' : 's'} at or above ${p.failOn} ${c.dim('(fail_on)')}`);
  if (p.coverage.length) {
    out.push(`  ${c.dim('What these agents can enforce themselves (docs/agent-capabilities.md):')}`);
    const width = Math.max(...p.coverage.map((x) => x.key.length));
    const mark: Record<string, string> = { yes: c.green('yes'), partial: c.yellow('partial'), no: c.red('no'), unknown: c.dim('unknown') };
    for (const x of p.coverage) out.push(`    ${x.key.padEnd(width)}  ${x.agents.map((a) => `${a.name} ${mark[a.support] ?? a.support}`).join(c.dim(' · '))}`);
  }
  out.push(`  ${p.enforced ? (p.passed ? c.green('PASS') : c.red('FAIL')) : c.dim('NOT ENFORCED')}  ${c.dim(p.enforced ? (p.passed ? 'the policy is met' : 'exit code 1') : 'no policy file, so this run always exits 0')}`);
  return out;
}
