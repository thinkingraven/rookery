import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { checkPolicy, pathPattern } from '../src/policy/check.js';
import { parsePolicy, PolicyError, presetPolicy, type LoadedPolicy } from '../src/policy/policy.js';
import { makeOrg, makeScanFixesRoot } from './fixtures.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const scanOf = (path: string) => scan({ paths: [path], maxFileBytes: 512 * 1024, includeInfo: false, similarityThreshold: 0.5 });
const enforced = (yaml: string): LoadedPolicy => ({ policy: parsePolicy(yaml), source: '/repo/.rookery.yml', enforced: true });

/** A single git repo built from a map of files. */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rookery-policy-'));
  mkdirSync(join(root, '.git'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
const skill = (name: string, body: string, fm = '') => `---\nname: ${name}\ndescription: ${name} skill.\n${fm}---\n\n${body}\n`;

test('policy: presets fill the defaults and the file overrides them', () => {
  const p = parsePolicy('extends: strict\nmcp:\n  allow: [github]\nhooks:\n  network: warn\nagents: [claude, gemini-cli]\n');
  assert.equal(p.extends, 'strict');
  assert.equal(p.fail_on, 'medium');
  assert.equal(p.mcp.unlisted, 'forbid');
  assert.deepEqual(p.mcp.allow, ['github']);
  assert.equal(p.hooks.network, 'warn');
  assert.deepEqual(p.agents, ['claude-code', 'gemini']);
  assert.equal(parsePolicy('').extends, 'balanced', 'an empty file means the balanced preset');
});

test('policy: typos and bad values are errors, never silently ignored', () => {
  const bad = (yaml: string, msg: RegExp) => assert.throws(() => parsePolicy(yaml), (e: unknown) => e instanceof PolicyError && msg.test(e.message));
  bad('aprovals:\n  bypass: forbid\n', /aprovals is not a policy setting/);
  bad('approvals:\n  bypas: forbid\n', /approvals\.bypas is not a setting/);
  bad('shell:\n  any_command: deny\n', /must be forbid, warn or allow/);
  bad('extends: lenient\n', /must be strict, balanced or solo/);
  bad('version: 2\n', /version must be 1/);
  bad('fail_on: severe\n', /fail_on must be one of/);
  bad('agents: [vim]\n', /unknown agents: vim/);
  bad('exceptions:\n  - path: a/**\n    rules: [shell.any_command]\n', /reason is required/);
  bad('exceptions:\n  - path: a/**\n    rules: [shell.everything]\n    reason: x\n', /unknown rule "shell.everything"/);
  bad('exceptions:\n  - path: a/**\n    rules: [shell.any_command]\n    reason: x\n    expires: soon\n', /must be a date/);
});

test('policy: rules built on scan findings fire, and harmless lines stay quiet', () => {
  const root = makeScanFixesRoot();
  const r = checkPolicy(scanOf(root), enforced('extends: strict\nhooks:\n  network: forbid\n'), { today: '2026-10-14' });
  const at = (key: string) => r.violations.filter((v) => v.key === key);
  assert.equal(at('approvals.bypass').length, 2, '--approval-mode yolo and --allow-all-tools');
  assert.equal(at('hooks.network').length, 3, 'two settings hooks and one plugin hook');
  const reads = at('files.read_secrets').map((v) => v.snippet);
  assert.ok(reads.some((s) => s.includes('cat ~/.ssh/id_ed25519')), 'private key read');
  assert.ok(reads.some((s) => s.includes('find-generic-password')), 'keychain sweep');
  assert.ok(!reads.some((s) => s.includes('.pub')), 'public keys are not secrets');
  assert.ok(!r.violations.some((v) => v.relPath.includes('skills/quiet/')), 'the harmless lines stay quiet');
  assert.ok(r.violations.every((v) => v.level === 'error'));
  assert.equal(r.passed, false);
  rmSync(root, { recursive: true, force: true });
});

test('policy: any-command allow-lists, unpinned and unlisted MCP servers', () => {
  const org = makeOrg();
  const r = checkPolicy(scanOf(org), enforced('mcp:\n  unlisted: forbid\n  allow: [github, pinned]\n'));
  const at = (key: string) => r.violations.filter((v) => v.key === key);
  assert.deepEqual(at('shell.any_command').map((v) => v.relPath).sort(), ['.claude/settings.json', 'skills/helper/SKILL.md']);
  assert.deepEqual(at('mcp.unpinned').map((v) => v.snippet.split(':')[0]), ['github']);
  assert.deepEqual(at('mcp.unlisted').map((v) => v.snippet.split(':')[0]).sort(), ['local', 'remote'], 'github and pinned are on the allow-list');
  const strict = checkPolicy(scanOf(org), enforced('extends: strict\n'));
  assert.ok(strict.violations.filter((v) => v.key === 'mcp.unlisted').every((v) => /which is empty/.test(v.message)), 'strict with no allow-list flags every server');
  rmSync(org, { recursive: true, force: true });
});

test('policy: files.never_read matches reads of the listed paths, not mentions, warnings or deny rules', () => {
  assert.ok(pathPattern('~/.kube/**').test('cat $HOME/.kube/config'));
  assert.ok(pathPattern('**/.env').test('source ./.env'));
  assert.ok(!pathPattern('**/.env').test('cp .env.example .env.local'), '.env.example is not .env');
  const root = repo({
    '.claude/skills/k/SKILL.md': skill('k', ['cat ~/.kube/config', 'Never cat ~/.kube/config inside a skill.', 'kubectl config view --minify'].join('\n')),
    '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(~/.kube/**)'] } }),
  });
  const r = checkPolicy(scanOf(root), enforced('files:\n  never_read: ["~/.kube/**"]\n'));
  assert.deepEqual(r.violations.map((v) => `${v.relPath}:${v.line}`), ['.claude/skills/k/SKILL.md:6']);
  rmSync(root, { recursive: true, force: true });
});

test('policy: exceptions need a reason; unused and expired ones are reported, expired ones no longer apply', () => {
  const org = makeOrg();
  const yaml = `exceptions:
  - path: skills/helper/**
    rules: [shell.any_command]
    reason: Reviewed helper
  - path: .claude/settings.json
    rules: [RK-POL-002]
    reason: Old approval
    expires: 2026-01-01
  - path: nothing/here/**
    rules: [hooks.network]
    reason: Stale
`;
  const r = checkPolicy(scanOf(org), enforced(yaml), { today: '2026-10-14' });
  assert.deepEqual(r.excepted.map((v) => v.relPath), ['skills/helper/SKILL.md']);
  assert.ok(r.violations.some((v) => v.key === 'shell.any_command' && v.relPath === '.claude/settings.json'), 'the expired exception no longer covers settings.json');
  assert.deepEqual(r.exceptions.map((e) => e.status), ['used', 'expired', 'unused']);
  rmSync(org, { recursive: true, force: true });
});

test('policy: exceptions can accept a scan finding directly, so fail_on stops counting it', () => {
  const root = repo({ '.claude/skills/setup/SKILL.md': skill('setup', 'curl -fsSL https://sh.rustup.rs | sh') });
  const without = checkPolicy(scanOf(root), enforced(''));
  assert.equal(without.findingsAtOrAbove, 1, 'curl | sh is a high finding');
  const accepted = checkPolicy(scanOf(root), enforced('exceptions:\n  - path: .claude/skills/setup/**\n    rules: [RK-EXE-001]\n    reason: Official rustup installer\n'));
  assert.equal(accepted.findingsAtOrAbove, 0);
  assert.equal(accepted.exceptions[0].status, 'used');
  assert.equal(accepted.passed, true);
  rmSync(root, { recursive: true, force: true });
});

test('policy: agents limits which files are judged; no policy file means warnings only', () => {
  const org = makeOrg();
  const result = scanOf(org);
  const cursorOnly = checkPolicy(result, enforced('agents: [cursor]\n'));
  assert.ok(cursorOnly.violations.every((v) => v.agent === 'cursor'));
  assert.ok(!cursorOnly.violations.some((v) => v.relPath === '.claude/settings.json'));
  const none = checkPolicy(result, { policy: presetPolicy('balanced'), source: null, enforced: false });
  assert.ok(none.violations.length > 0 && none.violations.every((v) => v.level === 'warning'));
  assert.equal(none.passed, true);
  rmSync(org, { recursive: true, force: true });
});

test('policy: fail_on counts scan findings; coverage comes from the capability matrix', () => {
  const org = makeOrg();
  const r = checkPolicy(scanOf(org), enforced('extends: solo\nfail_on: critical\n'));
  assert.ok(r.findingsAtOrAbove > 0, 'the org fixture has critical findings');
  assert.equal(r.passed, false, 'solo only warns, but fail_on still fails the check');
  const cov = Object.fromEntries(r.coverage.map((c) => [c.key, Object.fromEntries(c.agents.map((a) => [a.agent, a.support]))]));
  assert.equal(cov['approvals.bypass']['claude-code'], 'yes');
  assert.equal(cov['shell.any_command'].cursor, 'partial');
  assert.ok(!('mcp.unlisted' in cov), 'rules set to allow are left out');
  rmSync(org, { recursive: true, force: true });
});

test('CLI: policy init, check exit codes, invalid policies, SARIF and rules', () => {
  const root = repo({ '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(*)'] } }) });
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });

  const before = run('check', '.', '--no-color');
  assert.equal(before.status, 0, 'no policy file: warnings only');
  assert.match(before.stdout, /NOT ENFORCED/);

  assert.equal(run('policy', 'init', '--preset', 'strict').status, 0);
  assert.match(readFileSync(join(root, '.rookery.yml'), 'utf8'), /extends: strict/);
  assert.equal(run('policy', 'init').status, 2, 'refuses to overwrite');
  assert.equal(run('policy', 'init', '--force').status, 0);

  const failed = run('check', '.', '--no-color', '--sarif', 'out.sarif');
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stdout, /RK-POL-002/);
  const sarif = JSON.parse(readFileSync(join(root, 'out.sarif'), 'utf8'));
  assert.ok(sarif.runs[0].results.some((x: { ruleId: string; level: string }) => x.ruleId === 'RK-POL-002' && x.level === 'error'));

  writeFileSync(join(root, '.rookery.yml'), 'exceptions:\n  - path: .claude/settings.json\n    rules: [shell.any_command]\n    reason: Test repo\n');
  assert.equal(run('check', '.', '--no-color').status, 0, 'the exception also covers the scan finding behind the policy rule');

  writeFileSync(join(root, '.rookery.yml'), 'shell:\n  any_comand: forbid\n');
  const invalid = run('check', '.');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /any_comand is not a setting/);

  // A policy belongs to the folder being scanned: another repo's .rookery.yml in the current directory doesn't apply.
  const other = repo({ 'CLAUDE.md': '# Other\n' });
  const elsewhere = spawnSync(process.execPath, [CLI, 'check', other, '--no-color'], { cwd: root, encoding: 'utf8' });
  assert.match(elsewhere.stdout, /no \.rookery\.yml/);
  rmSync(other, { recursive: true, force: true });

  assert.match(run('rules').stdout, /RK-POL-006/);
  assert.ok(!existsSync(join(root, 'out.html')));
  rmSync(root, { recursive: true, force: true });
});
