import type { ScanResult } from '../types.js';
import { CATEGORY_LABELS } from '../categories.js';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown summary, suitable for CI job summaries and PR comments. */
export function renderMarkdown(r: ScanResult): string {
  const s = r.stats.findingsBySeverity;
  const lines: string[] = [];
  lines.push(`# Rookery report`, '', `Scanned **${r.repos.length}** repo(s) · **${r.stats.artifacts}** agent artifacts · ${new Date(r.scannedAt).toUTCString()} ${r.stats.worktreesSkipped ? ` · ${r.stats.worktreesSkipped} git worktree(s) skipped` : ''} · rookery v${r.tool.version}`, '');
  lines.push(`| Critical | High | Medium | Low | Duplicate clusters |`, `|---|---|---|---|---|`, `| ${s.critical} | ${s.high} | ${s.medium} | ${s.low} | ${r.clusters.length} |`, '');

  if (r.categories.length) {
    lines.push('## What teams keep building', '', '| Purpose | Artifacts | Repos |', '|---|---|---|');
    for (const c of r.categories) lines.push(`| ${CATEGORY_LABELS[c.category] ?? c.category} | ${c.count} | ${c.repos} |`);
    lines.push('');
  }
  if (r.clusters.length) {
    lines.push('## Near-duplicates', '');
    for (const c of r.clusters) {
      lines.push(`- **${esc(c.label)}** ×${c.members.length} (${c.exact ? 'identical' : Math.round(c.similarity * 100) + '% similar'})`);
      for (const m of c.members) lines.push(`  - \`${m.repo}/${m.relPath}\``);
    }
    lines.push('');
  }
  if (r.findings.length) {
    lines.push('## Security findings', '', '| Severity | Confidence | Rule | Finding | Location |', '|---|---|---|---|---|');
    for (const f of r.findings) lines.push(`| ${f.severity} | ${f.confidence}${f.context ? ` (${esc(f.context)})` : ''} | ${f.ruleId} | ${esc(f.title)} | \`${f.repo}/${f.relPath}:${f.line}\` |`);
    lines.push('');
  }
  lines.push('## Inventory', '', '| Repo | Path | Agent | Kind | Name | Tokens |', '|---|---|---|---|---|---|');
  for (const a of r.artifacts) lines.push(`| ${a.repo} | \`${a.relPath}\` | ${a.agent} | ${a.kind} | ${esc(a.name)} | ${a.tokens} |`);
  return lines.join('\n') + '\n';
}
