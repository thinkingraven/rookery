import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Artifact, Hook, McpServer } from './types.js';
import type { Candidate } from './discover.js';
import { repoName } from './discover.js';
import { categorize } from './categories.js';
import { provenanceOf } from './provenance.js';

const BUNDLED_EXT = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.ps1', '.pl', '.md', '.json', '.yaml', '.yml', '.toml', '.txt', '.mdc']);
const MAX_BUNDLED_BYTES = 256 * 1024;

export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string; bodyStartLine: number } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, bodyStartLine: 1 };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Malformed frontmatter: fall back to simple "key: value" lines.
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  const bodyStartLine = m[0].split('\n').length;
  return { data, body: text.slice(m[0].length), bodyStartLine };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function firstHeading(body: string): string {
  const m = /^#{1,3}\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : '';
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const t = block.trim();
    if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('<!--') || t.startsWith('|') || t.startsWith('---')) continue;
    return t.replace(/\s+/g, ' ').slice(0, 240);
  }
  return '';
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/```[a-z]*\n?/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function parseJsonSafe(text: string): any {
  try { return JSON.parse(text); } catch {
    // Tolerate JSON with comments / trailing commas (VS Code style).
    try { return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
  }
}

function mcpFromObject(obj: any): McpServer[] {
  const servers = obj?.mcpServers ?? obj?.servers ?? obj?.mcp?.servers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers).map(([name, cfg]: [string, any]) => ({
    name,
    command: typeof cfg?.command === 'string' ? cfg.command : undefined,
    args: Array.isArray(cfg?.args) ? cfg.args.map(String) : undefined,
    url: typeof cfg?.url === 'string' ? cfg.url : typeof cfg?.httpUrl === 'string' ? cfg.httpUrl : undefined,
    transport: typeof cfg?.type === 'string' ? cfg.type : typeof cfg?.transport === 'string' ? cfg.transport : undefined,
  }));
}

function hooksFromSettings(obj: any): Hook[] {
  const hooks = obj?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: Hook[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const inner = (entry as any)?.hooks ?? [entry];
      for (const h of Array.isArray(inner) ? inner : [inner]) {
        if (h && typeof h.command === 'string') out.push({ event, command: h.command });
      }
    }
  }
  return out;
}

/** Minimal TOML reader for Codex `[mcp_servers.<name>]` tables. */
function mcpFromCodexToml(text: string): McpServer[] {
  const out: McpServer[] = [];
  const re = /^\[mcp_servers\.("?)([^\]"]+)\1\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const block = m[3];
    const get = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm').exec(block)?.[1];
    const argsRaw = /^args\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1];
    out.push({
      name: m[2],
      command: get('command'),
      url: get('url'),
      args: argsRaw ? [...argsRaw.matchAll(/"([^"]*)"/g)].map((a) => a[1]) : undefined,
    });
  }
  return out;
}

function bundledFiles(skillDir: string, repoRoot: string): { relPath: string; content: string }[] {
  const out: { relPath: string; content: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length > 50) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(full, depth + 1); continue; }
      if (!e.isFile() || e.name === 'SKILL.md' || !BUNDLED_EXT.has(extname(e.name).toLowerCase())) continue;
      try {
        if (statSync(full).size > MAX_BUNDLED_BYTES) continue;
        out.push({ relPath: relative(repoRoot, full).split(sep).join('/'), content: readFileSync(full, 'utf8') });
      } catch { /* unreadable */ }
    }
  };
  walk(skillDir, 0);
  return out;
}

function defaultName(c: Candidate): string {
  const base = basename(c.relPath);
  if (base === 'SKILL.md') return basename(dirname(c.path));
  if (c.kind === 'rules' && !base.endsWith('.mdc') && !c.relPath.includes('/rules/') && !c.relPath.includes('/instructions/')) {
    const dir = dirname(c.relPath);
    return dir === '.' ? base : `${base} (${dir})`;
  }
  return base.replace(/\.(prompt|instructions|chatmode|agent)\.md$/, '').replace(/\.(md|mdc|toml|json)$/, '');
}

export function parseCandidate(c: Candidate, maxFileBytes: number): Artifact | null {
  let text: string;
  try {
    if (statSync(c.path).size > maxFileBytes) return null;
    text = readFileSync(c.path, 'utf8');
  } catch {
    return null;
  }

  let frontmatter: Record<string, unknown> = {};
  let body = text;
  let hooks: Hook[] = [];
  let mcpServers: McpServer[] = [];
  let allowedTools: string[] = [];

  const isJson = c.relPath.endsWith('.json');
  if (isJson) {
    const obj = parseJsonSafe(text) ?? {};
    hooks = hooksFromSettings(obj);
    mcpServers = mcpFromObject(obj);
    allowedTools = toList(obj?.permissions?.allow);
    frontmatter = { permissions: obj?.permissions, defaultMode: obj?.permissions?.defaultMode };
  } else if (c.relPath.endsWith('config.toml')) {
    mcpServers = mcpFromCodexToml(text);
  } else if (c.agent === 'skillshare' && /\.ya?ml$/.test(c.relPath)) {
    // skillshare config.yaml (mcp.servers) or mcp.yaml (servers)
    let obj: any = {};
    try { obj = parseYaml(text) ?? {}; } catch { obj = {}; }
    mcpServers = mcpFromObject(obj);
  } else {
    const fm = splitFrontmatter(text);
    frontmatter = fm.data;
    body = fm.body;
    allowedTools = toList(frontmatter['allowed-tools'] ?? frontmatter['allowed_tools'] ?? frontmatter['tools']);
  }

  const name = str(frontmatter.name).trim() || (c.kind === 'skill' ? '' : firstHeading(body)) || defaultName(c);
  const description = str(frontmatter.description).trim() || (isJson ? '' : firstParagraph(body));
  const bundled = c.kind === 'skill' ? bundledFiles(dirname(c.path), c.repoRoot) : [];
  const normalized = normalize(`${description}\n${body}`);

  return {
    id: `${repoName(c.repoRoot)}:${c.relPath}`,
    repo: repoName(c.repoRoot),
    repoRoot: c.repoRoot,
    path: c.path,
    relPath: c.relPath,
    agent: c.agent,
    kind: c.kind,
    name: c.kind === 'skill' && !str(frontmatter.name).trim() ? defaultName(c) : name,
    description,
    body: text,
    bytes: Buffer.byteLength(text),
    tokens: Math.ceil(text.length / 4),
    allowedTools,
    hooks,
    mcpServers,
    scripts: bundled.filter((b) => !b.relPath.endsWith('.md')).map((b) => b.relPath),
    bundled,
    category: categorize(`${name} ${description}`, body, c.kind),
    sha256: createHash('sha256').update(normalized).digest('hex'),
    frontmatter,
    realPath: c.realPath,
    links: c.links.map((l) => ({ repo: repoName(l.repoRoot), relPath: l.relPath, agent: l.agent, via: 'symlink' as const })),
    provenance: provenanceOf(c.realPath, c.kind),
  };
}
