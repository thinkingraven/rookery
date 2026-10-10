import type { ScanResult } from '../types.js';

/** JSON report without file bodies (keeps output small and avoids re-publishing file contents). */
export function renderJson(r: ScanResult): string {
  return JSON.stringify(
    {
      ...r,
      artifacts: r.artifacts.map(({ body, bundled, path, repoRoot, frontmatter, ...rest }) => rest),
    },
    null,
    2,
  ) + '\n';
}
