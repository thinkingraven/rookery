# Policy: `rookery check` and `.rookery.yml`

`rookery scan` tells you what's there. `rookery check` tells you whether it's **allowed**. You write what agents may do in a repo into one file, `.rookery.yml`. `rookery check` scans the repo and fails, with exit code 1, when the agent files break the policy. It works the same for Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and Windsurf.

```bash
npx @thinkingraven/rookery policy init     # writes .rookery.yml (balanced preset)
npx @thinkingraven/rookery check           # scan + policy; exit 1 if the policy fails
```

Without a `.rookery.yml`, `check` shows what the `balanced` preset *would* flag, as warnings only, and always exits 0. So it's safe to try on any repo.

## The file

```yaml
version: 1
extends: balanced          # strict | balanced | solo

fail_on: high              # scan findings at or above this also fail the check (or none)

approvals:
  bypass: forbid           # forbid | warn | allow
shell:
  any_command: forbid
  deny: ["rm -rf", "git push --force"]   # written into each agent's deny rules by `policy apply`
mcp:
  unpinned: forbid
  unlisted: allow
  allow: [github, linear]
hooks:
  network: warn
files:
  read_secrets: forbid
  never_read: ["~/.ssh/**", "~/.aws/**", "~/.config/gh/**", "**/.env"]

drift: warn                # agent configs out of date with the policy, once `policy apply` is used

runtime:
  hooks: true              # `policy apply` installs `rookery hook`, which checks calls while agents run
  command: rookery         # optional: how hooks run rookery (default: npx -y @thinkingraven/rookery@<version>)

agents: [claude-code, cursor]   # optional: only judge these agents' files

exceptions:
  - path: .claude/skills/deploy/**
    rules: [shell.any_command]
    reason: "Deploy skill needs the full CLI; reviewed by @platform"
    expires: 2026-12-31
```

Every behaviour takes one of three values:
- `forbid` fails the check;
- `warn` reports it and still passes;
- `allow` ignores it.

Unknown keys and invalid values are errors, with exit code 2, so a typo can never quietly weaken a policy.

## Presets

| Setting | `strict` | `balanced` (default) | `solo` |
|---|---|---|---|
| `fail_on` | medium | high | none |
| `approvals.bypass` | forbid | forbid | warn |
| `shell.any_command` | forbid | forbid | warn |
| `mcp.unpinned` | forbid | forbid | warn |
| `mcp.unlisted` | forbid | allow | allow |
| `hooks.network` | forbid | warn | warn |
| `files.read_secrets` | forbid | forbid | warn |
| `files.never_read` | `~/.ssh/**`, `~/.aws/**`, `~/.config/gh/**`, `**/.env` | same | same |
| `shell.deny` | none | none | none |
| `drift` | forbid | warn | allow |

`strict` forbids every MCP server that isn't in `mcp.allow`, so list the ones you use.

## Rules

### `approvals.bypass`

**RK-POL-001.** Agent files that switch off approval prompts or the sandbox: `--dangerously-skip-permissions`, `bypassPermissions`, `--yolo`, `--approval-mode yolo`, `--allow-all-tools`, `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`. Built on scan rule `RK-EXE-004`.

### `shell.any_command`

**RK-POL-002.** A bare `Bash` / `Bash(*)` in agent settings, or in a skill's or command's `allowed-tools`. A subagent's `tools:` list restricts it, so it doesn't count. Built on `RK-PRM-001` and `RK-PRM-002`.

### `mcp.unpinned`

**RK-POL-003.** An `npx`, `uvx` or `bunx` MCP server without an exact version. Built on `RK-MCP-001`.

### `mcp.unlisted`

**RK-POL-004.** An MCP server whose name isn't in `mcp.allow` (the match ignores case). It covers every MCP config rookery reads: `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.codex/config.toml`, Gemini settings and plugin manifests.

### `hooks.network`

**RK-POL-005.** A hook that calls `curl`, `wget`, `ssh` and the like. It covers settings files and plugin `hooks.json`. Built on `RK-HOOK-001`.

### `files.read_secrets`

**RK-POL-006.** Agent instructions, or the scripts bundled with them, that read credentials:
- credential files and password-manager or keychain sweeps (`RK-EXF-003`, `RK-EXF-004`);
- any path in `files.never_read`. These match on a read command plus the path, and examples or warnings in docs don't count.

`never_read` patterns:
- `~/x/**`: anything under `~/x/`, also written as `$HOME/x/`.
- `**/name`: a file called `name` anywhere. `**/.env` doesn't match `.env.example`.
- `*` and `?`: wildcards within one path segment.

Public keys (`*.pub`) are never treated as secrets.

### `drift`

**RK-POL-007.** After `rookery policy apply --write`, the agent configs it wrote must keep matching the policy. `check` reports any file that `apply` would now create, change or delete, for example when someone deletes a deny rule or edits the policy without re-applying. It only applies once `.rookery/applied.json` exists.

## Exceptions

Exceptions live only in `.rookery.yml`, so every one is reviewed in one place.

| Field | |
|---|---|
| `path` | Glob relative to the repo root (`**`, `*`, `?`). A folder covers everything inside it. |
| `rules` | Policy settings (`shell.any_command`), policy rule ids (`RK-POL-002`) or scan rule ids (`RK-EXE-001`). An exception for a policy rule also covers the scan finding behind it, so `fail_on` doesn't count it either. |
| `reason` | Required. Why this is acceptable. |
| `expires` | Optional `YYYY-MM-DD`. After this date the exception stops applying. |

`check` reports exceptions that matched nothing (unused) and ones that have expired, so they don't pile up.

## `rookery policy apply`: write the policy into each agent's config

`check` judges what's in the repo. `apply` makes the agents enforce the policy themselves. It writes each agent's own config from `.rookery.yml`, for the agents found in the repo (or listed in `agents:`).

```bash
npx @thinkingraven/rookery policy apply           # dry run: shows a diff per file, writes nothing
npx @thinkingraven/rookery policy apply --write   # writes the files; commit them
```

| Agent | What `apply` writes in the repo |
|---|---|
| Claude Code | `.claude/settings.json`: `permissions.disableBypassPermissionsMode: "disable"`; `permissions.deny` with `Bash(prefix)`, `Bash(prefix *)` and `Read(glob)`; `allowedMcpServers` when `mcp.unlisted` is `forbid` |
| Codex | `.codex/rules/rookery.rules`: one `prefix_rule(…, decision = "forbidden")` per `shell.deny` entry |
| Gemini CLI | `.gemini/settings.json`: `security.disableYoloMode`, `mcp.allowed`, and `tools.exclude` with `run_shell_command(prefix)`; `.geminiignore` for in-repo `never_read` paths |
| Cursor | `.cursor/cli.json`: `permissions.deny` with `Shell(cmd:args*)` and `Read(glob)` (the CLI reads this file); `.cursorignore` for in-repo `never_read` paths |
| Windsurf | `.devinignore` for in-repo `never_read` paths |
| GitHub Copilot | nothing: a repo can't enforce these for Copilot (VS Code's `false` terminal rules only prompt) |

With `runtime.hooks: true`, `apply` also installs the runtime hook in each agent. See the next section.

**What only an admin can enforce** goes into `.rookery/ADMIN.md`, regenerated on every apply, with the exact snippet per agent:
- Claude Code: `managed-settings.json`;
- Codex: `requirements.toml` (`allowed_approval_policies`, `allowed_sandbox_modes`, `deny_read`, `prefix_rules`);
- Gemini CLI: the system settings file and an admin policy TOML;
- Cursor: dashboard steps, plus turning Workspace Trust on through MDM;
- GitHub Copilot: enterprise `managed-settings.json`;
- Windsurf: team settings.

Codex permission profiles are beta, and Codex ignores them when any config sets `sandbox_mode`. That's why Codex read denies go to `ADMIN.md`, not the repo.

**How `apply` treats your files:**
- **Additive and owned.** `apply` records every value it adds in `.rookery/applied.json`. The next run updates or removes only those values. Values you wrote, even identical ones, are never claimed or removed.
- **Never overrides.** If a file sets a key to a different value, for example `"disableYoloMode": false`, `apply` leaves it and reports a conflict.
- **No comments lost.** JSON files with comments are not rewritten; `apply` lists what to add by hand. Other JSON files are rewritten with 2-space indentation.
- **Marked blocks.** Ignore files get a block between `# >>> rookery` and `# <<< rookery`. Lines outside it are untouched.
- **Clean removal.** When the policy no longer needs something, `apply` takes it back out. Files it created are deleted once empty.

After the first `--write`, `check` reports drift (`RK-POL-007`) whenever the configs fall out of date with `.rookery.yml`.

## `rookery hook`: enforce the policy while agents run

`apply` writes the rules each agent can express in its own config. The runtime hook covers the rest: every shell command, file read and MCP call goes through `rookery hook` before the agent runs it, and the hook blocks what `.rookery.yml` forbids. It works the same way in every agent, so one policy gives the same answers in Claude Code, Codex, Gemini CLI, Cursor, Copilot and Windsurf.

```yaml
# .rookery.yml
runtime:
  hooks: true
```

```bash
npx @thinkingraven/rookery policy apply --write   # installs the hook; commit the files
```

**What it checks**

| Setting | Blocked while the agent runs |
|---|---|
| `shell.deny` | A command that starts with a listed prefix, anywhere in the command line: after `&&`, `;` or `\|`, inside `$(…)` or `sh -c '…'`, after `sudo` or `env`, or run by its full path (`/bin/rm -rf`). |
| `approvals.bypass` | Starting another agent with its approvals or sandbox off, such as `claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`, `gemini -y`, or `copilot --allow-all-tools`. |
| `files.read_secrets` | A shell command that reads a `files.never_read` path or a credential file (`cat ~/.ssh/id_rsa`, `source .env`, `security find-generic-password -w`). The same goes for the agent's own file tools (Read, Grep, `read_file`, `view` and so on). Writing to `.env` and reading public keys are fine. |
| `mcp.unlisted` | A call to an MCP server that isn't in `mcp.allow`. |

- `forbid` blocks the call. The agent sees the reason, for example `rookery policy (shell.deny): \`rm -rf\` is not allowed in this repo.`
- `warn` lets the call through and logs it.
- `allow` ignores it.

Exceptions don't apply here: they cover files in the repo, not live calls.

**What each agent gets**

| Agent | Where the hook goes | Calls it sees | If the hook can't run at all |
|---|---|---|---|
| Claude Code | `.claude/settings.json`: `hooks.PreToolUse` | Bash, PowerShell, Read, Grep, Glob, MCP | The call is blocked (`onFailure: "block"`, Claude Code 2.1.295 or later) |
| Codex | `.codex/hooks.json`: `PreToolUse` | shell, MCP | The call goes through. Codex runs project hooks only after you trust them in `/hooks`. |
| Gemini CLI | `.gemini/settings.json`: `hooks.BeforeTool` | `run_shell_command`, `read_file`, `read_many_files`, MCP | The call goes through, with a warning. Gemini asks before it runs a new or changed project hook. |
| Cursor | `.cursor/hooks.json`: `beforeShellExecution`, `beforeReadFile`, `beforeMCPExecution` | shell, file reads, MCP | The call is blocked (`failClosed: true`) |
| GitHub Copilot | `.github/hooks/rookery.json`: `preToolUse` | `bash`, `powershell`, `view`, `grep`, `rg`, `glob` | The call is blocked if the hook crashes. A timeout lets it through. |
| Windsurf | `.devin/hooks.json` (or `.windsurf/hooks.json` if the repo already uses it): `pre_run_command`, `pre_read_code`, `pre_mcp_tool_use` | shell, file reads, MCP | The call goes through |

`apply` adds its hook next to any hooks you already have, and takes only its own entry back out when you turn `runtime.hooks` off.

**Make it binding.** Anyone who can edit the repo can take the hook out. `ADMIN.md` gets a "Runtime hook" section with the same hook for Claude Code managed settings, Codex `requirements.toml`, Copilot policy hooks and Windsurf system hooks.

**Fail closed.** If the hook gets input it can't read, or `.rookery.yml` is invalid, it blocks the call and says why. Whether a hook that can't start at all blocks the call is up to each agent, as the table shows.

**Which policy.** The hook uses the `.rookery.yml` of the project the agent has open (from `CLAUDE_PROJECT_DIR`, `GEMINI_PROJECT_DIR` or `CURSOR_PROJECT_DIR`), so a policy file somewhere else can't loosen it. Otherwise it uses the nearest `.rookery.yml` at or above the call's folder, stopping at the repo root. With no policy it has no opinion. `rookery hook <agent> --policy <file>` names the file outright.

**Speed.** By default the hooks run `npx -y @thinkingraven/rookery@<version>`, pinned to the version that installed them. npx adds about half a second to every checked call; rookery itself takes about 50 ms. To make it faster, install rookery (`npm i -g @thinkingraven/rookery`) and set `runtime.command: rookery`.

**Upgrades.** `apply` keeps the pinned version, so a newer rookery in CI doesn't report drift. To move the hooks to the version you're running, use `rookery policy apply --write --update-hooks`.

**Decision log.** Each block or warning is appended to `~/.rookery/decisions/YYYY-MM-DD.jsonl`, on your machine. A line holds the time, agent, kind of call, decision, rule, setting, the repo folder name, and a short subject: the first words of the command or the matched glob, with your home folder shown as `~` and long tokens cut short. `ROOKERY_HOME` moves the log; `ROOKERY_HOOK_LOG=0` turns it off.

**Limits.** The hook is a guardrail, not a sandbox. It reads command text, so a process set on getting around it can: a script that reads the file itself, a variable that holds the path, a command it doesn't recognise. Use it together with what `apply` writes into each agent's own config, the agent's sandbox, and the admin settings in `ADMIN.md`. Cursor doesn't document whether a hook's `allow` also skips Cursor's own approval prompt. rookery answers `allow` when it has no objection, as Cursor's examples do.

## Can the agents enforce it themselves?

`check` judges the files in the repo. Whether each agent can *enforce* the same rule while it runs is a different question, and the answer differs per agent. `check` prints that per policy setting, for the agents it found, from [the capability matrix](agent-capabilities.md):

```
What these agents can enforce themselves:
  approvals.bypass    Claude Code yes · Cursor yes
  shell.any_command   Claude Code partial · Cursor partial
  files.read_secrets  Claude Code yes · Cursor partial
```

"Partial" means the agent has the control with important gaps; the matrix lists them. `rookery policy apply` writes the parts each agent accepts from a repo.

## In CI

The GitHub Action runs `check` when the repo has a `.rookery.yml`, or when you pass `policy:`:

```yaml
- uses: thinkingraven/rookery@v0
  with:
    policy: .rookery.yml      # optional; found automatically at the repo root
    sarif: rookery.sarif      # policy violations show up in code scanning as RK-POL-* alerts
```

With a policy, the policy's `fail_on` decides which scan findings fail the job. The Action's `fail-on` input is ignored.

Exit codes:
- `0`: passed, or no policy file;
- `1`: the policy failed;
- `2`: usage error or invalid policy.

## Output

`check` adds a **Policy** section to the terminal and Markdown reports, a `policy` object to the JSON report, and `RK-POL-*` results to SARIF. The HTML report doesn't show the policy yet.
