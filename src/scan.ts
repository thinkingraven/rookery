import { discover, localRoots, repoName, type Root } from './discover.js';
import { skillshareCopyName, skillshareFlatName } from './provenance.js';
import { parseCandidate } from './parse.js';
import { runRules } from './rules.js';
import { findClusters } from './similarity.js';
import { SEVERITIES, type Artifact, type Finding, type ScanOptions, type ScanResult, type Severity } from './types.js';
import { VERSION } from './version.js';

const CONTENT_CATEGORIES = new Set(['project-instructions', 'agent-settings', 'mcp-servers', 'plugin-manifest']);

export function scan(opts: ScanOptions): ScanResult {
  const started = Date.now();
  const roots: Root[] = [...opts.paths, ...(opts.local ? localRoots(opts.home) : [])];
  const { candidates, filesScanned, repos, allRepos, worktreesSkipped } = discover(roots, { worktrees: opts.worktrees });

  const parsed = candidates
    .map((c) => parseCandidate(c, opts.maxFileBytes))
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.relPath.localeCompare(b.relPath));
  const artifacts = mergeSyncedCopies(parsed);

  const severityRank = (s: Severity) => SEVERITIES.indexOf(s);
  const findings = dedupe(artifacts.flatMap(runRules))
    .filter((f) => opts.includeInfo || f.severity !== 'info')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.repo.localeCompare(b.repo) || a.relPath.localeCompare(b.relPath) || a.line - b.line);

  const clusters = findClusters(artifacts, opts.similarityThreshold);
  // Copies installed from the same source (e.g. by a skill manager) are synced, not reinvented.
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  // An exact copy of an installed skill (no record of its own) counts as a copy of that install too.
  for (const c of clusters) {
    const provs = c.members.map((m) => byId.get(m.artifactId)?.provenance?.source);
    const sources = new Set(provs.filter(Boolean));
    const [only] = [...sources];
    if (sources.size === 1 && (provs.every(Boolean) || c.exact)) c.syncedFrom = only;
  }

  const catMap = new Map<string, { count: number; repos: Set<string> }>();
  for (const a of artifacts) {
    if (CONTENT_CATEGORIES.has(a.category)) continue;
    const e = catMap.get(a.category) ?? { count: 0, repos: new Set<string>() };
    e.count++;
    e.repos.add(a.repo);
    catMap.set(a.category, e);
  }
  const categories = [...catMap.entries()]
    .map(([category, e]) => ({ category, count: e.count, repos: e.repos.size }))
    .sort((x, y) => (x.category === 'other' ? 1 : 0) - (y.category === 'other' ? 1 : 0) || y.count - x.count);

  const tally = (key: 'agent' | 'kind') => artifacts.reduce<Record<string, number>>((acc, a) => ((acc[a[key]] = (acc[a[key]] ?? 0) + 1), acc), {});
  const findingsBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;

  return {
    tool: { name: 'rookery', version: VERSION },
    scannedAt: new Date().toISOString(),
    roots: opts.paths,
    repos: repos.map(repoName),
    artifacts,
    findings,
    clusters,
    categories,
    stats: {
      artifacts: artifacts.length,
      byAgent: tally('agent'),
      byKind: tally('kind'),
      findingsBySeverity,
      duplicateArtifacts: clusters.reduce((n, c) => n + c.members.length, 0),
      totalTokens: artifacts.reduce((n, a) => n + a.tokens, 0),
      filesScanned,
      reposWithoutArtifacts: allRepos.filter((r) => !repos.includes(r)).length,
      worktreesSkipped: worktreesSkipped.length,
      linkedArtifacts: artifacts.filter((a) => a.links.length).length,
      managed: artifacts.reduce<Record<string, number>>((acc, a) => (a.provenance ? ((acc[a.provenance.manager] = (acc[a.provenance.manager] ?? 0) + 1), acc) : acc), {}),
      modifiedSinceInstall: artifacts.filter((a) => a.provenance?.modified).length,
      durationMs: Date.now() - started,
    },
  };
}

/**
 * A file can be its own artifact and also a bundled file of a parent skill (a CLAUDE.md inside a skill folder).
 * Report each finding once, under the file's own artifact when there is one.
 */
function dedupe(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const k = `${f.repo}|${f.ruleId}|${f.relPath}|${f.line}|${f.ruleId.startsWith('RK-HOOK') ? f.snippet : ''}`;
    const prev = byKey.get(k);
    if (!prev || (f.artifactId === `${f.repo}:${f.relPath}` && prev.artifactId !== `${prev.repo}:${prev.relPath}`)) byKey.set(k, f);
  }
  return [...byKey.values()];
}

/** Fold copies skillshare synced into tool folders (copy mode) into the source skill they came from. */
function mergeSyncedCopies(artifacts: Artifact[]): Artifact[] {
  const sources = new Map<string, Artifact>();
  for (const a of artifacts) {
    const flat = a.agent === 'skillshare' ? skillshareFlatName(a.realPath, a.kind) : null;
    if (flat) sources.set(`${a.kind}:${flat}`, a);
  }
  return artifacts.filter((a) => {
    if (a.agent === 'skillshare') return true;
    const name = skillshareCopyName(a.path, a.kind);
    if (!name) return true;
    const source = sources.get(`${a.kind}:${name}`);
    if (!source) { a.provenance ??= { manager: 'skillshare' }; return true; }
    source.links.push({ repo: a.repo, relPath: a.relPath, agent: a.agent, via: 'copy' });
    return false;
  });
}
