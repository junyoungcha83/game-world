// 낱말퍼즐 판 만들기 — 수준별 단어 목록(words-<수준>.json)으로 단계마다 고정된 판을 만들어
// assets/crossword-data.js 로 내보낸다. 씨앗값이 고정이라 다시 돌려도 같은 판이 나온다.
//   node tools/crossword/build.mjs
// 단어 목록 형식: [["낱말", "이모지", "열쇠 문장"], ...]  (한 칸 = 한 음절)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'assets', 'crossword-data.js');

// 수준 설정 — levels[i] = i+1단계: 판 크기(n), 단어 수(words), 미리 채울 칸 비율(given)
const lv = (n, words, given) => ({ n, words, given });
const TIERS = [
  { id: 'k1', label: '초등저학년', desc: '2~3글자 · 그림 열쇠', minLen: 2, maxLen: 3,
    levels: [lv(5, 4, .40), lv(5, 4, .35), lv(5, 5, .30), lv(5, 5, .25), lv(6, 6, .22),
             lv(6, 6, .18), lv(6, 7, .14), lv(6, 7, .10), lv(7, 8, .06), lv(7, 8, 0)] },
  { id: 'k2', label: '초등고학년', desc: '교과 낱말 · 쉬운 속담' },
  { id: 'm',  label: '중학생',     desc: '한자어 · 사자성어' },
  { id: 'h',  label: '고등학생',   desc: '문학 · 역사 용어' },
  { id: 'a',  label: '성인',       desc: '시사 · 관용구 · 순우리말' },
];

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const shuffle = (a, R) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const syl = w => [...w];

// 판에 낱말 하나를 놓을 수 있는지 — 놓으면 겹치는 칸 수, 못 놓으면 -1
// 규칙: 판 안, 겹치는 칸은 같은 글자, 앞뒤 칸은 비어 있음, 새로 채우는 칸의 옆(평행 방향)은 비어 있음
function fits(g, n, s, r, c, d) {
  const dr = d === 'd' ? 1 : 0, dc = d === 'a' ? 1 : 0, L = s.length;
  const er = r + dr * (L - 1), ec = c + dc * (L - 1);
  if (r < 0 || c < 0 || er >= n || ec >= n) return -1;
  const at = (y, x) => (y < 0 || x < 0 || y >= n || x >= n) ? null : g[y][x];
  if (at(r - dr, c - dc) || at(er + dr, ec + dc)) return -1;
  let cross = 0, prevFilled = false;
  for (let k = 0; k < L; k++) {
    const y = r + dr * k, x = c + dc * k, v = g[y][x];
    // 이미 찬 칸이 연달아 있으면 같은 방향 낱말과 겹치는 것(돌고래 안의 고래) — 안 됨
    if (v) { if (v !== s[k] || prevFilled) return -1; cross++; prevFilled = true; continue; }
    prevFilled = false;
    if (at(y - dc, x - dr) || at(y + dc, x + dr)) return -1;   // 옆 칸이 차 있으면 엉뚱한 낱말이 생긴다
  }
  return cross === L ? -1 : cross;
}
function place(g, s, r, c, d) { for (let k = 0; k < s.length; k++) g[r + (d === 'd' ? k : 0)][c + (d === 'a' ? k : 0)] = s[k]; }

// 한 판 만들기 — 여러 번 시도해서 겹침이 가장 많은 판을 고른다
function makePuzzle(pool, spec, R) {
  const { n, words: want } = spec;
  let best = null;
  for (let attempt = 0; attempt < 4000; attempt++) {
    const g = Array.from({ length: n }, () => Array(n).fill(null));
    const order = shuffle(pool.slice(), R);
    const first = order.find(w => w.s.length <= n);
    const d0 = R() < .5 ? 'a' : 'd';
    const off = Math.floor(R() * (n - first.s.length + 1)), line = Math.floor(R() * n);
    const r0 = d0 === 'a' ? line : off, c0 = d0 === 'a' ? off : line;
    place(g, first.s, r0, c0, d0);
    const placed = [{ ...first, r: r0, c: c0, d: d0 }], used = new Set([first.w]);
    let bb = { r0, c0, r1: r0 + (d0 === 'd' ? first.s.length - 1 : 0), c1: c0 + (d0 === 'a' ? first.s.length - 1 : 0) };
    while (placed.length < want) {
      const cands = [];
      for (const w of order) {
        if (used.has(w.w)) continue;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (const d of ['a', 'd']) {
          const k = fits(g, n, w.s, y, x, d); if (k <= 0) continue;
          const ey = y + (d === 'd' ? w.s.length - 1 : 0), ex = x + (d === 'a' ? w.s.length - 1 : 0);
          const area = (Math.max(bb.r1, ey) - Math.min(bb.r0, y) + 1) * (Math.max(bb.c1, ex) - Math.min(bb.c0, x) + 1);
          cands.push({ w, r: y, c: x, d, k, area });
        }
        if (cands.length > 60) break;
      }
      if (!cands.length) break;
      // 겹침이 많고 판이 덜 넓어지는 자리를 고른다(촘촘하게) — 앞쪽 몇 개 중에서 무작위
      cands.sort((a, b) => (b.k - a.k) || (a.area - b.area));
      const pick = cands[Math.floor(R() * Math.min(3, cands.length))];
      place(g, pick.w.s, pick.r, pick.c, pick.d);
      const ey = pick.r + (pick.d === 'd' ? pick.w.s.length - 1 : 0), ex = pick.c + (pick.d === 'a' ? pick.w.s.length - 1 : 0);
      bb = { r0: Math.min(bb.r0, pick.r), r1: Math.max(bb.r1, ey), c0: Math.min(bb.c0, pick.c), c1: Math.max(bb.c1, ex) };
      placed.push({ ...pick.w, r: pick.r, c: pick.c, d: pick.d }); used.add(pick.w.w);
    }
    if (placed.length < want) continue;
    // 점수: 가로·세로가 고루 섞이고, 판을 넓게 쓰고, 겹침이 많을수록 좋다
    const across = placed.filter(p => p.d === 'a').length, filled = g.flat().filter(Boolean).length;
    const crosses = placed.reduce((t, p) => t + p.s.length, 0) - filled;
    const area = (bb.r1 - bb.r0 + 1) * (bb.c1 - bb.c0 + 1);
    const score = crosses * 6 + filled * 2 - area - Math.abs(across * 2 - placed.length) * 3 - Math.abs((bb.r1 - bb.r0) - (bb.c1 - bb.c0)) * 2;
    if (!best || score > best.score) best = { score, g, placed };
  }
  if (!best) throw new Error(`판을 못 만듦: ${n}×${n} 단어 ${want}개`);
  return best;
}

// 번호 매기기 + 미리 채울 칸 고르기
function finish(best, spec, R) {
  // 쓰지 않는 바깥 줄·칸은 잘라낸다 → 판이 w×h, 칸이 커진다
  let r0 = 99, r1 = -1, c0 = 99, c1 = -1;
  best.g.forEach((row, y) => row.forEach((v, x) => { if (v) { r0 = Math.min(r0, y); r1 = Math.max(r1, y); c0 = Math.min(c0, x); c1 = Math.max(c1, x); } }));
  const g = best.g.slice(r0, r1 + 1).map(row => row.slice(c0, c1 + 1));
  const placed = best.placed.map(p => ({ ...p, r: p.r - r0, c: p.c - c0 }));
  const w = c1 - c0 + 1, h = r1 - r0 + 1, n = w;
  const starts = new Map();
  for (const p of placed) starts.set(p.r * n + p.c, true);
  const num = new Map(); let k = 0;
  for (let i = 0; i < n * n; i++) if (starts.has(i)) num.set(i, ++k);
  const words = placed.map(p => ({ num: num.get(p.r * n + p.c), d: p.d, r: p.r, c: p.c, w: p.w, e: p.e, clue: p.clue }))
    .sort((a, b) => (a.d === b.d ? a.num - b.num : a.d === 'a' ? -1 : 1));
  const cellsOf = w => syl(w.w).map((_, j) => (w.r + (w.d === 'd' ? j : 0)) * n + w.c + (w.d === 'a' ? j : 0));
  const all = [...new Set(words.flatMap(cellsOf))];
  const crossing = new Set(all.filter(i => words.filter(w => cellsOf(w).includes(i)).length > 1));
  // 미리 채우기: 겹치는 칸은 되도록 남겨 두고(풀면서 알아내는 재미), 낱말마다 빈칸이 최소 하나는 남게
  const target = Math.round(all.length * spec.given), given = new Set();
  const order = shuffle(all.filter(i => !crossing.has(i)), R).concat(shuffle(all.filter(i => crossing.has(i)), R));
  // 낱말 첫 글자를 먼저 열어 준다(저학년 힌트) — 첫 글자 후보를 앞으로
  const firsts = new Set(words.map(w => cellsOf(w)[0]));
  order.sort((a, b) => (firsts.has(b) ? 1 : 0) - (firsts.has(a) ? 1 : 0));
  for (const i of order) {
    if (given.size >= target) break;
    given.add(i);
    if (words.some(w => cellsOf(w).every(x => given.has(x)))) given.delete(i);
  }
  const grid = g.map(row => row.map(v => v || '.').join('')).join('');   // 칸마다 한 글자, 빈칸은 '.'
  return { w, h, grid, given: [...given].sort((a, b) => a - b), words };
}

const out = { tiers: [] };
for (const T of TIERS) {
  const file = join(HERE, `words-${T.id}.json`);
  const tier = { id: T.id, label: T.label, desc: T.desc, puzzles: [] };
  out.tiers.push(tier);
  if (!existsSync(file) || !T.levels) continue;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const seen = new Set();
  const pool = raw.map(([w, e, clue]) => ({ w, e, clue, s: syl(w) }))
    .filter(x => { if (seen.has(x.w)) throw new Error(`중복 낱말: ${x.w}`); seen.add(x.w); return x.s.length >= T.minLen && x.s.length <= T.maxLen; });
  const usedBefore = new Set();
  T.levels.forEach((spec, i) => {
    const R = rng(1000 * (TIERS.indexOf(T) + 1) + i + 1);
    // 앞 단계에서 쓴 낱말은 빼고 만든다(모자라면 다시 섞어 씀)
    let fresh = pool.filter(x => !usedBefore.has(x.w));
    if (fresh.length < 40) fresh = pool;
    const p = finish(makePuzzle(fresh, spec, R), spec, R);
    p.words.forEach(w => usedBefore.add(w.w));
    tier.puzzles.push(p);
    const rows = []; for (let y = 0; y < p.h; y++) rows.push(p.grid.slice(y * p.w, (y + 1) * p.w).replace(/\./g, '·'));
    console.log(`${T.label} ${i + 1}단계 ${p.w}×${p.h} 낱말 ${p.words.length} · 미리 ${p.given.length}칸\n  ${rows.join('\n  ')}\n  ${p.words.map(w => `${w.num}${w.d === 'a' ? '→' : '↓'}${w.w}`).join(' ')}`);
  });
}
writeFileSync(OUT, `// 낱말퍼즐 판 — tools/crossword/build.mjs 가 만든 파일입니다. 직접 고치지 말고 단어 목록을 고친 뒤 다시 만드세요.\nconst CW_DATA = ${JSON.stringify(out)};\n`);
console.log('→', OUT);
