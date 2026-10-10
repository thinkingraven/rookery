# Changelog

All notable changes to rookery are listed here. This project follows [semantic versioning](https://semver.org).

## 0.1.0 — 2026-10-11

First release.

- **Discovery** of skills, commands, subagents, rules files, settings, hooks, MCP configs and plugin manifests for Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf and generic `SKILL.md` folders, including the scripts bundled with a skill.
- **Repo-aware scanning** of one repo or a folder of many; linked git worktrees are skipped unless `--worktrees` is passed.
- **What teams keep building**: artifacts grouped into purposes such as code review, testing and deployment.
- **Near-duplicates** across repos and agents using MinHash and LSH over word 3-grams.
- **26 security and quality rules** for secrets, exfiltration, prompt injection, hidden Unicode, harness overrides, unsafe execution, supply chain, hooks, permissions and MCP servers, with confidence scoring and `rookery-ignore` suppressions.
- **Reports** for the terminal, JSON, Markdown (CI summaries) and a self-contained HTML page.
- **CI**: `--fail-on` and `--strict`, plus a GitHub Action.
