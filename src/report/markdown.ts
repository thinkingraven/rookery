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
  lines.push('<details><summary><b>Inventory</b> (' + r.artifacts.length + ' agent artifacts)</summary>', '', '| Repo | Path | Agent | Kind | Name | Source | Tokens |', '|---|---|---|---|---|---|---|');
  for (const a of r.artifacts) lines.push(`| ${a.repo} | \`${a.relPath}\` | ${AGENT_LABEL[a.agent] ?? a.agent} | ${a.kind} | ${esc(a.name)} | ${[a.provenance ? esc(provenanceText(a.provenance)) + (a.provenance.modified ? ' (edited)' : '') : '', a.links.length ? `also in ${[...new Set(a.links.map((l) => AGENT_LABEL[l.agent] ?? l.agent))].join(', ')}` : ''].filter(Boolean).join('; ')} | ${a.tokens} |`);
  lines.push('', '</details>');
  return lines.join('\n') + '\n';
}
