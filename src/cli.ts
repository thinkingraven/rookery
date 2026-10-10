#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { scan } from './scan.js';
import { renderTerminal } from './report/terminal.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { renderHtml } from './report/html.js';
import { ALL_RULES } from './rules.js';
import { SEVERITIES, type Severity } from './types.js';
import { VERSION } from './version.js';

const HELP = `rookery v${VERSION}: find, de-duplicate and security-check AI agent skills.

Usage
  rookery scan [paths...]        Scan one or more repos or folders (default: .)
  rookery rules                  List every security rule

Options
  --format <terminal|json|markdown>   Output format on stdout (default: terminal)
  --html <file>                       Also write a shareable HTML report
  --json <file>                       Also write the JSON report to a file
  --md <file>                         Also write a Markdown report to a file
  --fail-on <severity>                Exit 1 if any finding is at or above this severity
                                      (critical, high, medium, low)
  --threshold <0-1>                   Near-duplicate similarity threshold (default: 0.5)
  --max-file-size <kb>                Skip files larger than this (default: 512)
  --strict                            Count low-confidence findings for --fail-on
                                      (examples, docs, tests) as well
  --info                              Include info-level findings
  --worktrees                         Also scan linked git worktrees (skipped by default)
  --verbose                           Show everything in the terminal report
  --no-color                          Disable colours (also respects NO_COLOR; FORCE_COLOR forces them)
  -v, --version                       Print the version
  -h, --help                          Show this help

Examples
  npx @thinkingraven/rookery scan .
  npx @thinkingraven/rookery scan ~/code --html rookery-report.html
  npx @thinkingraven/rookery scan . --format json --fail-on high   # in CI
`;

function fail(msg: string): never {
  process.stderr.write(`rookery: ${msg}\n\nRun \`rookery --help\` for usage.\n`);
  process.exit(2);
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'terminal' },
        html: { type: 'string' },
        json: { type: 'string' },
        md: { type: 'string' },
        'fail-on': { type: 'string' },
        threshold: { type: 'string', default: '0.5' },
        'max-file-size': { type: 'string', default: '512' },
        info: { type: 'boolean', default: false },
        worktrees: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }
  const { values: o, positionals } = parsed;
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(`${VERSION}\n`); return 0; }

  const [command = 'scan', ...rest] = positionals;
  if (command === 'rules') {
    for (const r of ALL_RULES) process.stdout.write(`${r.id}  ${r.severity.padEnd(8)}  ${r.title}\n          ${r.why}\n`);
    return 0;
  }
  // Allow `rookery <path>` as a shortcut for `rookery scan <path>`.
  const paths = command === 'scan' ? rest : [command, ...rest];
  if (command !== 'scan' && command.startsWith('-')) fail(`unknown command: ${command}`);

  const format = o.format as string;
  if (!['terminal', 'json', 'markdown'].includes(format)) fail(`--format must be terminal, json or markdown (got "${format}")`);
  const threshold = Number(o.threshold);
  if (!(threshold > 0 && threshold <= 1)) fail('--threshold must be a number between 0 and 1');
  const maxKb = Number(o['max-file-size']);
  if (!(maxKb > 0)) fail('--max-file-size must be a positive number of kilobytes');
  const failOn = o['fail-on'] as Severity | undefined;
  if (failOn && !SEVERITIES.includes(failOn)) fail(`--fail-on must be one of ${SEVERITIES.join(', ')}`);

  let result;
  try {
    result = scan({ paths: paths.length ? paths : ['.'], maxFileBytes: maxKb * 1024, includeInfo: o.info as boolean, similarityThreshold: threshold, worktrees: o.worktrees as boolean });
  } catch (err) {
    fail((err as Error).message);
  }

  if (o.html) writeFileSync(o.html as string, renderHtml(result));
  if (o.json) writeFileSync(o.json as string, renderJson(result));
  if (o.md) writeFileSync(o.md as string, renderMarkdown(result));

  if (format === 'json') process.stdout.write(renderJson(result));
  else if (format === 'markdown') process.stdout.write(renderMarkdown(result));
  else {
    const color = !o['no-color'] && !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') || process.stdout.isTTY === true);
    process.stdout.write(renderTerminal(result, { color, verbose: o.verbose as boolean, htmlPath: o.html as string | undefined }));
  }

  if (failOn) {
    const limit = SEVERITIES.indexOf(failOn);
    const counted = result.findings.filter((f) => o.strict || f.confidence === 'high');
    if (counted.some((f) => SEVERITIES.indexOf(f.severity) <= limit)) return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
