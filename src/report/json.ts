import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { ScanResult } from '../types.js';

/** A path under the home folder as ~/…, so reports don't carry the user's name. */
function tilde(path: string, home = homedir()): string {
  return path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length).split(sep).join('/') : path;
}

/**
 * JSON report without file bodies (keeps output small and avoids re-publishing file contents).
 * `repoRoot` stays, with the home folder as ~, so other tools (roost) can match artifacts to the repos agents ran in.
 */
export function renderJson(r: ScanResult): string {
  return JSON.stringify(
    {
      ...r,
      artifacts: r.artifacts.map(({ body, bundled, path, repoRoot, realPath, frontmatter, ...rest }) => ({ ...rest, repoRoot: tilde(repoRoot) })),
    },
    null,
    2,
  ) + '\n';
}
