import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseCall, reply, runHook, segments, type Call, type HookAgent } from '../src/policy/runtime.js';
import { planApply, readState, writePlan } from '../src/policy/apply.js';
import { parsePolicy, PolicyError } from '../src/policy/policy.js';
import { VERSION } from '../src/version.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const HOME = '/home/dev';
const STRICT = parsePolicy('extends: strict\nshell:\n  deny: ["rm -rf", "git push --force"]\nmcp:\n  allow: [github]\n');
const SOLO = parsePolicy('extends: solo\n');
const sh = (command: string): Call => ({ kind: 'shell', command, cwd: '/work/app' });
const decide = (call: Call, policy = STRICT) => evaluate(call, policy, { home: HOME });

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rookery-hook-'));
  mkdirSync(join(root, '.git'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

test('hook: each agent\'s input becomes the same call', () => {
  const cases: [HookAgent, Record<string, unknown>, Call][] = [
    ['claude-code', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/r' }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['claude-code', { tool_name: 'Read', tool_input: { file_path: '/r/.env' }, cwd: '/r' }, { kind: 'read', paths: ['/r/.env'], cwd: '/r' }],
    ['claude-code', { tool_name: 'mcp__slack__post', tool_input: {}, cwd: '/r' }, { kind: 'mcp', server: 'slack', tool: 'mcp__slack__post', cwd: '/r' }],
    ['codex', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/r' }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['gemini', { tool_name: 'run_shell_command', tool_input: { command: 'ls' }, cwd: '/r' }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['gemini', { tool_name: 'read_many_files', tool_input: { include: ['a', '.env'] }, cwd: '/r' }, { kind: 'read', paths: ['a', '.env'], cwd: '/r' }],
    ['gemini', { tool_name: 'mcp_slack_post', tool_input: {}, mcp_context: { server_name: 'slack' }, cwd: '/r' }, { kind: 'mcp', server: 'slack', tool: 'mcp_slack_post', cwd: '/r' }],
    ['cursor', { hook_event_name: 'beforeShellExecution', command: 'ls', cwd: '/r' }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['cursor', { hook_event_name: 'beforeReadFile', file_path: '/r/.env', workspace_roots: ['/r'] }, { kind: 'read', paths: ['/r/.env'], cwd: '/r' }],
    ['cursor', { hook_event_name: 'beforeMCPExecution', tool_name: 'post', tool_input: '{}', mcp_server_name: 'slack', command: 'npx slack-mcp' }, { kind: 'mcp', server: 'slack', tool: 'post', cwd: undefined }],
    ['copilot', { toolName: 'bash', toolArgs: '{"command":"ls"}', cwd: '/r' }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['copilot', { toolName: 'view', toolArgs: { path: '/r/.env' }, cwd: '/r' }, { kind: 'read', paths: ['/r/.env'], cwd: '/r' }],
    ['copilot', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/r' }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['windsurf', { agent_action_name: 'pre_run_command', tool_info: { command_line: 'ls', cwd: '/r' } }, { kind: 'shell', command: 'ls', cwd: '/r' }],
    ['windsurf', { agent_action_name: 'pre_mcp_tool_use', tool_info: { mcp_server_name: 'slack', mcp_tool_name: 'post', mcp_tool_arguments: {} } }, { kind: 'mcp', server: 'slack', tool: 'post' }],
    ['claude-code', { tool_name: 'Edit', tool_input: {}, cwd: '/r' }, { kind: 'other', cwd: '/r' }],
  ];
  for (const [agent, input, call] of cases) assert.deepEqual(parseCall(agent, input), call, `${agent} ${JSON.stringify(input)}`);
});

test('hook: commands split into simple commands, without env, sudo or wrappers', () => {
  assert.deepEqual(segments('FOO=1 sudo -E rm -rf x && echo "a && b" | grep c; (cd y) 2>&1'), ['rm -rf x', 'echo "a && b"', 'grep c', 'cd y', '2>&1']);
  assert.deepEqual(segments("bash -lc 'git push --force'"), ["bash -lc 'git push --force'", 'git push --force']);
  assert.deepEqual(segments('echo $(cat ~/.ssh/id_rsa)'), ['echo', 'cat ~/.ssh/id_rsa']);
});

test('hook: shell.deny matches command prefixes, wherever they sit in the line', () => {
  for (const cmd of ['rm -rf build', 'ls && rm -rf build', '/bin/rm -rf build', 'sudo rm -rf /', 'sh -c "rm -rf build"', 'git push --force origin main', 'FOO=1 git push --force']) {
    const d = decide(sh(cmd));
    assert.equal(d.action, 'deny', cmd);
    assert.equal(d.key, 'shell.deny');
  }
  for (const cmd of ['rm -r build', 'git push origin main', 'git commit -m "rm -rf the old folder"', 'echo rm -rf', 'grep -r "git push --force" docs']) assert.equal(decide(sh(cmd)).action, 'pass', cmd);
});

test('hook: starting another agent with approvals off', () => {
  for (const cmd of ['claude -p "fix it" --dangerously-skip-permissions', 'npx -y @anthropic-ai/claude-code --permission-mode bypassPermissions', 'codex exec --dangerously-bypass-approvals-and-sandbox "x"', 'codex -c approval_policy="never" exec x', 'codex --sandbox danger-full-access', 'gemini -y -p hi', 'gemini --approval-mode=yolo', 'copilot --allow-all-tools -p x', 'cursor-agent -f "x"']) {
    const d = decide(sh(cmd));
    assert.equal(d.action, 'deny', cmd);
    assert.equal(d.ruleId, 'RK-POL-001');
  }
  for (const cmd of ['claude -p "explain what --dangerously-skip-permissions does"', 'git commit -m "add --yolo docs"', 'npx -y prettier --write .', 'gemini -p hi', 'grep -- --yolo README.md']) assert.equal(decide(sh(cmd)).action, 'pass', cmd);
  assert.equal(decide(sh('gemini --yolo'), SOLO).action, 'warn', 'solo warns');
});

test('hook: reading protected paths from the shell', () => {
  for (const cmd of ['cat ~/.ssh/id_rsa', `cat ${HOME}/.ssh/id_ed25519`, 'tail -n 5 "$HOME/.aws/credentials"', 'source .env', '. ./.env', 'grep TOKEN config/.env', 'cp .env /tmp/x', 'git show HEAD:.env', 'echo $(cat ~/.config/gh/hosts.yml)', 'security find-generic-password -s x -w', 'cat ~/.npmrc']) {
    const d = decide(sh(cmd));
    assert.equal(d.action, 'deny', cmd);
    assert.equal(d.ruleId, 'RK-POL-006', cmd);
  }
  for (const cmd of ['cat ~/.ssh/id_ed25519.pub', 'cp .env.example .env', 'cat .env.example', 'echo "x=1" > .env', 'ls ~/.ssh', 'git commit -m "never cat .env"', 'ssh-keygen -t ed25519 -f ~/.ssh/id_new']) assert.equal(decide(sh(cmd)).action, 'pass', cmd);
  assert.equal(decide(sh('cat ~/.ssh/id_rsa'), parsePolicy('files:\n  read_secrets: allow\n')).action, 'pass');
});

test('hook: file reads by the agent\'s own tools', () => {
  const read = (...paths: string[]): Call => ({ kind: 'read', paths, cwd: '/work/app' });
  assert.equal(decide(read(`${HOME}/.aws/credentials`)).action, 'deny');
  assert.equal(decide(read('~/.ssh')).action, 'deny', 'a folder under never_read');
  assert.equal(decide(read('.env')).action, 'deny', 'relative to the call\'s folder');
  assert.match(decide(read(`${HOME}/.ssh/config`)).reason!, /~\/\.ssh\/config matches files\.never_read \(~\/\.ssh\/\*\*\)/);
  for (const p of ['/work/app/.env.example', `${HOME}/.ssh/id_rsa.pub`, '/work/app/src/env.ts', `${HOME}/.sshx/a`]) assert.equal(decide(read(p)).action, 'pass', p);
  assert.equal(decide(read('/etc/secret')).action, 'pass');
  assert.equal(decide(read('/etc/secret'), parsePolicy('files:\n  never_read: ["/etc/secret"]\n')).action, 'deny', 'absolute globs');
});

test('hook: MCP servers off the allow-list', () => {
  assert.equal(decide({ kind: 'mcp', server: 'slack', tool: 'mcp__slack__post' }).action, 'deny');
  assert.equal(decide({ kind: 'mcp', server: 'GitHub', tool: 'mcp__github__get_issue' }).action, 'pass', 'case-insensitive');
  assert.equal(decide({ kind: 'mcp', tool: 'mcp_github_get_issue' }).action, 'pass', 'Gemini without mcp_context: the allow-listed prefix');
  assert.equal(decide({ kind: 'mcp', tool: 'mcp_slack_post' }).action, 'deny');
  assert.equal(decide({ kind: 'mcp', server: 'slack', tool: 'post' }, parsePolicy('extends: balanced\n')).action, 'pass', 'balanced allows unlisted servers');
});

test('hook: each agent gets its own answer', () => {
  const deny = { action: 'deny' as const, reason: 'no' };
  const pass = { action: 'pass' as const };
  assert.deepEqual(JSON.parse(reply('claude-code', deny).stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
  assert.deepEqual(JSON.parse(reply('codex', deny).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(JSON.parse(reply('gemini', deny).stdout), { decision: 'deny', reason: 'no' });
  assert.deepEqual(JSON.parse(reply('cursor', deny).stdout), { permission: 'deny', user_message: 'no', agent_message: 'no' });
  assert.deepEqual(JSON.parse(reply('cursor', pass).stdout), { permission: 'allow' }, 'Cursor blocks on an empty answer');
  assert.deepEqual(JSON.parse(reply('copilot', deny).stdout), { permissionDecision: 'deny', permissionDecisionReason: 'no' });
  assert.deepEqual(reply('windsurf', deny), { stdout: '', stderr: 'no\n', exitCode: 2 });
  for (const a of ['claude-code', 'codex', 'gemini', 'copilot', 'windsurf'] as HookAgent[]) assert.deepEqual(reply(a, pass), { stdout: '', stderr: '', exitCode: 0 }, a);
  assert.deepEqual(reply('gemini', { action: 'warn', reason: 'w' }), { stdout: '', stderr: '', exitCode: 0 }, 'warnings only go to the log');
});

test('hook: finds the policy, fails closed, and logs denies without secrets', () => {
  const root = repo({ '.rookery.yml': 'extends: strict\n', 'src/a.ts': '' });
  const logs = mkdtempSync(join(tmpdir(), 'rookery-log-'));
  const env = { ROOKERY_HOME: logs };
  const call = (cmd: string, cwd = join(root, 'src')) => JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd });
  const run = (stdin: string, e: NodeJS.ProcessEnv = env) => runHook('claude-code', stdin, { env: e, home: HOME, cwd: tmpdir() });
  const denied = (r: { stdout: string }) => r.stdout && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';

  assert.ok(denied(run(call(`cat ${HOME}/.ssh/id_rsa`))), 'policy found above the call\'s folder');
  assert.equal(run(call('npm test')).stdout, '');
  assert.ok(!denied(run(call(`cat ${HOME}/.ssh/id_rsa`, tmpdir()))), 'no policy: no opinion');

  for (const bad of ['', 'not json', '[]']) assert.match(JSON.parse(run(bad).stdout).hookSpecificOutput.permissionDecisionReason, /fail closed/, JSON.stringify(bad));
  writeFileSync(join(root, '.rookery.yml'), 'extends: strict\nshel: {}\n');
  assert.match(JSON.parse(run(call('npm test')).stdout).hookSpecificOutput.permissionDecisionReason, /fail closed.*shel is not a policy setting/, 'an invalid policy blocks');

  // A policy elsewhere can't loosen the project's: the project dir the agent reports comes first.
  writeFileSync(join(root, '.rookery.yml'), 'extends: strict\n');
  const loose = repo({ '.rookery.yml': 'extends: solo\n' });
  assert.ok(denied(run(call(`cat ${HOME}/.ssh/id_rsa`, loose), { ...env, CLAUDE_PROJECT_DIR: root })));
  assert.ok(!denied(run(call(`cat ${HOME}/.ssh/id_rsa`, loose))), 'without it, the nearest policy');

  const day = readdirSync(join(logs, 'decisions'));
  assert.equal(day.length, 1);
  const lines = readFileSync(join(logs, 'decisions', day[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 5);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['agent', 'decision', 'key', 'kind', 'repo', 'rule', 'subject', 'ts']);
  assert.equal(lines[0].subject, 'cat ~/.ssh/**');
  assert.ok(lines.every((l) => !JSON.stringify(l).includes(HOME)), 'no home folder in the log');

  const quiet = mkdtempSync(join(tmpdir(), 'rookery-log-'));
  run(call(`cat ${HOME}/.ssh/id_rsa`), { ROOKERY_HOME: quiet, ROOKERY_HOOK_LOG: '0' });
  assert.ok(!existsSync(join(quiet, 'decisions')));
  for (const d of [root, loose, logs, quiet]) rmSync(d, { recursive: true, force: true });
});

test('hook CLI: answers on stdout, and blocks on a usage error', () => {
  const root = repo({ '.rookery.yml': 'extends: strict\nshell:\n  deny: ["rm -rf"]\n' });
  const env = { ...process.env, ROOKERY_HOOK_LOG: '0', CLAUDE_PROJECT_DIR: '', GEMINI_PROJECT_DIR: '', CURSOR_PROJECT_DIR: '' };
  const run = (args: string[], input: string) => spawnSync(process.execPath, [CLI, 'hook', ...args], { cwd: root, input, env, encoding: 'utf8' });
  const cursor = run(['cursor'], JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'rm -rf build', cwd: root }));
  assert.equal(cursor.status, 0);
  assert.equal(JSON.parse(cursor.stdout).permission, 'deny');
  const windsurf = run(['windsurf'], JSON.stringify({ agent_action_name: 'pre_run_command', tool_info: { command_line: 'rm -rf build', cwd: root } }));
  assert.equal(windsurf.status, 2);
  assert.match(windsurf.stderr, /rm -rf/);
  assert.equal(run(['gemini'], JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'ls' }, cwd: root })).stdout, '');
  const unknown = run(['vim'], '{}');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /expected one of claude-code/);
  writeFileSync(join(root, 'other.yml'), 'extends: solo\n');
  assert.equal(run(['gemini', '--policy', 'other.yml'], JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'rm -rf x' }, cwd: root })).stdout, '', '--policy picks the file');
  rmSync(root, { recursive: true, force: true });
});

const HOOKS = 'extends: strict\nmcp:\n  allow: [github]\nruntime:\n  hooks: true\n';
const json = (root: string, rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const apply = (root: string, yaml: string, agents: Parameters<typeof planApply>[2], opts = {}) => { const plan = planApply(root, parsePolicy(yaml), agents, opts); writePlan(root, plan); return plan; };

test('apply: runtime.hooks installs the hook in every agent, next to the user\'s own hooks', () => {
  const mine = { matcher: 'Write', hooks: [{ type: 'command', command: './fmt.sh' }] };
  const root = repo({ '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [mine] } }) });
  const plan = apply(root, HOOKS, ['claude-code', 'codex', 'gemini', 'cursor', 'copilot', 'windsurf']);
  const cmd = (a: string) => `npx -y @thinkingraven/rookery@${VERSION} hook ${a}`;

  const claude = json(root, '.claude/settings.json');
  assert.deepEqual(claude.hooks.PreToolUse[0], mine, 'the user\'s hook stays first');
  assert.deepEqual(claude.hooks.PreToolUse[1], { matcher: 'Bash|PowerShell|Read|Grep|Glob|mcp__.*', hooks: [{ type: 'command', command: cmd('claude-code'), timeout: 30, onFailure: 'block' }] });
  assert.equal(claude.permissions.disableBypassPermissionsMode, 'disable', 'settings and hooks land in one file');
  assert.equal(json(root, '.codex/hooks.json').hooks.PreToolUse[0].hooks[0].command, cmd('codex'));
  assert.equal(json(root, '.gemini/settings.json').hooks.BeforeTool[0].hooks[0].timeout, 30000);
  const cursor = json(root, '.cursor/hooks.json');
  assert.equal(cursor.version, 1);
  assert.deepEqual(Object.keys(cursor.hooks), ['beforeShellExecution', 'beforeReadFile', 'beforeMCPExecution']);
  assert.equal(cursor.hooks.beforeReadFile[0].failClosed, true);
  assert.equal(json(root, '.github/hooks/rookery.json').hooks.preToolUse[0].bash, cmd('copilot'));
  assert.deepEqual(json(root, '.devin/hooks.json').hooks.pre_run_command, [{ command: cmd('windsurf') }]);
  assert.equal(readState(root)!.hookCommand, `npx -y @thinkingraven/rookery@${VERSION}`);
  assert.ok(plan.notes.some((n) => n.includes('/hooks')), 'Codex trust is called out');
  assert.match(readFileSync(join(root, '.rookery/ADMIN.md'), 'utf8'), /## Runtime hook[\s\S]*\[\[hooks\.PreToolUse\.hooks\]\][\s\S]*policy\.d\/rookery\.json[\s\S]*\/etc\/devin\/hooks\.json/, 'how an admin makes the hook binding');

  assert.ok(planApply(root, parsePolicy(HOOKS), ['claude-code', 'codex', 'gemini', 'cursor', 'copilot', 'windsurf']).changes.every((c) => c.status === 'unchanged'), 'a second apply changes nothing');

  apply(root, 'extends: strict\nmcp:\n  allow: [github]\n', ['claude-code', 'codex', 'gemini', 'cursor', 'copilot', 'windsurf']);
  assert.deepEqual(json(root, '.claude/settings.json').hooks.PreToolUse, [mine], 'hooks off: only rookery\'s entry goes');
  assert.equal(json(root, '.gemini/settings.json').hooks, undefined);
  for (const f of ['.codex/hooks.json', '.cursor/hooks.json', '.github/hooks/rookery.json', '.devin/hooks.json']) assert.ok(!existsSync(join(root, f)), f);
  assert.equal(readState(root)!.hookCommand, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('apply: the hook version stays put until --update-hooks; runtime.command wins', () => {
  const root = repo({});
  const old = 'npx -y @thinkingraven/rookery@0.0.1';
  apply(root, HOOKS, ['claude-code']);
  // Pretend an older rookery installed the hooks.
  const s = json(root, '.claude/settings.json');
  s.hooks.PreToolUse[0].hooks[0].command = `${old} hook claude-code`;
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
  const st = readState(root)!;
  st.hookCommand = old;
  (st.files['.claude/settings.json'] as { add: Record<string, unknown[]> }).add['hooks.PreToolUse'] = s.hooks.PreToolUse;
  writeFileSync(join(root, '.rookery/applied.json'), JSON.stringify(st, null, 2) + '\n');
  const admin = join(root, '.rookery/ADMIN.md');
  writeFileSync(admin, readFileSync(admin, 'utf8').split(`rookery@${VERSION}`).join('rookery@0.0.1'));

  const kept = planApply(root, parsePolicy(HOOKS), ['claude-code']);
  assert.ok(kept.changes.every((c) => c.status === 'unchanged'), 'no drift from a newer rookery');
  assert.ok(kept.notes.some((n) => n.includes('rookery@0.0.1') && n.includes('--update-hooks')));
  apply(root, HOOKS, ['claude-code'], { updateHooks: true });
  assert.deepEqual(json(root, '.claude/settings.json').hooks.PreToolUse.map((h: { hooks: { command: string }[] }) => h.hooks[0].command), [`npx -y @thinkingraven/rookery@${VERSION} hook claude-code`], 'replaced, not duplicated');

  apply(root, `${HOOKS}  command: rookery\n`, ['claude-code']);
  assert.equal(json(root, '.claude/settings.json').hooks.PreToolUse[0].hooks[0].command, 'rookery hook claude-code');
  rmSync(root, { recursive: true, force: true });
});

test('apply: Windsurf keeps a legacy .windsurf/hooks.json; a Copilot hook file rookery did not write is left alone', () => {
  const root = repo({ '.windsurf/hooks.json': '{"hooks":{"post_write_code":[{"command":"./lint.sh"}]}}', '.github/hooks/rookery.json': '{"version":1,"hooks":{}}' });
  const plan = apply(root, HOOKS, ['windsurf', 'copilot']);
  const w = json(root, '.windsurf/hooks.json');
  assert.deepEqual(w.hooks.post_write_code, [{ command: './lint.sh' }]);
  assert.equal(w.hooks.pre_read_code.length, 1);
  assert.ok(!existsSync(join(root, '.devin/hooks.json')), 'creating it would switch the legacy file off');
  assert.equal(readFileSync(join(root, '.github/hooks/rookery.json'), 'utf8'), '{"version":1,"hooks":{}}');
  assert.ok(plan.conflicts.some((c) => c.includes(".github/hooks/rookery.json already exists and wasn't written by rookery")));
  rmSync(root, { recursive: true, force: true });
});

test('policy: runtime is validated', () => {
  assert.deepEqual(parsePolicy('runtime:\n  hooks: true\n  command: " rookery "\n').runtime, { hooks: true, command: 'rookery' });
  assert.equal(parsePolicy('extends: strict\n').runtime.hooks, false, 'off unless asked for');
  assert.throws(() => parsePolicy('runtime:\n  hooks: yes please\n'), (e: unknown) => e instanceof PolicyError && /runtime\.hooks must be true or false/.test(e.message));
  assert.throws(() => parsePolicy('runtime:\n  hook: true\n'), (e: unknown) => e instanceof PolicyError && /runtime\.hook is not a setting/.test(e.message));
  assert.throws(() => parsePolicy('runtime:\n  command: ""\n'), PolicyError);
});
