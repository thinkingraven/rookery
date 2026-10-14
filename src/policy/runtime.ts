import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ruleMatches } from '../rules.js';
import { pathPattern } from './check.js';
import { parsePolicy, POLICY_FILES, POLICY_RULES, type Level, type Policy } from './policy.js';

/**
 * `rookery hook <agent>`: a pre-tool-use hook that checks one live tool call against .rookery.yml.
 *
 * Input and output follow each agent's own hook contract (checked against their docs, 2026-10-14).
 * Any error denies the call (fail closed). A repo without a policy gets no opinion.
 */

export const HOOK_AGENTS = ['claude-code', 'codex', 'gemini', 'cursor', 'copilot', 'windsurf'] as const;
export type HookAgent = typeof HOOK_AGENTS[number];

export type Call =
  | { kind: 'shell'; command: string; cwd?: string }
  | { kind: 'read'; paths: string[]; cwd?: string }
  | { kind: 'mcp'; server?: string; tool: string; cwd?: string }
  | { kind: 'other'; cwd?: string };

export interface Decision {
  action: 'deny' | 'warn' | 'pass';
  key?: string;       // the policy setting: approvals.bypass, shell.deny, files.read_secrets, mcp.unlisted
  ruleId?: string;    // its RK-POL id, when it has one
  reason?: string;
  subject?: string;   // redacted: the first command words, a ~ path, or server / tool
}

export interface HookReply { stdout: string; stderr: string; exitCode: number }

type Input = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Input => {
  if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Input : {};
};
const some = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x);

/** Turn one agent's hook input into a common call. */
export function parseCall(agent: HookAgent, input: Input): Call {
  if (agent === 'claude-code' || agent === 'codex' || (agent === 'copilot' && 'tool_name' in input)) {
    // Copilot's PascalCase PreToolUse sends this same shape, with Claude tool names.
    const name = str(input.tool_name) ?? '';
    const ti = obj(input.tool_input);
    const cwd = str(input.cwd);
    if (name === 'Bash' || name === 'PowerShell') return { kind: 'shell', command: str(ti.command) ?? '', cwd };
    if (name === 'Read') return { kind: 'read', paths: some(str(ti.file_path)), cwd };
    if (name === 'Grep' || name === 'Glob') return { kind: 'read', paths: some(str(ti.path)), cwd };
    if (name.startsWith('mcp__')) return { kind: 'mcp', server: str(obj(input.mcp_server).name) ?? name.split('__')[1], tool: name, cwd };
    return { kind: 'other', cwd };
  }
  if (agent === 'gemini') {
    const name = str(input.tool_name) ?? '';
    const ti = obj(input.tool_input);
    const cwd = str(input.cwd);
    if (name === 'run_shell_command') return { kind: 'shell', command: str(ti.command) ?? '', cwd };
    if (name === 'read_file') return { kind: 'read', paths: some(str(ti.file_path), str(ti.absolute_path)), cwd };
    if (name === 'read_many_files') return { kind: 'read', paths: Array.isArray(ti.include) ? ti.include.filter((x): x is string => typeof x === 'string') : [], cwd };
    if (name.startsWith('mcp_')) {
      const ctx = obj(input.mcp_context);
      return { kind: 'mcp', server: str(ctx.server_name) ?? str(ctx.serverName), tool: name, cwd };
    }
    return { kind: 'other', cwd };
  }
  if (agent === 'cursor') {
    const event = str(input.hook_event_name);
    const cwd = str(input.cwd) ?? (Array.isArray(input.workspace_roots) ? str(input.workspace_roots[0]) : undefined);
    if (event === 'beforeShellExecution') return { kind: 'shell', command: str(input.command) ?? '', cwd };
    if (event === 'beforeReadFile') return { kind: 'read', paths: some(str(input.file_path)), cwd };
    // input.command here is the MCP server's launch command, not a shell command.
    if (event === 'beforeMCPExecution') return { kind: 'mcp', server: str(input.mcp_server_name), tool: str(input.tool_name) ?? '', cwd };
    return { kind: 'other', cwd };
  }
  if (agent === 'copilot') {
    const name = str(input.toolName) ?? '';
    const args = obj(input.toolArgs);
    const cwd = str(input.cwd);
    if (name === 'bash' || name === 'powershell') return { kind: 'shell', command: str(args.command) ?? '', cwd };
    if (/^(?:view|grep|rg|glob)$/.test(name)) return { kind: 'read', paths: some(str(args.path) ?? str(args.file_path)), cwd };
    return { kind: 'other', cwd };
  }
  // windsurf
  const action = str(input.agent_action_name);
  const info = obj(input.tool_info);
  if (action === 'pre_run_command') return { kind: 'shell', command: str(info.command_line) ?? '', cwd: str(info.cwd) };
  if (action === 'pre_read_code') return { kind: 'read', paths: some(str(info.file_path)) };
  if (action === 'pre_mcp_tool_use') return { kind: 'mcp', server: str(info.mcp_server_name), tool: str(info.mcp_tool_name) ?? '' };
  return { kind: 'other' };
}

const SHELL_C = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-[a-z]*c[a-z]*\s+(["'])([\s\S]*)\1\s*$|^eval\s+(["'])([\s\S]*)\3\s*$/;

/** Split a command line into simple commands at && || ; | & and newlines (outside quotes), without leading env, sudo or exec. `sh -c '…'` and `eval '…'` are opened up. */
export function segments(command: string, depth = 0): string[] {
  const out: string[] = [];
  let cur = '', quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) { cur += ch; if (ch === quote && command[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') { out.push(cur); cur = ''; i++; continue; }
    if (';|&\n`()'.includes(ch) && !(ch === '&' && /\d?>$/.test(cur))) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  const simple = out
    .map((s) => s.trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
      .replace(/^(?:(?:sudo|exec|command|env|nohup|time|xargs|nice)\s+(?:-\S+\s+)*)+/, '')
      .trim())
    .filter(Boolean);
  if (depth > 2) return simple;
  return simple.flatMap((s) => {
    const m = SHELL_C.exec(s);
    return m ? [s, ...segments(m[2] ?? m[4], depth + 1)] : [s];
  });
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']|["']$/g, ''));
/** Quoted text with spaces in it (a prompt, a commit message) is not part of the command's shape. */
const dropProse = (s: string) => s.replace(/"(?:[^"\\]|\\.)*\s(?:[^"\\]|\\.)*"|'[^']*\s[^']*'/g, '""');

const AGENT_RUN = /^(?:(?:npx|bunx|pnpx|uvx)\s+(?:-\S+\s+)*|(?:pnpm|yarn)\s+dlx\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:@[\w.-]+\/)?(claude(?:-code)?|codex|gemini(?:-cli)?|copilot|cursor-agent|opencode)(?:@\S+)?(?=\s|$)/;
const BYPASS = /--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo\b|--approval-mode[= ]+["']?yolo\b|--allow-all-tools\b|--allow-all\b|--permission-mode[= ]+["']?bypassPermissions\b|approval_policy\s*=\s*["']?never\b|sandbox_mode\s*=\s*["']?danger-full-access|(?:--sandbox|-s)[= ]+["']?danger-full-access/;
const BYPASS_SHORT: Record<string, RegExp> = { gemini: /(?:^|\s)-y(?=\s|$)/, 'cursor-agent': /(?:^|\s)(?:-f|--force)(?=\s|$)/ };
const READ_VERBS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'nl', 'tac', 'cp', 'scp', 'rsync', 'base64', 'xxd', 'od', 'strings', 'grep', 'rg', 'awk', 'sed', 'jq', 'source', '.', 'tar', 'zip', 'gzip', 'diff', 'vi', 'vim', 'nano', 'open']);
const WRITE_LAST = new Set(['cp', 'mv', 'scp', 'rsync', 'install', 'ln']);

const tilde = (s: string, home: string) => s.split(home).join('~');
/** For the log: no home folder, and long tokens cut short in case a command carried a secret. Paths stay whole. */
function redact(s: string, home: string, path = false): string {
  const t = tilde(s, home);
  return (path ? t : t.replace(/[A-Za-z0-9_\-+=]{24,}/g, (x) => `${x.slice(0, 4)}…`)).slice(0, 160);
}

const globRe = (g: string) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');

/** The never_read glob a file path falls under, if any. Paths resolve against the call's folder; ~ is the home folder. */
export function protectedPath(globs: string[], path: string, cwd: string, home: string): string | null {
  const abs = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : isAbsolute(path) ? path : resolve(cwd, path);
  if (/\.pub$/.test(abs)) return null;
  for (const g of globs) {
    const under = (base: string) => new RegExp(`^${globRe(base.replace(/\/\*\*$/, ''))}(?:/.*)?$`);
    const re = g.startsWith('~/') ? under(join(home, g.slice(2)))
      : g.startsWith('**/') ? new RegExp(`(?:^|/)${globRe(g.slice(3))}(?:/.*)?$`)
      : under(isAbsolute(g) ? g : resolve(cwd, g));
    if (re.test(abs)) return g;
  }
  return null;
}

/** Check one call against the policy. Exceptions don't apply here: they cover files in the repo, not live calls. */
export function evaluate(call: Call, policy: Policy, ctx: { home?: string; cwd?: string } = {}): Decision {
  const home = ctx.home ?? homedir();
  const cwd = call.cwd ?? ctx.cwd ?? process.cwd();
  const found: Decision[] = [];
  const add = (key: string, level: Level, reason: string, subject: string) => {
    if (level === 'allow') return;
    const ruleId = POLICY_RULES.find((r) => r.key === key)?.id;
    found.push({ action: level === 'forbid' ? 'deny' : 'warn', key, ruleId, reason: `rookery policy (${key}${ruleId ? `, ${ruleId}` : ''}): ${reason}`, subject: redact(subject, home, call.kind === 'read') });
  };

  if (call.kind === 'shell') {
    const homeRe = new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$|["'\\s])`, 'g');
    const never = policy.files.never_read.map((g) => ({ g, re: pathPattern(g) }));
    for (const seg of segments(call.command)) {
      const shape = dropProse(seg);
      const w = words(shape);
      const cmd = [basename(w[0] ?? ''), ...w.slice(1)];

      for (const d of policy.shell.deny) {
        const p = d.split(' ');
        if (p.every((t, i) => cmd[i] === t)) add('shell.deny', 'forbid', `\`${d}\` is not allowed in this repo.`, cmd.slice(0, p.length + 1).join(' '));
      }

      const agent = AGENT_RUN.exec(shape);
      if (agent) {
        const name = agent[1].replace(/-(?:code|cli)$/, '');
        if (BYPASS.test(shape) || BYPASS_SHORT[name]?.test(shape)) add('approvals.bypass', policy.approvals.bypass, `starting ${name} with its approvals or sandbox off is not allowed.`, w.slice(0, 3).join(' '));
      }

      if (policy.files.read_secrets === 'allow') continue;
      // What the command reads: drop redirect targets and the destination of cp/mv-style commands.
      let reads = shape.replace(homeRe, '~').replace(/\d?>>?\s*(?:"[^"]*"|'[^']*'|\S+)/g, ' ');
      if (WRITE_LAST.has(cmd[0])) reads = reads.trim().split(/\s+/).slice(0, -1).join(' ');
      const verb = READ_VERBS.has(cmd[0]) || (cmd[0] === 'git' && /^(?:show|diff|log|blame|grep)$/.test(cmd[1] ?? ''));
      const hit = verb && never.find(({ re }) => { const m = re.exec(reads); return !!m && !/^[^\s'"]*\.pub(?=$|[\s'"])/.test(reads.slice(m.index + m[0].length)); });
      if (hit) add('files.read_secrets', policy.files.read_secrets, `reading ${hit.g} is not allowed (files.never_read).`, `${cmd[0]} ${hit.g}`);
      else if (ruleMatches('RK-EXF-003', reads) || ruleMatches('RK-EXF-004', reads)) add('files.read_secrets', policy.files.read_secrets, 'reading credentials or a password store is not allowed.', cmd.slice(0, 3).join(' '));
    }
  } else if (call.kind === 'read' && policy.files.read_secrets !== 'allow') {
    for (const p of call.paths) {
      const g = protectedPath(policy.files.never_read, p, cwd, home);
      if (g) add('files.read_secrets', policy.files.read_secrets, `${tilde(p, home)} matches files.never_read (${g}).`, p);
    }
  } else if (call.kind === 'mcp') {
    const allow = policy.mcp.allow.map((s) => s.toLowerCase());
    const tool = call.tool.toLowerCase();
    const server = call.server ?? policy.mcp.allow.find((a) => tool.startsWith(`mcp_${a.toLowerCase()}_`) || tool.startsWith(`mcp__${a.toLowerCase()}__`));
    if (!server || !allow.includes(server.toLowerCase())) add('mcp.unlisted', policy.mcp.unlisted, `the MCP server ${server ? `"${server}"` : 'behind this tool'} is not in mcp.allow.`, `${server ?? '?'} / ${call.tool}`);
  }
  return found.find((d) => d.action === 'deny') ?? found[0] ?? { action: 'pass' };
}

/** The agent-specific answer. Only a deny changes anything; warnings pass and go to the log. */
export function reply(agent: HookAgent, d: Decision): HookReply {
  const reason = d.reason ?? 'blocked by rookery policy';
  const out = (o: object): HookReply => ({ stdout: JSON.stringify(o) + '\n', stderr: '', exitCode: 0 });
  const none: HookReply = { stdout: '', stderr: '', exitCode: 0 };
  const deny = d.action === 'deny';
  switch (agent) {
    case 'claude-code':
    case 'codex':
      return deny ? out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) : none;
    case 'gemini':
      return deny ? out({ decision: 'deny', reason }) : none;
    case 'cursor':
      // Cursor blocks on a missing or invalid answer, so always answer; `allow` is what Cursor's own examples return.
      return out(deny ? { permission: 'deny', user_message: reason, agent_message: reason } : { permission: 'allow' });
    case 'copilot':
      return deny ? out({ permissionDecision: 'deny', permissionDecisionReason: reason }) : none;
    case 'windsurf':
      return deny ? { stdout: '', stderr: reason + '\n', exitCode: 2 } : none;
  }
}

/** The nearest .rookery.yml at or above a folder, not past the repo root. */
export function findPolicyUp(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    for (const f of POLICY_FILES) if (existsSync(join(dir, f))) return join(dir, f);
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Append a deny or warn to ~/.rookery/decisions/YYYY-MM-DD.jsonl. ROOKERY_HOME moves it; ROOKERY_HOOK_LOG=0 turns it off. */
export function logDecision(agent: HookAgent, call: Call, d: Decision, policyFile: string | null, env: NodeJS.ProcessEnv = process.env): void {
  if (d.action === 'pass' || env.ROOKERY_HOOK_LOG === '0') return;
  const dir = join(env.ROOKERY_HOME ?? join(homedir(), '.rookery'), 'decisions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const entry = { ts: now, agent, kind: call.kind, decision: d.action, rule: d.ruleId, key: d.key, subject: d.subject, repo: policyFile ? basename(dirname(policyFile)) : undefined };
  appendFileSync(join(dir, `${now.slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export interface HookOptions {
  policyFile?: string;          // --policy: use this file instead of looking for one
  cwd?: string;                 // the hook process's folder (default process.cwd())
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** The whole hook: parse, find the policy, decide, log, answer. Any failure denies. */
export function runHook(agent: HookAgent, stdin: string, opts: HookOptions = {}): HookReply {
  const env = opts.env ?? process.env;
  let call: Call = { kind: 'other' };
  let file: string | null = null;
  try {
    const input: unknown = JSON.parse(stdin);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('hook input is not a JSON object');
    call = parseCall(agent, input as Input);
    // The project the hook was installed in comes first, so a policy file dropped elsewhere can't loosen it.
    const starts = some(env.CLAUDE_PROJECT_DIR, env.GEMINI_PROJECT_DIR, env.CURSOR_PROJECT_DIR, call.cwd, opts.cwd ?? process.cwd());
    file = opts.policyFile ? resolve(opts.cwd ?? process.cwd(), opts.policyFile) : null;
    for (const s of starts) { if (file) break; file = findPolicyUp(s); }
    if (!file) return reply(agent, { action: 'pass' });
    const policy = parsePolicy(readFileSync(file, 'utf8'), file);
    const d = evaluate(call, policy, { home: opts.home, cwd: opts.cwd });
    try { logDecision(agent, call, d, file, env); } catch { /* the log never changes the decision */ }
    return reply(agent, d);
  } catch (err) {
    const d: Decision = { action: 'deny', reason: `rookery hook failed, so this call is blocked (fail closed): ${(err as Error).message.split('\n')[0]}`, subject: 'hook error' };
    try { logDecision(agent, call, d, file, env); } catch { /* ignore */ }
    return reply(agent, d);
  }
}
