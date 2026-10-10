/** Keyword taxonomy for "what are teams building again and again". Order breaks ties. */
const TAXONOMY: { category: string; label: string; words: string[] }[] = [
  { category: 'code-review', label: 'Code review', words: ['pull request', 'review this pr', 'review a pull request', 'code review', 'review code', 'pr review', 'review pr', 'review the pr', 'pull request review', 'review pull request', 'reviewer', 'review changes', 'review the diff', 'code-review'] },
  { category: 'commit-messages', label: 'Commit messages', words: ['commit message', 'conventional commit', 'git commit', 'commit msg', 'commit-message'] },
  { category: 'pr-descriptions', label: 'PR descriptions', words: ['pr description', 'pull request description', 'describe the pr', 'pr summary', 'pr body', 'open a pr', 'create a pr', 'pr template'] },
  { category: 'testing', label: 'Testing', words: ['unit test', 'write tests', 'test cases', 'e2e', 'end-to-end', 'jest', 'pytest', 'vitest', 'playwright', 'test coverage', 'tdd', 'testing'] },
  { category: 'debugging', label: 'Debugging', words: ['debug', 'debugging', 'diagnose', 'root cause', 'stack trace', 'bug fix', 'fix the bug', 'troubleshoot', 'reproduce'] },
  { category: 'refactoring', label: 'Refactoring', words: ['refactor', 'clean up code', 'simplify', 'code smell', 'dead code', 'tech debt'] },
  { category: 'security', label: 'Security', words: ['security', 'vulnerab*', 'owasp', 'secret scan', 'threat model', 'cve', 'pentest', 'auth review'] },
  { category: 'documentation', label: 'Documentation', words: ['documentation', 'readme', 'docstring', 'write docs', 'api docs', 'jsdoc', 'docs'] },
  { category: 'release-notes', label: 'Changelog & release notes', words: ['changelog', 'release notes', 'release note', 'version bump', 'semver'] },
  { category: 'deployment', label: 'Deployment & CI/CD', words: ['deploy', 'deployment', 'ci/cd', 'github actions', 'pipeline', 'docker', 'kubernetes', 'helm', 'terraform', 'rollout'] },
  { category: 'database', label: 'Database & migrations', words: ['migration', 'database', 'schema', 'sql', 'postgres', 'mysql', 'prisma', 'orm'] },
  { category: 'api', label: 'API design', words: ['api design', 'endpoint', 'openapi', 'swagger', 'graphql', 'rest api', 'grpc'] },
  { category: 'frontend', label: 'Frontend & UI', words: ['react', 'component', 'tailwind', 'css', 'frontend', 'ui', 'accessibility', 'a11y', 'design system', 'figma'] },
  { category: 'performance', label: 'Performance', words: ['performance', 'profiling', 'optimiz*', 'latency', 'benchmark', 'memory leak'] },
  { category: 'incident', label: 'Incidents & on-call', words: ['incident', 'postmortem', 'post-mortem', 'on-call', 'oncall', 'runbook', 'outage'] },
  { category: 'planning', label: 'Planning & specs', words: ['plan', 'planning', 'spec', 'specification', 'prd', 'requirements', 'design doc', 'rfc', 'user story', 'roadmap'] },
  { category: 'codebase-onboarding', label: 'Codebase onboarding', words: ['onboarding', 'explain the codebase', 'architecture overview', 'codebase tour', 'how this repo'] },
  { category: 'data-analysis', label: 'Data & analytics', words: ['analytics', 'dashboard', 'metrics', 'data analysis', 'pandas', 'notebook', 'chart'] },
  { category: 'content-writing', label: 'Writing & content', words: ['blog', 'copywriting', 'marketing', 'seo', 'newsletter', 'social post', 'tweet'] },
];

const FIXED: Record<string, string> = {
  rules: 'project-instructions',
  settings: 'agent-settings',
  'mcp-config': 'mcp-servers',
  plugin: 'plugin-manifest',
};

export const CATEGORY_LABELS: Record<string, string> = {
  ...Object.fromEntries(TAXONOMY.map((t) => [t.category, t.label])),
  'project-instructions': 'Project instructions',
  'agent-settings': 'Agent settings',
  'mcp-servers': 'MCP servers',
  'plugin-manifest': 'Plugin manifests',
  other: 'Other',
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const patternCache = new Map<string, RegExp>();
/** Hyphens, underscores and slashes count as spaces: "pr-review" matches "pr review". */
const norm = (t: string) => t.toLowerCase().replace(/[-_/]+/g, ' ');

/** Whole-word count. "plan" matches plan/plans/planned but not "explanation"; a trailing * marks a stem. */
function count(haystack: string, word: string): number {
  let re = patternCache.get(word);
  if (!re) {
    const stem = word.endsWith('*');
    const core = esc(norm(stem ? word.slice(0, -1) : word).trim());
    re = new RegExp(`(?<![a-z0-9])${core}${stem ? '' : '(?:s|es|ed|ing)?(?![a-z0-9])'}`, 'g');
    patternCache.set(word, re);
  }
  return haystack.match(re)?.length ?? 0;
}

/** Pick the best category: hits in name/description weigh 4x, body hits count once (capped). */
export function categorize(head: string, body: string, kind?: string): string {
  if (kind && FIXED[kind]) return FIXED[kind];
  const h = ` ${norm(head)} `;
  const b = ` ${norm(body)} `;
  let best = 'other', bestScore = 0;
  for (const t of TAXONOMY) {
    let score = 0;
    for (const w of t.words) score += count(h, w) * 4 + Math.min(count(b, w), 3);
    if (score > bestScore) { best = t.category; bestScore = score; }
  }
  return bestScore >= 2 ? best : 'other';
}
