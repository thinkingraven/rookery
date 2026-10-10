import type { Artifact, DuplicateCluster } from './types.js';
import { normalize, splitFrontmatter } from './parse.js';

const COMPARABLE = new Set(['skill', 'command', 'subagent', 'rules']);
const MIN_WORDS = 25;
const NUM_HASHES = 96;
const BANDS = 32; // 3 rows per band: catches pairs from roughly 0.3 Jaccard upwards
const ROWS = NUM_HASHES / BANDS;

const STOP = new Set('a an and are as at be by for from has have if in into is it its of on or that the this to was were will with you your we our they them can should must not use when then than also do does'.split(' '));

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Word 3-gram shingles over the content (frontmatter excluded), hashed to 32-bit ints. */
export function shingles(text: string): Set<number> {
  const words = normalize(splitFrontmatter(text).body).split(' ').filter((w) => w && !STOP.has(w));
  const out = new Set<number>();
  if (words.length < 3) { for (const w of words) out.add(fnv1a(w)); return out; }
  for (let i = 0; i + 2 < words.length; i++) out.add(fnv1a(`${words[i]} ${words[i + 1]} ${words[i + 2]}`));
  return out;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Deterministic hash family h_i(x) = (a_i * x + b_i) mod 2^32.
const COEFFS = Array.from({ length: NUM_HASHES }, (_, i) => [fnv1a(`a${i}`) | 1, fnv1a(`b${i}`)] as const);

function minhash(set: Set<number>): Uint32Array {
  const sig = new Uint32Array(NUM_HASHES).fill(0xffffffff);
  for (const x of set) {
    for (let i = 0; i < NUM_HASHES; i++) {
      const v = (Math.imul(COEFFS[i][0], x) + COEFFS[i][1]) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

export function findClusters(artifacts: Artifact[], threshold: number): DuplicateCluster[] {
  const items = artifacts
    .filter((a) => COMPARABLE.has(a.kind))
    .map((a) => ({ a, sh: shingles(a.body) }))
    .filter((x) => x.sh.size >= MIN_WORDS - 2);

  // LSH: bucket signature bands to find candidate pairs.
  const buckets = new Map<string, number[]>();
  items.forEach((x, idx) => {
    const sig = minhash(x.sh);
    for (let b = 0; b < BANDS; b++) {
      const key = `${b}:${Array.from(sig.subarray(b * ROWS, b * ROWS + ROWS)).join(',')}`;
      const list = buckets.get(key);
      if (list) list.push(idx); else buckets.set(key, [idx]);
    }
  });

  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pairSim = new Map<string, number>();
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 500) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [p, q] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]];
        const key = `${p}-${q}`;
        if (pairSim.has(key)) continue;
        const s = jaccard(items[p].sh, items[q].sh);
        pairSim.set(key, s);
        if (s >= threshold) parent[find(p)] = find(q);
      }
    }
  }

  const groups = new Map<number, number[]>();
  items.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i); else groups.set(r, [i]);
  });

  const clusters: DuplicateCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let total = 0, n = 0;
    for (let i = 0; i < members.length && i < 40; i++) {
      for (let j = i + 1; j < members.length && j < 40; j++) {
        const [p, q] = members[i] < members[j] ? [members[i], members[j]] : [members[j], members[i]];
        total += pairSim.get(`${p}-${q}`) ?? jaccard(items[p].sh, items[q].sh);
        n++;
      }
    }
    const arts = members.map((i) => items[i].a);
    const names = new Map<string, number>();
    for (const a of arts) names.set(a.name, (names.get(a.name) ?? 0) + 1);
    const label = [...names.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const cats = new Map<string, number>();
    for (const a of arts) cats.set(a.category, (cats.get(a.category) ?? 0) + 1);
    clusters.push({
      id: `dup-${clusters.length + 1}`,
      label,
      category: [...cats.entries()].sort((x, y) => y[1] - x[1])[0][0],
      similarity: n ? total / n : 1,
      exact: new Set(arts.map((a) => a.sha256)).size === 1,
      members: arts.map((a) => ({ artifactId: a.id, repo: a.repo, relPath: a.relPath, name: a.name, agent: a.agent })),
    });
  }
  clusters.sort((x, y) => y.members.length - x.members.length || y.similarity - x.similarity);
  clusters.forEach((c, i) => (c.id = `dup-${i + 1}`));
  return clusters;
}
