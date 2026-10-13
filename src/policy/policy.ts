import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Agent, Severity } from '../types.js';
import { SEVERITIES } from '../types.js';
import { ALL_RULES } from '../rules.js';

/** What a policy does about a behaviour it finds. */
export type Level = 'forbid' | 'warn' | 'allow';
export type PresetName = 'strict' | 'balanced' | 'solo';

export interface Exception {
  path: string;      // glob, relative to the repo root
  rules: string[];   // policy keys (shell.any_command), policy rule ids (RK-POL-002) or scan rule ids (RK-EXE-001)
  reason: string;
  expires?: string;  // YYYY-MM-DD
}

export interface Policy {
  version: 1;
  extends: PresetName;
  agents?: Agent[];             // judge only these agents' files
  fail_on: Severity | 'none';   // scan findings at or above this severity fail the check
  approvals: { bypass: Level };
  shell: { any_command: Level; deny: string[] };   // deny: command prefixes written into each agent's deny rules by `policy apply`
  mcp: { unpinned: Level; unlisted: Level; allow: string[] };
  hooks: { network: Level };
  files: { read_secrets: Level; never_read: string[] };
  drift: Level;                 // agent configs out of date with the policy (once `policy apply` has been used)
  exceptions: Exception[];
}

/** Where a policy came from, and whether it is enforced. */
export interface LoadedPolicy {
  policy: Policy;
  source: string | null;  // path of the .rookery.yml, or null for the default
  enforced: boolean;      // false when no policy file exists: report as warnings only
}

export const POLICY_FILES = ['.rookery.yml', '.rookery.yaml'];

const NEVER_READ_DEFAULT = ['~/.ssh/**', '~/.aws/**', '~/.config/gh/**', '**/.env'];

export const PRESETS: Record<PresetName, Omit<Policy, 'version' | 'extends' | 'exceptions'>> = {
  strict: {
    fail_on: 'medium',
    approvals: { bypass: 'forbid' },
    shell: { any_command: 'forbid', deny: [] },
    mcp: { unpinned: 'forbid', unlisted: 'forbid', allow: [] },
    hooks: { network: 'forbid' },
    files: { read_secrets: 'forbid', never_read: NEVER_READ_DEFAULT },
    drift: 'forbid',
  },
  balanced: {
    fail_on: 'high',
    approvals: { bypass: 'forbid' },
    shell: { any_command: 'forbid', deny: [] },
    mcp: { unpinned: 'forbid', unlisted: 'allow', allow: [] },
    hooks: { network: 'warn' },
    files: { read_secrets: 'forbid', never_read: NEVER_READ_DEFAULT },
    drift: 'warn',
  },
  solo: {
    fail_on: 'none',
    approvals: { bypass: 'warn' },
    shell: { any_command: 'warn', deny: [] },
    mcp: { unpinned: 'warn', unlisted: 'allow', allow: [] },
    hooks: { network: 'warn' },
    files: { read_secrets: 'warn', never_read: NEVER_READ_DEFAULT },
    drift: 'allow',
  },
};

export function presetPolicy(name: PresetName): Policy {
  const p = PRESETS[name];
  return { version: 1, extends: name, ...structuredClone(p), exceptions: [] };
}

export class PolicyError extends Error {}

const LEVELS = ['forbid', 'warn', 'allow'];
const AGENT_ALIASES: Record<string, Agent> = {
  'claude-code': 'claude-code', claude: 'claude-code', codex: 'codex', cursor: 'cursor', copilot: 'copilot',
  'github-copilot': 'copilot', gemini: 'gemini', 'gemini-cli': 'gemini', windsurf: 'windsurf',
};
const SHAPE: Record<string, string[] | null> = {
  version: null, extends: null, agents: null, fail_on: null, exceptions: null, drift: null,
  approvals: ['bypass'], shell: ['any_command', 'deny'], mcp: ['unpinned', 'unlisted', 'allow'], hooks: ['network'], files: ['read_secrets', 'never_read'],
};

/** Parse and validate policy YAML. Unknown keys and bad values are errors, so typos never weaken a policy silently. */
export function parsePolicy(text: string, source = '.rookery.yml'): Policy {
  let raw: unknown;
  try { raw = parseYaml(text) ?? {}; } catch (err) { throw new PolicyError(`${source}: not valid YAML (${(err as Error).message.split('\n')[0]})`); }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new PolicyError(`${source}: expected a mapping at the top level`);
  const doc = raw as Record<string, unknown>;
  const problems: string[] = [];
  const where = (k: string) => `${source}: ${k}`;

  for (const [k, v] of Object.entries(doc)) {
    if (!(k in SHAPE)) { problems.push(`${where(k)} is not a policy setting (expected one of ${Object.keys(SHAPE).join(', ')})`); continue; }
    const keys = SHAPE[k];
    if (keys && (typeof v !== 'object' || v === null || Array.isArray(v))) problems.push(`${where(k)} must be a mapping`);
    else if (keys) for (const sub of Object.keys(v as object)) if (!keys.includes(sub)) problems.push(`${where(`${k}.${sub}`)} is not a setting (expected ${keys.join(', ')})`);
  }
  if (doc.version !== undefined && doc.version !== 1) problems.push(`${where('version')} must be 1`);
  const preset = (doc.extends ?? 'balanced') as PresetName;
  if (!(preset in PRESETS)) problems.push(`${where('extends')} must be strict, balanced or solo`);
  const policy = presetPolicy(preset in PRESETS ? preset : 'balanced');

  const level = (path: string, v: unknown, set: (l: Level) => void) => {
    if (v === undefined) return;
    if (typeof v === 'string' && LEVELS.includes(v)) set(v as Level);
    else problems.push(`${where(path)} must be forbid, warn or allow`);
  };
  const list = (path: string, v: unknown): string[] | undefined => {
    if (v === undefined) return undefined;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim())) return v.map((x) => x.trim());
    problems.push(`${where(path)} must be a list of strings`);
    return undefined;
  };
  const sec = (k: string) => (doc[k] && typeof doc[k] === 'object' ? doc[k] as Record<string, unknown> : {});

  if (doc.fail_on !== undefined) {
    if (typeof doc.fail_on === 'string' && ([...SEVERITIES, 'none'] as string[]).includes(doc.fail_on)) policy.fail_on = doc.fail_on as Severity | 'none';
    else problems.push(`${where('fail_on')} must be one of ${[...SEVERITIES, 'none'].join(', ')}`);
  }
  const agents = list('agents', doc.agents);
  if (agents) {
    const bad = agents.filter((a) => !(a.toLowerCase() in AGENT_ALIASES));
    if (bad.length) problems.push(`${where('agents')} has unknown agents: ${bad.join(', ')} (expected ${Object.keys(AGENT_ALIASES).join(', ')})`);
    else policy.agents = [...new Set(agents.map((a) => AGENT_ALIASES[a.toLowerCase()]))];
  }
  level('approvals.bypass', sec('approvals').bypass, (l) => { policy.approvals.bypass = l; });
  level('shell.any_command', sec('shell').any_command, (l) => { policy.shell.any_command = l; });
  const deny = list('shell.deny', sec('shell').deny);
  if (deny) {
    const bad = deny.filter((d) => !/^[\w./@+-][^\n"'`$;|&<>()]*$/.test(d));
    if (bad.length) problems.push(`${where('shell.deny')} entries must be plain command prefixes (no quotes, pipes or shell syntax): ${bad.join(', ')}`);
    else policy.shell.deny = deny.map((d) => d.replace(/\s+/g, ' '));
  }
  level('drift', doc.drift, (l) => { policy.drift = l; });
  level('mcp.unpinned', sec('mcp').unpinned, (l) => { policy.mcp.unpinned = l; });
  level('mcp.unlisted', sec('mcp').unlisted, (l) => { policy.mcp.unlisted = l; });
  const allow = list('mcp.allow', sec('mcp').allow);
  if (allow) policy.mcp.allow = allow;
  level('hooks.network', sec('hooks').network, (l) => { policy.hooks.network = l; });
  level('files.read_secrets', sec('files').read_secrets, (l) => { policy.files.read_secrets = l; });
  const neverRead = list('files.never_read', sec('files').never_read);
  if (neverRead) policy.files.never_read = neverRead;

  if (doc.exceptions !== undefined) {
    if (!Array.isArray(doc.exceptions)) problems.push(`${where('exceptions')} must be a list`);
    else doc.exceptions.forEach((e, i) => {
      const at = `exceptions[${i}]`;
      if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${where(at)} must be a mapping`); return; }
      const x = e as Record<string, unknown>;
      for (const k of Object.keys(x)) if (!['path', 'rules', 'reason', 'expires'].includes(k)) problems.push(`${where(`${at}.${k}`)} is not a setting (expected path, rules, reason, expires)`);
      if (typeof x.path !== 'string' || !x.path.trim()) problems.push(`${where(`${at}.path`)} is required`);
      const rules = list(`${at}.rules`, x.rules);
      if (!rules) problems.push(`${where(`${at}.rules`)} is required`);
      else for (const r of rules) if (!RULE_KEYS.has(r) && !RULE_IDS.has(r)) problems.push(`${where(`${at}.rules`)}: unknown rule "${r}"`);
      if (typeof x.reason !== 'string' || !x.reason.trim()) problems.push(`${where(`${at}.reason`)} is required: say why this is acceptable`);
      const expires = x.expires instanceof Date ? x.expires.toISOString().slice(0, 10) : x.expires;
      if (expires !== undefined && (typeof expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires))) problems.push(`${where(`${at}.expires`)} must be a date (YYYY-MM-DD)`);
      if (typeof x.path === 'string' && rules && typeof x.reason === 'string') policy.exceptions.push({ path: x.path.trim(), rules, reason: x.reason.trim(), ...(typeof expires === 'string' ? { expires } : {}) });
    });
  }
  if (problems.length) throw new PolicyError(problems.join('\n'));
  return policy;
}

/** The policy rules, by id and by settings key. */
export const POLICY_RULES = [
  { id: 'RK-POL-001', key: 'approvals.bypass', title: 'Agent approvals switched off', why: 'The policy does not allow turning off the agent\'s approval prompts or sandbox.', remediation: 'Remove the bypass flag or setting, or add a reviewed exception to .rookery.yml.' },
  { id: 'RK-POL-002', key: 'shell.any_command', title: 'Any shell command pre-approved', why: 'The policy does not allow pre-approving every shell command.', remediation: 'Replace bare Bash / Bash(*) with the specific commands the skill needs.' },
  { id: 'RK-POL-003', key: 'mcp.unpinned', title: 'MCP server not pinned to a version', why: 'The policy requires MCP servers to run a pinned version.', remediation: 'Pin an exact version, e.g. npx -y @scope/server@1.4.2.' },
  { id: 'RK-POL-004', key: 'mcp.unlisted', title: 'MCP server not on the allow-list', why: 'The policy only allows the MCP servers listed in mcp.allow.', remediation: 'Remove the server, or add its name to mcp.allow after review.' },
  { id: 'RK-POL-005', key: 'hooks.network', title: 'Hook makes network calls', why: 'The policy does not allow hooks that call the network.', remediation: 'Keep hooks local; move network work into an explicit, reviewed command.' },
  { id: 'RK-POL-006', key: 'files.read_secrets', title: 'Reads credentials or protected paths', why: 'The policy does not allow agent files to read credentials, password stores or the paths in files.never_read.', remediation: 'Use the tool\'s own auth flow or ask the user for the one value needed.' },
  { id: 'RK-POL-007', key: 'drift', title: 'Agent config out of date with the policy', why: 'The policy was applied to this repo\'s agent configs with `rookery policy apply`, and they no longer match it.', remediation: 'Run `rookery policy apply --write` and commit the result.' },
] as const;
export type PolicyRuleKey = typeof POLICY_RULES[number]['key'];
const RULE_KEYS = new Set<string>(POLICY_RULES.map((r) => r.key));
const RULE_IDS = new Set<string>([...POLICY_RULES.map((r) => r.id), ...ALL_RULES.map((r) => r.id)]);

/** Find .rookery.yml in the scanned folder (the first path, or the current directory when none is given). */
export function findPolicyFile(paths: string[], cwd = process.cwd()): string | null {
  const first = paths[0] ? resolve(cwd, paths[0]) : cwd;
  const dir = existsSync(first) && statSync(first).isFile() ? dirname(first) : first;
  for (const f of POLICY_FILES) if (existsSync(join(dir, f))) return join(dir, f);
  return null;
}

export function loadPolicy(explicit: string | undefined, paths: string[], cwd = process.cwd()): LoadedPolicy {
  const file = explicit ? resolve(explicit) : findPolicyFile(paths, cwd);
  if (explicit && !existsSync(file!)) throw new PolicyError(`policy file not found: ${explicit}`);
  if (!file) return { policy: presetPolicy('balanced'), source: null, enforced: false };
  return { policy: parsePolicy(readFileSync(file, 'utf8'), file), source: file, enforced: true };
}

/** A commented starter policy for `rookery policy init`. */
export function policyTemplate(preset: PresetName): string {
  const p = PRESETS[preset];
  return `# rookery policy: what AI agents may do in this repo. Checked by \`rookery check\`.
# Docs: https://github.com/thinkingraven/rookery/blob/main/docs/policy.md
version: 1
extends: ${preset}                # strict | balanced | solo: the defaults below come from here

# Scan findings at or above this severity also fail the check (critical, high, medium, low, info, none).
fail_on: ${p.fail_on}

# Each behaviour can be: forbid (fails the check), warn (reported) or allow (ignored).
approvals:
  bypass: ${p.approvals.bypass}              # --dangerously-skip-permissions, bypassPermissions, --yolo, approval_policy = "never"…
shell:
  any_command: ${p.shell.any_command}         # bare Bash / Bash(*) in settings, or in a skill's allowed-tools
  deny: []                   # command prefixes \`rookery policy apply\` writes into each agent's deny rules, e.g. ["rm -rf", "git push --force"]
mcp:
  unpinned: ${p.mcp.unpinned}            # npx/uvx servers without an exact version
  unlisted: ${p.mcp.unlisted}${' '.repeat(Math.max(1, 12 - p.mcp.unlisted.length))}# servers whose name is not in allow
  allow: []                  # e.g. [github, linear]
hooks:
  network: ${p.hooks.network}               # hooks that call curl, wget, ssh…
files:
  read_secrets: ${p.files.read_secrets}        # credential files, password managers, and the paths below
  never_read:
${p.files.never_read.map((x) => `    - "${x}"`).join('\n')}

# Once \`rookery policy apply --write\` has run, agent configs that no longer match this file are drift.
drift: ${p.drift}

# Only judge these agents' files (default: all). claude-code, codex, cursor, copilot, gemini, windsurf
# agents: [claude-code, cursor]

# Reviewed exceptions. Each needs a reason; expired or unused ones are reported.
# rules can name policy settings (shell.any_command), policy rules (RK-POL-002) or scan rules (RK-EXE-001).
exceptions: []
#  - path: .claude/skills/deploy/**
#    rules: [shell.any_command]
#    reason: "Deploy skill needs the full CLI; reviewed by @platform"
#    expires: 2026-12-31
#  - path: .claude/skills/setup/**
#    rules: [RK-EXE-001]
#    reason: "Official rustup installer"
`;
}
