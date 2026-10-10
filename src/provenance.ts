import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Provenance } from './types.js';

// Who installed a skill and from where, read from the records skill managers keep:
//   skillshare  <source>/.metadata.json (per-file sha256), <project>/.skillshare/skills.lock.json,
//               and .skillshare-manifest.json in each tool folder it syncs to
//   npx skills  <dir>/.agents/.skill-lock.json

const jsonCache = new Map<string, any>();
function readJson(path: string): any {
  if (!jsonCache.has(path)) {
    let v: any = null;
    try { if (existsSync(path)) v = JSON.parse(readFileSync(path, 'utf8')); } catch { v = null; }
    jsonCache.set(path, v);
  }
  return jsonCache.get(path);
}

const posix = (p: string) => p.split(sep).join('/');
const sha256 = (path: string) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
const short = (commit?: unknown) => (typeof commit === 'string' && commit ? commit.slice(0, 7) : undefined);

/** The skillshare skills source folder containing `path`, e.g. ~/.config/skillshare/skills or <repo>/.skillshare/skills. */
function skillshareSource(path: string): string | null {
  let dir = dirname(path);
  for (let i = 0; i < 12; i++) {
    const root = dirname(dir);
    // Only a real skillshare folder: it has a config (project and global) or install metadata.
    if (basename(dir) === 'skills' && /^\.?skillshare$/.test(basename(root)) && (existsSync(join(root, 'config.yaml')) || existsSync(join(dir, '.metadata.json')))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Look a skill up by its path in the source, then by each parent folder (tracked repos are recorded at their root). */
function lookup<T>(table: Record<string, T> | undefined, key: string): [string, T] | null {
  if (!table) return null;
  for (let k = key; k; k = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : '') if (table[k]) return [k, table[k]];
  return null;
}

function fromSkillshare(realPath: string, kind: string): Provenance | null {
  const source = skillshareSource(realPath);
  if (!source) return null;
  const itemDir = kind === 'skill' ? dirname(realPath) : realPath;
  const key = posix(relative(source, itemDir)).replace(/\.md$/, '');
  const meta = readJson(join(source, '.metadata.json'));
  const lock = readJson(join(dirname(source), 'skills.lock.json'));
  const out: Provenance = { manager: 'skillshare' };

  // Current format: { version: 1, entries: { "<path>": {...} } }. Older: { skills: [{ name, source }] }.
  const legacy = Array.isArray(meta?.skills) ? Object.fromEntries(meta.skills.map((s: any) => [s?.name, s])) : undefined;
  const hit = lookup(meta?.entries, key) ?? lookup(legacy, key) ?? lookup(legacy, basename(itemDir));
  if (hit) {
    const [at, e] = hit as [string, any];
    if (typeof e.source === 'string' && e.source) out.source = e.source;
    if (typeof e.repo_url === 'string' && e.repo_url) out.url = e.repo_url;
    out.commit = short(e.version);
    if (typeof e.installed_at === 'string') out.installedAt = e.installed_at;
    if (e.tracked === true) out.tracked = true;
    // file_hashes: { "SKILL.md": "sha256:<hex>" }, relative to the recorded entry's folder.
    if (e.file_hashes && typeof e.file_hashes === 'object') {
      const base = join(source, at);
      const files = Object.entries(e.file_hashes as Record<string, string>).slice(0, 200);
      out.modified = files.some(([file, digest]) => sha256(join(base, file)) !== String(digest).replace(/^sha256:/, ''));
    }
  }
  const pinned = lookup(lock?.skills, key);
  if (pinned) {
    const e = pinned[1] as any;
    out.source ??= typeof e.source === 'string' ? e.source : undefined;
    out.commit ??= short(e.commit);
  }
  return out;
}

function fromSkillsCli(realPath: string): Provenance | null {
  // <dir>/.agents/skills/<name>/SKILL.md  with  <dir>/.agents/.skill-lock.json
  const m = posix(realPath).match(/^(.*\/\.agents)\/skills\/([^/]+)\/SKILL\.md$/);
  if (!m) return null;
  const e = readJson(join(m[1], '.skill-lock.json'))?.skills?.[m[2]];
  if (!e) return null;
  return {
    manager: 'skills-cli',
    source: typeof e.source === 'string' ? e.source : undefined,
    url: typeof e.sourceUrl === 'string' ? e.sourceUrl : undefined,
    installedAt: typeof e.installedAt === 'string' ? e.installedAt : undefined,
  };
}

/** A real (non-symlink) copy that skillshare synced into a tool folder in copy mode: returns its flattened name. */
export function skillshareCopyName(path: string, kind: string): string | null {
  const itemDir = kind === 'skill' ? dirname(path) : path;
  const managed = readJson(join(dirname(itemDir), '.skillshare-manifest.json'))?.managed;
  const name = basename(itemDir);
  return managed && typeof managed === 'object' && managed[name] && managed[name] !== 'symlink' ? name : null;
}

/** The flattened name skillshare gives a source skill in tool folders: tools/pdf → tools__pdf. */
export function skillshareFlatName(realPath: string, kind: string): string | null {
  const source = skillshareSource(realPath);
  if (!source) return null;
  return posix(relative(source, kind === 'skill' ? dirname(realPath) : realPath)).replace(/\//g, '__');
}

export function provenanceOf(realPath: string, kind: string): Provenance | undefined {
  if (kind !== 'skill' && kind !== 'subagent' && kind !== 'command' && kind !== 'rules') return undefined;
  return fromSkillshare(realPath, kind) ?? fromSkillsCli(realPath) ?? undefined;
}
