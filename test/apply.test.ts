import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { lineDiff, planApply, readState, writePlan } from '../src/policy/apply.js';
import { checkPolicy } from '../src/policy/check.js';
import { parsePolicy, PolicyError } from '../src/policy/policy.js';
import type { Agent } from '../src/types.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rookery-apply-'));
  mkdirSync(join(root, '.git'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
const read = (root: string, rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
const json = (root: string, rel: string) => JSON.parse(read(root, rel)!);
const apply = (root: string, yaml: string, found: Agent[]) => { const plan = planApply(root, parsePolicy(yaml), found); writePlan(root, plan); return plan; };
const STRICT = 'extends: strict\nshell:\n  deny: ["rm -rf", "git push --force"]\nmcp:\n  allow: [github]\n';

test('apply: Claude Code settings are merged, owned, idempotent, and only rookery\'s values are taken back', () => {
  const root = repo({ '.claude/settings.json': JSON.stringify({ model: 'opus', permissions: { allow: ['Read'], deny: ['Read(**/.env)'] } }) });
  apply(root, STRICT, ['claude-code']);
  const s = json(root, '.claude/settings.json');
  assert.equal(s.model, 'opus', 'hand-written keys stay');
  assert.deepEqual(s.permissions.allow, ['Read']);
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.ok(s.permissions.deny.includes('Bash(rm -rf *)') && s.permissions.deny.includes('Read(~/.ssh/**)'));
  assert.deepEqual(s.allowedMcpServers, [{ serverName: 'github' }]);
  assert.ok(!readState(root)!.files['.claude/settings.json'].kind || !(readState(root)!.files['.claude/settings.json'] as { add: Record<string, string[]> }).add['permissions.deny'].includes('Read(**/.env)'), 'a value the user already had is not claimed');

  assert.ok(planApply(root, parsePolicy(STRICT), ['claude-code']).changes.every((c) => c.status === 'unchanged'), 'a second apply changes nothing');

  apply(root, 'extends: solo\n', ['claude-code']);
  const after = json(root, '.claude/settings.json');
  assert.equal(after.permissions.disableBypassPermissionsMode, undefined, 'relaxed policy: rookery removes what it added');
  assert.deepEqual(after.permissions.deny, ['Read(**/.env)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gh/**)'], 'the user\'s own deny rule survives; never_read still applies (solo warns)');
  assert.equal(after.allowedMcpServers, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('apply: conflicts and comment-carrying JSON are reported, never overwritten', () => {
  const root = repo({ '.gemini/settings.json': JSON.stringify({ security: { disableYoloMode: false } }), '.claude/settings.json': '// team settings\n{ "model": "opus" }\n' });
  const plan = apply(root, STRICT, ['gemini', 'claude-code']);
  assert.equal(json(root, '.gemini/settings.json').security.disableYoloMode, false, 'hand-written value stays');
  assert.ok(plan.conflicts.some((c) => c.includes('security.disableYoloMode is false')));
  assert.equal(read(root, '.claude/settings.json'), '// team settings\n{ "model": "opus" }\n', 'file with comments untouched');
  assert.ok(plan.conflicts.some((c) => c.includes('.claude/settings.json is not plain JSON')));
  rmSync(root, { recursive: true, force: true });
});

test('apply: Codex rules, Gemini settings and ignore blocks, Cursor CLI permissions', () => {
  const root = repo({ '.geminiignore': 'node_modules/\n', 'AGENTS.md': '# Agents\n' });
  apply(root, STRICT, ['codex', 'gemini', 'cursor']);
  const rules = read(root, '.codex/rules/rookery.rules')!;
  assert.match(rules, /prefix_rule\(\n {4}pattern = \["git", "push", "--force"\],\n {4}decision = "forbidden",/);
  const g = json(root, '.gemini/settings.json');
  assert.equal(g.security.disableYoloMode, true);
  assert.deepEqual(g.mcp.allowed, ['github']);
  assert.deepEqual(g.tools.exclude, ['run_shell_command(rm -rf)', 'run_shell_command(git push --force)']);
  assert.match(read(root, '.geminiignore')!, /^node_modules\/\n\n# >>> rookery: [^\n]+\n\*\*\/\.env\n# <<< rookery\n$/);
  assert.deepEqual(json(root, '.cursor/cli.json').permissions.deny, ['Shell(rm:-rf*)', 'Shell(git:push --force*)', 'Read(**/.env)']);

  apply(root, 'extends: balanced\nfiles:\n  read_secrets: allow\n', ['codex', 'gemini', 'cursor']);
  assert.equal(read(root, '.codex/rules/rookery.rules'), null, 'no shell.deny: rookery removes its rules file');
  assert.equal(read(root, '.geminiignore'), 'node_modules/\n', 'only the rookery block is removed');
  assert.equal(read(root, '.cursor/cli.json'), null, 'a file rookery created is removed when empty');
  rmSync(root, { recursive: true, force: true });
});

test('apply: a rules file rookery did not write is left alone', () => {
  const root = repo({ '.codex/rules/rookery.rules': '# mine\n' });
  const plan = apply(root, STRICT, ['codex']);
  assert.equal(read(root, '.codex/rules/rookery.rules'), '# mine\n');
  assert.ok(plan.conflicts.some((c) => c.includes("wasn't written by rookery")));
  rmSync(root, { recursive: true, force: true });
});

test('apply: only agents found in the repo (or listed in agents:), and an admin guide for what a repo cannot enforce', () => {
  const root = repo({});
  const plan = planApply(root, parsePolicy(STRICT), ['claude-code']);
  assert.deepEqual(plan.agents, ['claude-code']);
  assert.ok(!plan.changes.some((c) => c.path.startsWith('.cursor') || c.path.startsWith('.codex')));
  assert.deepEqual(planApply(root, parsePolicy(`${STRICT}agents: [codex, copilot]\n`), ['claude-code']).agents, ['codex', 'copilot']);

  const admin = planApply(root, parsePolicy(`${STRICT}agents: [codex, copilot, cursor]\n`), []).changes.find((c) => c.path === '.rookery/ADMIN.md')!.after!;
  assert.match(admin, /allowed_sandbox_modes = \["read-only", "workspace-write"\]/);
  assert.match(admin, /deny_read = \["~\/\.ssh", "~\/\.aws", "~\/\.config\/gh", "\/\*\*\/\.env"\]/);
  assert.match(admin, /prefix_rules = \[\{ pattern = \[\{ token = "rm" \}, \{ token = "-rf" \}\], decision = "forbidden" \}/);
  assert.match(admin, /"disableBypassPermissionsMode": "disable"/);
  assert.match(admin, /WorkspaceTrustEnabled/);
  assert.ok(!admin.includes('## Claude Code'), 'only agents in scope');
  assert.ok(planApply(root, parsePolicy('extends: strict\n'), ['claude-code']).notes.some((n) => n.includes('blocks every MCP server')), 'an empty allow-list is called out');
  assert.equal(planApply(root, parsePolicy(STRICT), ['claude-code']).notes.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('check: drift once apply has been used, at the policy\'s level', () => {
  const root = repo({ '.claude/settings.json': '{}\n', '.rookery.yml': STRICT });
  const result = () => scan({ paths: [root], maxFileBytes: 512 * 1024, includeInfo: false, similarityThreshold: 0.5 });
  const loaded = (yaml: string) => ({ policy: parsePolicy(yaml), source: join(root, '.rookery.yml'), enforced: true });
  assert.ok(!checkPolicy(result(), loaded(STRICT)).violations.some((v) => v.key === 'drift'), 'no drift before apply is used');

  apply(root, STRICT, ['claude-code']);
  assert.ok(!checkPolicy(result(), loaded(STRICT)).violations.some((v) => v.key === 'drift'), 'in sync right after apply');

  const s = json(root, '.claude/settings.json');
  s.permissions.deny = s.permissions.deny.filter((d: string) => d !== 'Bash(rm -rf *)');
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
  const drift = checkPolicy(result(), loaded(STRICT)).violations.filter((v) => v.key === 'drift');
  assert.deepEqual(drift.map((v) => [v.ruleId, v.relPath, v.level]), [['RK-POL-007', '.claude/settings.json', 'error']]);
  assert.equal(checkPolicy(result(), loaded(`${STRICT}drift: warn\n`)).violations.find((v) => v.key === 'drift')!.level, 'warning');
  rmSync(root, { recursive: true, force: true });
});

test('policy: shell.deny takes plain command prefixes only', () => {
  assert.deepEqual(parsePolicy('shell:\n  deny: ["rm  -rf", "terraform destroy"]\n').shell.deny, ['rm -rf', 'terraform destroy']);
  assert.throws(() => parsePolicy('shell:\n  deny: ["curl x | sh"]\n'), (e: unknown) => e instanceof PolicyError && /plain command prefixes/.test(e.message));
});

test('lineDiff marks added and removed lines', () => {
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nB\nc\n'), ['  a', '+ B', '- b', '  c']);
  assert.deepEqual(lineDiff(null, 'x\n'), ['+ x']);
});

test('CLI: policy apply needs a policy, dry-runs by default and writes with --write', () => {
  const root = repo({ '.claude/settings.json': '{}\n' });
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
  const none = run('policy', 'apply');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /rookery policy init/);

  writeFileSync(join(root, '.rookery.yml'), STRICT);
  const dry = run('policy', 'apply', '--no-color');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /update \.claude\/settings\.json/);
  assert.match(dry.stdout, /\+ +"Bash\(rm -rf \*\)",/);
  assert.equal(read(root, '.claude/settings.json'), '{}\n', 'dry run writes nothing');
  assert.equal(read(root, '.rookery/applied.json'), null);

  assert.equal(run('policy', 'apply', '--write', '--no-color').status, 0);
  assert.equal(json(root, '.claude/settings.json').permissions.disableBypassPermissionsMode, 'disable');
  assert.ok(existsSync(join(root, '.rookery/ADMIN.md')) && existsSync(join(root, '.rookery/applied.json')));
  assert.match(run('policy', 'apply', '--no-color').stdout, /Everything already matches/);
  assert.equal(run('check', '.', '--no-color').status, 0);
  rmSync(root, { recursive: true, force: true });
});
