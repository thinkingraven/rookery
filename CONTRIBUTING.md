# Contributing to rookery

Thanks for helping. Rookery is small on purpose: one runtime dependency (`yaml`), no network calls, and every rule has to earn its place by catching real problems without burying people in noise.

## Setup

```bash
git clone https://github.com/thinkingraven/rookery.git
cd rookery
npm ci
npm test                         # builds, then runs the test suite
node dist/src/cli.js scan ~/code # try it on your own repos
```

Node 20 or newer.

## Where things live

| Path | What it does |
|---|---|
| `src/discover.ts` | Walks folders (following symlinks inside agent folders), finds repo boundaries, classifies agent files by path (`RULES`, first match wins), `--local` roots |
| `src/parse.ts` | Frontmatter, settings JSON, Codex TOML, MCP servers, hooks, bundled scripts |
| `src/rules.ts` | Security and quality rules, confidence scoring, suppressions, secret masking |
| `src/provenance.ts` | Install records from skillshare and `npx skills`: source, commit, edits since install, synced copies |
| `src/similarity.ts` | MinHash + LSH near-duplicate clustering |
| `src/categories.ts` | Purpose taxonomy ("Code review", "Testing"…) |
| `src/report/*` | Terminal, JSON, Markdown and HTML reports |
| `test/` | `node:test` suite and fixture repos |
| `scripts/gen-rules-doc.mjs` | Generates `docs/rules.md` from the rules |
| `action.yml` | The GitHub Action |

## Adding or changing a rule

1. Add it to `TEXT_RULES` (regex over text) or `META_RULES` (structured config) in `src/rules.ts`, with a clear `title`, `why` and `remediation`.
2. Add a test that **fires** on a realistic sample and one that **stays quiet** on the nearest harmless wording. False positives are bugs.
3. Run it on a large real corpus before opening the PR, for example a clone of [anthropics/skills](https://github.com/anthropics/skills), and say in the PR how many new findings it produced.
4. Run `npm run docs` and commit the updated `docs/rules.md` (CI checks it).

## Supporting a new agent

Add path patterns to `RULES` in `src/discover.ts`, a case to the `classify` test, and a row to the "What it finds" table in the README. Link the agent's docs in the PR.

## Pull requests

- Keep changes focused; one rule or feature per PR.
- No new runtime dependencies without discussing it in an issue first.
- Rookery must never execute scanned files or make network calls.

## Releasing

1. In a PR, bump the version (`npm version <x.y.z> --no-git-tag-version`) and move the changelog's "Unreleased" notes under it.
2. Once it's merged, publish a GitHub release tagged `vX.Y.Z` on that commit. `.github/workflows/release.yml` runs the tests and publishes to npm with provenance; the tag must match `package.json`.
3. Move the major tag the GitHub Action uses: `git tag -f v0 vX.Y.Z && git push -f origin v0` (owners only, since release tags are protected).

## Reporting false positives

Use the [false positive form](https://github.com/thinkingraven/rookery/issues/new?template=false-positive.yml). Replace real secrets, hosts and names with placeholders.
