import type { Artifact, Provenance } from '../types.js';

export const MANAGER_LABEL: Record<string, string> = { skillshare: 'skillshare', 'skills-cli': 'npx skills' };
export const AGENT_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini', windsurf: 'Windsurf', skillshare: 'skillshare', 'agent-skills': 'Agent Skills', mcp: 'MCP',
};

/** "https://github.com/anthropics/skills.git" or "anthropics/skills/skills/pdf" → "anthropics/skills". */
export function shortSource(source?: string): string {
  if (!source) return 'created locally';
  if (/^(?:\/|~|\.\.?\/|[A-Za-z]:\\)/.test(source)) return 'local folder';
  const s = source.replace(/^(?:https?:\/\/|git@|ssh:\/\/)/, '').replace(/^github\.com[/:]/, '').replace(/\.git$/, '');
  const parts = s.split(/[/:]/).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
}

export function provenanceText(p: Provenance): string {
  const where = p.source ? `${shortSource(p.source)}${p.commit ? '@' + p.commit : ''}` : 'created locally';
  return `${MANAGER_LABEL[p.manager] ?? p.manager} · ${where}${p.tracked ? ' (tracked repo)' : ''}`;
}

export interface SourceGroup { manager: string; source: string; count: number; modified: number }

export function sourceGroups(artifacts: Artifact[]): SourceGroup[] {
  const map = new Map<string, SourceGroup>();
  for (const a of artifacts) {
    if (!a.provenance) continue;
    const source = shortSource(a.provenance.source);
    const key = `${a.provenance.manager}\u0000${source}`;
    const g = map.get(key) ?? { manager: a.provenance.manager, source, count: 0, modified: 0 };
    g.count++;
    if (a.provenance.modified) g.modified++;
    map.set(key, g);
  }
  return [...map.values()].sort((x, y) => x.manager.localeCompare(y.manager) || y.count - x.count || x.source.localeCompare(y.source));
}

/** How many artifacts are linked into each tool, split by symlink and copy. */
export function linkTargets(artifacts: Artifact[]): { agent: string; symlink: number; copy: number }[] {
  const map = new Map<string, { agent: string; symlink: number; copy: number }>();
  for (const a of artifacts) for (const l of a.links) {
    const t = map.get(l.agent) ?? { agent: l.agent, symlink: 0, copy: 0 };
    t[l.via]++;
    map.set(l.agent, t);
  }
  return [...map.values()].sort((x, y) => y.symlink + y.copy - (x.symlink + x.copy));
}

export function linkText(t: { agent: string; symlink: number; copy: number }): string {
  const label = AGENT_LABEL[t.agent] ?? t.agent;
  if (t.copy && t.symlink) return `${label} ${t.symlink + t.copy} (${t.copy} copied)`;
  return `${label} ${t.symlink + t.copy}${t.copy ? ' (copied)' : ''}`;
}
