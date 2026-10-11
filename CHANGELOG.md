# Changelog

All notable changes to rookery are listed here. This project follows [semantic versioning](https://semver.org).

## Unreleased

- **SARIF 2.1.0 output** for GitHub code scanning and other SARIF viewers: `--sarif <file>` or `--format sarif`, and a `sarif` input on the GitHub Action. Every rule carries its severity for code scanning and a link to its docs; paths are repo-relative; fingerprints stay stable when lines move. Low-confidence findings are only included with `--strict`.

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
