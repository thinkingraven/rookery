import type { ScanResult, Severity } from '../types.js';
import { CATEGORY_LABELS } from '../categories.js';

const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const SEV: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const AGENT: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot', gemini: 'Gemini', windsurf: 'Windsurf', 'agent-skills': 'Agent Skills', mcp: 'MCP' };

/** Self-contained, branded HTML report (Thinking Raven design system: bone, ink, amber). */
export function renderHtml(r: ScanResult): string {
  const s = r.stats.findingsBySeverity;
  const maxCat = Math.max(1, ...r.categories.map((c) => c.count));
  const tiles = [
    ['Repos', r.repos.length], ['Agent artifacts', r.stats.artifacts], ['Duplicate clusters', r.clusters.length],
    ['Critical', r.findings.filter((f) => f.severity === 'critical' && f.confidence === 'high').length], ['High', r.findings.filter((f) => f.severity === 'high' && f.confidence === 'high').length], ['Medium', r.findings.filter((f) => f.severity === 'medium' && f.confidence === 'high').length],
  ];
  const cats = r.categories.map((c) => `<div class="cat"><span>${e(CATEGORY_LABELS[c.category] ?? c.category)}</span><i style="width:${Math.max(4, (c.count / maxCat) * 100)}%"></i><b>${c.count}</b><small>${c.repos} repo${c.repos === 1 ? '' : 's'}</small></div>`).join('');
  const clusters = r.clusters.map((c) => `<article class="card"><header><h3>${e(c.label)} <span class="count">×${c.members.length}</span></h3><span class="pill">${c.exact ? 'identical' : Math.round(c.similarity * 100) + '% similar'}</span></header><p class="muted">${e(CATEGORY_LABELS[c.category] ?? c.category)}</p><ul>${c.members.map((m) => `<li><code>${e(m.repo)}/${e(m.relPath)}</code> <span class="muted">${e(AGENT[m.agent] ?? m.agent)}</span></li>`).join('')}</ul></article>`).join('');
  const findings = r.findings.map((f) => `<tr data-sev="${f.severity}" data-conf="${f.confidence}"${f.confidence === 'low' || f.severity === 'low' || f.severity === 'info' ? ' hidden' : ''}><td><span class="sev ${f.severity}">${f.severity}</span>${f.confidence === 'low' ? '<div class="muted lowc">low confidence</div>' : ''}</td><td><b>${e(f.title)}</b><div class="muted mono">${e(f.ruleId)}</div>${f.context ? `<div class="muted">${e(f.context)}</div>` : ''}</td><td><code>${e(f.repo)}/${e(f.relPath)}:${f.line}</code><div class="snip">${e(f.snippet)}</div></td><td class="muted">${e(f.remediation)}</td></tr>`).join('');
  const inventory = r.artifacts.map((a) => `<tr><td>${e(a.repo)}</td><td><code>${e(a.relPath)}</code></td><td>${e(AGENT[a.agent] ?? a.agent)}</td><td>${e(a.kind)}</td><td>${e(a.name)}<div class="muted">${e(a.description.slice(0, 140))}</div></td><td>${e(CATEGORY_LABELS[a.category] ?? a.category)}</td><td class="num">${a.tokens.toLocaleString('en-US')}</td></tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rookery report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap">
<style>
:root{--ink:#0F0F14;--bone:#F3EFE6;--card:#fff;--amber:#F2A93B;--muted:#5C5C68;--hair:#E3DDD0;--soft:#FAF8F3;--crit:#B42318;--high:#C2410C;--med:#8A5A00;--low:#2F5FA8}
*{box-sizing:border-box}body{margin:0;background:var(--bone);color:#2B2B33;font:400 15px/1.55 "Space Grotesk","Helvetica Neue",Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}@media(min-width:720px){.wrap{padding:0 28px}}
.hero{background:var(--ink);color:var(--bone);padding:48px 0 40px}.kicker{font:700 12px/1.4 "Space Mono",monospace;letter-spacing:1.8px;text-transform:uppercase;color:var(--amber)}
.hero h1{font:700 clamp(32px,5vw,52px)/1.05 "Space Grotesk",sans-serif;letter-spacing:-1.5px;margin:10px 0 8px}.hero h1 .dot{color:var(--amber)}.hero p{color:#9A9AA8;margin:0}
.tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:28px}.tile{background:#15151B;border:1px solid #2A2A33;border-radius:14px;padding:14px 16px}.tile b{display:block;font-size:28px;color:var(--bone);letter-spacing:-.5px}.tile span{color:#9A9AA8;font-size:13px}
.tile.critical b{color:#FF7B72}.tile.high b{color:#FFB38A}
section{padding:40px 0;border-bottom:1px solid var(--hair)}h2{font:700 28px/1.15 "Space Grotesk",sans-serif;letter-spacing:-.6px;margin:0 0 6px;color:var(--ink)}.sub{color:var(--muted);margin:0 0 20px;max-width:720px}
.cat{display:grid;grid-template-columns:minmax(120px,220px) 1fr 40px 70px;gap:12px;align-items:center;padding:6px 0}.cat i{height:12px;background:var(--amber);border-radius:6px;display:block}.cat b{color:var(--ink)}.cat small{color:var(--muted)}
.cards{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))}.card{background:var(--card);border:1px solid var(--hair);border-radius:18px;padding:18px 20px;min-width:0}
.card header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.card h3{margin:0;font:600 17px/1.3 "Space Grotesk",sans-serif;color:var(--ink);overflow-wrap:anywhere}.count{color:var(--muted);font-weight:500}
.card ul{margin:10px 0 0;padding-left:18px}.card li{margin:4px 0;overflow-wrap:anywhere}.pill{background:#E9E3D6;color:var(--ink);border-radius:999px;padding:3px 10px;font-size:12px;white-space:nowrap}
.muted{color:var(--muted)}.mono,code{font-family:"Space Mono",ui-monospace,monospace;font-size:12.5px}code{background:var(--soft);border:1px solid var(--hair);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
.tablewrap{overflow-x:auto;background:var(--card);border:1px solid var(--hair);border-radius:18px}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid #EEE8DC;vertical-align:top}th{font:700 11px/1.4 "Space Mono",monospace;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);background:var(--soft)}tr:last-child td{border-bottom:0}td.num{text-align:right;font-variant-numeric:tabular-nums}
.sev{display:inline-block;border-radius:999px;padding:2px 10px;font:700 11px/1.6 "Space Mono",monospace;text-transform:uppercase;letter-spacing:1px;color:#fff}.sev.critical{background:var(--crit)}.sev.high{background:var(--high)}.sev.medium{background:var(--med)}.sev.low{background:var(--low)}.sev.info{background:#6A6A75}
.lowc{font-size:11px;margin-top:4px}.snip{margin-top:6px;font:12px/1.5 "Space Mono",monospace;color:#2B2B33;background:var(--soft);border-radius:8px;padding:6px 8px;overflow-wrap:anywhere}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}.filters button{border:1px solid var(--ink);background:transparent;border-radius:999px;padding:6px 14px;font:600 13px "Space Grotesk",sans-serif;cursor:pointer;color:var(--ink)}.filters button[aria-pressed="true"]{background:var(--ink);color:var(--bone)}
input.search{width:100%;max-width:360px;height:42px;border:1px solid var(--hair);border-radius:12px;padding:0 14px;font:inherit;margin-bottom:14px;background:#fff}
input.search:focus,.filters button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--bone),0 0 0 4px var(--ink)}
details>summary{cursor:pointer;font-weight:600;color:var(--ink);margin:0 0 14px;width:max-content}footer{padding:28px 0 48px;color:var(--muted);font-size:13px}.empty{color:var(--muted);background:#fff;border:1px dashed var(--hair);border-radius:14px;padding:18px}
</style></head><body>
<header class="hero"><div class="wrap">
  <div class="kicker">Rookery report · ${e(new Date(r.scannedAt).toUTCString())}</div>
  <h1>Your agent skills, <span style="font-weight:400">at a glance</span><span class="dot">.</span></h1>
  <p>${r.repos.length} repo${r.repos.length === 1 ? '' : 's'} · ${r.stats.filesScanned.toLocaleString('en-US')} files scanned · ~${r.stats.totalTokens.toLocaleString('en-US')} tokens of agent context · rookery v${e(r.tool.version)}</p>
  <div class="tiles">${tiles.map(([k, v]) => `<div class="tile ${String(k).toLowerCase()}"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
</div></header>
<main>
<section><div class="wrap"><h2>What teams keep building</h2><p class="sub">Skills, commands, subagents and rules grouped by purpose. Tall bars across many repos are the best candidates for one shared, governed skill.</p>${cats || '<p class="empty">No skills or commands found.</p>'}</div></section>
<section><div class="wrap"><h2>Near-duplicates</h2><p class="sub">${r.clusters.length ? `${r.stats.duplicateArtifacts} artifacts are near-copies of each other and could become ${r.clusters.length} shared skill${r.clusters.length === 1 ? '' : 's'}.` : 'No near-duplicates found.'}</p><div class="cards">${clusters}</div></div></section>
<section><div class="wrap"><h2>Security findings</h2><p class="sub">Static checks for secrets, exfiltration, prompt injection, permission bypasses, risky hooks and unpinned MCP servers. Suppress a reviewed line with <code>rookery-ignore RK-XXX-000</code>.</p>
${r.findings.length ? `<div class="filters" role="group" aria-label="Filter findings"><button type="button" data-f="all" aria-pressed="true">Critical–medium ${r.findings.filter((f) => f.confidence === 'high' && ['critical', 'high', 'medium'].includes(f.severity)).length}</button>${SEV.map((x) => [x, r.findings.filter((f) => f.severity === x && f.confidence === 'high').length] as const).filter(([, n]) => n).map(([x, n]) => `<button type="button" data-f="${x}" aria-pressed="false">${x} ${n}</button>`).join('')}${r.findings.some((f) => f.confidence === 'low') ? `<button type="button" data-f="low-confidence" aria-pressed="false">Low confidence ${r.findings.filter((f) => f.confidence === 'low').length}</button>` : ''}</div><div class="tablewrap"><table><thead><tr><th>Severity</th><th>Finding</th><th>Where</th><th>Fix</th></tr></thead><tbody id="findings">${findings}</tbody></table></div>` : '<p class="empty">No findings. Nice.</p>'}
</div></section>
<section><div class="wrap"><h2>Inventory</h2><p class="sub">Every agent artifact found, across Claude Code, Codex, Cursor, Copilot, Gemini and Windsurf.</p><details${r.artifacts.length <= 60 ? ' open' : ''}><summary>${r.artifacts.length > 60 ? `Show all ${r.artifacts.length} artifacts` : 'Artifacts'}</summary><input class="search" type="search" placeholder="Filter by repo, path, name…" aria-label="Filter inventory"><div class="tablewrap"><table><thead><tr><th>Repo</th><th>Path</th><th>Agent</th><th>Kind</th><th>Name</th><th>Purpose</th><th>Tokens</th></tr></thead><tbody id="inventory">${inventory}</tbody></table></div></details></div></section>
</main>
<footer><div class="wrap">Generated by <b>rookery</b> by Thinking Raven · <a href="https://github.com/thinkingraven/rookery">github.com/thinkingraven/rookery</a></div></footer>
<script>
document.querySelectorAll('[data-f]').forEach(function(b){b.addEventListener('click',function(){var f=b.getAttribute('data-f');document.querySelectorAll('[data-f]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});document.querySelectorAll('#findings tr').forEach(function(tr){var low=tr.getAttribute('data-conf')==='low';var sv=tr.getAttribute('data-sev');tr.hidden=f==='low-confidence'?!low:(low||!(f==='all'?['critical','high','medium'].indexOf(sv)>-1:sv===f))})})});
var q=document.querySelector('input.search');if(q)q.addEventListener('input',function(){var v=q.value.toLowerCase();document.querySelectorAll('#inventory tr').forEach(function(tr){tr.hidden=v&&tr.textContent.toLowerCase().indexOf(v)===-1})});
</script>
</body></html>
`;
}
