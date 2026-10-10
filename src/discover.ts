import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, basename, dirname, resolve } from 'node:path';
import type { Agent, ArtifactKind } from './types.js';

/** A file that looks like an agent artifact, before parsing. */
export interface Candidate {
  path: string;
  repoRoot: string;
  relPath: string; // posix, relative to repoRoot
  agent: Agent;
  kind: ArtifactKind;
}

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
  // Generic Agent Skills (any SKILL.md not matched above, e.g. plugin or shared skill folders)
  { test: (_r, b) => b === 'SKILL.md', agent: 'agent-skills', kind: 'skill' },
];

export function classify(relPath: string): { agent: Agent; kind: ArtifactKind } | null {
  const base = relPath.split('/').pop() ?? relPath;
  for (const rule of RULES) if (rule.test(relPath, base)) return { agent: rule.agent, kind: rule.kind };
  return null;
}

const toPosix = (p: string) => p.split(sep).join('/');

/** Walk the given roots and return every agent artifact candidate, attributed to its nearest git repo. */
export function discover(roots: string[]): { candidates: Candidate[]; filesScanned: number; repos: string[] } {
  const candidates: Candidate[] = [];
  const repos = new Set<string>();
  let filesScanned = 0;

  for (const rawRoot of roots) {
    const root = resolve(rawRoot);
    if (!existsSync(root)) throw new Error(`Path not found: ${rawRoot}`);
    const rootIsFile = statSync(root).isFile();
    const walkRoot = rootIsFile ? dirname(root) : root;
    const fallbackRepo = findGitRoot(walkRoot) ?? walkRoot;

    const visit = (dir: string, repoRoot: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      // A nested .git marks a new repo boundary (monorepo folders of many repos).
      const isRepo = entries.some((e) => e.name === '.git');
      const currentRepo = isRepo ? dir : repoRoot;
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          visit(full, currentRepo, depth + 1);
        } else if (e.isFile()) {
          if (rootIsFile && full !== root) continue;
          filesScanned++;
          const rel = toPosix(relative(currentRepo, full));
          const hit = classify(rel);
          if (hit) {
            candidates.push({ path: full, repoRoot: currentRepo, relPath: rel, ...hit });
            repos.add(currentRepo);
          }
        }
      }
    };
    visit(walkRoot, fallbackRepo, 0);
  }

  // De-duplicate if overlapping roots were passed.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
  return { candidates: unique, filesScanned, repos: [...repos].sort() };
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
  return basename(repoRoot) || repoRoot;
}

