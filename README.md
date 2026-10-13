<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/rookery-wordmark-bone.svg">
    <img alt="rookery." src=".github/assets/rookery-wordmark-ink.svg" width="280">
  </picture>
</p>

<h3 align="center">Find every AI agent skill in your repos.<br>Spot the duplicates. Catch the risky ones.</h3>

<p align="center">
  <a href="https://github.com/thinkingraven/rookery/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/thinkingraven/rookery/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@thinkingraven/rookery"><img alt="npm" src="https://img.shields.io/npm/v/@thinkingraven/rookery?color=F2A93B&label=npm"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-0F0F14">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-0F0F14"></a>
</p>

<p align="center">
  Claude Code · Codex · Cursor · GitHub Copilot · Gemini CLI · Windsurf · MCP · skillshare · npx skills
</p>

<p align="center">
  <img src=".github/assets/terminal.png" width="860" alt="rookery scanning six repos: an inventory of 21 agent artifacts, bars of what teams keep building, three near-duplicate clusters across Codex, Claude Code, Copilot and Cursor, and security findings including hidden Unicode and secrets sent to a webhook">
</p>

---

Every team ends up writing its own *review my PR*, *write a commit message* and *deploy to staging* skill: for Claude Code in one repo, Cursor in another, Copilot in a third. Nobody knows how many there are, which one is best, or which one quietly pipes environment variables to a webhook or tells the agent to skip approval prompts.

**rookery** gives you that picture in one command. It runs locally, takes about a second, and never uploads anything.

## Quick start

```bash
npx @thinkingraven/rookery scan .                         # one repo
npx @thinkingraven/rookery scan ~/code                    # a folder of many repos
npx @thinkingraven/rookery scan ~/code --html report.html # a shareable report
npx @thinkingraven/rookery scan --local                   # your own machine (~/.claude, ~/.agents, skillshare…)
```

Or install it: `npm install -g @thinkingraven/rookery`, then run `rookery scan .`. Node 20 or newer.

## What you get

| | |
|---|---|
| **Inventory** | Every skill, command, subagent, rules file, settings file, hook and MCP server, with its agent, purpose and size in tokens. |
| **What teams keep building** | Artifacts grouped by purpose (code review, testing, commits, deployment…) and how many repos have one. A tall bar across many repos is your best candidate for one shared, reviewed skill. |
| **Near-duplicates** | Copy-pasted and lightly edited skills clustered across repos *and* across agents. A Cursor rule, a Claude skill and a Copilot prompt can be the same thing. |
| **Where skills come from** | Skills installed by [skillshare](https://github.com/runkids/skillshare) or `npx skills`: the source repo and commit, which tools each one is linked into, and which ones were **edited since install**. Symlinks and synced copies count once, not as duplicates. |
| **Security findings** | 27 static checks on skill text, bundled scripts and agent config: secrets, exfiltration, prompt injection, hidden Unicode, harness overrides, piped installs, risky hooks, broad permissions and MCP servers. |

Add `--html report.html` for a self-contained report you can send to your team:

<p align="center">
  <img src=".github/assets/report.png" width="860" alt="rookery HTML report: summary tiles, what teams keep building bars and near-duplicate cards">
</p>

## What it finds

| Agent | Files |
|---|---|
| **Claude Code** | `.claude/skills/*/SKILL.md`, `.claude/commands/`, `.claude/agents/`, `.claude/settings*.json` (hooks, permissions), `CLAUDE.md`, `.mcp.json`, `.claude-plugin/` |
| **Claude Code plugins** | every folder with `.claude-plugin/plugin.json` or listed in a `marketplace.json`: its `agents/`, `commands/`, `hooks/hooks.json`, skills and MCP servers, plus agent and command paths the manifest declares |
| **Codex** | `AGENTS.md`, `.codex/config.toml` (MCP servers), `.codex/prompts/`, `.codex/skills/` |
| **Cursor** | `.cursor/rules/*.mdc`, `.cursorrules`, `.cursor/commands/`, `.cursor/skills/`, `.cursor/mcp.json` |
| **GitHub Copilot** | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`, `.github/chatmodes/`, `.github/agents/`, `.vscode/mcp.json` |
| **Gemini CLI** | `GEMINI.md`, `.gemini/settings.json`, `.gemini/commands/`, `.gemini/skills/` |
| **Windsurf** | `.windsurfrules`, `.windsurf/rules/`, `.windsurf/workflows/` |
| **skillshare** | `~/.config/skillshare/` and a project's `.skillshare/` (or `skillshare/`): skills (including tracked repos), agents, extras (rules, commands), and MCP servers in `config.yaml` / `mcp.yaml`. Install records (`.metadata.json`, `skills.lock.json`, `.skillshare-manifest.json`) give each skill's source, commit and local edits |
| **npx skills** | `.agents/skills/` with `.agents/.skill-lock.json` for install sources |
| **Agent Skills** | any `SKILL.md` folder, including the scripts and references bundled next to it |
| **Catalogues** | collections that publish files outside the folders an agent loads them from are recognised by frontmatter: `.mdc` files with `globs`/`alwaysApply` (Cursor rules), `.md` files with `name`, `description` and `tools` or `model` (subagents), and `.md` files with `argument-hint` (commands) |

Point it at one repo or a folder of many. Each nested `.git` counts as its own repo, and repos with no agent files are counted too (a catalogue layout is the usual reason). Linked git worktrees (such as Claude Code's `.claude/worktrees/`) are skipped, so branch checkouts don't show up as duplicates; pass `--worktrees` to include them.

Skill managers install by symlink, so rookery follows symlinks inside agent folders (with a loop guard) and reports each real skill once, listing every tool it's linked into. `--local` adds your user-level folders: `~/.claude`, `~/.agents`, `~/.codex`, `~/.cursor`, `~/.gemini` and `~/.config/skillshare`.

## Security rules

| Family | Rules | Examples |
|---|---|---|
| Secrets | `RK-SEC-001…003` | private keys, AWS/GitHub/Slack/OpenAI/Anthropic/Google/GitLab tokens, hard-coded secrets |
| Exfiltration | `RK-EXF-001…004` | `env \| curl`, webhook and paste services, reading `~/.aws/credentials`, sweeping password managers, the keychain, browser profiles or other projects' `.env` files |
| Prompt injection | `RK-INJ-001…004` | "ignore previous instructions", zero-width and bidi characters, instructions in HTML comments, "the user must never see…" |
| Unsafe execution | `RK-EXE-001…005` | `curl \| sh`, `rm -rf ~`, base64-to-shell, `--dangerously-skip-permissions`, `sudo` |
| Supply chain | `RK-SUP-001…002` | download-and-run binaries, unpinned global installs |
| Hooks and permissions | `RK-HOOK-*`, `RK-PRM-*` | hooks that call the network, `Bash(*)` allow-lists |
| MCP | `RK-MCP-001…003` | unpinned `npx` servers, plain-HTTP servers |

**[Full rule reference →](docs/rules.md)** (or run `rookery rules`).

### Confidence, not noise

Security skills and docs are full of attack examples. Rookery marks a finding **low confidence** when its context shows the pattern is being described rather than used: tests and fixtures, security reference docs, Markdown tables, warning sentences ("never run `curl | sh`") and strings inside scanner code. Low-confidence findings are listed separately and don't fail CI unless you pass `--strict`.

Secrets are masked in every report (`phc_…mpx`), and the JSON report never includes file contents.

To accept a reviewed line, add `rookery-ignore` or `rookery-ignore RK-EXE-001` on the line or the line above. Markers from `gitleaks`, `trufflehog`, `nosec`, `noqa` and `security-allowlist` are honoured too.

## Use it in CI

### GitHub Action

```yaml
# .github/workflows/rookery.yml
name: rookery
on: [pull_request]
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: thinkingraven/rookery@v0
        with:
          fail-on: high              # critical | high | medium | low | '' (never fail)
          html: rookery-report.html  # optional
```

The findings land in the job summary. Inputs: `path` (default `.`), `fail-on` (default `high`), `html`, `sarif`, `policy`, and `args` for any other options (for example `--strict`). With a `.rookery.yml` at the repo root (or `policy:` set), the action runs `rookery check` and the policy decides what fails.

### GitHub code scanning

Write SARIF and upload it, and findings show up as alerts in the repo's **Security** tab and as annotations on pull requests:

```yaml
# .github/workflows/rookery.yml
name: rookery
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
  security-events: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: thinkingraven/rookery@v0
        with:
          fail-on: high
          sarif: rookery.sarif
      - uses: github/codeql-action/upload-sarif@v4
        if: always()               # upload even when fail-on stops the job
        with:
          sarif_file: rookery.sarif
          category: rookery
```

Code scanning shows each rule's severity (critical, high, medium, low) and links to its entry in [docs/rules.md](docs/rules.md). Low-confidence findings (examples, docs, tests) are left out of the SARIF unless you pass `--strict`, so they don't open alerts. Any other SARIF viewer works too: `npx -y @thinkingraven/rookery scan . --sarif rookery.sarif`.

### Anywhere else

```bash
npx -y @thinkingraven/rookery scan . --fail-on high --md rookery.md
```

Exit codes: `0` OK · `1` high-confidence findings at or above `--fail-on` · `2` usage error.

## Options

| Option | Default | Description |
|---|---|---|
| `--format <terminal\|json\|markdown\|sarif>` | `terminal` | Output on stdout |
| `--html <file>` · `--json <file>` · `--md <file>` · `--sarif <file>` | | Also write a report file |
| `--fail-on <severity>` | | Exit 1 on high-confidence findings at or above `critical`, `high`, `medium` or `low` |
| `--strict` | off | Count low-confidence findings for `--fail-on` too, and include them in SARIF |
| `--threshold <0-1>` | `0.5` | Near-duplicate similarity (Jaccard over word 3-grams) |
| `--max-file-size <kb>` | `512` | Skip larger files |
| `--local` | off | Also scan your user-level agent folders (`~/.claude`, `~/.agents`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.config/skillshare`) |
| `--worktrees` | off | Also scan linked git worktrees |
| `--info` | off | Include info-level findings |
| `--verbose` | off | Show everything in the terminal |
| `--no-color` | | Disable colour (`NO_COLOR` and `FORCE_COLOR` are respected) |

## How it works

```mermaid
flowchart LR
  A[Walk folders] --> B[Classify agent files by path]
  B --> C[Parse frontmatter, settings, hooks, MCP, bundled scripts]
  C --> D[Purpose taxonomy]
  C --> E[MinHash + LSH near-duplicates]
  C --> F[27 rules + confidence]
  D & E & F --> G[Terminal · JSON · Markdown · HTML · SARIF]
```

- **Discovery** skips `node_modules`, build output, trash and worktrees, and finds repo boundaries from `.git`. A skill or agent folder named like build output (`skills/build/`, `skills/coverage/`) is still scanned.
- **Duplicates** hash word 3-grams into MinHash signatures, bucket them with locality-sensitive hashing, and confirm every candidate pair with exact Jaccard similarity, so it stays fast across thousands of files.
- **Rules** are regular expressions and structured checks. Nothing is executed.

## Privacy

- Runs entirely on your machine and makes no network requests.
- Reads files; never executes, modifies or uploads them.
- Reports mask secrets; the JSON report omits file contents.

## FAQ

<details>
<summary><b>How is this different from gitleaks or trufflehog?</b></summary>

Secret scanners look for credentials in all of your code. Rookery understands agent files: which skills exist, which agent loads them, which ones are duplicates, and agent-specific risks such as prompt injection, hidden Unicode, hooks, permission allow-lists, approval bypasses and MCP servers. Use both.
</details>

<details>
<summary><b>My security skill is full of findings.</b></summary>

Skills that teach security quote attacks. Most of those land as low confidence and are hidden from the summary. If one still shows as high confidence, add `rookery-ignore RK-XXX-000` after reviewing it, or [report a false positive](https://github.com/thinkingraven/rookery/issues/new?template=false-positive.yml).
</details>

<details>
<summary><b>I use skillshare (or npx skills). Does rookery replace it?</b></summary>

No. Those tools install and sync skills on one machine; rookery is the inventory and review layer across every repo and machine, whatever installed the skills. Rookery reads their install records to show where each skill came from and whether it was edited since install, and it never runs them.
</details>

<details>
<summary><b>Can it scan a whole GitHub organisation?</b></summary>

Today it scans local folders, so clone the repos first (for example with `gh repo list ORG --json name -q '.[].name' | xargs -I{} gh repo clone ORG/{}`). A built-in `--github-org` option is on the roadmap.
</details>

## Policy: `rookery check`

`scan` tells you what's there. `check` tells you whether it's **allowed**. Write what agents may do into `.rookery.yml`, and `check` fails CI when a skill, command, settings file or MCP config breaks it. The same policy covers Claude Code, Codex, Cursor, Copilot, Gemini CLI and Windsurf.

```bash
npx @thinkingraven/rookery policy init     # starter .rookery.yml (strict | balanced | solo)
npx @thinkingraven/rookery check           # exit 1 if the policy fails
```

```yaml
version: 1
extends: balanced
approvals: { bypass: forbid }          # --dangerously-skip-permissions, --yolo, approval_policy = "never"…
shell: { any_command: forbid }         # bare Bash / Bash(*)
mcp: { unpinned: forbid, unlisted: forbid, allow: [github] }
files: { never_read: ["~/.ssh/**", "**/.env"] }
exceptions:
  - path: .claude/skills/deploy/**
    rules: [shell.any_command]
    reason: "Reviewed by @platform"
    expires: 2026-12-31
```

- **No policy file yet?** `check` shows what the balanced preset would flag, as warnings only.
- **In CI:** the GitHub Action runs `check` automatically when the repo has a `.rookery.yml`.
- **For each setting:** it also prints whether each agent in the repo can enforce that rule itself, from the capability matrix.

Full reference: [docs/policy.md](docs/policy.md).

## What can each agent enforce?

[docs/agent-capabilities.md](docs/agent-capabilities.md) compares Claude Code, Codex, Gemini CLI, OpenCode, Cursor, GitHub Copilot and Windsurf on 16 controls: allow/deny/ask rules, read and write limits, network, sandbox, bypass modes and admin lockout, MCP allow-lists, blocking hooks, managed policy, and whether a cloned repo's own config takes effect. Every cell links to the docs or source it came from.

## Roadmap

- `--github-org <org>` to scan an organisation without cloning by hand
- `rookery policy apply`: compile `.rookery.yml` into each agent's own config. What each agent can enforce today: [docs/agent-capabilities.md](docs/agent-capabilities.md)
- Match local skills against well-known public skills
- A registry to publish, review, distribute and measure the skills rookery finds

## Contributing

Bug reports, false positives and new agent layouts are very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © [Thinking Raven](https://thinkingraven.com)
