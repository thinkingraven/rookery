import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.js';
import { classify } from '../src/discover.js';
import { categorize } from '../src/categories.js';
import { makeOrg, makeEmptyRepo } from './fixtures.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const org = makeOrg();
const result = scan({ paths: [org], maxFileBytes: 512 * 1024, includeInfo: true, similarityThreshold: 0.5 });
const has = (ruleId: string, pathPart?: string) => result.findings.some((f) => f.ruleId === ruleId && (!pathPart || f.relPath.includes(pathPart)));

test('classifies agent files across tools', () => {
  assert.deepEqual(classify('.claude/skills/x/SKILL.md'), { agent: 'claude-code', kind: 'skill' });
  assert.deepEqual(classify('packages/api/AGENTS.md'), { agent: 'codex', kind: 'rules' });
  assert.deepEqual(classify('.cursor/rules/style.mdc'), { agent: 'cursor', kind: 'rules' });
  assert.deepEqual(classify('.github/prompts/fix.prompt.md'), { agent: 'copilot', kind: 'command' });
  assert.deepEqual(classify('.vscode/mcp.json'), { agent: 'copilot', kind: 'mcp-config' });
  assert.deepEqual(classify('plugins/x/skills/y/SKILL.md'), { agent: 'agent-skills', kind: 'skill' });
  assert.equal(classify('src/index.ts'), null);
  assert.equal(classify('docs/README.md'), null);
});

test('discovers artifacts and attributes them to the right repo', () => {
  assert.deepEqual(result.repos, ['repo-a', 'repo-b', 'repo-c']);
  assert.equal(result.stats.artifacts, 12);
  assert.equal(result.stats.byAgent['claude-code'], 5);
  assert.equal(result.stats.byKind.skill, 4);
  const deploy = result.artifacts.find((a) => a.name === 'deploy')!;
  assert.equal(deploy.repo, 'repo-a');
  assert.deepEqual(deploy.scripts, ['.claude/skills/deploy/scripts/deploy.sh']);
});

test('parses hooks, permissions and MCP servers', () => {
  const settings = result.artifacts.find((a) => a.kind === 'settings')!;
  assert.equal(settings.hooks.length, 2);
  assert.ok(settings.allowedTools.includes('Bash(*)'));
  const mcp = result.artifacts.find((a) => a.relPath === '.mcp.json')!;
  assert.deepEqual(mcp.mcpServers.map((s) => s.name), ['github', 'remote', 'local']);
});

test('detects exfiltration and unsafe execution in bundled scripts', () => {
  assert.ok(has('RK-EXF-001', 'deploy.sh'), 'env piped to curl');
  assert.ok(has('RK-EXF-002', 'deploy.sh'), 'webhook.site');
  assert.ok(has('RK-EXE-001', 'deploy.sh'), 'curl | bash');
});

test('detects prompt injection, hidden unicode and hidden comments', () => {
  assert.ok(has('RK-INJ-001', 'helper'));
  assert.ok(has('RK-INJ-002', 'helper'));
  assert.ok(has('RK-INJ-003', 'helper'));
});

test('honours rookery-ignore suppressions', () => {
  assert.ok(!result.findings.some((f) => f.ruleId === 'RK-EXE-001' && f.relPath.includes('helper')));
});

test('flags permissions, hooks and MCP configuration risks', () => {
  assert.ok(has('RK-PRM-002', 'settings.json'));
  assert.ok(has('RK-PRM-001', 'helper'));
  assert.ok(has('RK-HOOK-001', 'settings.json'));
  assert.ok(has('RK-HOOK-002', 'settings.json'));
  assert.ok(has('RK-MCP-001', '.mcp.json'));
  assert.ok(has('RK-MCP-002', '.mcp.json'));
  assert.ok(!result.findings.some((f) => f.ruleId === 'RK-MCP-001' && f.relPath.includes('.cursor')), 'pinned package is fine');
  assert.ok(!result.findings.some((f) => f.snippet.includes('localhost')), 'localhost MCP is fine');
  assert.ok(has('RK-QLT-001', 'commit-msg'));
});

test('clusters near-duplicate review skills across agents', () => {
  const cluster = result.clusters.find((c) => c.members.some((m) => m.relPath.includes('pr-review')));
  assert.ok(cluster, 'expected a review cluster');
  assert.equal(cluster.members.length, 3);
  assert.deepEqual(new Set(cluster.members.map((m) => m.agent)), new Set(['claude-code', 'cursor', 'copilot']));
  assert.equal(cluster.category, 'code-review');
  assert.ok(cluster.similarity > 0.5 && !cluster.exact);
});

test('categorises by purpose with whole-word matching', () => {
  assert.equal(categorize('pr-review Review a pull request', ''), 'code-review');
  assert.equal(categorize('commit-msg', 'Write a conventional commit message'), 'commit-messages');
  assert.equal(categorize('explainer', 'An explanation of specific things'), 'other');
  assert.equal(categorize('anything', 'x', 'rules'), 'project-instructions');
});

test('CLI: JSON output, HTML report and --fail-on exit code', () => {
  const html = join(org, 'report.html');
  const run = spawnSync(process.execPath, [CLI, 'scan', org, '--format', 'json', '--fail-on', 'high', '--html', html], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  const json = JSON.parse(run.stdout);
  assert.equal(json.tool.name, 'rookery');
  assert.ok(!('body' in json.artifacts[0]), 'JSON must not include file bodies');
  assert.ok(existsSync(html) && readFileSync(html, 'utf8').includes('Rookery report'));
});

test('CLI: clean repo exits 0 and says nothing was found', () => {
  const empty = makeEmptyRepo();
  const out = execFileSync(process.execPath, [CLI, 'scan', empty, '--fail-on', 'high', '--no-color'], { encoding: 'utf8' });
  assert.match(out, /No agent skills, rules or configs found/);
  rmSync(empty, { recursive: true, force: true });
});

test('CLI: rejects bad options with exit code 2', () => {
  const run = spawnSync(process.execPath, [CLI, 'scan', org, '--fail-on', 'severe'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--fail-on must be one of/);
});

test('real-world false positives are suppressed or low confidence', async () => {
  const { makeNoisyRepo } = await import('./fixtures.js');
  const noisy = makeNoisyRepo();
  const r = scan({ paths: [noisy], maxFileBytes: 512 * 1024, includeInfo: false, similarityThreshold: 0.5 });
  const high = r.findings.filter((f) => f.confidence === 'high');
  const where = (id: string, part: string) => high.some((f) => f.ruleId === id && f.relPath.includes(part));
  // Must not fire (or not with high confidence)
  assert.ok(!high.some((f) => f.ruleId === 'RK-SEC-002' && f.relPath.includes('memory')), 'example/placeholder tokens and words containing "sk-"');
  assert.ok(!high.some((f) => f.ruleId === 'RK-SEC-003' && f.relPath.includes('memory')), 'placeholder secret');
  assert.ok(!high.some((f) => f.relPath.includes('onboarding.md')), 'warnings, benign eval, authoring comments and advice');
  assert.ok(!high.some((f) => f.relPath.includes('scan.py')), 'patterns and payloads inside scanner code');
  assert.ok(!r.findings.some((f) => f.relPath.includes('finance.md')), 'negated or ordinary uses of injection-like phrases');
  // Must fire
  assert.ok(where('RK-SEC-001', 'real'), 'real private key block');
  assert.ok(where('RK-SEC-002', 'real'), 'real-looking OpenAI key');
  assert.ok(where('RK-EXF-003', 'real'), 'reads AWS credentials');
  // The malicious fixture's injection stays high confidence even though it says "do not"
  assert.ok(result.findings.some((f) => f.ruleId === 'RK-INJ-001' && f.confidence === 'high'));
  rmSync(noisy, { recursive: true, force: true });
});
