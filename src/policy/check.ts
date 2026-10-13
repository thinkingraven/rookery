import type { Agent, Artifact, Finding, PolicyResult, PolicyViolation, ScanResult } from '../types.js';
import { SEVERITIES } from '../types.js';
import { lowConfidence } from '../rules.js';
import { AGENT_SUPPORT } from './capabilities.js';
import { POLICY_RULES, type Level, type LoadedPolicy, type PolicyRuleKey } from './policy.js';

/** Scan rules each policy rule builds on. */
const FROM_FINDINGS: Partial<Record<PolicyRuleKey, string[]>> = {
  'approvals.bypass': ['RK-EXE-004'],
  'shell.any_command': ['RK-PRM-001', 'RK-PRM-002'],
  'mcp.unpinned': ['RK-MCP-001'],
  'hooks.network': ['RK-HOOK-001'],
  'files.read_secrets': ['RK-EXF-003', 'RK-EXF-004'],
};

/** Which control in docs/agent-capabilities.json an agent would need to enforce each rule itself. */
const ENFORCED_BY: Partial<Record<PolicyRuleKey, string>> = {
  'approvals.bypass': 'bypass_lockout',
  'shell.any_command': 'deny_commands',
  'mcp.unlisted': 'mcp_server_allowlist',
  'files.read_secrets': 'file_read_deny',
};

/** rookery agent id → capability matrix id. Generic Agent Skills, skillshare and bare MCP configs have no agent of their own. */
const MATRIX_ID: Partial<Record<Agent, string>> = {
  'claude-code': 'claude-code', codex: 'codex', gemini: 'gemini-cli', cursor: 'cursor', copilot: 'copilot', windsurf: 'windsurf',
};

const READ_VERB = /\b(?:cat|less|more|head|tail|cp|scp|rsync|base64|xxd|grep|rg|awk|sed|source|upload|send)\b|\b(?:open|readFile|readFileSync|read_text|Get-Content)\s*\(/;

/** A never_read glob as a regex over text: "~/.ssh/**" matches ~/.ssh/…, $HOME/.ssh/…; "**\/.env" matches a .env file name. */
export function pathPattern(glob: string): RegExp {
  let g = glob.trim();
  let head = '';
  if (g.startsWith('~/')) { head = String.raw`(?:~|\$HOME|\$\{HOME\})/`; g = g.slice(2); }
  else if (g.startsWith('**/')) { head = String.raw`(?:^|[\s'"=(:/])`; g = g.slice(3); }
  else head = String.raw`(?:^|[\s'"=(:])`;
  const prefix = g.endsWith('/**');
  if (prefix) g = g.slice(0, -3);
  const body = g.split('').map((ch) => (ch === '*' ? String.raw`[^\s'"/]*` : ch === '?' ? String.raw`[^\s'"/]` : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(head + body + (prefix ? '/' : String.raw`(?=$|[\s'"\`;|&)<>,])`));
}

function globToRegex(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '');
  const re = g.split('').map((ch, i, a) => {
    if (ch === '*' && a[i + 1] === '*') return '';
    if (ch === '*' && a[i - 1] === '*') return '.*';
    if (ch === '*') return '[^/]*';
    if (ch === '?') return '[^/]';
    return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${re}(?:/.*)?$`);
}

function lineOf(text: string, needle: string): number {
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split('\n').length;
}

export interface CheckOptions { strict?: boolean; today?: string }

/** Judge a scan against a policy. */
export function checkPolicy(r: ScanResult, loaded: LoadedPolicy, opts: CheckOptions = {}): PolicyResult {
  const { policy, enforced } = loaded;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const byId = new Map(r.artifacts.map((a) => [a.id, a]));
  const inScope = (agent?: Agent) => !policy.agents || (agent !== undefined && policy.agents.includes(agent));
  const levelOf: Record<PolicyRuleKey, Level> = {
    'approvals.bypass': policy.approvals.bypass,
    'shell.any_command': policy.shell.any_command,
    'mcp.unpinned': policy.mcp.unpinned,
    'mcp.unlisted': policy.mcp.unlisted,
    'hooks.network': policy.hooks.network,
    'files.read_secrets': policy.files.read_secrets,
  };
  const raw: PolicyViolation[] = [];
  const add = (key: PolicyRuleKey, v: Omit<PolicyViolation, 'ruleId' | 'key' | 'level' | 'title'>) => {
    const level = levelOf[key];
    if (level === 'allow') return;
    const rule = POLICY_RULES.find((x) => x.key === key)!;
    raw.push({ ruleId: rule.id, key, title: rule.title, level: level === 'forbid' && enforced ? 'error' : 'warning', ...v });
  };

  // 1. Rules built on scan findings.
  const counted = (f: Finding) => opts.strict || f.confidence === 'high';
  for (const [key, ruleIds] of Object.entries(FROM_FINDINGS) as [PolicyRuleKey, string[]][]) {
    for (const f of r.findings) {
      if (!ruleIds.includes(f.ruleId) || !counted(f)) continue;
      const agent = byId.get(f.artifactId)?.agent;
      if (!inScope(agent)) continue;
      add(key, { message: f.message, repo: f.repo, relPath: f.relPath, line: f.line, snippet: f.snippet, agent, fromFinding: f.ruleId });
    }
  }

  // 2. MCP servers not on the allow-list.
  const allowed = new Set(policy.mcp.allow.map((s) => s.toLowerCase()));
  for (const a of r.artifacts) {
    if (!inScope(a.agent)) continue;
    for (const s of a.mcpServers) {
      if (allowed.has(s.name.toLowerCase())) continue;
      add('mcp.unlisted', {
        message: allowed.size ? `"${s.name}" is not in mcp.allow.` : `"${s.name}" is not in mcp.allow, which is empty.`,
        repo: a.repo, relPath: a.relPath, line: lineOf(a.body, `"${s.name}"`), snippet: `${s.name}: ${s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ')}`, agent: a.agent,
      });
    }
  }

  // 3. Reads of the paths in files.never_read, in agent instructions and the scripts bundled with them.
  const patterns = policy.files.never_read.map((g) => ({ glob: g, re: pathPattern(g) }));
  const seen = new Set(raw.filter((v) => v.key === 'files.read_secrets').map((v) => `${v.repo}|${v.relPath}|${v.line}`));
  const textsOf = (a: Artifact) => (a.kind === 'settings' || a.kind === 'mcp-config' || a.kind === 'plugin' ? [] : [{ relPath: a.relPath, content: a.body }, ...a.bundled]);
  if (patterns.length) for (const a of r.artifacts) {
    if (!inScope(a.agent)) continue;
    for (const t of textsOf(a)) {
      t.content.split('\n').forEach((line, i) => {
        if (!READ_VERB.test(line)) return;
        // Public keys (id_ed25519.pub) are not secrets, even under a protected folder.
        const hit = patterns.find((p) => { const m = p.re.exec(line); return !!m && !/^\S*?\.pub\b/.test(line.slice(m.index + m[0].length)); });
        if (!hit || /rookery-ignore/.test(line)) return;
        if (!opts.strict && lowConfidence('RK-EXF-003', t.relPath, line)) return;
        const k = `${a.repo}|${t.relPath}|${i + 1}`;
        if (seen.has(k)) return;
        seen.add(k);
        add('files.read_secrets', { message: `Reads ${hit.glob}, which files.never_read protects.`, repo: a.repo, relPath: t.relPath, line: i + 1, snippet: line.trim().slice(0, 160), agent: a.agent });
      });
    }
  }

  // Exceptions: reviewed paths and rules that a violation may match. Expired exceptions no longer apply.
  const exceptions = policy.exceptions.map((e) => ({ ...e, re: globToRegex(e.path), expired: !!e.expires && e.expires < today, matched: 0 }));
  const violations: PolicyViolation[] = [];
  const excepted: PolicyViolation[] = [];
  for (const v of raw) {
    const e = exceptions.find((x) => !x.expired && (x.rules.includes(v.key) || x.rules.includes(v.ruleId)) && (x.re.test(v.relPath) || x.re.test(`${v.repo}/${v.relPath}`)));
    if (e) { e.matched++; excepted.push({ ...v, exception: { path: e.path, reason: e.reason } }); }
    else violations.push(v);
  }

  // Scan findings at or above fail_on also fail the check, unless an exception covers them: either the
  // scan rule itself (RK-EXE-001) or a policy violation built on that finding.
  const backing = new Set(excepted.filter((v) => v.fromFinding).map((v) => `${v.fromFinding}|${v.repo}|${v.relPath}|${v.line}`));
  const exceptFinding = (f: Finding) => {
    if (backing.has(`${f.ruleId}|${f.repo}|${f.relPath}|${f.line}`)) return true;
    const e = exceptions.find((x) => !x.expired && x.rules.includes(f.ruleId) && (x.re.test(f.relPath) || x.re.test(`${f.repo}/${f.relPath}`)));
    if (e) e.matched++;
    return !!e;
  };
  const limit = policy.fail_on === 'none' ? -1 : SEVERITIES.indexOf(policy.fail_on);
  const findingsAtOrAbove = limit < 0 ? 0 : r.findings.filter((f) => counted(f) && SEVERITIES.indexOf(f.severity) <= limit && inScope(byId.get(f.artifactId)?.agent) && !exceptFinding(f)).length;

  // What the agents in this repo can enforce themselves, from the capability matrix.
  const present = [...new Set(r.artifacts.filter((a) => inScope(a.agent)).map((a) => MATRIX_ID[a.agent]).filter((x): x is string => !!x))].sort();
  const coverage = (Object.entries(ENFORCED_BY) as [PolicyRuleKey, string][])
    .filter(([key]) => levelOf[key] !== 'allow')
    .map(([key, capability]) => ({ key, capability, agents: present.map((id) => ({ agent: id, name: AGENT_SUPPORT[id]?.name ?? id, support: AGENT_SUPPORT[id]?.support[capability] ?? 'unknown' })) }))
    .filter((c) => c.agents.length);

  const order = (v: PolicyViolation) => `${v.level === 'error' ? 0 : 1}|${v.ruleId}|${v.repo}|${v.relPath}|${String(v.line).padStart(6, '0')}`;
  violations.sort((a, b) => order(a).localeCompare(order(b)));
  return {
    source: loaded.source,
    preset: policy.extends,
    enforced,
    failOn: policy.fail_on,
    violations,
    excepted,
    exceptions: exceptions.map(({ re, expired, matched, ...e }) => ({ ...e, matched, status: expired ? 'expired' : matched ? 'used' : 'unused' })),
    findingsAtOrAbove,
    coverage,
    passed: !enforced || (!violations.some((v) => v.level === 'error') && findingsAtOrAbove === 0),
  };
}
