# Changelog

All notable changes to rookery are listed here. This project follows [semantic versioning](https://semver.org).

## 0.8.0 — 2026-10-16

- **`preloadTokens` on every artifact**: the size, in tokens, of what actually loads before anything is invoked — a skill or subagent's name and description alone (the body loads only once it runs), or the whole file for anything always-on (rules, settings, mcp-config, plugin), where `tokens` already was the preload cost. `tokens` (the whole-file estimate) is unchanged and still there. Built for roost's "context tax" (`roost context --rookery`), where the existing `tokens` field was the wrong unit: it overstated a skill's real preload cost by counting the body too.

## 0.7.2 — 2026-10-14

- **JSON report: each artifact keeps its `repoRoot`**, with your home folder shown as `~` (for example `~/code/app`). Tools that combine rookery with agent usage, such as roost, need it to match a skill to the repo an agent ran in. Absolute file paths and file contents are still left out.

## 0.7.1 — 2026-10-14

- **Capability matrix corrections** (`docs/agent-capabilities.md` and `.json`, and what `rookery check` prints about which agents can enforce a rule):
  - **Deny commands:** Gemini CLI and OpenCode are now partial, like the other five. Their command rules match text, so a wrapper or another interpreter can get round them.
  - **Lock out bypass modes:** Windsurf is now partial. The team setting caps Cascade only, and no toggle turns Bypass off in Devin Local.
  - **Key findings rewritten:**
    - Claude Code's Read deny does stop `cat`, `head`, `tail`, `sed` and `tee`.
    - Which agents' hooks fail open, and which can fail closed (Claude Code `onFailure`, Cursor `failClosed`, Copilot on a crash), with sources.
    - What "no complete audit log" means per agent.
  - Researcher notes removed from the answers. The legend no longer lists "unknown", which no answer uses.

## 0.7.0 — 2026-10-14

- **Skill quality, its own section in every report.** Seven new checks on top of "no description" and "very large file", each backed by an agent's documented limits:
  - `RK-QLT-003`: the name breaks the Agent Skills format (1–64 lowercase letters, digits and hyphens).
  - `RK-QLT-004`: `name` doesn't match the skill's folder.
  - `RK-QLT-005`: the description is over 1,024 characters, or over 1,536 with `when_to_use`.
  - `RK-QLT-006`: a link to a file, or a listed `references/…` or `scripts/…` file, that the skill doesn't ship.
  - `RK-QLT-007`: the description is too short to match on.
  - `RK-QLT-008`: a frontmatter field looks misspelled (`allowed_tools`, `tools:` in a skill, `descripton`). Claude Code ignores unknown fields silently.
  - `RK-QLT-009`: two different skills share a name for the same agent in one repo.
- **Size:** `RK-QLT-002` also flags a `SKILL.md` over 500 lines.
- **Separate from security:** quality issues appear under QUALITY in the terminal and under "Skill quality" in the Markdown and HTML reports, no longer among security findings. Test fixtures are skipped.

## 0.6.0 — 2026-10-14

- **`rookery hook <agent>`: the policy, enforced while agents run.** A pre-tool-use hook for Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot and Windsurf. It reads each agent's own hook input and checks the call against `.rookery.yml`:
  - commands that start with a `shell.deny` prefix, anywhere in a command line;
  - starting another agent with its approvals or sandbox off;
  - shell commands and file reads that touch `files.never_read` paths or credential files;
  - MCP servers that aren't in `mcp.allow`.
  `forbid` blocks the call with the reason, in the agent's own answer format; `warn` lets it through.
- **Fail closed.** Unreadable input or an invalid policy blocks the call.
- **Decision log.** Blocks and warnings go to `~/.rookery/decisions/YYYY-MM-DD.jsonl` on your machine, with redacted subjects. `ROOKERY_HOME` moves it and `ROOKERY_HOOK_LOG=0` turns it off.
- **`runtime: { hooks, command }` in `.rookery.yml`.** With `hooks: true`, `policy apply` installs the hook in each agent's config, next to existing hooks:
  - `.claude/settings.json`, with `onFailure: "block"`;
  - `.codex/hooks.json`;
  - `.gemini/settings.json`;
  - `.cursor/hooks.json`, with `failClosed: true`;
  - `.github/hooks/rookery.json`;
  - `.devin/hooks.json`.
  Hooks run a pinned `npx` version until `--update-hooks`, or the `command` you set.

## 0.5.0 — 2026-10-14

- **`rookery policy apply`.** Writes `.rookery.yml` into each agent's own config, for the agents found in the repo or listed in `agents:`.
  - **Claude Code:** `.claude/settings.json`, with the bypass lock, deny rules and MCP allow-list.
  - **Codex:** `.codex/rules/rookery.rules`, with forbidden command prefixes.
  - **Gemini CLI:** `.gemini/settings.json` (yolo off, MCP allow-list, tool excludes) and `.geminiignore`.
  - **Cursor:** `.cursor/cli.json` permissions and `.cursorignore`.
  - **Windsurf:** `.devinignore`.
  - **Dry run by default:** shows a diff per file; `--write` applies it.
  - **Owned and additive:** `.rookery/applied.json` records what rookery added, so later runs update or remove only those values. Hand-written values are never overwritten or removed, and conflicts are reported.
- **`.rookery/ADMIN.md`.** The settings only an admin can make binding, with exact snippets per agent: managed settings, Codex `requirements.toml`, Gemini system settings and admin policy, Cursor and Windsurf team settings, Copilot enterprise managed settings.
- **New policy settings:** `shell.deny` (command prefixes) and `drift`.
- **`RK-POL-007`:** once `apply` has been used, `check` reports agent configs that are out of date with the policy.

## 0.4.0 — 2026-10-14

- **Policy: `rookery check` and `.rookery.yml`.**
  - One file says what agents may do in a repo, and `check` fails CI when the agent files break it.
  - **Six policy rules:**
    - approval bypasses (`RK-POL-001`);
    - any-command allow-lists (`RK-POL-002`);
    - unpinned MCP servers (`RK-POL-003`) and MCP servers not on an allow-list (`RK-POL-004`);
    - network-calling hooks (`RK-POL-005`);
    - reads of credentials or `files.never_read` paths (`RK-POL-006`).
  - **Presets and exceptions:** `strict`, `balanced` and `solo` presets. Exceptions need a reason and can expire, and they can also accept scan findings (`rules: [RK-EXE-001]`). Unused and expired exceptions are reported.
  - **Per-agent enforceability:** for each setting, `check` prints whether each agent in the repo can enforce the rule itself, from `docs/agent-capabilities.md`.
  - **Without a `.rookery.yml`:** `check` shows what `balanced` would flag, as warnings only, and exits 0.
  - **Output:** terminal, Markdown, JSON and SARIF (`RK-POL-*` alerts in code scanning).
- **`rookery policy init`** writes a commented starter `.rookery.yml`.
- **GitHub Action:** a new `policy` input. The Action runs `check` automatically when the repo has a `.rookery.yml`.
- **Capability matrix:** `docs/agent-capabilities.md` compares seven agents on 16 controls.

## 0.3.0 — 2026-10-11

Fixes from scanning 38 popular public skill repositories (14,245 agent files), where every high and critical alert was read by hand.

- **SARIF 2.1.0 output** for GitHub code scanning and other SARIF viewers: `--sarif <file>` or `--format sarif`, and a `sarif` input on the GitHub Action. Every rule carries its severity for code scanning and a link to its docs; paths are repo-relative; fingerprints stay stable when lines move. Low-confidence findings are only included with `--strict`.
- **Claude Code plugins** are inventoried: agents, commands and `hooks/hooks.json` in every plugin folder, paths declared in `plugin.json`, and plugins listed by a `marketplace.json`. Plugin hooks now get the hook checks.
- **Catalogues** that publish files outside an agent's folders are recognised by frontmatter: Cursor rules (`globs`/`alwaysApply`), subagents (`name` + `description` + `tools`/`model`) and commands (`argument-hint`).
- **New rule `RK-EXF-004`**: sweeping password managers, the macOS keychain, browser profiles or other projects' `.env` files for secrets.
- `RK-EXE-004` catches `--approval-mode yolo` (Gemini CLI) and `--allow-all-tools` (Copilot CLI).
- Fewer false positives:
  - `RK-EXE-002` only flags deleting the home or root folder itself, not paths under it such as `~/.cache/uv`;
  - `RK-INJ-002` accepts zero-width joiners and non-joiners inside Persian, Arabic and Indic words and inside emoji sequences;
  - `RK-EXF-001` ignores tokens sent in an `Authorization` header or `-u` to their own API;
  - `RK-EXF-003` ignores public `.pub` keys;
  - `RK-SEC-003` skips more placeholders, including non-English ones and base64-encoded numbers;
  - `RK-EXE-001` needs a URL, host or variable before the pipe, so prose about `curl | bash` is quiet;
  - `RK-INJ-001` ignores harmless uses of "silently run";
  - `RK-INJ-003` needs an instruction aimed at the model and skips comments inside fenced code samples;
  - `RK-EXE-005` only flags `sudo` where it runs, not in `echo` hints or prose;
  - `RK-PRM-001` no longer treats a subagent's `tools:` list (which restricts it) as an allow-list.
- Each hook gets its own finding on its own line; a finding in a file that is both its own artifact and bundled with a skill is reported once.
- Skill and agent folders named like build output (`skills/build/`, `skills/coverage/`) are scanned, and so is a repo named `out` inside the scanned folder.
- `evals/` folders count as tests, and `security-allowlist` markers from other scanners are honoured.
- Reports say how many scanned repos had no agent files.

## 0.2.0 — 2026-10-11

- **skillshare support**: scans `~/.config/skillshare/` and project `.skillshare/` (or `skillshare/`) folders: skills, tracked skill repos, agents, extras, and MCP servers in `config.yaml` / `mcp.yaml`.
- **Where skills come from**: install source, commit and "edited since install" from skillshare's metadata and lock files, and the source repo from `npx skills`' lock file. Shown in every report.
- **Symlinks are followed** inside agent folders (skillshare and `npx skills` install by symlink), with a loop guard. Each real skill is reported once with the tools it's linked into; skillshare copy-mode copies fold into their source.
- `--local` scans your user-level agent folders.
- Skills in `.codex/skills/`, `.cursor/skills/` and `.gemini/skills/` are attributed to their tool.

## 0.1.0 — 2026-10-11

First release.

- **Discovery** of skills, commands, subagents, rules files, settings, hooks, MCP configs and plugin manifests for Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf and generic `SKILL.md` folders, including the scripts bundled with a skill.
- **Repo-aware scanning** of one repo or a folder of many; linked git worktrees are skipped unless `--worktrees` is passed.
- **What teams keep building**: artifacts grouped into purposes such as code review, testing and deployment.
- **Near-duplicates** across repos and agents using MinHash and LSH over word 3-grams.
- **26 security and quality rules** for secrets, exfiltration, prompt injection, hidden Unicode, harness overrides, unsafe execution, supply chain, hooks, permissions and MCP servers, with confidence scoring and `rookery-ignore` suppressions.
- **Reports** for the terminal, JSON, Markdown (CI summaries) and a self-contained HTML page.
- **CI**: `--fail-on` and `--strict`, plus a GitHub Action.
