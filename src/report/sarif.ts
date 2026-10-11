import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL_RULES } from '../rules.js';
import type { Finding, ScanResult, Severity } from '../types.js';

const RULES_DOC = 'https://github.com/thinkingraven/rookery/blob/main/docs/rules.md';

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };

/** GitHub code scanning maps this score to its own Critical (9+), High (7+), Medium (4+) and Low labels. */
const SECURITY_SEVERITY: Partial<Record<Severity, string>> = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0' };

const pascal = (s: string) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/** Repo-relative URI when the file sits under `base` (GitHub resolves it against the checkout), an absolute file URI otherwise. */
function location(base: string, repoRoot: string, relPath: string): { uri: string; uriBaseId?: string } {
  const abs = join(repoRoot, relPath);
  const rel = relative(base, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { uri: pathToFileURL(abs).href };
  return { uri: rel.split(sep).map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' };
}

/**
 * SARIF 2.1.0 for GitHub code scanning and other SARIF viewers. Low-confidence findings (examples, docs,
 * tests) are left out unless `strict`, because code scanning would raise them as real alerts.
 */
export function renderSarif(r: ScanResult, opts: { strict?: boolean; base?: string } = {}): string {
  const base = opts.base ?? process.cwd();
  const roots = new Map(r.artifacts.map((a) => [a.id + '\0' + a.repo, a.repoRoot]));
  const ruleIndex = new Map(ALL_RULES.map((rule, i) => [rule.id, i]));
  const seen = new Map<string, number>();

  const result = (f: Finding) => {
    const loc = location(base, roots.get(f.artifactId + '\0' + f.repo) ?? base, f.relPath);
    // Stable across line moves; the counter keeps identical lines in one file apart.
    const key = `${f.ruleId}|${loc.uri}|${f.snippet}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return {
      ruleId: f.ruleId,
      ruleIndex: ruleIndex.get(f.ruleId),
      level: LEVEL[f.severity],
      message: { text: `${f.title}. ${f.message}` },
      locations: [{ physicalLocation: { artifactLocation: loc, region: { startLine: Math.max(1, f.line) } } }],
      partialFingerprints: { 'rookeryFinding/v1': createHash('sha256').update(`${key}|${n}`).digest('hex').slice(0, 32) },
      properties: { repo: f.repo, confidence: f.confidence, ...(f.context ? { context: f.context } : {}) },
    };
  };

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: r.tool.name,
          version: r.tool.version,
          semanticVersion: r.tool.version,
          informationUri: 'https://github.com/thinkingraven/rookery',
          rules: ALL_RULES.map((rule) => {
            const quality = rule.id.startsWith('RK-QLT');
            const helpUri = `${RULES_DOC}#${rule.id.toLowerCase()}`;
            return {
              id: rule.id,
              name: pascal(rule.title),
              shortDescription: { text: rule.title },
              fullDescription: { text: rule.why },
              help: { text: `${rule.why}\n\nFix: ${rule.remediation}`, markdown: `${rule.why}\n\n**Fix:** ${rule.remediation}\n\n[Rule reference](${helpUri})` },
              helpUri,
              defaultConfiguration: { level: LEVEL[rule.severity] },
              properties: {
                tags: quality ? ['quality', 'ai-agents'] : ['security', 'ai-agents'],
                precision: 'high',
                ...(!quality && SECURITY_SEVERITY[rule.severity] ? { 'security-severity': SECURITY_SEVERITY[rule.severity] } : {}),
              },
            };
          }),
        },
      },
      results: r.findings.filter((f) => opts.strict || f.confidence === 'high').map(result),
      columnKind: 'utf16CodeUnits',
    }],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}
