import { readFileSync } from 'node:fs';

/** Read the version from package.json (works from both src/ and dist/src/). */
function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (pkg.name === '@thinkingraven/rookery') return pkg.version;
    } catch { /* try next */ }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
