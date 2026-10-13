import type { ScanResult } from '../types.js';
import { CATEGORY_LABELS } from '../categories.js';
import { AGENT_LABEL, MANAGER_LABEL, linkTargets, linkText, provenanceText, sourceGroups } from './sources.js';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown summary, suitable for CI job summaries and PR comments. */
export function renderMarkdown(r: ScanResult): string {
  const s = r.stats.findingsBySeverity;
  const lines: string[] = [];
  lines.push(`# Rookery report`, '', `Scanned **${r.repos.length}** repo(s)${r.stats.reposWithoutArtifacts ? ` (+${r.stats.reposWithoutArtifacts} with no agent files)` : ''} · **${r.stats.artifacts}** agent artifacts · ${new Date(r.scannedAt).toUTCString()} ${r.stats.worktreesSkipped ? ` · ${r.stats.worktreesSkipped} git worktree(s) skipped` : ''} · rookery v${r.tool.version}`, '');
  lines.push(`| Critical | High | Medium | Low | Duplicate clusters |`, `|---|---|---|---|---|`, `| ${s.critical} | ${s.high} | ${s.medium} | ${s.low} | ${r.clusters.filter((c) => !c.syncedFrom).length} |`, '');

  if (r.categories.length) {
    lines.push('## What teams keep building', '', '| Purpose | Artifacts | Repos |', '|---|---|---|');
    for (const c of r.categories) lines.push(`| ${CATEGORY_LABELS[c.category] ?? c.category} | ${c.count} | ${c.repos} |`);
    lines.push('');
  }
  const groups = sourceGroups(r.artifacts);
  const targets = linkTargets(r.artifacts);
  if (groups.length || targets.length) {
    lines.push('## Where skills come from', '');
    if (groups.length) {
      lines.push('| Installed by | Source | Skills | Edited since install |', '|---|---|---|---|');
      for (const g of groups) lines.push(`| ${MANAGER_LABEL[g.manager] ?? g.manager} | \`${esc(g.source)}\` | ${g.count} | ${g.modified || ''} |`);
      lines.push('');
    }
    if (targets.length) lines.push(`Linked into: ${targets.map(linkText).join(' · ')}`, '');
  }
  if (r.clusters.length) {
    lines.push('## Near-duplicates', '');
    for (const c of r.clusters) {
      lines.push(`- **${esc(c.label)}** ×${c.members.length} (${c.syncedFrom ? `copies of installed ${esc(c.syncedFrom)}` : c.exact ? 'identical' : Math.round(c.similarity * 100) + '% similar'})`);
      for (const m of c.members) lines.push(`  - \`${m.repo}/${m.relPath}\``);
    }
    lines.push('');
  }
  if (r.findings.length) {
    lines.push('## Security findings', '', '| Severity | Confidence | Rule | Finding | Location |', '|---|---|---|---|---|');
    for (const f of r.findings) lines.push(`| ${f.severity} | ${f.confidence}${f.context ? ` (${esc(f.context)})` : ''} | ${f.ruleId} | ${esc(f.title)} | \`${f.repo}/${f.relPath}:${f.line}\` |`);
    lines.push('');
  }
  if (r.policy) {
    const p = r.policy;
    const errors = p.violations.filter((v) => v.level === 'error').length;
    lines.push('## Policy', '', `${p.enforced ? (p.passed ? '**Pass**' : '**Fail**') : '**Not enforced**'} · ${p.source ? `\`${esc(p.source.split('/').pop()!)}\` extends \`${p.preset}\`` : `no .rookery.yml, so this shows what \`${p.preset}\` would flag (warnings only)`} · ${errors} error(s) · ${p.violations.length - errors} warning(s)${p.failOn !== 'none' ? ` · ${p.findingsAtOrAbove} scan finding(s) at or above ${p.failOn}` : ''}`, '');
    if (p.violations.length) {
      lines.push('| Level | Rule | Setting | Location | Detail |', '|---|---|---|---|---|');
      for (const v of p.violations) lines.push(`| ${v.level} | ${v.ruleId} | \`${v.key}\` | \`${esc(v.repo)}/${esc(v.relPath)}:${v.line}\` | ${esc(v.snippet)} |`);
      lines.push('');
    }
    const flagged = p.exceptions.filter((e) => e.status !== 'used');
    if (p.excepted.length || flagged.length) {
      lines.push(`Exceptions: ${p.excepted.length} violation(s) excepted.`, ...flagged.map((e) => `- ${e.status}: \`${esc(e.path)}\` (${e.rules.join(', ')})${e.expires ? `, expires ${e.expires}` : ''}`), '');
    }
    if (p.coverage.length) {
      const agents = p.coverage[0].agents.map((a) => a.name);
      lines.push('<details><summary>What these agents can enforce themselves</summary>', '', `| Setting | ${agents.join(' | ')} |`, `|---|${agents.map(() => '---').join('|')}|`);
      for (const x of p.coverage) lines.push(`| \`${x.key}\` | ${x.agents.map((a) => a.support).join(' | ')} |`);
      lines.push('', 'From [docs/agent-capabilities.md](https://github.com/thinkingraven/rookery/blob/main/docs/agent-capabilities.md).', '', '</details>', '');
    }
  }
  lines.push('<details><summary><b>Inventory</b> (' + r.artifacts.length + ' agent artifacts)</summary>', '', '| Repo | Path | Agent | Kind | Name | Source | Tokens |', '|---|---|---|---|---|---|---|');
  for (const a of r.artifacts) lines.push(`| ${a.repo} | \`${a.relPath}\` | ${AGENT_LABEL[a.agent] ?? a.agent} | ${a.kind} | ${esc(a.name)} | ${[a.provenance ? esc(provenanceText(a.provenance)) + (a.provenance.modified ? ' (edited)' : '') : '', a.links.length ? `also in ${[...new Set(a.links.map((l) => AGENT_LABEL[l.agent] ?? l.agent))].join(', ')}` : ''].filter(Boolean).join('; ')} | ${a.tokens} |`);
  lines.push('', '</details>');
  return lines.join('\n') + '\n';
}
