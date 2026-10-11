# Changelog

All notable changes to rookery are listed here. This project follows [semantic versioning](https://semver.org).

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
