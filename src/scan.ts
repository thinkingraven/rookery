import { discover, repoName } from './discover.js';
import { parseCandidate } from './parse.js';
import { runRules } from './rules.js';
import { findClusters } from './similarity.js';
import { SEVERITIES, type ScanOptions, type ScanResult, type Severity } from './types.js';
import { VERSION } from './version.js';

const CONTENT_CATEGORIES = new Set(['project-instructions', 'agent-settings', 'mcp-servers', 'plugin-manifest']);

export function scan(opts: ScanOptions): ScanResult {
  const started = Date.now();
  const { candidates, filesScanned, repos } = discover(opts.paths);

  const artifacts = candidates
    .map((c) => parseCandidate(c, opts.maxFileBytes))
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.relPath.localeCompare(b.relPath));

  const severityRank = (s: Severity) => SEVERITIES.indexOf(s);
  const findings = artifacts
    .flatMap(runRules)
    .filter((f) => opts.includeInfo || f.severity !== 'info')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.repo.localeCompare(b.repo) || a.relPath.localeCompare(b.relPath) || a.line - b.line);

  const clusters = findClusters(artifacts, opts.similarityThreshold);

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
      durationMs: Date.now() - started,
    },
  };
}
