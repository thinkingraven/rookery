import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep, basename, dirname, resolve } from 'node:path';
import type { Agent, ArtifactKind } from './types.js';

/** A file that looks like an agent artifact, before parsing. */
export interface Candidate {
  path: string;     // where it was found (may run through a symlink)
  realPath: string; // after resolving symlinks
  repoRoot: string;
  relPath: string;  // posix, relative to repoRoot
  agent: Agent;
  kind: ArtifactKind;
  links: { repoRoot: string; relPath: string; agent: Agent }[]; // other symlinked locations of the same file
  viaLink: boolean; // reached through a symlink (a file link or a linked folder above it)
}

/** A folder or file to scan; `repoRoot` pins attribution (used for the home directory with --local). */
export type Root = string | { path: string; repoRoot: string };

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', 'target', '__pycache__',
  '.venv', 'venv', 'env', 'coverage', '.cache', '.npm', '.yarn', '.pnpm-store', '.gradle', '.idea',
  'Pods', '.turbo', '.terraform', 'bower_components', '.svelte-kit', '.parcel-cache', '.tox',
  '.trash', '.Trash', 'Trash', '.history',
]);

const MAX_DEPTH = 14;

interface Rule {
  test: (rel: string, base: string) => boolean;
  agent: Agent;
  kind: ArtifactKind;
}

const under = (rel: string, dir: string) => rel.startsWith(dir + '/') || rel.includes('/' + dir + '/');

// skillshare layouts. Global: ~/.config/skillshare/{skills,agents,rules,commands,…}. Project: .skillshare/ or skillshare/.
// The visible project folder `skillshare/` only counts at the repo root.
const SS_PREFIX = String.raw`(?:(?:^|\/)\.skillshare|(?:^|\/)\.config\/skillshare|^skillshare)`;
const SS_ROOT = new RegExp(`${SS_PREFIX}$`);
const SS_SKILLS = new RegExp(`${SS_PREFIX}\\/skills\\/`);
const SS_AGENTS = new RegExp(`${SS_PREFIX}\\/agents\\/[^/]+$`);
const SS_EXTRAS = new RegExp(`${SS_PREFIX}\\/(?:extras\\/[^/]+|rules|commands|prompts|workflows)\\/(?:.+\\/)?[^/]+$`);
/** skillshare's operational folders, never agent content. */
const SS_SKIP = new Set(['trash', 'backups', 'logs']);
/** Folder names where skill managers create symlinks; symlinked folders are only followed inside these. */
const AGENT_SEGMENTS = new Set(['.claude', '.agents', '.codex', '.cursor', '.gemini', '.github', '.windsurf', '.skillshare', 'skillshare', 'skills', 'agents', 'commands', 'prompts', 'rules', 'extras', 'workflows']);
const inAgentArea = (p: string) => p.split(/[\\/]/).some((s) => AGENT_SEGMENTS.has(s));

/** Ordered: first match wins. */
const RULES: Rule[] = [
  // Claude Code
  { test: (r, b) => b === 'SKILL.md' && under(r, '.claude/skills'), agent: 'claude-code', kind: 'skill' },
  { test: (r, b) => b.endsWith('.md') && under(r, '.claude/commands'), agent: 'claude-code', kind: 'command' },
  { test: (r, b) => b.endsWith('.md') && under(r, '.claude/agents'), agent: 'claude-code', kind: 'subagent' },
  { test: (r, b) => (b === 'settings.json' || b === 'settings.local.json') && under(r, '.claude') && dirname(r).endsWith('.claude'), agent: 'claude-code', kind: 'settings' },
  { test: (_r, b) => b === 'CLAUDE.md' || b === 'CLAUDE.local.md', agent: 'claude-code', kind: 'rules' },
  { test: (_r, b) => b === '.mcp.json', agent: 'claude-code', kind: 'mcp-config' },
  { test: (r, b) => (b === 'plugin.json' || b === 'marketplace.json') && under(r, '.claude-plugin'), agent: 'claude-code', kind: 'plugin' },
  // Codex
  { test: (_r, b) => b === 'AGENTS.md' || b === 'AGENTS.override.md', agent: 'codex', kind: 'rules' },
  { test: (r, b) => b === 'config.toml' && under(r, '.codex'), agent: 'codex', kind: 'settings' },
  { test: (r, b) => b.endsWith('.md') && under(r, '.codex/prompts'), agent: 'codex', kind: 'command' },
  // Cursor
  { test: (r, b) => (b.endsWith('.mdc') || b.endsWith('.md')) && under(r, '.cursor/rules'), agent: 'cursor', kind: 'rules' },
  { test: (r, b) => b.endsWith('.md') && under(r, '.cursor/commands'), agent: 'cursor', kind: 'command' },
  { test: (_r, b) => b === '.cursorrules', agent: 'cursor', kind: 'rules' },
  { test: (r, b) => b === 'mcp.json' && under(r, '.cursor'), agent: 'cursor', kind: 'mcp-config' },
  // GitHub Copilot
  { test: (r, b) => b === 'copilot-instructions.md' && under(r, '.github'), agent: 'copilot', kind: 'rules' },
  { test: (r, b) => b.endsWith('.instructions.md') && under(r, '.github/instructions'), agent: 'copilot', kind: 'rules' },
  { test: (r, b) => b.endsWith('.prompt.md') && under(r, '.github/prompts'), agent: 'copilot', kind: 'command' },
  { test: (r, b) => (b.endsWith('.chatmode.md') || b.endsWith('.agent.md')) && (under(r, '.github/chatmodes') || under(r, '.github/agents')), agent: 'copilot', kind: 'subagent' },
  { test: (r, b) => b === 'mcp.json' && under(r, '.vscode'), agent: 'copilot', kind: 'mcp-config' },
  // Gemini CLI
  { test: (_r, b) => b === 'GEMINI.md', agent: 'gemini', kind: 'rules' },
  { test: (r, b) => b === 'settings.json' && under(r, '.gemini'), agent: 'gemini', kind: 'settings' },
  { test: (r, b) => b.endsWith('.toml') && under(r, '.gemini/commands'), agent: 'gemini', kind: 'command' },
  // Windsurf
  { test: (_r, b) => b === '.windsurfrules', agent: 'windsurf', kind: 'rules' },
  { test: (r, b) => b.endsWith('.md') && under(r, '.windsurf/rules'), agent: 'windsurf', kind: 'rules' },
  { test: (r, b) => b.endsWith('.md') && under(r, '.windsurf/workflows'), agent: 'windsurf', kind: 'command' },
  // Skills synced into other tools' folders (skillshare and npx skills targets)
  { test: (r, b) => b === 'SKILL.md' && under(r, '.codex/skills'), agent: 'codex', kind: 'skill' },
  { test: (r, b) => b === 'SKILL.md' && under(r, '.cursor/skills'), agent: 'cursor', kind: 'skill' },
  { test: (r, b) => b === 'SKILL.md' && under(r, '.gemini/skills'), agent: 'gemini', kind: 'skill' },
  // skillshare: ~/.config/skillshare/ (global) and .skillshare/ or skillshare/ (project)
  { test: (r, b) => b === 'SKILL.md' && SS_SKILLS.test(r), agent: 'skillshare', kind: 'skill' },
  { test: (r, b) => b.endsWith('.md') && SS_AGENTS.test(r), agent: 'skillshare', kind: 'subagent' },
  { test: (r, b) => b.endsWith('.md') && SS_EXTRAS.test(r), agent: 'skillshare', kind: 'rules' },
  { test: (r, b) => (b === 'config.yaml' || b === 'mcp.yaml') && SS_ROOT.test(dirname(r)), agent: 'skillshare', kind: 'settings' },
  // Generic Agent Skills (any SKILL.md not matched above, e.g. plugin or shared skill folders)
  { test: (_r, b) => b === 'SKILL.md', agent: 'agent-skills', kind: 'skill' },
];

export function classify(relPath: string): { agent: Agent; kind: ArtifactKind } | null {
  const base = relPath.split('/').pop() ?? relPath;
  for (const rule of RULES) {
    if (!rule.test(relPath, base)) continue;
    if (rule.agent === 'skillshare' && rule.kind === 'rules' && /\.?skillshare\/(?:extras\/)?(?:commands|prompts|workflows)\//.test(relPath)) return { agent: 'skillshare', kind: 'command' };
    if (rule.kind === 'settings' && base === 'mcp.yaml') return { agent: rule.agent, kind: 'mcp-config' };
    return { agent: rule.agent, kind: rule.kind };
  }
  return null;
}

/** User-level agent folders scanned by --local (only those that exist). */
export function localRoots(home = homedir()): Root[] {
  const xdg = process.env.XDG_CONFIG_HOME && home === homedir() ? process.env.XDG_CONFIG_HOME : join(home, '.config');
  const paths = [
    '.claude/skills', '.claude/commands', '.claude/agents', '.claude/settings.json', '.claude/CLAUDE.md',
    '.agents/skills',
    '.codex/skills', '.codex/prompts', '.codex/config.toml', '.codex/AGENTS.md',
    '.cursor/skills', '.cursor/rules', '.cursor/commands', '.cursor/mcp.json',
    '.gemini/skills', '.gemini/commands', '.gemini/settings.json', '.gemini/GEMINI.md',
  ].map((p) => join(home, p));
  paths.push(join(xdg, 'skillshare'));
  return paths.filter((p) => existsSync(p)).map((p) => ({ path: p, repoRoot: p.startsWith(home + sep) ? home : dirname(p) }));
}

const toPosix = (p: string) => p.split(sep).join('/');

/** Walk the given roots and return every agent artifact candidate, attributed to its nearest git repo. */
export function discover(roots: Root[], opts: { worktrees?: boolean } = {}): { candidates: Candidate[]; filesScanned: number; repos: string[]; worktreesSkipped: string[] } {
  const found: Candidate[] = [];
  const repos = new Set<string>();
  const worktreesSkipped: string[] = [];
  let filesScanned = 0;

  for (const spec of roots) {
    const rawRoot = typeof spec === 'string' ? spec : spec.path;
    const root = resolve(rawRoot);
    if (!existsSync(root)) throw new Error(`Path not found: ${rawRoot}`);
    const rootIsFile = statSync(root).isFile();
    const walkRoot = rootIsFile ? dirname(root) : root;
    const pinned = typeof spec === 'string' ? undefined : resolve(spec.repoRoot);
    const fallbackRepo = pinned ?? findGitRoot(walkRoot) ?? walkRoot;

    const addFile = (full: string, repoRoot: string, viaLink: boolean) => {
      if (rootIsFile && full !== root) return;
      filesScanned++;
      const rel = toPosix(relative(repoRoot, full));
      const hit = classify(rel);
      if (!hit) return;
      let realPath = full;
      try { realPath = realpathSync(full); } catch { /* keep the logical path */ }
      found.push({ path: full, realPath, repoRoot, relPath: rel, ...hit, links: [], viaLink });
      repos.add(repoRoot);
    };

    // `ancestors` holds the real paths of the folders above this one, so a symlink back up the tree can't loop.
    const visit = (dir: string, repoRoot: string, depth: number, ancestors: Set<string>, viaLink: boolean) => {
      if (depth > MAX_DEPTH) return;
      let real = dir;
      try { real = realpathSync(dir); } catch { return; }
      if (ancestors.has(real)) return;
      const chain = new Set(ancestors).add(real);
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      // A nested .git marks a new repo boundary, except inside a skillshare source (tracked skill repos belong to it).
      const isRepo = !pinned && entries.some((e) => e.name === '.git') && !SS_SKILLS.test(toPosix(relative(repoRoot, dir)) + '/');
      // A linked worktree is another checkout of a repo, not another team's repo: skip it unless asked.
      if (isRepo && depth > 0 && !opts.worktrees && isLinkedWorktree(entries, dir)) { worktreesSkipped.push(dir); return; }
      const currentRepo = isRepo ? dir : repoRoot;
      const inSkillshare = SS_ROOT.test(toPosix(relative(repoRoot, dir)));
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || (inSkillshare && SS_SKIP.has(e.name))) continue;
          visit(full, currentRepo, depth + 1, chain, viaLink);
        } else if (e.isFile()) {
          addFile(full, currentRepo, viaLink);
        } else if (e.isSymbolicLink()) {
          // Skill managers (skillshare, npx skills) install by symlink. Follow links inside agent folders
          // when they point at agent content; ignore broken links.
          let st;
          try { st = statSync(full); } catch { continue; }
          if (st.isFile()) addFile(full, currentRepo, true);
          else if (st.isDirectory() && !SKIP_DIRS.has(e.name) && inAgentArea(dir)) {
            let target = full;
            try { target = realpathSync(full); } catch { continue; }
            if (inAgentArea(target)) visit(full, currentRepo, depth + 1, chain, true);
          }
        }
      }
    };
    visit(walkRoot, fallbackRepo, 0, new Set(), false);
  }

  // De-duplicate overlapping roots, then fold symlinked copies of the same file into one candidate.
  const seen = new Set<string>();
  const unique = found.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
  const byReal = new Map<string, Candidate[]>();
  for (const c of unique) byReal.set(c.realPath, [...(byReal.get(c.realPath) ?? []), c]);
  const candidates: Candidate[] = [];
  for (const group of byReal.values()) {
    // Prefer the real file itself, then a skillshare source, then the first location found.
    const primary = group.find((c) => !c.viaLink) ?? group.find((c) => c.agent === 'skillshare') ?? group[0];
    primary.links = group.filter((c) => c !== primary).map((c) => ({ repoRoot: c.repoRoot, relPath: c.relPath, agent: c.agent }));
    candidates.push(primary);
  }
  return { candidates, filesScanned, repos: [...repos].sort(), worktreesSkipped };
}

/** True when `.git` is a file pointing into another repo's .git/worktrees/ (not a submodule). */
function isLinkedWorktree(entries: { name: string; isFile(): boolean }[], dir: string): boolean {
  const git = entries.find((e) => e.name === '.git');
  if (!git || !git.isFile()) return false;
  try { return /^gitdir:.*[\\/]worktrees[\\/]/m.test(readFileSync(join(dir, '.git'), 'utf8')); } catch { return false; }
}

function findGitRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function repoName(repoRoot: string): string {
  if (repoRoot === homedir()) return '~';
  return basename(repoRoot) || repoRoot;
}

