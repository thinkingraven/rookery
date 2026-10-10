import type { Artifact, Finding, Severity } from './types.js';

export interface RuleMeta {
  id: string;
  severity: Severity;
  title: string;
  why: string;
  remediation: string;
}

interface TextRule extends RuleMeta {
  re: RegExp;              // tested line by line unless `multiline`
  multiline?: boolean;
  exclude?: RegExp;        // matched text that should NOT count (placeholders etc.)
  validate?: (match: string) => boolean; // extra check on the matched text
}

/** Real tokens contain digits and character variety; examples and placeholders don't. */
function realToken(match: string): boolean {
  const t = match.replace(/^[^A-Za-z0-9]+/, '');
  if (/example|test|dummy|fake|sample|placeholder|xxxx|redacted/i.test(t)) return false;
  const body = t.replace(/^(?:AKIA|gh[pousr]_|github_pat_|xox[baprs]-|sk-ant-|sk-proj-|sk-|AIza|glpat-)/, '');
  return /\d/.test(body) && new Set(body).size >= 10;
}

const TEXT_RULES: TextRule[] = [
  { id: 'RK-SEC-001', severity: 'critical', title: 'Private key in an agent file', multiline: true, re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[ \t]*\r?\n[ \t]*[A-Za-z0-9+/=]{40,}/g,
    why: 'Anyone who can read the skill can use this key.', remediation: 'Remove the key, rotate it, and load it from a secret manager at runtime.' },
  { id: 'RK-SEC-002', severity: 'critical', title: 'Access token in an agent file', validate: realToken, re: /(?<![A-Za-z0-9_-])(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})/,
    why: 'Tokens in skills get copied into every repo and every agent context that loads them.', remediation: 'Revoke the token now, then reference it through an environment variable or secret manager.' },
  { id: 'RK-SEC-003', severity: 'high', title: 'Hard-coded secret value', re: /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i,
    exclude: /your|example|placeholder|xxxx|changeme|change[-_]?me|change[-_]in|replace|dummy|sample|fake|test|dev(?:elopment)?[-_]|local|redacted|todo|keyvault|1234|abcdef|<|\$\{|\{\{|\*\*\*/i,
    validate: (m) => { const v = /["']([^"']+)["']\s*$/.exec(m)?.[1] ?? ''; return /\d/.test(v) && /[A-Za-z]/.test(v) && new Set(v).size >= 10; },
    why: 'Literal secrets in instructions or scripts leak through version control and model context.', remediation: 'Replace the literal with an environment variable and rotate the value.' },
  { id: 'RK-EXE-001', severity: 'high', title: 'Remote script piped to a shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
    why: 'The agent runs whatever the remote server returns, with your user\'s permissions.', remediation: 'Pin a checksum-verified installer, or vendor the script into the repo.' },
  { id: 'RK-EXE-002', severity: 'high', title: 'Destructive delete of home or root', re: /\brm\s+-[rRfF]{2,}\s+(?:\/(?=\s|$)|\/\*|~(?=[\s/]|$)|\$HOME\b|"\$HOME")/,
    why: 'One bad expansion wipes the developer\'s machine.', remediation: 'Delete only explicit, project-relative paths, and confirm with the user first.' },
  { id: 'RK-EXE-003', severity: 'high', title: 'Obfuscated code execution', re: /(?:base64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:ba|z)?sh|\beval\s+"?\$\(\s*(?:curl|wget|echo\s+["']?[A-Za-z0-9+/=]{40,}|base64|printf\s+["']\\x)|python3?\s+-c\s+["'][^"']*\bexec\(|\becho\s+["']?[A-Za-z0-9+/=]{60,}["']?\s*\|\s*base64)/,
    why: 'Encoded payloads hide what the agent will actually run from reviewers.', remediation: 'Replace with readable commands so reviewers and scanners can see the behaviour.' },
  { id: 'RK-EXE-004', severity: 'high', title: 'Agent permission checks bypassed', re: /(--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo\b|bypassPermissions|approval_policy\s*=\s*"never"|sandbox_mode\s*=\s*"danger-full-access")/,
    why: 'Turns off the human-in-the-loop safety net for every command the agent runs.', remediation: 'Remove the bypass; grant narrow, explicit permissions instead.' },
  { id: 'RK-EXE-005', severity: 'medium', title: 'Runs commands with sudo', re: /(?<![\w-])sudo\s+[a-z]/,
    why: 'Agent-driven root access magnifies the impact of any mistake or injection.', remediation: 'Avoid sudo in skills; document a manual setup step instead.' },
  { id: 'RK-EXF-001', severity: 'critical', title: 'Environment or secrets sent over the network',
    re: /(?:\b(?:env|printenv)\b\s*\|\s*(?:curl|wget|nc)\b|\b(?:curl|wget)\b[^\n]*(?:\s-d\s|--data(?:-binary|-raw|-urlencode)?\b|\s-F\s|--form\b|--post-data)[^\n]*\$(?:\(|\{)?(?:env\b|printenv\b|[A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)\b)|\$\{?[A-Z_]*(?:TOKEN|SECRET|API_KEY)\}?[^\n]*\|\s*(?:curl|nc)\b)/,
    why: 'Classic exfiltration: credentials leave the machine on the agent\'s behalf.', remediation: 'Remove the call. Never send environment variables or secrets to external endpoints.' },
  { id: 'RK-EXF-002', severity: 'high', title: 'Data sent to a capture or paste service',
    re: /\b(?:webhook\.site|requestbin\.(?:com|net)|pipedream\.net|ngrok(?:-free)?\.(?:io|app|dev)|pastebin\.com|transfer\.sh|hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks|interact\.sh|burpcollaborator\.net|oast\.(?:pro|live|site|fun|me))/i,
    why: 'These endpoints are common exfiltration sinks and rarely belong in shared skills.', remediation: 'Remove the endpoint or replace it with an approved internal service.' },
  { id: 'RK-EXF-003', severity: 'high', title: 'Reads credential files', re: /(?:\bcat|\bless|\bhead|\btail|\bcp|\bscp|\brsync|\bbase64|\bxxd|\bopen\(|readFileSync\(|readFile\(|read_text\(|Get-Content|\bupload|\bsend)\b[^\n]{0,80}(?:(?:~|\$HOME|\$\{HOME\}|os\.homedir\(\))\/?\.(?:ssh\/(?:id_[a-z0-9]+|config)|aws\/credentials|npmrc|netrc|pypirc|docker\/config\.json|kube\/config|config\/gh\/hosts\.yml)|\bid_(?:rsa|ed25519|ecdsa)\b)/,
    why: 'Skills rarely need credential files; reading them is a precursor to theft.', remediation: 'Use the official CLI or SDK auth flow instead of reading credential files directly.' },
  { id: 'RK-INJ-001', severity: 'high', title: 'Prompt-injection phrasing',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions|prompts?|rules|messages|guidelines)|\byou\s+are\s+no\s+longer\s+(?:bound|restricted|limited|subject|required|an?\s+(?:ai|assistant|language\s+model)|claude|chatgpt)\b|\bdo\s+not\s+(?:tell|inform|alert|notify)\s+the\s+user\s+(?:about|what\s+you|that\s+you|you\b|of\b)|\b(?:run|execute|delete|remove|send|upload|push|install|overwrite|deploy)\b[^.\n]{0,60}\bwithout\s+(?:asking|telling|notifying|informing)\s+the\s+user\b|(?<!\b(?:not|never|don'?t)\s+)\b(?:silently|secretly)\s+(?:run|execute|send|upload|delete)\b/i,
    why: 'Instructions that override the agent or hide actions from the user are a hallmark of malicious skills.', remediation: 'Remove the phrasing. Skills should never ask the agent to hide actions or override its instructions.' },
  { id: 'RK-INJ-003', severity: 'medium', title: 'Instructions hidden in an HTML comment', multiline: true,
    re: /<!--(?:(?!-->)[\s\S]){0,1200}?(?:\b(?:ignore|disregard)\b[^>]{0,60}\b(?:instructions?|previous|above|prior)\b|system prompt|\byou are now\b|\bdo not (?:tell|mention|reveal|inform)\b|\b(?:curl|wget|exfiltrat\w*|upload)\b|\bsend (?:the|all|your|every)\b)(?:(?!-->)[\s\S]){0,1200}?-->/gi,
    why: 'HTML comments are invisible in rendered Markdown but fully visible to the model.', remediation: 'Move real instructions into visible text, or delete the comment.' },
  { id: 'RK-SUP-001', severity: 'high', title: 'Downloads and runs a binary', re: /\b(?:curl|wget)\b[^\n]*(?:\s-o\s|\s-O\b|--output\b)\s*\S*[^\n]*(?:&&|;)\s*(?:chmod\s+\+x|\.\/|sh\s|bash\s)/,
    why: 'Unverified downloads executed by the agent are a supply-chain risk.', remediation: 'Install from a package manager with pinned versions, or verify a checksum before running.' },
  { id: 'RK-SUP-002', severity: 'low', title: 'Global or unpinned package install', re: /\b(?:npm\s+(?:i|install)\s+(?:-g|--global)\b|pip3?\s+install\s+(?!-r\b|-e\b|\.|needed\b|required\b|necessary\b)[a-z][\w.-]*(?![=<>~]=)(?:\s|$)|pipx\s+install\b|gem\s+install\b)/i,
    exclude: /\bno\s+(?:pip|npm)\s+install/i,
    why: 'Unpinned installs change underneath you and can pull in compromised releases.', remediation: 'Pin exact versions, or use a lockfile.' },
];

const META_RULES: RuleMeta[] = [
  { id: 'RK-INJ-002', severity: 'critical', title: 'Hidden Unicode characters', why: 'Zero-width, bidirectional and tag characters can smuggle instructions that humans cannot see.', remediation: 'Strip the characters and review the file in a hex-aware editor.' },
  { id: 'RK-HOOK-001', severity: 'high', title: 'Hook makes network calls', why: 'Hooks run automatically on agent events, so a network call here runs without anyone asking.', remediation: 'Keep hooks local (formatters, linters). Move network work into explicit, reviewed commands.' },
  { id: 'RK-HOOK-002', severity: 'info', title: 'Hooks configured', why: 'Hooks execute shell commands automatically; they deserve review.', remediation: 'Review each hook command and keep the list short.' },
  { id: 'RK-PRM-001', severity: 'medium', title: 'Skill allows any shell command', why: 'Unrestricted Bash access means one bad instruction can do anything the user can.', remediation: 'Scope allowed-tools to specific commands, e.g. Bash(git diff:*).' },
  { id: 'RK-PRM-002', severity: 'high', title: 'Settings allow any shell command', why: 'A wildcard Bash permission applies to every session in the repo.', remediation: 'Replace the wildcard with narrow, explicit command patterns.' },
  { id: 'RK-MCP-001', severity: 'medium', title: 'Unpinned MCP server package', why: 'npx/uvx without a version runs whatever was published most recently, including a compromised release.', remediation: 'Pin an exact version, e.g. npx -y @scope/server@1.4.2.' },
  { id: 'RK-MCP-002', severity: 'high', title: 'MCP server over plain HTTP', why: 'Traffic, including tool inputs and tokens, travels unencrypted.', remediation: 'Use https://, or a local stdio server.' },
  { id: 'RK-MCP-003', severity: 'info', title: 'Remote MCP server', why: 'Tool calls and their data leave your network.', remediation: 'Confirm the vendor is approved and the data classification allows it.' },
  { id: 'RK-QLT-001', severity: 'low', title: 'Skill has no description', why: 'Agents decide when to load a skill from its description; without one it is rarely used.', remediation: 'Add a one-sentence description to the frontmatter saying what it does and when to use it.' },
  { id: 'RK-QLT-002', severity: 'info', title: 'Very large agent file', why: 'Large always-on files consume context on every request.', remediation: 'Split into smaller skills that load on demand.' },
];

export const ALL_RULES: RuleMeta[] = [...TEXT_RULES, ...META_RULES].sort((a, b) => a.id.localeCompare(b.id));
const META = Object.fromEntries(META_RULES.map((r) => [r.id, r]));

const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], index: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

/** Lines suppressed by `rookery-ignore` (all rules) or `rookery-ignore RK-XXX-000` on the same or previous line. */
function suppressions(lines: string[]): Map<number, Set<string> | 'all'> {
  const out = new Map<number, Set<string> | 'all'>();
  lines.forEach((l, i) => {
    const m = /rookery-ignore(?::?\s+((?:RK-[A-Z]+-\d{3}[\s,]*)+))?/.exec(l);
    if (!m) {
      // Respect other scanners' allow-markers too (secrets/static-analysis tools).
      if (/\b(?:noqa|nosec|gitleaks:allow|trufflehog:ignore|pragma:\s*allowlist secret|handoff:allow)\b/i.test(l)) for (const ln of [i + 1, i + 2]) out.set(ln, 'all');
      return;
    }
    const ids = m[1] ? new Set(m[1].split(/[\s,]+/).filter(Boolean)) : 'all';
    for (const ln of [i + 1, i + 2]) out.set(ln, ids);
  });
  return out;
}

/** Show only the ends of anything that looks like a secret: "phc_zjjb…pmx". */
const mask = (s: string) => s.replace(/[A-Za-z0-9_\-/+=]{16,}/g, (t) => (/[0-9]/.test(t) && /[A-Za-z]/.test(t) ? `${t.slice(0, 4)}…${t.slice(-3)}` : t));

const clip = (s: string) => {
  const t = s.replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '⟨?⟩').replace(/[\u{E0000}-\u{E007F}]/gu, '⟨?⟩').trim();
  return t.length > 160 ? t.slice(0, 157) + '…' : t;
};

function scanText(text: string, relPath: string, art: Artifact, push: (f: Omit<Finding, 'artifactId' | 'repo' | 'confidence'>, assessText?: string) => void) {
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const sup = suppressions(lines);
  const allowed = (line: number, id: string) => {
    const s = sup.get(line);
    return !(s === 'all' || (s && s.has(id)));
  };

  for (const rule of TEXT_RULES) {
    if (rule.multiline) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text))) {
        const line = lineOf(starts, m.index);
        if ((!rule.validate || rule.validate(m[0])) && allowed(line, rule.id)) push({ ruleId: rule.id, severity: rule.severity, title: rule.title, message: rule.why, relPath, line, snippet: clip(m[0].split('\n').slice(0, 2).join(' ')), remediation: rule.remediation });
      }
      continue;
    }
    lines.forEach((l, i) => {
      const m = rule.re.exec(l);
      if (!m || (rule.exclude && rule.exclude.test(m[0])) || (rule.validate && !rule.validate(m[0])) || !allowed(i + 1, rule.id)) return;
      // For injection phrases, judge the surrounding words (the phrase itself may contain "do not").
      const quoted = new RegExp(`["'“‘\`]\\s*${m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(l);
      const around = rule.id.startsWith('RK-INJ') ? (quoted ? `e.g. ${l}` : l.replace(new RegExp(rule.re.source, rule.re.flags.replace('g', '') + 'g'), ' ')) : undefined;
      push({ ruleId: rule.id, severity: rule.severity, title: rule.title, message: rule.why, relPath, line: i + 1, snippet: clip(l), remediation: rule.remediation }, around);
    });
  }

  // Hidden Unicode (ignore a single BOM at the very start of the file).
  lines.forEach((l, i) => {
    const probe = i === 0 ? l.replace(/^﻿/, '') : l;
    if (HIDDEN.test(probe) && allowed(i + 1, 'RK-INJ-002')) {
      const r = META['RK-INJ-002'];
      push({ ruleId: r.id, severity: r.severity, title: r.title, message: r.why, relPath, line: i + 1, snippet: clip(l), remediation: r.remediation });
    }
  });
  void art;
}

function findLine(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  return idx === -1 ? 1 : text.slice(0, idx).split('\n').length;
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|fixtures?|examples?|samples?|testdata|spec|mocks?)\/|(?:^|\/|[._-])(?:test|spec|example|sample|fixture|mock)s?[._-][^/]*$/i;
const DOC_WARNING = /(?:\be\.g\.|\bfor example\b|\bexample:|\bsuch as\b|\bnever\b|\bdon'?t\b|\bdo not\b|\bavoid\b|\bbad:|\banti-?pattern\b|\bdangerous\b|\bmalicious\b|\battacker\b|\bthreat\b|\bdetects?\b|\bflag(?:s|ged)?\b|\bblocks?\b|\binstead of\b)/i;
const SECURITY_DOC = /(?:threat|attack|vuln|security|audit|redact|scanner|antipattern|injection)[^/]*\.mdx?$/i;
const PATTERN_CODE = /\b(?:regex|pattern|re\.compile|RegExp|rule|signature|payload|PATTERNS?)\b/;
const ALWAYS_HIGH = new Set(['RK-INJ-002', 'RK-HOOK-001', 'RK-HOOK-002', 'RK-PRM-001', 'RK-PRM-002', 'RK-MCP-001', 'RK-MCP-002', 'RK-MCP-003', 'RK-QLT-001', 'RK-QLT-002']);

/** Lower confidence when context shows the pattern is described, tested or warned about rather than used. */
function assess(ruleId: string, relPath: string, snippet: string, around = snippet): { confidence: 'high' | 'low'; context?: string } {
  if (ALWAYS_HIGH.has(ruleId)) return { confidence: 'high' };
  const isDoc = /\.(?:md|mdx|mdc|txt)$/i.test(relPath);
  const isCode = /\.(?:py|js|mjs|cjs|ts|rb|go|java|rs)$/i.test(relPath);
  if (TEST_PATH.test(relPath)) return { confidence: 'low', context: 'test, fixture or example file' };
  if (isDoc && SECURITY_DOC.test(relPath)) return { confidence: 'low', context: 'security reference document' };
  if (/^\s*\|/.test(snippet)) return { confidence: 'low', context: 'documentation table' };
  if (DOC_WARNING.test(around) || /\b(?:data|content),?\s+(?:not|never)\s+instructions\b/i.test(around)) return { confidence: 'low', context: 'described as an example or warning' };
  if (isCode && (PATTERN_CODE.test(snippet) || /^\s*[rbf]?["'`]/.test(snippet))) return { confidence: 'low', context: 'string or pattern inside scanner code' };
  if (isDoc && ruleId === 'RK-EXE-005') return { confidence: 'low', context: 'setup instructions in documentation' };
  return { confidence: 'high' };
}

const PKG_RUNNERS = new Set(['npx', 'uvx', 'bunx', 'pnpx']);

function unpinnedPackage(cmd?: string, args: string[] = []): string | null {
  if (!cmd) return null;
  const bin = cmd.split('/').pop() ?? cmd;
  let rest = args;
  if (bin === 'pnpm' || bin === 'yarn') { if (args[0] !== 'dlx') return null; rest = args.slice(1); }
  else if (!PKG_RUNNERS.has(bin)) return null;
  const pkg = rest.find((a) => !a.startsWith('-'));
  if (!pkg || pkg.startsWith('.') || pkg.startsWith('/')) return null;
  const at = pkg.lastIndexOf('@');
  const hasVersion = at > 0 && /\d/.test(pkg.slice(at + 1)) && !/latest|next/.test(pkg.slice(at + 1));
  return hasVersion ? null : pkg;
}

const BROAD_BASH = /^(?:\*|Bash|Bash\(\*\)|Bash\(\*:\*\)|Bash\(:\*\))$/;

/** Run every rule against one artifact (its own text, bundled files and structured config). */
export function runRules(art: Artifact): Finding[] {
  const findings: Finding[] = [];
  const push = (f: Omit<Finding, 'artifactId' | 'repo' | 'confidence'>, assessText?: string) =>
    findings.push({ ...f, snippet: f.ruleId.startsWith('RK-SEC') ? mask(f.snippet) : f.snippet, artifactId: art.id, repo: art.repo, ...assess(f.ruleId, f.relPath, f.snippet, assessText ?? f.snippet) });
  const meta = (id: string, line: number, snippet: string, relPath = art.relPath) => {
    const r = META[id];
    push({ ruleId: r.id, severity: r.severity, title: r.title, message: r.why, relPath, line, snippet: clip(snippet), remediation: r.remediation });
  };

  scanText(art.body, art.relPath, art, push);
  for (const b of art.bundled) scanText(b.content, b.relPath, art, push);

  for (const h of art.hooks) {
    const line = findLine(art.body, h.command);
    if (/\b(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet|Invoke-WebRequest|iwr)\b/.test(h.command)) meta('RK-HOOK-001', line, `${h.event}: ${h.command}`);
    else meta('RK-HOOK-002', line, `${h.event}: ${h.command}`);
  }

  if (art.kind === 'settings') {
    const broad = art.allowedTools.filter((t) => BROAD_BASH.test(t.trim()));
    if (broad.length) meta('RK-PRM-002', findLine(art.body, broad[0]), `permissions.allow: ${broad.join(', ')}`);
  } else if (art.allowedTools.some((t) => BROAD_BASH.test(t.trim()))) {
    meta('RK-PRM-001', findLine(art.body, 'allowed-tools') || 1, `allowed-tools: ${art.allowedTools.join(', ')}`);
  }

  for (const s of art.mcpServers) {
    const pkg = unpinnedPackage(s.command, s.args);
    if (pkg) meta('RK-MCP-001', findLine(art.body, pkg), `${s.name}: ${s.command} ${(s.args ?? []).join(' ')}`);
    if (s.url) {
      const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(s.url);
      if (s.url.startsWith('http://') && !local) meta('RK-MCP-002', findLine(art.body, s.url), `${s.name}: ${s.url}`);
      else if (!local) meta('RK-MCP-003', findLine(art.body, s.url), `${s.name}: ${s.url}`);
    }
  }

  if (art.kind === 'skill' && !String(art.frontmatter.description ?? '').trim()) meta('RK-QLT-001', 1, art.name);
  if (art.tokens > 5000 && (art.kind === 'rules' || art.kind === 'skill')) meta('RK-QLT-002', 1, `${art.tokens.toLocaleString('en-US')} tokens`);

  // One finding per rule per line is enough.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.ruleId}|${f.relPath}|${f.line}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
