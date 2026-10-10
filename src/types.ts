export type Agent = 'claude-code' | 'codex' | 'cursor' | 'copilot' | 'gemini' | 'windsurf' | 'agent-skills' | 'mcp';

export type ArtifactKind =
  | 'skill'          // SKILL.md (Agent Skills format)
  | 'command'        // slash command / reusable prompt
  | 'subagent'       // .claude/agents/*.md, Copilot chat modes
  | 'rules'          // always-on project instructions (CLAUDE.md, AGENTS.md, .cursor/rules, copilot-instructions)
  | 'settings'       // agent settings with permissions / hooks
  | 'mcp-config'     // MCP server definitions
  | 'plugin'         // plugin / marketplace manifests
  ;

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
}

export interface Hook {
  event: string;
  command: string;
}

export interface Artifact {
  id: string;               // stable id: repo-relative path
  repo: string;             // repo display name
  repoRoot: string;         // absolute path of the repo root
  path: string;             // absolute path
  relPath: string;          // path relative to the repo root
  agent: Agent;
  kind: ArtifactKind;
  name: string;
  description: string;
  body: string;             // full text content
  bytes: number;
  tokens: number;           // rough estimate (chars / 4)
  allowedTools: string[];
  hooks: Hook[];
  mcpServers: McpServer[];
  scripts: string[];        // sibling script files bundled with a skill (repo-relative)
  bundled: { relPath: string; content: string }[]; // text contents of bundled files, scanned by rules
  category: string;
  sha256: string;           // hash of normalised content
  frontmatter: Record<string, unknown>;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  artifactId: string;
  repo: string;
  relPath: string;
  line: number;
  snippet: string;
  remediation: string;
  confidence: 'high' | 'low';
  context?: string;          // why confidence was lowered
}

export interface DuplicateCluster {
  id: string;
  label: string;            // representative name
  category: string;
  similarity: number;       // average pairwise similarity (0..1)
  exact: boolean;           // all members identical after normalisation
  members: { artifactId: string; repo: string; relPath: string; name: string; agent: Agent }[];
}

export interface ScanResult {
  tool: { name: string; version: string };
  scannedAt: string;
  roots: string[];
  repos: string[];
  artifacts: Artifact[];
  findings: Finding[];
  clusters: DuplicateCluster[];
  categories: { category: string; count: number; repos: number }[];
  stats: {
    artifacts: number;
    byAgent: Record<string, number>;
    byKind: Record<string, number>;
    findingsBySeverity: Record<Severity, number>;
    duplicateArtifacts: number;
    totalTokens: number;
    filesScanned: number;
    durationMs: number;
  };
}

export interface ScanOptions {
  paths: string[];
  maxFileBytes: number;
  includeInfo: boolean;
  similarityThreshold: number;
}

export type Confidence = 'high' | 'low';
