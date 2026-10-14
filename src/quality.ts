import { existsSync } from 'node:fs';
import { basename, dirname, join, normalize as normPath } from 'node:path';
import type { Artifact } from './types.js';

/**
 * Skill quality checks: does a skill follow the Agent Skills format, and can an agent find and use it?
 * Each limit comes from an agent's docs (Claude Code skills, Cursor /skills warnings, Copilot CLI reference).
 */

export interface QualityIssue { id: string; line: number; snippet: string }

/** Quality rules (RK-QLT-*) are reported apart from security findings. */
export const isQuality = (ruleId: string) => ruleId.startsWith('RK-QLT-');

/** Frontmatter fields documented for skills by Claude Code, Copilot, Cursor and the Agent Skills spec. */
const SKILL_FIELDS = [
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable',
  'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell',
  'metadata', 'license', 'compatibility', 'icon', 'color',
];
const squash = (k: string) => k.toLowerCase().replace(/[-_\s]/g, '');
const BY_SQUASHED = new Map(SKILL_FIELDS.map((f) => [squash(f), f]));
const NAME_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}

/** The documented field a frontmatter key was probably meant to be, or null if it isn't a near miss. */
export function intendedField(key: string): string | null {
  if (SKILL_FIELDS.includes(key)) return null;
  if (key === 'tools') return 'allowed-tools';   // a subagent field; skills don't read it
  const s = squash(key);
  const exact = BY_SQUASHED.get(s);
  if (exact) return exact;
  if (s.length < 6) return null;
  for (const [sq, field] of BY_SQUASHED) if (distance(s, sq) <= 1) return field;
  return null;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
function keyLine(text: string, key: string): number {
  const m = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').exec(text);
  return m ? lineOf(text, m.index) : 1;
}

/** The text with fenced code blocks blanked out (same line count), so examples in code don't count as links. */
function withoutFences(text: string): string {
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; return ''; }
    if (m) { fence = m[1]; return ''; }
    return line;
  }).join('\n');
}

const PLACEHOLDER = /(?:^|\/)(?:path\/to|your[-_]|example\.|foo|bar|my[-_])|\.\.\.|[*{}<>$]/i;
const LISTED = /^[ \t]*(?:[-*+]|\d+\.|\|)[ \t]*`((?:\.\/)?(?:scripts|references|reference|assets|templates|examples|resources)\/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+)`/gm;

/** Files a skill links to, or lists as its contents, that aren't in the skill folder or the repo. */
function missingFiles(art: Artifact): QualityIssue[] {
  const text = withoutFences(art.body);
  const dir = dirname(art.path);
  const refs: { path: string; index: number }[] = [];
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const u = m[1].split('#')[0].split('?')[0];
    if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || /^[/~#]/.test(u)) continue;
    refs.push({ path: u, index: m.index });
  }
  for (const m of text.matchAll(LISTED)) refs.push({ path: m[1], index: m.index });
  const out: QualityIssue[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    let p: string;
    try { p = decodeURIComponent(r.path); } catch { p = r.path; }
    if (seen.has(p) || !/\.[A-Za-z0-9]{1,8}$/.test(p) || PLACEHOLDER.test(p)) continue;
    seen.add(p);
    if (existsSync(normPath(join(dir, p))) || existsSync(join(art.repoRoot, p))) continue;
    out.push({ id: 'RK-QLT-006', line: lineOf(text, r.index), snippet: p });
  }
  return out;
}

/** Test fixtures are minimal on purpose, so quality checks skip them. */
const FIXTURE = /(?:^|\/)(?:tests?|__tests__|fixtures?|testdata)\//;

/** Quality issues in one artifact. Most checks apply to skills (SKILL.md). */
export function qualityIssues(art: Artifact): QualityIssue[] {
  const out: QualityIssue[] = [];
  if (FIXTURE.test(art.relPath)) return out;
  const fm = art.frontmatter;
  const lines = art.body.split('\n').length;
  if (art.tokens > 5000 && (art.kind === 'rules' || art.kind === 'skill')) out.push({ id: 'RK-QLT-002', line: 1, snippet: `${art.tokens.toLocaleString('en-US')} tokens` });
  else if (art.kind === 'skill' && lines > 500) out.push({ id: 'RK-QLT-002', line: 1, snippet: `${lines.toLocaleString('en-US')} lines` });
  if (art.kind !== 'skill' || basename(art.path) !== 'SKILL.md') return out;

  const description = typeof fm.description === 'string' ? fm.description.trim() : fm.description == null ? '' : String(fm.description);
  if (!description) out.push({ id: 'RK-QLT-001', line: 1, snippet: art.name });
  else {
    const words = description.split(/\s+/).filter(Boolean).length;
    if (words < 4) out.push({ id: 'RK-QLT-007', line: keyLine(art.body, 'description'), snippet: `description: ${description}` });
    const whenToUse = typeof fm.when_to_use === 'string' ? fm.when_to_use.trim() : '';
    if (description.length > 1024) out.push({ id: 'RK-QLT-005', line: keyLine(art.body, 'description'), snippet: `${description.length.toLocaleString('en-US')} characters (limit 1,024)` });
    else if (description.length + whenToUse.length > 1536) out.push({ id: 'RK-QLT-005', line: keyLine(art.body, 'when_to_use'), snippet: `description + when_to_use: ${(description.length + whenToUse.length).toLocaleString('en-US')} characters (Claude Code cuts at 1,536)` });
  }

  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (name) {
    if (name.length > 64 || !NAME_FORMAT.test(name)) out.push({ id: 'RK-QLT-003', line: keyLine(art.body, 'name'), snippet: `name: ${name}` });
    const folder = basename(dirname(art.path));
    const pluginRoot = existsSync(join(dirname(art.path), '.claude-plugin')) || existsSync(join(dirname(art.path), 'plugin.json'));
    if (name !== folder && !pluginRoot) out.push({ id: 'RK-QLT-004', line: keyLine(art.body, 'name'), snippet: `name: ${name} (folder: ${folder})` });
  }

  for (const key of Object.keys(fm)) {
    const meant = intendedField(key);
    if (meant) out.push({ id: 'RK-QLT-008', line: keyLine(art.body, key), snippet: key === 'tools' ? 'tools: skills use allowed-tools (tools is a subagent field)' : `${key}: did you mean ${meant}?` });
  }

  out.push(...missingFiles(art));
  return out;
}

/** Different skills with the same name for the same agent in one repo: only one of them answers to it. */
export function nameCollisions(artifacts: Artifact[]): { art: Artifact; other: Artifact }[] {
  const groups = new Map<string, Artifact[]>();
  for (const a of artifacts) {
    if (a.kind !== 'skill' || FIXTURE.test(a.relPath)) continue;
    const k = `${a.repoRoot}\u0000${a.agent}\u0000${a.name.toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: { art: Artifact; other: Artifact }[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [first, ...rest] = list;
    for (const a of rest) if (a.sha256 !== first.sha256 && a.realPath !== first.realPath) out.push({ art: a, other: first });
  }
  return out;
}
