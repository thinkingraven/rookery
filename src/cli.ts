#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { scan } from './scan.js';
import { renderTerminal } from './report/terminal.js';
import { renderJson } from './report/json.js';
import { renderMarkdown } from './report/markdown.js';
import { renderHtml } from './report/html.js';
import { renderSarif } from './report/sarif.js';
import { ALL_RULES } from './rules.js';
import { loadPolicy, PolicyError, POLICY_RULES, policyTemplate, PRESETS, type PresetName } from './policy/policy.js';
import { checkPolicy } from './policy/check.js';
import { ADMIN_FILE, STATE_FILE, lineDiff, planApply, writePlan } from './policy/apply.js';
import { SEVERITIES, type Severity } from './types.js';
import { VERSION } from './version.js';

const HELP = `rookery v${VERSION}: find, de-duplicate and security-check AI agent skills.

Usage
  rookery scan [paths...]        Scan one or more repos or folders (default: .)
  rookery check [paths...]       Scan, then check the result against .rookery.yml (exit 1 if it fails)
  rookery policy init            Write a starter .rookery.yml (--preset strict|balanced|solo)
  rookery policy apply [path]    Show how .rookery.yml maps into each agent's own config (--write to apply)
  rookery rules                  List every security and policy rule

Options
  --format <terminal|json|markdown|sarif>
                                      Output format on stdout (default: terminal)
  --html <file>                       Also write a shareable HTML report
  --json <file>                       Also write the JSON report to a file
  --md <file>                         Also write a Markdown report to a file
  --sarif <file>                      Also write SARIF 2.1.0 (GitHub code scanning) to a file
  --fail-on <severity>                Exit 1 if any finding is at or above this severity
                                      (critical, high, medium, low)
  --threshold <0-1>                   Near-duplicate similarity threshold (default: 0.5)
  --max-file-size <kb>                Skip files larger than this (default: 512)
  --strict                            Count low-confidence findings for --fail-on and
                                      include them in SARIF (examples, docs, tests)
  --info                              Include info-level findings
  --worktrees                         Also scan linked git worktrees (skipped by default)
  --local                             Also scan your user-level agent folders (~/.claude, ~/.agents,
                                      ~/.codex, ~/.cursor, ~/.gemini, ~/.config/skillshare)
  --verbose                           Show everything in the terminal report
  --no-color                          Disable colours (also respects NO_COLOR; FORCE_COLOR forces them)
  --policy <file>                     Policy file for check (default: .rookery.yml next to the scanned folder)
  --preset <name>                     Preset for policy init: strict, balanced (default) or solo
  --force                             Let policy init overwrite an existing file
  --write                             Let policy apply write the files (without it, apply only shows a diff)
  -v, --version                       Print the version
  -h, --help                          Show this help

Examples
  npx @thinkingraven/rookery scan .
  npx @thinkingraven/rookery scan ~/code --html rookery-report.html
  npx @thinkingraven/rookery scan . --format json --fail-on high   # in CI
  npx @thinkingraven/rookery policy init && npx @thinkingraven/rookery check
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
        sarif: { type: 'string' },
        'fail-on': { type: 'string' },
        threshold: { type: 'string', default: '0.5' },
        'max-file-size': { type: 'string', default: '512' },
        info: { type: 'boolean', default: false },
        worktrees: { type: 'boolean', default: false },
        local: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        policy: { type: 'string' },
        preset: { type: 'string', default: 'balanced' },
        force: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
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
    for (const r of POLICY_RULES) process.stdout.write(`${r.id}  ${'policy'.padEnd(8)}  ${r.title} (${r.key})\n          ${r.why}\n`);
    return 0;
  }
  if (command === 'policy' && rest[0] === 'apply') return policyApply(rest[1] ?? '.', o as Record<string, unknown>);
  if (command === 'policy') {
    if (rest[0] !== 'init') fail(`unknown policy command: ${rest[0] ?? '(none)'}. Did you mean \`rookery policy init\` or \`rookery policy apply\`?`);
    const preset = o.preset as string;
    if (!(preset in PRESETS)) fail('--preset must be strict, balanced or solo');
    const file = (o.policy as string | undefined) ?? '.rookery.yml';
    if (existsSync(file) && !o.force) fail(`${file} already exists (use --force to overwrite)`);
    writeFileSync(file, policyTemplate(preset as PresetName));
    process.stdout.write(`Wrote ${file} (preset: ${preset}). Run \`rookery check\` to see where this repo stands.\n`);
    return 0;
  }
  const checking = command === 'check';
  // Allow `rookery <path>` as a shortcut for `rookery scan <path>`.
  const paths = command === 'scan' || checking ? rest : [command, ...rest];
  if (command !== 'scan' && !checking && command.startsWith('-')) fail(`unknown command: ${command}`);

  const format = o.format as string;
  if (!['terminal', 'json', 'markdown', 'sarif'].includes(format)) fail(`--format must be terminal, json, markdown or sarif (got "${format}")`);
  const threshold = Number(o.threshold);
  if (!(threshold > 0 && threshold <= 1)) fail('--threshold must be a number between 0 and 1');
  const maxKb = Number(o['max-file-size']);
  if (!(maxKb > 0)) fail('--max-file-size must be a positive number of kilobytes');
  const failOn = o['fail-on'] as Severity | undefined;
  if (failOn && !SEVERITIES.includes(failOn)) fail(`--fail-on must be one of ${SEVERITIES.join(', ')}`);

  let loaded;
  if (checking) {
    try { loaded = loadPolicy(o.policy as string | undefined, paths); } catch (err) {
      if (err instanceof PolicyError) fail(`invalid policy\n${err.message}`);
      throw err;
    }
  }

  let result;
  try {
    result = scan({ paths: paths.length ? paths : o.local ? [] : ['.'], maxFileBytes: maxKb * 1024, includeInfo: o.info as boolean, similarityThreshold: threshold, worktrees: o.worktrees as boolean, local: o.local as boolean });
  } catch (err) {
    fail((err as Error).message);
  }

  if (loaded) result.policy = checkPolicy(result, loaded, { strict: o.strict as boolean });

  if (o.html) writeFileSync(o.html as string, renderHtml(result));
  if (o.json) writeFileSync(o.json as string, renderJson(result));
  if (o.md) writeFileSync(o.md as string, renderMarkdown(result));
  if (o.sarif) writeFileSync(o.sarif as string, renderSarif(result, { strict: o.strict as boolean }));

  if (format === 'json') process.stdout.write(renderJson(result));
  else if (format === 'sarif') process.stdout.write(renderSarif(result, { strict: o.strict as boolean }));
  else if (format === 'markdown') process.stdout.write(renderMarkdown(result));
  else {
    const color = !o['no-color'] && !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') || process.stdout.isTTY === true);
    process.stdout.write(renderTerminal(result, { color, verbose: o.verbose as boolean, htmlPath: o.html as string | undefined }));
  }

  if (result.policy) return result.policy.passed && !(failOn && failedOn(result.findings, failOn, o.strict as boolean)) ? 0 : 1;
  if (failOn) {
    const limit = SEVERITIES.indexOf(failOn);
    const counted = result.findings.filter((f) => o.strict || f.confidence === 'high');
    if (counted.some((f) => SEVERITIES.indexOf(f.severity) <= limit)) return 1;
  }
  return 0;
}

function policyApply(target: string, o: Record<string, unknown>): number {
  let loaded;
  try { loaded = loadPolicy(o.policy as string | undefined, [target]); } catch (err) {
    if (err instanceof PolicyError) fail(`invalid policy\n${err.message}`);
    throw err;
  }
  if (!loaded.source) fail(`no .rookery.yml in ${target}. Run \`rookery policy init\` first.`);
  const root = dirname(loaded.source);
  let result;
  try { result = scan({ paths: [root], maxFileBytes: 512 * 1024, includeInfo: false, similarityThreshold: 0.5 }); } catch (err) { fail((err as Error).message); }
  const plan = planApply(root, loaded.policy, [...new Set(result.artifacts.map((a) => a.agent))]);
  const color = !o['no-color'] && !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') || process.stdout.isTTY === true);
  const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c('1'), dim = c('2'), green = c('32'), red = c('31'), yellow = c('33'), amber = c('38;5;214');
  const AGENT: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', cursor: 'Cursor', copilot: 'GitHub Copilot', windsurf: 'Windsurf' };
  const out: string[] = [`${bold('rookery')}${amber('.')} ${dim('policy apply')}  ${dim('·')}  ${relative(process.cwd(), loaded.source) || '.rookery.yml'}  ${dim('·')}  ${plan.agents.length ? plan.agents.map((a) => AGENT[a] ?? a).join(', ') : 'no agents found (list them under agents: in .rookery.yml)'}`, ''];
  const changed = plan.changes.filter((x) => x.status !== 'unchanged');
  for (const ch of changed) {
    const tag = ch.status === 'create' ? green('create') : ch.status === 'delete' ? red('delete') : yellow('update');
    out.push(`${tag} ${bold(ch.path)}${ch.agent ? dim(`  (${AGENT[ch.agent] ?? ch.agent})`) : ''}`);
    if (ch.path === ADMIN_FILE || ch.path === STATE_FILE) { out.push(dim(ch.path === ADMIN_FILE ? '    admin-only settings for this policy, regenerated on each apply' : '    what rookery added, so the next apply can update or remove only its own values'), ''); continue; }
    for (const l of lineDiff(ch.before, ch.after)) out.push('    ' + (l.startsWith('+') ? green(l) : l.startsWith('-') ? red(l) : dim(l)));
    out.push('');
  }
  if (!changed.length) out.push(green('Everything already matches the policy.'), '');
  for (const nt of plan.notes) out.push(`${amber('note')} ${nt}`);
  for (const cf of plan.conflicts) out.push(`${yellow('!')} ${cf}`);
  if (plan.conflicts.length || plan.notes.length) out.push('');
  if (o.write) {
    const n = writePlan(root, plan);
    out.push(n ? `${green('Wrote')} ${n} file${n === 1 ? '' : 's'}. Commit them; \`rookery check\` now reports drift if they fall out of date. Admin-only settings: ${ADMIN_FILE}.` : 'Nothing to write.');
  } else if (changed.length) out.push(dim('Dry run: nothing written. Run again with --write to apply.'));
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function failedOn(findings: { severity: Severity; confidence: string }[], failOn: Severity, strict: boolean): boolean {
  const limit = SEVERITIES.indexOf(failOn);
  return findings.some((f) => (strict || f.confidence === 'high') && SEVERITIES.indexOf(f.severity) <= limit);
}

process.exitCode = main(process.argv.slice(2));
