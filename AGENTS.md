# AGENTS.md

Guidance for coding agents working on rookery.

## Commands

- `npm ci`: install
- `npm test`: build (TypeScript to `dist/`) and run the `node:test` suite. Run it after every change.
- `npm run docs`: regenerate `docs/rules.md`; required whenever `src/rules.ts` changes
- `node dist/src/cli.js scan <path>`: run the CLI from source

## Ground rules

- Rookery must never execute scanned files or make network calls.
- Keep the single runtime dependency (`yaml`). Use Node built-ins (`node:fs`, `node:util` `parseArgs`, `node:test`).
- ESM with NodeNext resolution: import local files with a `.js` extension.
- Every new or changed rule needs a test that fires and a test that stays quiet on the nearest harmless wording (`test/scan.test.ts`, fixtures in `test/fixtures.ts`). False positives are bugs.
- Never put real secrets in fixtures; build fake ones that pass the validators in `src/rules.ts`.
- Reports must mask secrets (`mask()` in `src/rules.ts`) and the JSON report must never include file bodies.

## Map

See the table in [CONTRIBUTING.md](CONTRIBUTING.md#where-things-live).

## Brand

Copy, colours and type follow the Thinking Raven brand: https://thinkingraven.github.io/brand/ (DESIGN.md and AGENTS.md there). Write "rookery." in lowercase with an amber full stop in visuals and "rookery" in prose.

## Public repository rules

This repository is public. Follow the organisation rules in https://github.com/thinkingraven/.github/blob/main/PUBLIC-REPOS.md: no secrets, no employer or client material, no personal data, demo data only in screenshots and examples.
