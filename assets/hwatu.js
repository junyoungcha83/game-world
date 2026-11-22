// ── 화투(맞고) — 스포츠 ─────────────────────────────────
// 첫 화면: 게임하기 / 공부하기.
//  · 게임하기: 컴퓨터와 1:1(레벨 1~10, 3연승 승급·5연패 강등) 또는 친구와 1:1(방 코드, 테트리스 배틀과 같은 방 API)
//  · 공부하기: 1~12월 48장 나열·설명, 점수 내는 법
// 규칙은 2인 맞고 기본형: 10장씩·바닥 8장·더미 20장, 7점부터 고/스톱, 쪽·뻑·따닥·싹쓸이(피 1장 뺏기),
// 피박·광박·멍박·고박 2배. 흔들기·폭탄·총통·보너스패는 넣지 않았다.
// 친구 대결은 방장 폰이 판(엔진)을 돌리고 상태를 슬롯 a 에, 참가자는 자기 행동만 슬롯 b 에 쓴다.
// 이 파일은 app.js 보다 먼저 읽힌다 — app.js 의 함수(recordStat·roomPut 등)는 실행 시점에만 쓴다.

// 카드 정의 — 월마다 4장. t: G광 Y열끗 T띠 P피, pi: 피 장수(쌍피 2), tti: hong/cheong/cho, god: 고도리, bi: 비광, kj: 국진
const HW_MONTHS = [
  { m: 1, name: '송학', hanja: '松鶴', flower: '소나무', color: '#0f766e', desc: '소나무와 학. 새해와 오래 사는 것(장수)을 뜻해요. 광에는 학과 붉은 해가 그려져 있어요.' },
  { m: 2, name: '매조', hanja: '梅鳥', flower: '매화', color: '#be185d', desc: '매화와 꾀꼬리. 이른 봄을 알려요. 꾀꼬리 열끗은 고도리 새 중 하나예요.' },
  { m: 3, name: '벚꽃', hanja: '櫻', flower: '벚꽃', color: '#db2777', desc: '활짝 핀 벚꽃과 꽃구경 휘장(만막). 광이 있어요.' },
  { m: 4, name: '흑싸리', hanja: '藤', flower: '등나무', color: '#52525b', desc: '등나무 꽃과 두견새. 검은 싸리처럼 보여 흑싸리라 불러요. 두견새는 고도리 새예요.' },
  { m: 5, name: '난초', hanja: '菖蒲', flower: '창포', color: '#6d28d9', desc: '창포 꽃과 나무다리(팔교). 이름은 난초지만 사실은 창포예요.' },
  { m: 6, name: '모란', hanja: '牡丹', flower: '모란', color: '#b91c1c', desc: '꽃의 왕 모란과 나비. 띠는 청단이에요.' },
  { m: 7, name: '홍싸리', hanja: '萩', flower: '싸리', color: '#9a3412', desc: '붉은 싸리와 멧돼지. 띠는 초단이에요.' },
  { m: 8, name: '공산', hanja: '空山', flower: '억새', color: '#1e293b', desc: '억새 언덕 위 보름달(광)과 기러기 세 마리(고도리). 빈 산이라 공산이에요.' },
  { m: 9, name: '국화', hanja: '菊', flower: '국화', color: '#ca8a04', desc: '국화와 술잔. 술잔 열끗(국진)은 열끗으로도, 쌍피로도 쓸 수 있어요.' },
  { m: 10, name: '단풍', hanja: '楓', flower: '단풍', color: '#c2410c', desc: '단풍과 사슴. 띠는 청단이에요.' },
  { m: 11, name: '오동', hanja: '桐', flower: '오동나무', color: '#4d7c0f', desc: '오동잎과 봉황(광). 흔히 "똥"이라 불러요. 쌍피가 한 장 있어요.' },
  { m: 12, name: '비', hanja: '雨', flower: '버드나무', color: '#1d4ed8', desc: '비 오는 날. 우산 쓴 사람(비광), 제비, 띠, 번개(쌍피). 비광은 광 셋 점수를 깎아요.' },
];
const HW_DEF = {
  1:  [{ t: 'G', art: '🕊️', lb: '광' }, { t: 'T', art: '🌲', tti: 'hong' }, { t: 'P', art: '🌲' }, { t: 'P', art: '🌲' }],
  2:  [{ t: 'Y', art: '🐤', lb: '꾀꼬리', god: 1 }, { t: 'T', art: '💮', tti: 'hong' }, { t: 'P', art: '💮' }, { t: 'P', art: '💮' }],
  3:  [{ t: 'G', art: '🎪', lb: '광' }, { t: 'T', art: '🌸', tti: 'hong' }, { t: 'P', art: '🌸' }, { t: 'P', art: '🌸' }],
  4:  [{ t: 'Y', art: '🐦', lb: '두견새', god: 1 }, { t: 'T', art: '🍇', tti: 'cho' }, { t: 'P', art: '🍇' }, { t: 'P', art: '🍇' }],
  5:  [{ t: 'Y', art: '🌉', lb: '다리' }, { t: 'T', art: '🌾', tti: 'cho' }, { t: 'P', art: '🌾' }, { t: 'P', art: '🌾' }],
  6:  [{ t: 'Y', art: '🦋', lb: '나비' }, { t: 'T', art: '🌺', tti: 'cheong' }, { t: 'P', art: '🌺' }, { t: 'P', art: '🌺' }],
  7:  [{ t: 'Y', art: '🐗', lb: '멧돼지' }, { t: 'T', art: '🍂', tti: 'cho' }, { t: 'P', art: '🍂' }, { t: 'P', art: '🍂' }],
  8:  [{ t: 'G', art: '🌕', lb: '광' }, { t: 'Y', art: '🦢', lb: '기러기', god: 1 }, { t: 'P', art: '⛰️' }, { t: 'P', art: '⛰️' }],
  9:  [{ t: 'Y', art: '🍶', lb: '국진', kj: 1 }, { t: 'T', art: '🌼', tti: 'cheong' }, { t: 'P', art: '🌼' }, { t: 'P', art: '🌼' }],
  10: [{ t: 'Y', art: '🦌', lb: '사슴' }, { t: 'T', art: '🍁', tti: 'cheong' }, { t: 'P', art: '🍁' }, { t: 'P', art: '🍁' }],
  11: [{ t: 'G', art: '🦚', lb: '광' }, { t: 'P', art: '🌳', pi: 2 }, { t: 'P', art: '🌳' }, { t: 'P', art: '🌳' }],
  12: [{ t: 'G', art: '☂️', lb: '비광', bi: 1 }, { t: 'Y', art: '🐦', lb: '제비' }, { t: 'T', art: '🌧️', tti: 'rain' }, { t: 'P', art: '⚡', pi: 2 }],
};
const HW_TTI_LB = { hong: '홍단', cheong: '청단', cho: '초단', rain: '띠' };
const HW_CARDS = [];
for (let m = 1; m <= 12; m++) HW_DEF[m].forEach((d, k) => {
  const c = { id: (m - 1) * 4 + k, m, ...d };
  if (c.t === 'P') c.pi = c.pi || 1;
  if (!c.lb) c.lb = c.t === 'T' ? HW_TTI_LB[c.tti] : (c.pi === 2 ? '쌍피' : '피');
  HW_CARDS.push(c);
});
const HW_GO_AT = 7;             // 맞고: 7점부터 고/스톱
const HW_LV_KEY = 'hwatu', HW_VS_KEY = 'hwatu_vs';

// ── 점수 계산 ───────────────────────────────────────────
// 국진(9월 술잔)은 열끗·쌍피 중 점수가 더 높은 쪽으로 친다.
function hwScore(ids) {
  const cs = ids.map(i => HW_CARDS[i]);
  const best = [false, true].map(kjAsPi => hwScoreWith(cs, kjAsPi)).sort((a, b) => b.total - a.total)[0];
  return best;
}
function hwScoreWith(cs, kjAsPi) {
  const g = cs.filter(c => c.t === 'G'), hasBi = g.some(c => c.bi);
  const y = cs.filter(c => c.t === 'Y' && !(c.kj && kjAsPi));
  const t = cs.filter(c => c.t === 'T');
  const piN = cs.filter(c => c.t === 'P').reduce((s, c) => s + c.pi, 0) + (kjAsPi && cs.some(c => c.kj) ? 2 : 0);
  const parts = [];
  let gp = 0;
  if (g.length === 5) gp = 15; else if (g.length === 4) gp = 4; else if (g.length === 3) gp = hasBi ? 2 : 3;
  if (gp) parts.push(`${g.length === 3 && hasBi ? '비삼광' : g.length + '광'} ${gp}`);
  const yp = y.length >= 5 ? y.length - 4 : 0; if (yp) parts.push(`열끗 ${yp}`);
  const godori = y.filter(c => c.god).length === 3 ? 5 : 0; if (godori) parts.push('고도리 5');
  const tp = t.length >= 5 ? t.length - 4 : 0; if (tp) parts.push(`띠 ${tp}`);
  let dan = 0;
  for (const k of ['hong', 'cheong', 'cho']) if (t.filter(c => c.tti === k).length === 3) { dan += 3; parts.push(`${HW_TTI_LB[k]} 3`); }
  const pp = piN >= 10 ? piN - 9 : 0; if (pp) parts.push(`피 ${pp}`);
  return { total: gp + yp + godori + tp + dan + pp, gwang: g.length, gp, yeol: y.length, yp, pi: piN, pp, parts };
}

// ── 판 엔진 ─────────────────────────────────────────────
// S = { pile, floor, hands[2], caps[2], turn, goN[2], goAt[2], need, t(이번 턴), last(직전 턴 요약), end }
// need: null | {k:'pickHand'|'pickFlip', p, opts} | {k:'flip', p} | {k:'go', p, sc}
function hwShuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function hwDeal(first, rnd) {
  rnd = rnd || Math.random;
  for (;;) {
    const d = hwShuffle(HW_CARDS.map(c => c.id), rnd);
    const S = { hands: [d.slice(0, 10), d.slice(10, 20)], floor: d.slice(20, 28), pile: d.slice(28), caps: [[], []],
      turn: first || 0, goN: [0, 0], goAt: [0, 0], need: null, t: null, last: null, end: null, n: 0 };
    // 바닥에 같은 월 4장이 깔리면 다시 섞는다
    const cnt = {}; S.floor.forEach(i => cnt[HW_CARDS[i].m] = (cnt[HW_CARDS[i].m] || 0) + 1);
    if (Object.values(cnt).some(v => v >= 4)) continue;
    S.hands.forEach(h => h.sort((a, b) => a - b));
    return S;
  }
}
const hwM = i => HW_CARDS[i].m;
const hwRm = (arr, id) => { const k = arr.indexOf(id); if (k >= 0) arr.splice(k, 1); };
function hwFloorOf(S, m) { return S.floor.filter(i => hwM(i) === m); }

// 손패 한 장 내기
function hwPlay(S, id) {
  const p = S.turn;
  if (S.end || S.need || !S.hands[p].includes(id)) return false;
  hwRm(S.hands[p], id);
  const ms = hwFloorOf(S, hwM(id));
  const T = S.t = { p, c: id, d: null, mc: ms.length, take: [], other: null, steal: 0, ev: [] };
  if (ms.length === 0) S.floor.push(id);
  else if (ms.length === 1) { hwRm(S.floor, ms[0]); T.take.push(id, ms[0]); }
  else if (ms.length === 2) { S.need = { k: 'pickHand', p, opts: ms }; return true; }
  else { ms.forEach(i => hwRm(S.floor, i)); T.take.push(id, ...ms); T.steal++; T.ev.push('뻑 먹기'); }
  S.need = { k: 'flip', p };
  return true;
}
function hwPick(S, fid) {
  const nd = S.need, T = S.t;
  if (!nd || !nd.opts || !nd.opts.includes(fid)) return false;
  if (nd.k === 'pickHand') {
    hwRm(S.floor, fid); T.take.push(T.c, fid); T.other = nd.opts.find(i => i !== fid);
    S.need = { k: 'flip', p: T.p };
  } else {
    hwRm(S.floor, fid); hwRm(S.floor, T.d); T.take.push(T.d, fid);
    S.need = { k: 'collect', p: T.p };
  }
  return true;
}
// 더미 맨 위 한 장 뒤집기
function hwFlip(S) {
  const T = S.t; if (!S.need || S.need.k !== 'flip') return false;
  S.need = null;
  const d = T.d = S.pile.pop();
  if (hwM(d) === hwM(T.c)) {
    if (T.mc === 0) { hwRm(S.floor, T.c); T.take.push(T.c, d); T.steal++; T.ev.push('쪽'); }
    else if (T.mc === 1) { S.floor.push(...T.take, d); T.take = []; T.ev.push('뻑'); }
    else if (T.mc === 2) { hwRm(S.floor, T.other); T.take.push(d, T.other); T.steal++; T.ev.push('따닥'); }
  } else {
    const ms = hwFloorOf(S, hwM(d));
    if (ms.length === 0) S.floor.push(d);
    else if (ms.length === 1) { hwRm(S.floor, ms[0]); T.take.push(d, ms[0]); }
    else if (ms.length === 2) { S.floor.push(d); S.need = { k: 'pickFlip', p: T.p, opts: ms }; return true; }
    else { ms.forEach(i => hwRm(S.floor, i)); T.take.push(d, ...ms); T.steal++; T.ev.push('뻑 먹기'); }
  }
  // 가져갈 패가 있으면 바닥에 잠깐 보여준 뒤(collect) 먹은 패로 옮긴다 — 무엇을 먹는지 눈으로 확인
  if (T.take.length) S.need = { k: 'collect', p: T.p }; else hwFinish(S);
  return true;
}
function hwCollect(S) {
  if (!S.need || S.need.k !== 'collect') return false;
  S.need = null; hwFinish(S); return true;
}
function hwStealPi(S, to) {
  const from = S.caps[1 - to];
  const pick = from.find(i => HW_CARDS[i].t === 'P' && HW_CARDS[i].pi === 1) ?? from.find(i => HW_CARDS[i].t === 'P');
  if (pick == null) return false;
  hwRm(from, pick); S.caps[to].push(pick); return true;
}
function hwFinish(S) {
  const T = S.t, p = T.p;
  S.caps[p].push(...T.take);
  if (T.take.length && S.floor.length === 0 && S.pile.length > 0) { T.steal++; T.ev.push('싹쓸이'); }
  let stolen = 0; for (let k = 0; k < T.steal; k++) if (hwStealPi(S, p)) stolen++;
  if (stolen) T.ev.push(`피 ${stolen}장 뺏기`);
  S.last = { p, c: T.c, d: T.d, take: T.take.slice(), ev: T.ev.slice() };
  S.t = null; S.n++;
  const sc = hwScore(S.caps[p]).total;
  if (sc >= HW_GO_AT && sc > S.goAt[p]) {
    if (S.hands[p].length === 0) return hwStop(S, p);          // 낼 패가 없으면 자동 스톱
    S.need = { k: 'go', p, sc }; return;
  }
  hwNext(S);
}
function hwNext(S) {
  if (S.hands[0].length === 0 && S.hands[1].length === 0) { S.end = { draw: true }; return; }   // 나가리
  S.turn = 1 - S.turn;
  if (S.hands[S.turn].length === 0) S.turn = 1 - S.turn;
}
function hwGo(S, go) {
  const nd = S.need; if (!nd || nd.k !== 'go') return false;
  S.need = null;
  if (!go) return hwStop(S, nd.p);
  S.goN[nd.p]++; S.goAt[nd.p] = nd.sc;
  S.last = { ...(S.last || {}), ev: [...((S.last && S.last.ev) || []), `${S.goN[nd.p]}고!`] };
  hwNext(S);
  return true;
}
function hwStop(S, w) {
  const me = hwScore(S.caps[w]), op = hwScore(S.caps[1 - w]), g = S.goN[w];
  let pts = me.total + g; const mult = [];
  if (g >= 3) mult.push([`${g}고`, Math.pow(2, g - 2)]);
  if (me.pp > 0 && op.pi > 0 && op.pi <= 5) mult.push(['피박', 2]);
  if (me.gp > 0 && op.gwang === 0) mult.push(['광박', 2]);
  if (me.yeol >= 7) mult.push(['멍박', 2]);
  if (S.goN[1 - w] > 0) mult.push(['고박', 2]);
  for (const [, x] of mult) pts *= x;
  S.end = { w, pts, base: me.total, goN: g, parts: me.parts, mult: mult.map(m => m[0] + (m[1] > 2 ? ` ×${m[1]}` : ' ×2')) };
  return true;
}

// ── 컴퓨터(레벨 1~10) ───────────────────────────────────
// 레벨이 낮으면 무작위성이 크고, 높을수록 '필요한 패' 계산 + 상대 견제 + 위험한 패 내기 회피를 한다.
function hwNeedVal(id, caps) {
  const c = HW_CARDS[id], cs = caps.map(i => HW_CARDS[i]);
  if (c.t === 'G') { const n = cs.filter(x => x.t === 'G').length; return (c.bi ? 2.4 : 3) + (n >= 2 ? 3 : n); }
  if (c.t === 'Y') {
    if (c.kj) return 2.3;
    const ny = cs.filter(x => x.t === 'Y').length;
    if (c.god) return 2 + 1.6 * cs.filter(x => x.god).length;
    return 1.2 + (ny >= 4 ? 1 : 0);
  }
  if (c.t === 'T') {
    if (c.tti === 'rain') return 1 + (cs.filter(x => x.t === 'T').length >= 4 ? 1 : 0);
    return 1.5 + 1.5 * cs.filter(x => x.tti === c.tti).length;
  }
  const np = cs.filter(x => x.t === 'P').reduce((s, x) => s + x.pi, 0);
  return c.pi * (np >= 7 ? 1.5 : 1);
}
const HW_NOISE = [12, 9, 7, 5, 3.6, 2.6, 1.8, 1.1, 0.6, 0.25];
function hwAiPlay(S, lv) {
  const p = S.turn, o = 1 - p, noise = HW_NOISE[lv - 1] || 1;
  const seen = {};   // 보이는 패(바닥·먹은 패·내 손) 월별 수 → 남은 장 수로 위험도
  [...S.floor, ...S.caps[0], ...S.caps[1], ...S.hands[p]].forEach(i => seen[hwM(i)] = (seen[hwM(i)] || 0) + 1);
  const val = i => hwNeedVal(i, S.caps[p]) + (lv >= 5 ? 0.12 * lv * hwNeedVal(i, S.caps[o]) * 0.5 : 0);
  const top = S.pile[S.pile.length - 1], sense = lv >= 8 && Math.random() < [0.4, 0.7, 1][lv - 8];
  let best = null, bestV = -1e9;
  for (const id of S.hands[p]) {
    const ms = hwFloorOf(S, hwM(id));
    let v;
    if (ms.length === 0) {
      const risk = (4 - (seen[hwM(id)] || 0)) / 3;                 // 상대가 같은 월을 들고 있을 가능성
      v = -(lv >= 4 ? 0.7 * risk * hwNeedVal(id, S.caps[o]) : 0.3);
      if (lv >= 8 && risk === 0) v += 0.6;                           // 남은 짝이 없는 패는 안전하게 버리기
    } else if (ms.length === 1) v = val(id) + val(ms[0]);
    else if (ms.length === 2) v = val(id) + Math.max(val(ms[0]), val(ms[1])) - (lv >= 6 ? 0.3 * Math.min(hwNeedVal(ms[0], S.caps[o]), hwNeedVal(ms[1], S.caps[o])) : 0);
    else v = val(id) + ms.reduce((s, i) => s + val(i), 0) + 1.5;
    // 레벨 8~10: 고수의 '감'(8은 가끔, 10은 항상) — 더미 맨 위 패와 같은 월이면 쪽·따닥을 노리고 뻑은 피한다
    if (sense && top != null && hwM(top) === hwM(id)) {
      if (ms.length === 0) v += val(id) + val(top) + 1.5;
      else if (ms.length === 1) v -= val(id) + val(ms[0]) + 1;
      else if (ms.length === 2) v += Math.min(val(ms[0]), val(ms[1])) + val(top) + 1.5;
    }
    v += (Math.random() - 0.5) * noise;
    if (v > bestV) { bestV = v; best = id; }
  }
  return best;
}
function hwAiPick(S, lv) {
  const p = S.need.p, o = 1 - p, opts = S.need.opts;
  if (lv <= 2) return opts[Math.floor(Math.random() * opts.length)];
  const v = i => hwNeedVal(i, S.caps[p]) + (lv >= 5 ? 0.5 * hwNeedVal(i, S.caps[o]) : 0) + (Math.random() - 0.5) * HW_NOISE[lv - 1] * 0.3;
  return v(opts[0]) >= v(opts[1]) ? opts[0] : opts[1];
}
function hwAiGo(S, lv) {
  const p = S.need.p, o = 1 - p, left = S.hands[p].length, opSc = hwScore(S.caps[o]).total;
  if (lv <= 2) return left >= 2 && Math.random() < 0.5;
  if (left <= 1 || S.goN[p] >= 3) return false;
  const safe = lv >= 7 ? 2 : lv >= 4 ? 3 : 4;
  if (opSc > safe) return false;
  return left >= (lv >= 7 ? 3 : 2) && Math.random() < (lv >= 7 ? 0.85 : 0.6);
}

// ── 레벨 기록 ───────────────────────────────────────────
// 기록 키 hwatu: plays/wins/losses/draws + lv(현재 레벨), ws(연승), lz(연패), best(최고 도달 레벨)
function hwLvInfo() {
  const s = (typeof getStat === 'function' && getStat(HW_LV_KEY)) || {};
  return { lv: Math.min(10, Math.max(1, s.lv || 1)), ws: s.ws || 0, lz: s.lz || 0 };
}
function hwRecordAi(result) {
  const u = getCurrentUser(); if (!u) return null;
  state.scores[u.id] = state.scores[u.id] || {};
  const s = state.scores[u.id][HW_LV_KEY] = normStat(state.scores[u.id][HW_LV_KEY]);
  let lv = Math.min(10, Math.max(1, s.lv || 1)), ws = s.ws || 0, lz = s.lz || 0, change = 0;
  if (result === 'win') { ws++; lz = 0; if (ws >= 3) { ws = 0; if (lv < 10) { lv++; change = 1; } } }
  else if (result === 'loss') { lz++; ws = 0; if (lz >= 5) { lz = 0; if (lv > 1) { lv--; change = -1; } } }
  s.lv = lv; s.ws = ws; s.lz = lz;
  recordStat(HW_LV_KEY, { result, best: lv });
  return { lv, ws, lz, change };
}
function hwFmt(s) { return s ? `레벨 ${s.lv || 1} · ${s.wins}승 ${s.losses}패` : '아직 기록 없음'; }
function hwVsFmt(s) { return s ? `${s.plays}판 · ${s.wins}승 ${s.losses}패` : '아직 기록 없음'; }
function hwAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const a = getStat(HW_LV_KEY, u), b = getStat(HW_VS_KEY, u), parts = [];
  if (a && a.plays) parts.push(`레벨 ${a.lv || 1}`);
  if (b && b.plays) parts.push(`친구전 ${b.wins}승`);
  return parts.length ? parts.join(' · ') : '아직 기록 없음';
}

// ── 그리기 ──────────────────────────────────────────────
// 실제 화투 그림 — assets/hwatu/MM-K.webp (Wikimedia Commons 'Hwatu' SVG, CC BY-SA 4.0 → WebP 변환)
const hwImg = id => `assets/hwatu/${String(HW_CARDS[id].m).padStart(2, '0')}-${id % 4}.webp?v=1`;
function hwCard(id, cls) {
  const c = HW_CARDS[id];
  return `<div class="hw-card ${cls || ''}" data-id="${id}" style="background-image:url('${hwImg(id)}')" title="${c.m}월 ${c.lb}"></div>`;
}
// 공부하기용 — 카드 아래에 이름표
function hwCardCap(id, cls) {
  const c = HW_CARDS[id];
  return `<figure class="hw-fig">${hwCard(id, cls)}<figcaption>${c.lb}</figcaption></figure>`;
}
const hwBack = (cls) => `<div class="hw-card back ${cls || ''}"></div>`;
// 먹은 패 — 광/열끗/띠/피 네 묶음
function hwCapsHTML(ids) {
  const g = { G: [], Y: [], T: [], P: [] };
  ids.forEach(i => g[HW_CARDS[i].t].push(i));
  const piN = g.P.reduce((s, i) => s + HW_CARDS[i].pi, 0);
  const lab = { G: '광', Y: '열', T: '띠', P: '피' };
  return ['G', 'Y', 'T', 'P'].map(k => `<div class="hw-cap">
    <span class="hw-cap-n">${lab[k]} ${k === 'P' ? piN : g[k].length}</span>
    <div class="hw-cap-cards">${g[k].sort((a, b) => a - b).map(i => hwCard(i, 'mini')).join('')}</div></div>`).join('');
}

// ── 첫 화면 ─────────────────────────────────────────────
let hwStopLoop = null;   // 친구전 폴링 중단 함수
function hwLeave() { if (hwStopLoop) { hwStopLoop(); hwStopLoop = null; } }
function startHwatu(el) {
  hwLeave();
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => { hwLeave(); showView('hub'); };
  el.innerHTML = `<div class="hw hw-home">
    <div class="hw-title">🎴 화투</div>
    <div class="hw-home-cards">${[0, 8, 28, 44].map(i => hwCard(i)).join('')}</div>
    <div class="omok-levels">
      <button data-a="play">🎮 게임하기<small>컴퓨터 또는 친구와 1:1 맞고</small></button>
      <button data-a="study">📖 공부하기<small>1~12월 패 · 점수 내는 법</small></button>
    </div>
  </div>`;
  el.querySelector('[data-a="play"]').onclick = () => hwPlayMenu(el);
  el.querySelector('[data-a="study"]').onclick = () => hwStudy(el);
}
function hwPlayMenu(el) {
  hwLeave();
  document.getElementById('gameBack').onclick = () => startHwatu(el);
  const L = hwLvInfo();
  const stars = Array.from({ length: 10 }, (_, i) => `<i class="${i < L.lv ? 'on' : ''}"></i>`).join('');
  el.innerHTML = `<div class="hw hw-home">
    <div class="hw-title">🎮 게임하기</div>
    <div class="hw-lvbox">
      <div class="hw-lvbar">${stars}</div>
      <div>현재 <b>레벨 ${L.lv}</b>${L.lv === 10 ? ' (최고)' : ''}</div>
      <small>연승 ${L.ws}/3 → 레벨 업 · 연패 ${L.lz}/5 → 레벨 다운</small>
    </div>
    <div class="omok-levels">
      <button data-a="ai">🤖 컴퓨터와 대결<small>레벨 ${L.lv} 컴퓨터 · 3연승하면 레벨 업</small></button>
      <button data-a="host">👥 친구와 대결 · 방 만들기<small>다른 폰과 1:1 · 코드 공유</small></button>
      <button data-a="join">👥 친구와 대결 · 참가하기<small>받은 방 코드로 입장</small></button>
    </div>
  </div>`;
  el.querySelector('[data-a="ai"]').onclick = () => hwRunAi(el, 0);
  el.querySelector('[data-a="host"]').onclick = () => hwHost(el);
  el.querySelector('[data-a="join"]').onclick = () => hwJoin(el);
}

// ── 판 화면(공용) ───────────────────────────────────────
// ctx: { me, names[2], lv?, onPlay(id), onPick(id), onGo(bool), onAgain?, againLabel?, waitMsg? }
function hwRender(el, S, ctx) {
  const me = ctx.me, op = 1 - me;
  const lock = !!ctx.lock;
  const myTurn = !lock && !S.end && S.turn === me && !S.need;
  const pickMine = !lock && S.need && S.need.p === me && (S.need.k === 'pickHand' || S.need.k === 'pickFlip');
  const myMonths = new Set(S.floor.map(hwM));
  const scMe = hwScore(S.caps[me]), scOp = hwScore(S.caps[op]);
  // 바닥: 월별로 묶어 보여준다
  const prev = hwSnap(el);            // 다시 그리기 전 카드 위치 — 움직임 애니메이션의 출발점
  const groups = {}, T = S.t;
  const show = S.floor.slice();
  if (T) { show.push(...T.take); if (S.need && S.need.k === 'pickHand') show.push(T.c); }
  show.forEach(i => (groups[hwM(i)] = groups[hwM(i)] || []).push(i));
  const lastIds = T ? [T.c, T.d] : S.last ? [S.last.c, S.last.d] : [];
  const floorHTML = Object.keys(groups).sort((a, b) => a - b).map(m => `<div class="hw-fgrp">${groups[m].map(i =>
    hwCard(i, (pickMine && S.need.opts.includes(i) ? 'pick ' : '') + (lastIds.includes(i) ? 'fresh' : ''))).join('')}</div>`).join('');
  let msg = '';
  if (S.end) msg = '';
  else if (S.need && S.need.k === 'go') msg = S.need.p === me ? `${S.need.sc}점! 고 할까요, 스톱 할까요?` : `${ctx.names[op]} 고/스톱 고민 중…`;
  else if (pickMine) msg = '가져올 바닥 패를 골라요 👇';
  else if (S.need && S.need.k === 'flip') msg = '패를 뒤집는 중…';
  else if (S.need && S.need.k === 'collect') msg = `${S.need.p === me ? '내가' : ctx.names[op] + '이(가)'} 패를 가져가요`;
  else if (myTurn) msg = '낼 패를 골라요 (빛나는 패는 바닥에 짝이 있어요)';
  else msg = ctx.waitMsg || `${ctx.names[op]} 차례…`;
  const evText = S.last && S.last.ev.length ? `<span class="hw-ev">${S.last.p === me ? '나' : escapeHtml(ctx.names[op])}: ${S.last.ev.join(' · ')}</span>` : '';
  el.innerHTML = `<div class="hw hw-play">
    <div class="hw-side op">
      <div class="hw-who"><b>${escapeHtml(ctx.names[op])}</b>${ctx.lv ? `<span class="hw-chip">Lv.${ctx.lv}</span>` : ''}
        <span class="hw-sc">${scOp.total}점</span>${S.goN[op] ? `<span class="hw-chip go">${S.goN[op]}고</span>` : ''}
        <span class="hw-opp-hand">${S.end && S.hands[op].length ? S.hands[op].map(i => hwCard(i, 'tiny')).join('') : S.hands[op].map(() => hwBack('tiny')).join('')}</span></div>
      <div class="hw-caps">${hwCapsHTML(S.caps[op])}</div>
    </div>
    <div class="hw-floor">
      <div class="hw-pile">${S.pile.length ? hwBack() : ''}<span>${S.pile.length}</span></div>
      ${floorHTML}
    </div>
    <div class="hw-msg">${escapeHtml(msg)} ${evText}</div>
    <div class="hw-side me">
      <div class="hw-caps">${hwCapsHTML(S.caps[me])}</div>
      <div class="hw-who"><b>나</b><span class="hw-sc">${scMe.total}점</span>${S.goN[me] ? `<span class="hw-chip go">${S.goN[me]}고</span>` : ''}
        <span class="hw-parts">${scMe.parts.join(' · ')}</span></div>
    </div>
    <div class="hw-hand ${myTurn ? 'active' : ''}">${S.hands[me].map(i => hwCard(i, myTurn && myMonths.has(hwM(i)) ? 'match' : '')).join('')}</div>
    <div class="hw-over hidden"></div>
  </div>`;
  hwAnimate(el, prev, S, me);
  if (myTurn) el.querySelectorAll('.hw-hand .hw-card').forEach(c => c.onclick = () => ctx.onPlay(+c.dataset.id));
  if (pickMine) el.querySelectorAll('.hw-floor .hw-card.pick').forEach(c => c.onclick = () => ctx.onPick(+c.dataset.id));
  const over = el.querySelector('.hw-over');
  if (!lock && S.need && S.need.k === 'go' && S.need.p === me) {
    over.classList.remove('hidden');
    over.innerHTML = `<div class="hw-dlg"><div class="hw-dlg-t">${S.need.sc}점 났어요!</div>
      <p>고: 계속해서 점수를 더 키워요 (+1점, 3고부터 2배씩)<br>스톱: 여기서 끝내고 이겨요</p>
      <div class="hw-dlg-b"><button class="btn primary" data-g="1">고!</button><button class="btn" data-g="0">스톱</button></div></div>`;
    over.querySelectorAll('[data-g]').forEach(b => b.onclick = () => ctx.onGo(b.dataset.g === '1'));
  }
  if (S.end) {
    over.classList.remove('hidden');
    const E = S.end, win = !E.draw && E.w === me;
    const head = E.draw ? '나가리 (무승부) 🤝' : win ? `이겼어요! 🎉 ${E.pts}점` : `졌어요 😢 ${E.pts}점`;
    const detail = E.draw ? '아무도 7점을 못 내고 패가 다 떨어졌어요.'
      : `${E.w === me ? '내' : escapeHtml(ctx.names[op]) + '의'} 점수: ${E.parts.join(' · ')}${E.goN ? ` · ${E.goN}고(+${E.goN})` : ''}${E.mult.length ? `<br>배수: ${E.mult.join(' · ')}` : ''}`;
    over.innerHTML = `<div class="hw-dlg"><div class="hw-dlg-t">${head}</div><p>${detail}</p>${ctx.endNote || ''}
      <div class="hw-dlg-b">${ctx.onAgain ? `<button class="btn primary" data-x="again">${ctx.againLabel || '한 판 더'}</button>` : ''}
        <button class="btn ghost" data-x="out">나가기</button><button class="btn ghost" data-x="see">판 보기</button></div></div>`;
    const a = over.querySelector('[data-x="again"]'); if (a) a.onclick = ctx.onAgain;
    over.querySelector('[data-x="out"]').onclick = ctx.onOut;
    over.querySelector('[data-x="see"]').onclick = () => { over.classList.add('hidden'); const m = el.querySelector('.hw-msg');
      if (m) { m.innerHTML = ''; const b = document.createElement('button'); b.className = 'btn small'; b.textContent = '결과 다시 보기'; b.onclick = () => over.classList.remove('hidden'); m.appendChild(b); } };
  }
}

// 카드 이동 애니메이션(FLIP) — 다시 그리기 전/후 같은 카드(data-id)의 위치 차이만큼 되돌려 놓았다가 미끄러지게 한다.
// 이전 화면에 없던 카드는 출발점을 추정: 이번 턴에 뒤집은 패 = 더미, 상대가 낸 패 = 상대 손패 자리.
// 두 단계로 나눈다: ① 자리를 옮기는 패(손→바닥, 더미→바닥, 바닥→먹은 패)가 먼저 천천히 움직이고
// ② 그게 끝난 뒤에 바닥에 남은 패와 더미가 새 자리로 정리된다 — 한꺼번에 움직이면 정신없어서.
const HW_MOVE = 750, HW_SETTLE = 450;   // ms
const hwZone = c => c.closest('.hw-floor') ? 'floor' : c.closest('.hw-caps') ? 'caps' : c.closest('.hw-hand') ? 'hand' : 'other';
function hwSnap(el) {
  const r = { z: {} }; if (!el.querySelector('.hw-play')) return r;
  el.querySelectorAll('.hw-card[data-id]').forEach(c => { r[c.dataset.id] = c.getBoundingClientRect(); r.z[c.dataset.id] = hwZone(c); });
  const pile = el.querySelector('.hw-pile'), oh = el.querySelector('.hw-opp-hand');
  if (pile) r.pile = pile.getBoundingClientRect();
  if (oh) r.opp = oh.getBoundingClientRect();
  return r;
}
function hwSlide(c, from, delay, dur) {
  const to = c.getBoundingClientRect();
  const dx = from.left - to.left, dy = from.top - to.top;
  if (Math.abs(dx) + Math.abs(dy) < 3) return false;
  const sc = to.width ? from.width / to.width : 1;
  c.style.animation = 'none';                      // 깜빡임(hwPulse)이 transform을 덮지 않게 잠시 끔
  c.style.transition = 'none'; c.style.transformOrigin = '0 0';
  c.style.transform = `translate(${dx}px, ${dy}px) scale(${sc})`; c.style.zIndex = delay ? 5 : 20;
  c.getBoundingClientRect();                       // 강제 reflow — 출발 위치를 먼저 확정
  c.style.transition = `transform ${dur}ms cubic-bezier(.3,.7,.3,1) ${delay}ms`;
  c.style.transform = '';
  setTimeout(() => { c.style.zIndex = ''; c.style.transition = ''; c.style.transformOrigin = ''; c.style.animation = ''; }, delay + dur + 20);
  return true;
}
function hwAnimate(el, prev, S, me) {
  if (!prev.pile) return;
  const T = S.t || null, L = S.last || {};
  const flipped = T ? T.d : L.d, played = T ? T.c : L.c, actor = T ? T.p : L.p;
  const settle = [];                                // ② 단계: 바닥에 그대로 남아 자리만 바뀐 패
  let moved = false;
  el.querySelectorAll('.hw-card[data-id]').forEach(c => {
    const id = c.dataset.id;
    let from = prev[id];
    if (!from) {
      if (+id === flipped) from = prev.pile;
      else if (+id === played && actor !== me) from = prev.opp;
      else return;
    }
    if (prev.z[id] === 'floor' && hwZone(c) === 'floor') settle.push([c, from]);
    else if (hwSlide(c, from, 0, HW_MOVE)) moved = true;
  });
  const delay = moved ? HW_MOVE : 0;
  settle.forEach(([c, from]) => hwSlide(c, from, delay, HW_SETTLE));
  const pile = el.querySelector('.hw-pile');
  if (pile) hwSlide(pile, prev.pile, delay, HW_SETTLE);
}

// ── 컴퓨터와 대결 ───────────────────────────────────────
function hwRunAi(el, first) {
  hwLeave();
  document.getElementById('gameBack').onclick = () => { live = false; hwPlayMenu(el); };
  const L = hwLvInfo(), lv = L.lv;
  const S = hwDeal(first);
  let live = true, recorded = false;
  const alive = () => live && !!el.querySelector('.hw');
  const ctx = {
    me: 0, names: [myTetName ? myTetName() : '나', '컴퓨터'], lv,
    onPlay: id => { if (hwPlay(S, id)) step(); },
    onPick: id => { if (hwPick(S, id)) step(); },
    onGo: go => { hwGo(S, go); step(); },
    onAgain: () => hwRunAi(el, S.end && !S.end.draw ? S.end.w : first),
    onOut: () => { live = false; hwPlayMenu(el); },
  };
  hwStopLoop = () => { live = false; };
  function step() {
    if (!alive()) return;
    if (S.end && !recorded) {
      recorded = true;
      const res = S.end.draw ? 'draw' : S.end.w === 0 ? 'win' : 'loss';
      const r = hwRecordAi(res);
      if (r) ctx.endNote = `<div class="hw-lvnote ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : ''}">${
        r.change > 0 ? `⬆️ 3연승! 레벨 ${r.lv}(으)로 올랐어요` : r.change < 0 ? `⬇️ 5연패… 레벨 ${r.lv}(으)로 내려갔어요`
        : res === 'win' ? `연승 ${r.ws}/3${r.lv === 10 ? ' · 최고 레벨!' : ''}` : res === 'loss' ? `연패 ${r.lz}/5` : '무승부는 연승·연패에 들어가지 않아요'}</div>`;
    }
    hwRender(el, S, ctx);
    if (S.end) return;
    if (S.need && S.need.k === 'flip') { setTimeout(() => { if (alive()) { hwFlip(S); step(); } }, 1300); return; }
    if (S.need && S.need.k === 'collect') { setTimeout(() => { if (alive()) { hwCollect(S); step(); } }, 1400); return; }
    if (S.turn === 1 || (S.need && S.need.p === 1)) setTimeout(() => {
      if (!alive()) return;
      if (S.need && S.need.k === 'go') hwGo(S, hwAiGo(S, lv));
      else if (S.need && S.need.opts) hwPick(S, hwAiPick(S, lv));
      else if (!S.need) hwPlay(S, hwAiPlay(S, lv));
      step();
    }, S.need ? 1100 : 1500);
  }
  step();
}

// ── 친구와 대결(방 코드) ────────────────────────────────
// 방장(a)이 판을 돌린다: 슬롯 a = { kind, S, seq, names, g(판 번호) }, 슬롯 b = { name, act: { n, k, v } }
function hwLobby(el, html) { el.innerHTML = `<div class="hw hw-home">${html}</div>`; }
async function hwHost(el) {
  hwLeave();
  let live = true; hwStopLoop = () => { live = false; };
  document.getElementById('gameBack').onclick = () => { hwLeave(); hwPlayMenu(el); };
  const code = tetGenCode(), name = myTetName();
  hwLobby(el, '<div class="mg-msg">방 만드는 중…</div>');
  try {
    const r = await roomPutMeta(code, { kind: 'hwatu', host: name, at: Date.now() });
    if (!r.ok) throw new Error('net');
    await roomPut(code, 'a', { kind: 'hwatu', S: null, seq: 0, names: [name, ''], g: 0 });
  } catch (_) {
    hwLobby(el, '<div class="mg-msg">연결 실패 😥<br><small>인터넷을 확인하고 다시 시도해 주세요</small></div><button class="btn ghost" id="hwB">◀ 뒤로</button>');
    el.querySelector('#hwB').onclick = () => hwPlayMenu(el); return;
  }
  hwLobby(el, `<div class="mg-msg">방이 열렸어요</div><div class="tet-code">${code}</div>
    <p class="tet-lobtip">상대에게 이 <b>코드</b>를 알려주세요<br>상대는 화투 → 게임하기 → 참가하기</p>
    <div class="tet-wait">상대를 기다리는 중…</div><button class="btn ghost" id="hwB">취소</button>`);
  el.querySelector('#hwB').onclick = () => { hwLeave(); hwPlayMenu(el); };
  let opp = null;
  while (live && !opp) {
    const room = await roomGet(code);
    if (room && room.b && room.b.name) opp = room.b.name;
    else await tetSleep(800);
  }
  if (!live) return;
  // 판 시작
  let S, seq = 0, g = 0, handled = 0, recorded = -1;
  const names = [name, opp];
  const push = () => roomPut(code, 'a', { kind: 'hwatu', S, seq: ++seq, names, g });
  const newGame = (first) => { S = hwDeal(first); g++; push(); draw(); };
  const ctx = { me: 0, names,
    onPlay: id => { if (S.turn === 0 && hwPlay(S, id)) after(); },
    onPick: id => { if (hwPick(S, id)) after(); },
    onGo: go => { hwGo(S, go); after(); },
    onAgain: () => newGame(S.end && !S.end.draw ? S.end.w : 0), againLabel: '한 판 더',
    onOut: () => { hwLeave(); hwPlayMenu(el); },
  };
  document.getElementById('gameBack').onclick = () => { hwLeave(); hwPlayMenu(el); };
  function draw() {
    if (!live) return;
    if (S.end && recorded !== g) {
      recorded = g;
      recordStat(HW_VS_KEY, { result: S.end.draw ? 'draw' : S.end.w === 0 ? 'win' : 'loss' });
    }
    hwRender(el, S, ctx);
  }
  function after() {
    push(); draw();
    if (S.need && S.need.k === 'flip') setTimeout(() => { if (live) { hwFlip(S); after(); } }, 1300);
    if (S.need && S.need.k === 'collect') setTimeout(() => { if (live) { hwCollect(S); after(); } }, 1400);
  }
  newGame(0);
  // 상대 행동 받기
  (async () => {
    while (live) {
      await tetSleep(800);
      if (!live) return;
      const room = await roomGet(code);
      const act = room && room.b && room.b.act;
      if (!act || act.n <= handled || act.g !== g) continue;
      handled = act.n;
      let ok = false;
      if (act.k === 'play' && S.turn === 1 && !S.need) ok = hwPlay(S, act.v);
      else if (act.k === 'pick' && S.need && S.need.p === 1) ok = hwPick(S, act.v);
      else if (act.k === 'go' && S.need && S.need.k === 'go' && S.need.p === 1) ok = hwGo(S, !!act.v);
      if (ok) after();
    }
  })();
}
function hwJoin(el) {
  hwLeave();
  document.getElementById('gameBack').onclick = () => hwPlayMenu(el);
  hwLobby(el, `<div class="mg-msg">방 코드를 입력하세요</div>
    <input id="hwCode" class="tet-codein" maxlength="4" autocapitalize="characters" placeholder="ABCD" />
    <div id="hwJMsg" class="tet-lobtip"></div>
    <div class="tet-joinbtns"><button class="btn primary" id="hwGo">참가</button><button class="btn ghost" id="hwB">◀ 뒤로</button></div>`);
  const inp = el.querySelector('#hwCode');
  inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); };
  el.querySelector('#hwB').onclick = () => hwPlayMenu(el);
  el.querySelector('#hwGo').onclick = async () => {
    const code = inp.value.trim(), msg = el.querySelector('#hwJMsg');
    if (code.length < 3) { msg.textContent = '코드를 정확히 입력해 주세요'; return; }
    msg.textContent = '방을 찾는 중…';
    let meta; try { meta = await roomGetMeta(code); } catch (_) { msg.textContent = '연결 실패 — 다시 시도해 주세요'; return; }
    if (!meta) { msg.textContent = '그런 방이 없어요. 코드를 확인해 주세요'; return; }
    if (meta.kind !== 'hwatu') { msg.textContent = '화투 방이 아니에요 (테트리스 방 코드인지 확인해 주세요)'; return; }
    hwGuest(el, code, meta.host || '상대');
  };
}
async function hwGuest(el, code, hostName) {
  hwLeave();
  let live = true; hwStopLoop = () => { live = false; };
  document.getElementById('gameBack').onclick = () => { hwLeave(); hwPlayMenu(el); };
  const name = myTetName();
  let n = 0, g = 0, seq = -1, S = null, recorded = -1, sending = false;
  const send = (k, v) => { if (sending) return; sending = true; roomPut(code, 'b', { name, act: { n: ++n, g, k, v } }).finally(() => { sending = false; }); ctx.waitMsg = '보내는 중…'; ctx.lock = true; hwRender(el, S, ctx);
    // 방장 쪽에서 무시된 행동(늦게 도착 등)이면 판이 안 바뀐다 — 6초 뒤 잠금을 풀어 다시 고를 수 있게
    const at = seq; setTimeout(() => { if (live && ctx.lock && seq === at) { ctx.lock = false; ctx.waitMsg = null; hwRender(el, S, ctx); } }, 6000); };
  await roomPut(code, 'b', { name, act: null });
  hwLobby(el, `<div class="mg-msg">${escapeHtml(hostName)} 님의 방에 들어왔어요</div><div class="tet-wait">판을 나누는 중…</div>`);
  const ctx = { me: 1, names: [hostName, name],
    onPlay: id => send('play', id), onPick: id => send('pick', id), onGo: go => send('go', go ? 1 : 0),
    onAgain: null, onOut: () => { hwLeave(); hwPlayMenu(el); },
    endNote: '<p class="hw-lvnote">방장이 "한 판 더"를 누르면 바로 이어서 해요</p>',
  };
  while (live) {
    const room = await roomGet(code);
    const a = room && room.a;
    if (a && a.S && a.seq !== seq) {
      seq = a.seq; S = a.S; g = a.g; ctx.names = a.names; ctx.waitMsg = null; ctx.lock = false;
      if (S.end && recorded !== g) { recorded = g; recordStat(HW_VS_KEY, { result: S.end.draw ? 'draw' : S.end.w === 1 ? 'win' : 'loss' }); }
      if (live) hwRender(el, S, ctx);
    }
    await tetSleep(800);
  }
}

// ── 공부하기 ────────────────────────────────────────────
function hwStudy(el, tab) {
  hwLeave();
  document.getElementById('gameBack').onclick = () => startHwatu(el);
  tab = tab || 'cards';
  const ex = (ids) => `<span class="hw-ex">${ids.map(i => hwCardCap(i, 'small')).join('')}</span>`;
  const cards = HW_MONTHS.map(M => `<div class="hw-mrow">
      <div class="hw-mhead"><b>${M.m}월 · ${M.name}</b><small>${M.hanja} · ${M.flower}</small></div>
      <div class="hw-mcards">${[0, 1, 2, 3].map(k => hwCardCap((M.m - 1) * 4 + k, 'small')).join('')}</div>
      <p>${M.desc}</p></div>`).join('');
  const rules = `
    <section class="hw-rule"><h4>🃏 어떻게 하나요?</h4>
      <p>48장(12달 × 4장). 둘이서 10장씩 갖고, 바닥에 8장을 펼치고, 나머지 20장은 더미로 엎어 둬요.</p>
      <p>내 차례에 손패 1장을 내요. 바닥에 <b>같은 달</b> 패가 있으면 짝지어 가져와요. 그다음 더미 맨 위 1장을 뒤집어 같은 방법으로 한 번 더!</p>
      <p>바닥에 같은 달이 2장 있으면 둘 중 하나를 골라 가져와요.</p></section>
    <section class="hw-rule"><h4>☀️ 광 (5장)</h4>${ex([0, 8, 28, 40, 44])}
      <p>광 3장 = <b>3점</b> (비광이 섞이면 <b>2점</b>) · 4장 = <b>4점</b> · 5장 = <b>15점</b></p></section>
    <section class="hw-rule"><h4>🐾 열끗 (9장)</h4>${ex([4, 12, 16, 20, 24, 29, 32, 36, 45])}
      <p>5장 = <b>1점</b>, 1장 더할 때마다 +1점</p>
      <p><b>고도리</b>: 새 세 장(2월 꾀꼬리·4월 두견새·8월 기러기) = <b>5점</b></p>${ex([4, 12, 29])}
      <p>9월 술잔(국진)은 열끗 또는 쌍피 중 유리한 쪽으로 쳐요.</p></section>
    <section class="hw-rule"><h4>🎀 띠 (10장)</h4>
      <p>5장 = <b>1점</b>, 1장 더할 때마다 +1점</p>
      <p><b>홍단</b> (1·2·3월 글씨 띠) = <b>3점</b></p>${ex([1, 5, 9])}
      <p><b>청단</b> (6·9·10월 파란 띠) = <b>3점</b></p>${ex([21, 33, 37])}
      <p><b>초단</b> (4·5·7월 빨간 띠) = <b>3점</b></p>${ex([13, 17, 25])}
      <p>12월 비띠는 띠 장수에만 들어가요.</p></section>
    <section class="hw-rule"><h4>🍃 피 (나머지)</h4>${ex([2, 41, 47])}
      <p>피 10장 = <b>1점</b>, 1장 더할 때마다 +1점. 쌍피(11월·12월 번개)는 2장으로 쳐요.</p></section>
    <section class="hw-rule"><h4>🔥 고 / 스톱</h4>
      <p>점수가 <b>7점</b>이 되면 고르기:</p>
      <p><b>스톱</b> — 여기서 끝내고 이김. <b>고</b> — 계속해서 더 키움(1고 +1점, 2고 +2점, 3고부터는 2배·4배…). 고 했다가 상대가 먼저 나면 <b>고박</b>(2배로 짐)!</p>
      <p>마지막 패까지 아무도 못 나면 <b>나가리</b>(무승부).</p></section>
    <section class="hw-rule"><h4>✖️ 박 (2배)</h4>
      <p><b>피박</b>: 내가 피로 점수를 냈는데 상대 피가 1~5장 · <b>광박</b>: 내가 광으로 점수를 냈는데 상대 광이 0장 · <b>멍박</b>: 내 열끗이 7장 이상 · <b>고박</b>: 상대가 고를 했는데 내가 남</p></section>
    <section class="hw-rule"><h4>✨ 특별한 순간 (상대 피 1장 뺏기)</h4>
      <p><b>쪽</b>: 낸 패가 바닥에 짝이 없었는데 뒤집은 패가 바로 그 짝!</p>
      <p><b>따닥</b>: 바닥에 같은 달 2장 + 내 패 + 뒤집은 패까지 4장을 한 번에</p>
      <p><b>싹쓸이</b>: 내 차례가 끝났을 때 바닥이 텅 비면</p>
      <p><b>뻑</b>: 낸 패로 짝을 맞췄는데 뒤집은 패도 같은 달이면 3장이 바닥에 그대로 남아요(못 먹음). 나중에 4번째 패로 3장을 한꺼번에 먹으면 피 1장 뺏기!</p></section>
    <section class="hw-rule"><h4>🏅 레벨</h4>
      <p>컴퓨터와 대결은 레벨 1부터 시작해요. <b>3연승</b>하면 한 단계 올라가고, <b>5연패</b>하면 한 단계 내려가요. 레벨 10이 가장 어려워요.</p>
      <p>이 게임에는 흔들기·폭탄·총통·보너스패는 없어요.</p></section>`;
  el.innerHTML = `<div class="hw hw-study">
    <div class="hw-tabs"><button data-t="cards" class="${tab === 'cards' ? 'on' : ''}">🎴 1~12월 패</button><button data-t="rules" class="${tab === 'rules' ? 'on' : ''}">🧮 점수 내는 법</button></div>
    <div class="hw-study-body">${tab === 'cards' ? cards : rules}</div>
    <p class="hw-credit">카드 그림: Wikimedia Commons <a href="https://commons.wikimedia.org/wiki/Category:SVG_Hwatu" target="_blank" rel="noopener">SVG Hwatu</a> (Marcus Richert, Louie Mantia Jr. 원작 바탕) · <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.ko" target="_blank" rel="noopener">CC BY-SA 4.0</a> · 작은 그림 파일로 변환해 사용</p>
  </div>`;
  el.querySelectorAll('.hw-tabs button').forEach(b => b.onclick = () => hwStudy(el, b.dataset.t));
}
