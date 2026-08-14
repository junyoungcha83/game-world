// 게임 월드 — 방사형 게임 허브 + 사용자 프로필 + 미니게임. 데이터는 Worker+KV 동기화(읽기 공개·쓰기 토큰).

const API_BASE   = 'https://game-world-api.junyoung-cha83.workers.dev';  // 배포 후 확정
const STORAGE_KEY = 'game-world-state-v1';
const TOKEN_KEY   = 'game-world-edit-token';
const CURUSER_KEY = 'game-world-current-user';
const REPAIR_KEY  = 'game-world-repaired-v1';  // 부풀려진 기록 1회 정정 여부(기기별)
const BUILD = 'b105';  // 화면 우상단에 표시 — sw.js CACHE 버전과 같은 번호로 함께 올릴 것
const DELETE_PW = '0000';   // 사용자 삭제 확인 비밀번호(기본값)

function DEFAULT_STATE() { return { version: 1, users: [], scores: {} }; }
let state = DEFAULT_STATE();

// ── 유틸 ──────────────────────────────────────────────
function uid() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function setSync(t) { const el = document.getElementById('syncStatus'); if (el) el.textContent = t || ''; }

// ── 상태 저장/동기화 ──────────────────────────────────
function loadLocal() { try { const r = localStorage.getItem(STORAGE_KEY); if (r) { const p = JSON.parse(r); if (p && Array.isArray(p.users)) return p; } } catch {} return null; }
function saveLocalRaw() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function migrate(s) {
  s.version = s.version || 1;
  if (!Array.isArray(s.users)) s.users = [];
  if (!s.scores || typeof s.scores !== 'object') s.scores = {};
  for (const u of s.users) { u.id = u.id || uid(); u.name = String(u.name || ''); u.photo = typeof u.photo === 'string' ? u.photo : ''; u.created_at = u.created_at || new Date().toISOString(); }
  // 야구 배팅 제거 정리 — 남아있는 배팅 기록·가상 포인트 삭제(다시 살아나지 않도록)
  if (s.wallets) delete s.wallets;
  for (const k in s.scores) { if (s.scores[k]) delete s.scores[k].betbaseball; }
  return s;
}
async function fetchFromServer() {
  if (!API_BASE) return null;
  try { const r = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.users)) return j; } } catch {}
  return null;
}
let _pushTimer = null;
function save() { saveLocalRaw(); clearTimeout(_pushTimer); _pushTimer = setTimeout(pushToServer, 600); }
async function pushToServer() {
  if (!API_BASE) return;
  const token = getToken();
  if (!token) { setSync('동기화 꺼짐'); return; }
  setSync('동기화 중…');
  try {
    const r = await fetch(`${API_BASE}/api/data`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token }, body: JSON.stringify(state) });
    setSync(r.ok ? '✓ 동기화됨' : (r.status === 401 ? '비번 오류' : '동기화 실패'));
  } catch { setSync('오프라인'); }
}
// 로컬 우선으로 사용자/점수 병합 — 빈 원격이 로컬을 덮어쓰지 않게 함
function normName(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
// 같은 게임 통계 병합 — 카운터는 max (멱등: 같은 데이터를 여러 번 병합해도 커지지 않음)
function mergeStat(a, b, gid) {
  if (!a) return b ? { ...b } : b; if (!b) return { ...a };
  const dir = (GAMES.find(x => x.id === gid) || {}).best || 'high';
  const out = { plays: Math.max(a.plays||0, b.plays||0), wins: Math.max(a.wins||0, b.wins||0),
    losses: Math.max(a.losses||0, b.losses||0), draws: Math.max(a.draws||0, b.draws||0), best: null };
  const bs = [a.best, b.best].filter(v => v != null);
  if (bs.length) out.best = dir === 'high' ? Math.max(...bs) : Math.min(...bs);
  return out;
}
// 로컬·원격 상태를 '이름' 기준으로 정규화 병합 → { state, remap(oldId→canonId) }.
//  · 같은 이름은 대표 사용자 하나로 합침(대표 id 는 원격 우선 → 기기 간 안정).
//  · 카운터: 이름이 '중복'(서로 다른 id 2개↑)이면 신뢰 가능한 원격 값으로 정정 → 로컬 폭주(수십만) 복구.
//    단일 id 면 max(로컬,원격) — 멱등이라 재동기화로 값이 불어나지 않음.
function reconcile(local, remote) {
  local = local || {}; remote = remote || {};
  const ls = local.scores || {}, rs = remote.scores || {};
  const groups = {};   // 키(정규화 이름) → { localIds, remoteIds, user }
  const touch = (u, from) => {
    const key = normName(u.name) || ('__id__' + u.id);   // 이름 없으면 개별 보존
    const g = groups[key] || (groups[key] = { localIds: [], remoteIds: [], user: null });
    (from === 'remote' ? g.remoteIds : g.localIds).push(u.id);
    if (from === 'remote' || !g.user) g.user = u;         // 원격 프로필(사진 등) 우선
  };
  for (const u of (local.users || [])) touch(u, 'local');
  for (const u of (remote.users || [])) touch(u, 'remote');

  const users = [], scores = {}, remap = {};
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const canon = g.remoteIds[0] || g.localIds[0];
    users.push({ ...g.user, id: canon });
    for (const id of g.localIds.concat(g.remoteIds)) remap[id] = canon;
    const distinct = new Set([...g.localIds, ...g.remoteIds]);
    const isDup = distinct.size > 1;                      // 같은 이름에 서로 다른 id 가 여러 개
    const remoteScore = g.remoteIds[0] ? (rs[g.remoteIds[0]] || {}) : {};
    const localMax = {};
    for (const id of g.localIds) { const sc = ls[id] || {};
      for (const gid of Object.keys(sc)) localMax[gid] = mergeStat(localMax[gid], sc[gid], gid); }
    const out = {};
    for (const gid of new Set([...Object.keys(remoteScore), ...Object.keys(localMax)])) {
      if (gid === 'betbaseball') continue;                                         // 야구 배팅 기록은 병합에서 제외(제거)
      if (isDup) out[gid] = normStat({ ...(remoteScore[gid] || localMax[gid]) });  // 중복 → 원격 우선(정정)
      else out[gid] = mergeStat(localMax[gid], remoteScore[gid], gid);             // 단일 → max(멱등)
    }
    scores[canon] = out;
  }
  return { state: { version: 1, users, scores }, remap };
}
function idsCollapsed(remap) { return Object.keys(remap).some(k => remap[k] !== k); }

// 부풀려진 로컬 기록 1회 정정: 서버(진실)와 같은 이름 사용자의 게임 중,
//  로컬 판수가 서버보다 '명백히' 큰 경우(부풀림)만 서버 실제값으로 리셋/재산출.
//  기기별 1회만 실행(REPAIR_KEY). 정상 로컬-우세(소량 미동기화)는 건드리지 않음.
function repairOnce(remote) {
  if (!remote || localStorage.getItem(REPAIR_KEY) === '1') return false;
  const rByName = {};
  for (const u of (remote.users || [])) rByName[normName(u.name)] = u;
  const rs = remote.scores || {};
  let changed = false;
  for (const u of state.users) {
    const ru = rByName[normName(u.name)]; if (!ru) continue;
    const rsc = rs[ru.id] || {};
    const lsc = state.scores[u.id] = state.scores[u.id] || {};
    for (const gid of Object.keys(rsc)) {
      const rp = (rsc[gid] || {}).plays || 0, lp = (lsc[gid] || {}).plays || 0;
      if (lp > rp && lp > rp * 2 + 50) {   // 명백한 부풀림만 → 서버값으로 리셋
        lsc[gid] = normStat({ ...rsc[gid] });
        changed = true;
      }
    }
  }
  localStorage.setItem(REPAIR_KEY, '1');
  if (changed) { saveLocalRaw(); if (getToken()) pushToServer(); }
  return changed;
}

async function loadInitial() {
  const local = loadLocal();
  const remote = await fetchFromServer();
  if (local || remote) {
    const dd = reconcile(local ? migrate(local) : null, remote ? migrate(remote) : null);
    state = migrate(dd.state);
    const cur = localStorage.getItem(CURUSER_KEY);
    if (cur && dd.remap[cur] && dd.remap[cur] !== cur) setCurrentUser(dd.remap[cur]);   // 현재 사용자 재매핑
    repairOnce(remote);                                   // 부풀려진 로컬 기록 1회 정정
    saveLocalRaw();
    // 중복 id 가 대표로 접혔으면 서버에도 반영 → 서버에서 중복 id 제거(재발 방지)
    if (remote && getToken() && idsCollapsed(dd.remap)) pushToServer();
    setSync(remote ? '✓ 동기화됨' : (getToken() ? '오프라인(로컬)' : ''));
  } else {
    state = DEFAULT_STATE(); setSync('');
  }
}
// 앱을 다시 볼 때(포그라운드 복귀)마다 서버 최신본을 받아와 병합 → 다른 기기 기록 자동 반영.
// (기존엔 앱 콜드스타트에서만 pull → PWA 가 메모리에서 복귀하면 갱신 안 되던 문제)
let _resyncing = false;
async function resyncFromServer() {
  if (_resyncing || !API_BASE || document.hidden) return;
  _resyncing = true;
  try {
    const remote = await fetchFromServer();
    if (remote) {
      const dd = reconcile(state, migrate(remote));   // 이름 기준 정규화 병합(멱등 + 중복 정정)
      state = migrate(dd.state);
      const cur = localStorage.getItem(CURUSER_KEY);
      if (cur && dd.remap[cur] && dd.remap[cur] !== cur) setCurrentUser(dd.remap[cur]);
      repairOnce(remote);                                          // 부풀려진 로컬 기록 1회 정정
      saveLocalRaw();
      if (getToken() && idsCollapsed(dd.remap)) pushToServer();   // 중복 접힘 → 서버 정규화
      if (currentView === 'records') renderBoard();
      else if (currentView === 'hub') renderHub();
      else if (currentView === 'profile') renderProfile();
      setSync('✓ 동기화됨');
    }
  } catch {}
  _resyncing = false;
}

// ── 사용자 ────────────────────────────────────────────
function getCurrentUser() { const id = localStorage.getItem(CURUSER_KEY); return state.users.find(u => u.id === id) || null; }
function setCurrentUser(id) { localStorage.setItem(CURUSER_KEY, id); }
function deleteUser(id) {
  state.users = state.users.filter(u => u.id !== id);
  if (state.scores[id]) delete state.scores[id];
  if (localStorage.getItem(CURUSER_KEY) === id) localStorage.removeItem(CURUSER_KEY);
  save();
}
function avatarInner(u) {
  if (u && u.photo) return `<img src="${u.photo}" alt="" />`;
  const ini = u ? (u.name || '?').trim().charAt(0) : '＋';
  return `<span class="ini">${escapeHtml(ini || '?')}</span>`;
}
function setAvatar(imgId, fbId, u) {
  const img = document.getElementById(imgId), fb = document.getElementById(fbId);
  if (u && u.photo) { img.src = u.photo; img.style.display = ''; fb.style.display = 'none'; }
  else { img.removeAttribute('src'); img.style.display = 'none'; fb.style.display = ''; fb.textContent = u ? (u.name || '?').trim().charAt(0) || '?' : '＋'; }
}
// 사진 파일 → 정사각 리사이즈 → base64(jpeg)
function resizePhoto(file, size = 256) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const ctx = c.getContext('2d'); const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(); };
    img.src = url;
  });
}

// ── 점수 ──────────────────────────────────────────────
// 사용자(이름)별 게임 누적 통계: { plays, wins, losses, draws, best }
function getStat(gid, u) { u = u || getCurrentUser(); if (!u) return null; const s = state.scores[u.id] && state.scores[u.id][gid]; return s || null; }
function normStat(s) { s = (s && typeof s === 'object') ? s : {}; for (const k of ['plays','wins','losses','draws']) s[k] = s[k] || 0; if (s.best === undefined) s.best = null; return s; }
function recordStat(gid, opt) {
  opt = opt || {};
  const u = getCurrentUser(); if (!u) return;
  state.scores[u.id] = state.scores[u.id] || {};
  const s = state.scores[u.id][gid] = normStat(state.scores[u.id][gid]);
  s.plays++;
  if (opt.result === 'win') s.wins++; else if (opt.result === 'loss') s.losses++; else if (opt.result === 'draw') s.draws++;
  if (opt.best != null) { const dir = (GAMES.find(x => x.id === gid) || boardGames().find(x => x.id === gid) || {}).best || 'high';
    if (s.best == null || (dir === 'high' ? opt.best > s.best : opt.best < s.best)) s.best = opt.best; }
  save(); refreshStat(gid);
}
function refreshStat(gid) { const el = document.getElementById('gameBest'); if (el) { const g = GAMES.find(x => x.id === gid); if (g) el.textContent = g.fmtStat(getStat(gid)); } }

// ── 게임 레지스트리 (여기에 추가만 하면 방사형 메뉴 자동 반영) ──
const GAMES = [
  { id: 'rps',   name: '가위바위보', emoji: '✊', color: '#f472b6', best: 'high',
    fmtStat: s => s ? `${s.plays}판·${s.wins}승 · 최고 ${s.best || 0}연승` : '아직 기록 없음', start: startRPS },
  { id: 'guess', name: '숫자 맞히기', emoji: '🔢', color: '#60a5fa', best: 'low',
    fmtStat: s => s ? `${s.plays}판 · 최고 ${s.best != null ? s.best + '번만에' : '-'}` : '아직 기록 없음', start: startGuess },
  { id: 'ttt',   name: '틱택토',     emoji: '⭕', color: '#34d399', best: 'high',
    fmtStat: s => s ? `${s.plays}판 · ${s.wins}승 ${s.losses}패 ${s.draws}무` : '아직 기록 없음', start: startTTT },
  { id: 'flags', name: '국기 맞히기', emoji: '🚩', color: '#fbbf24', best: 'high',
    fmtStat: s => s ? `${s.plays}판·${s.wins}정답 · 최고 ${s.best || 0}연속` : '아직 기록 없음', start: startFlags },
  { id: 'capital', name: '수도 맞히기', emoji: '🏙️', color: '#22d3ee', best: 'high',
    fmtStat: s => s ? `${s.plays}판·${s.wins}정답 · 최고 ${s.best || 0}연속` : '아직 기록 없음', start: startCapital },
  { id: 'mapq', name: '지도 맞히기', emoji: '🗺️', color: '#fb923c', best: 'high',
    fmtStat: s => s ? `${s.plays}판·${s.wins}정답 · 최고 ${s.best || 0}연속` : '아직 기록 없음', start: startMap },
  { id: 'baseball', name: '3아웃 야구', emoji: '⚾', color: '#84cc16', best: 'low',
    fmtStat: s => s ? `${s.plays}게임·${s.wins}승 · 최소 ${s.best != null ? s.best + '번' : '-'}` : '아직 기록 없음', start: startBaseball },
  { id: 'omok', name: '오목', emoji: '⚫', color: '#a78bfa', best: 'high',
    fmtStat: () => omokAggFmt(), start: startOmok },
  { id: 'janggi', name: '장기', emoji: '漢', color: '#ef4444', best: 'high',
    fmtStat: () => janggiAggFmt(), start: startJanggi },
  { id: 'chess', name: '체스', emoji: '♞', color: '#eab308', best: 'high',
    fmtStat: () => chessAggFmt(), start: startChess },
  { id: 'spot', name: '틀린그림찾기', emoji: '🔍', color: '#e879f9', best: 'high',
    fmtStat: s => s ? `${s.plays}판·${s.wins}클리어 · 최고 ${s.best || 0}연속` : '아직 기록 없음', start: startSpot },
  { id: 'color', name: '색칠하기', emoji: '🎨', color: '#fb7185', best: 'high',
    fmtStat: () => '자유롭게 색칠해요', start: startColor },
  { id: 'timer10', name: '10초 맞추기', emoji: '⏱️', color: '#38bdf8', best: 'low',
    fmtStat: s => s ? `${s.plays}판 · 최고 ±${s.best != null ? (s.best / 1000).toFixed(2) : '-'}초` : '아직 기록 없음', start: startTimer10 },
  { id: 'brush', name: '붓칠하기', emoji: '🖌️', color: '#f59e0b', best: 'high',
    fmtStat: () => '자유롭게 붓칠해요', start: startBrush },
  { id: 'roulette', name: '룰렛', emoji: '🎡', color: '#f43f5e', best: 'high',
    fmtStat: () => '돌려돌려 룰렛~', start: startRoulette },
  { id: 'kbo', name: '프로야구', emoji: '🏟️', color: '#22c55e', best: 'high',
    fmtStat: s => s ? `${s.plays}경기·${s.wins}승 · 최다 ${s.best || 0}점` : '아직 기록 없음', start: startKbo },
  { id: 'archery', name: '양궁', emoji: '🎯', color: '#dc2626', best: 'high',
    fmtStat: s => s ? `${s.plays}경기·${s.wins}승 · 최고 ${s.best || 0}단계 격파` : '아직 기록 없음', start: startArchery },
  { id: 'pocket', name: '포켓볼', emoji: '🎱', color: '#16a34a', best: 'low',
    fmtStat: s => s ? `${s.plays}판·${s.wins}클리어 · 최소 ${s.best != null ? s.best + '타' : '-'}` : '아직 기록 없음', start: startPocket },
  { id: 'fourball', name: '4구', emoji: '🔴', color: '#b91c1c', best: 'high',
    svg: '<svg viewBox="0 0 100 100" width="100%" height="100%"><g stroke-linecap="round"><line x1="18" y1="18" x2="82" y2="82" stroke="#6b3f18" stroke-width="11"/><line x1="82" y1="18" x2="18" y2="82" stroke="#6b3f18" stroke-width="11"/><line x1="18" y1="18" x2="82" y2="82" stroke="#d8a05a" stroke-width="6.5"/><line x1="82" y1="18" x2="18" y2="82" stroke="#d8a05a" stroke-width="6.5"/></g><g stroke="rgba(0,0,0,.4)" stroke-width="1"><circle cx="50" cy="20" r="11" fill="#facc15"/><circle cx="80" cy="50" r="11" fill="#f8fafc"/><circle cx="50" cy="80" r="11" fill="#22c55e"/><circle cx="20" cy="50" r="11" fill="#38bdf8"/></g><g fill="rgba(255,255,255,.6)"><circle cx="46" cy="16" r="2.6"/><circle cx="76" cy="46" r="2.6"/><circle cx="46" cy="76" r="2.6"/><circle cx="16" cy="46" r="2.6"/></g></svg>',
    fmtStat: () => fourAggFmt(), start: startFourball },
  { id: 'tetris', name: '테트리스', emoji: '🟦', color: '#0ea5e9', best: 'high',
    fmtStat: s => s ? `${s.plays}판 · 최고 ${(s.best || 0).toLocaleString('ko-KR')}점` : '아직 기록 없음', start: startTetris },
];
// 오목 난이도(급수) — 기록은 급수별로 따로 누적/순위
const OMOK_LEVELS = [
  { key: 'omok_easy', label: '초급', desc: '쉬움' },
  { key: 'omok_mid',  label: '중급', desc: '보통' },
  { key: 'omok_hard', label: '상급', desc: '어려움' },
  { key: 'omok_pro',  label: '프로', desc: '매우 어려움' },
];
const omokFmt = s => s ? `${s.plays}판 · ${s.wins}승 ${s.losses}패 ${s.draws}무` : '아직 기록 없음';
function omokAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const parts = OMOK_LEVELS.map(l => { const s = getStat(l.key, u); return s && s.plays ? `${l.label} ${s.wins}승` : null; }).filter(Boolean);
  return parts.length ? parts.join(' · ') : '아직 기록 없음';
}
// 장기 난이도(vs컴퓨터) — 급수별 기록
const JANGGI_LEVELS = [
  { key: 'janggi_easy', label: '초급', ai: 'easy', desc: '쉬움' },
  { key: 'janggi_mid',  label: '중급', ai: 'mid',  desc: '보통' },
  { key: 'janggi_adv',  label: '고급', ai: 'adv',  desc: '어려움' },
  { key: 'janggi_pro',  label: '프로', ai: 'pro',  desc: '매우 어려움' },
];
const janggiFmt = s => s ? `${s.plays}판 · ${s.wins}승 ${s.losses}패` : '아직 기록 없음';
function janggiAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const parts = JANGGI_LEVELS.map(l => { const s = getStat(l.key, u); return s && s.plays ? `${l.label} ${s.wins}승` : null; }).filter(Boolean);
  return parts.length ? parts.join(' · ') : '아직 기록 없음';
}
// 체스 난이도(vs컴퓨터) — 급수별 기록
const CHESS_LEVELS = [
  { key: 'chess_easy', label: '초급', ai: 1, desc: '쉬움' },
  { key: 'chess_mid',  label: '중급', ai: 2, desc: '보통' },
  { key: 'chess_adv',  label: '고급', ai: 3, desc: '어려움' },
  { key: 'chess_pro',  label: '프로', ai: 4, desc: '매우 어려움' },
];
// 4구 — 연습(10샷 도전 점수)과 대결(vs 컴퓨터 승패)을 따로 기록. 2인 대결은 기록하지 않음
const FOUR_MODES = [
  { key: 'four_solo', name: '4구 연습', fmt: s => s ? `${s.plays}판 · 최고 ${s.best || 0}점` : '아직 기록 없음' },
  { key: 'four_vs',   name: '4구 대결', fmt: s => s ? `${s.plays}판 · ${s.wins}승 ${s.losses}패` : '아직 기록 없음' },
];
function fourAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const solo = getStat('four_solo', u), vs = getStat('four_vs', u), parts = [];
  if (solo && solo.plays) parts.push(`연습 최고 ${solo.best || 0}점`);
  if (vs && vs.plays) parts.push(`대결 ${vs.wins}승 ${vs.losses}패`);
  return parts.length ? parts.join(' · ') : '아직 기록 없음';
}
const chessFmt = s => s ? `${s.plays}판 · ${s.wins}승 ${s.losses}패 ${s.draws}무` : '아직 기록 없음';
function chessAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const parts = CHESS_LEVELS.map(l => { const s = getStat(l.key, u); return s && s.plays ? `${l.label} ${s.wins}승` : null; }).filter(Boolean);
  return parts.length ? parts.join(' · ') : '아직 기록 없음';
}
// 기록판에 쓸 게임 목록 — 오목·장기는 급수로 펼침
function boardGames() {
  const out = [];
  for (const g of GAMES) {
    if (g.id === 'color' || g.id === 'brush' || g.id === 'roulette') continue;   // 기록 없는 게임 → 순위판 제외
    if (g.id === 'omok') for (const l of OMOK_LEVELS) out.push({ id: l.key, emoji: '⚫', name: `오목 ${l.label}`, best: 'high', fmtStat: omokFmt });
    else if (g.id === 'janggi') for (const l of JANGGI_LEVELS) out.push({ id: l.key, emoji: '漢', name: `장기 ${l.label}`, best: 'high', fmtStat: janggiFmt });
    else if (g.id === 'chess') for (const l of CHESS_LEVELS) out.push({ id: l.key, emoji: '♞', name: `체스 ${l.label}`, best: 'high', fmtStat: chessFmt });
    else if (g.id === 'fourball') for (const m of FOUR_MODES) out.push({ id: m.key, emoji: '🔴', name: m.name, best: 'high', fmtStat: m.fmt });
    else out.push(g);
  }
  return out;
}

// ── 허브(방사형) ──────────────────────────────────────
// 홈 화면 카테고리 분류
const HUB_CATEGORIES = [
  { label: '🎨 자유',  ids: ['color', 'brush', 'roulette'] },
  { label: '♟️ 보드',  ids: ['omok', 'janggi', 'chess', 'tetris', 'ttt', 'baseball', 'spot'] },
  { label: '⚾ 스포츠', ids: ['kbo', 'archery', 'pocket', 'fourball'] },
  { label: '🕹️ 레트로', ids: ['timer10', 'rps', 'guess'] },
  { label: '🧠 퀴즈',  ids: ['flags', 'capital', 'mapq'] },
];
function renderHub() {
  const hub = document.getElementById('hub');
  const u = getCurrentUser();
  const byId = id => GAMES.find(g => g.id === id);
  hub.innerHTML = `
    <div class="hub-header">
      <button class="hub-avatar" id="hubAvatar">${avatarInner(u)}</button>
      <div class="hub-greet">${u ? escapeHtml(u.name) + ' 님, 즐겜!' : '게임을 골라요'}<small>사진을 누르면 프로필</small></div>
    </div>
    <div class="hub-cats">
      ${HUB_CATEGORIES.map(cat => `
        <section class="hub-cat">
          <h3 class="hub-cat-title">${cat.label}</h3>
          <div class="hub-grid">
            ${cat.ids.map(byId).filter(Boolean).map(g => `
              <button class="game-card" data-id="${g.id}">
                <span class="gc-emoji" style="background:${g.color}">${g.svg || g.emoji}</span>
                <span class="gc-name">${escapeHtml(g.name)}</span>
              </button>`).join('')}
          </div>
        </section>`).join('')}
    </div>`;
  hub.querySelector('#hubAvatar').onclick = () => showView('profile');
  hub.querySelectorAll('.game-card').forEach(b => b.onclick = () => openGame(b.dataset.id));
  document.getElementById('hubHint').textContent = '';
}

// ── 뷰 전환 ───────────────────────────────────────────
let currentView = 'hub';
function showView(name) {
  currentView = name;
  // 게임 플레이 중에는 당겨서 새로고침(pull-to-refresh) 비활성화 — 실수로 리로드되어 게임 리셋 방지
  document.body.classList.toggle('playing', name === 'game');
  ['hub', 'game', 'records', 'profile'].forEach(v => document.getElementById(v + 'View').classList.toggle('hidden', v !== name));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'profile') renderProfile();
  if (name === 'records') { renderBoard(); resyncFromServer(); }   // 기록 열 때마다 서버 최신 반영
  if (name === 'hub') renderHub();
}

// ── 기록(게임별 순위) ─────────────────────────────────
function renderBoard() {
  const wrap = document.getElementById('boardWrap'); if (!wrap) return;
  const cur = getCurrentUser();
  const info = `<p class="board-info">등록 사용자 ${state.users.length}명 · 현재 ${cur ? escapeHtml(cur.name) : '없음 ⚠️'}</p>`;
  wrap.innerHTML = info + boardGames().map(g => {
    // 기록이 있는 사용자만 추림 → 게임별 정렬 기준으로 순위
    const rows = state.users
      .map(u => ({ u, s: getStat(g.id, u) }))
      .filter(x => x.s && x.s.plays > 0)
      .sort((a, b) => boardCmp(g, a.s, b.s));
    const list = rows.length ? rows.map((x, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
      const me = cur && x.u.id === cur.id ? ' me' : '';
      return `<div class="board-row${me}"><span class="rank">${medal}</span>${avatarInner(x.u)}<span class="bname">${escapeHtml(x.u.name)}</span><span class="bstat">${g.fmtStat(x.s)}</span></div>`;
    }).join('') : '<div class="board-empty">아직 기록이 없어요</div>';
    return `<div class="board"><h3 class="board-title">${g.emoji} ${escapeHtml(g.name)}</h3>${list}</div>`;
  }).join('');
}
// 게임별 순위 정렬: 1순위 best(높을수록/낮을수록 좋음), 2순위 승수, 3순위 판수
function boardCmp(g, a, b) {
  const av = a.best, bv = b.best;
  if (av != null || bv != null) {
    if (av == null) return 1; if (bv == null) return -1;
    if (av !== bv) return g.best === 'high' ? bv - av : av - bv;
  }
  if (b.wins !== a.wins) return b.wins - a.wins;
  return b.plays - a.plays;
}
function openGame(id) {
  const g = GAMES.find(x => x.id === id); if (!g) return;
  if (!getCurrentUser()) { showReg(); return; }   // 사용자 없으면 기록이 안 쌓이므로 먼저 선택
  document.getElementById('gameTitle').textContent = g.emoji + ' ' + g.name;
  document.getElementById('gameBest').textContent = g.fmtStat(getStat(id));
  document.getElementById('gameBack').onclick = () => showView('hub');   // 기본 뒤로가기(게임이 필요시 자체 오버라이드)
  showView('game');
  g.start(document.getElementById('gameScreen'));
}

// ── 미니게임: 가위바위보 ──────────────────────────────
function startRPS(el) {
  let streak = 0, busy = false;
  const R = [['✊', '바위'], ['✌️', '가위'], ['🖐', '보']];   // 0바위 1가위 2보
  el.innerHTML = `<div class="mg rps">
    <div class="mg-msg" id="rpsMsg">준비!</div>
    <div class="mg-vs" id="rpsVs">　</div>
    <div class="rps-choices">${R.map((r, i) => `<button data-i="${i}">${r[0]}</button>`).join('')}</div>
    <div class="mg-score">연승 <b id="rpsStreak">0</b></div>
  </div>`;
  const choices = [...el.querySelectorAll('.rps-choices button')];
  const alive = () => !!el.querySelector('.rps');   // 다른 화면으로 이동하면 중단
  const setEnabled = (on) => choices.forEach(b => b.disabled = !on);

  const pick = (me) => {
    if (busy) return; busy = true; setEnabled(false);
    const cpu = Math.floor(Math.random() * 3);
    const r = (me === cpu) ? '무' : ((me + 1) % 3 === cpu ? '승' : '패');   // me가 (me+1)%3 을 이김
    document.getElementById('rpsVs').textContent = `나 ${R[me][0]}  vs  ${R[cpu][0]} 컴퓨터`;
    const msg = document.getElementById('rpsMsg');
    if (r === '승') { streak++; msg.textContent = '이겼다! 🎉'; recordStat('rps', { result: 'win', best: streak }); }
    else if (r === '패') { streak = 0; msg.textContent = '졌어요 😢'; recordStat('rps', { result: 'loss' }); }
    else { msg.textContent = '비겼네요 😐'; recordStat('rps', { result: 'draw' }); }
    document.getElementById('rpsStreak').textContent = streak;
    setTimeout(() => { if (alive()) countdown(); }, 1400);   // 결과 보여준 뒤 다음 라운드
  };

  const countdown = () => {
    if (!alive()) return;
    busy = true; setEnabled(false);
    const vs = document.getElementById('rpsVs'), msg = document.getElementById('rpsMsg');
    let n = 3;
    const tick = () => {
      if (!alive()) return;
      if (n > 0) {
        msg.textContent = '가위바위보…';
        vs.innerHTML = `<span class="rps-count">${n}</span>`;
        n--; setTimeout(tick, 700);
      } else {
        vs.textContent = '　'; msg.textContent = '지금 골라요!';
        busy = false; setEnabled(true);
      }
    };
    tick();
  };

  choices.forEach(b => b.onclick = () => pick(+b.dataset.i));
  countdown();
}

// ── 미니게임: 숫자 맞히기 ─────────────────────────────
function startGuess(el) {
  let target = 1 + Math.floor(Math.random() * 100), tries = 0, done = false;
  el.innerHTML = `<div class="mg guess">
    <div class="mg-msg" id="gMsg">1~100 사이 숫자를 맞혀보세요!</div>
    <div class="guess-in"><input type="number" id="gIn" min="1" max="100" inputmode="numeric" placeholder="?" /><button id="gBtn">확인</button></div>
    <div class="mg-score">시도 <b id="gTries">0</b></div>
    <button class="btn ghost small" id="gReset" hidden>다시 하기</button>
  </div>`;
  const go = () => {
    if (done) return;
    const v = parseInt(document.getElementById('gIn').value, 10);
    if (!(v >= 1 && v <= 100)) return;
    tries++; document.getElementById('gTries').textContent = tries;
    const m = document.getElementById('gMsg');
    if (v === target) { done = true; m.textContent = `정답! 🎉 ${tries}번 만에 맞혔어요`; recordStat('guess', { result: 'win', best: tries }); document.getElementById('gReset').hidden = false; }
    else m.textContent = v < target ? '⬆️ 더 큰 수예요' : '⬇️ 더 작은 수예요';
    const inp = document.getElementById('gIn'); inp.value = ''; inp.focus();
  };
  document.getElementById('gBtn').onclick = go;
  document.getElementById('gIn').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  document.getElementById('gReset').onclick = () => startGuess(el);
}

// ── 미니게임: 틱택토 ──────────────────────────────────
function startTTT(el) {
  let b = Array(9).fill(''), over = false;
  el.innerHTML = `<div class="mg ttt">
    <div class="mg-msg" id="tMsg">당신(O) 차례</div>
    <div class="ttt-grid" id="tGrid"></div>
    <button class="btn ghost small" id="tReset">다시 하기</button>
  </div>`;
  const grid = document.getElementById('tGrid');
  const winner = bd => { const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; for (const [a,c,d] of L) if (bd[a] && bd[a] === bd[c] && bd[a] === bd[d]) return bd[a]; return null; };
  const findMove = (bd, p) => { for (let i = 0; i < 9; i++) if (!bd[i]) { const t = bd.slice(); t[i] = p; if (winner(t) === p) return i; } return null; };
  const draw = () => {
    grid.innerHTML = b.map((c, i) => `<button data-i="${i}" ${(c || over) ? 'disabled' : ''}>${c}</button>`).join('');
    grid.querySelectorAll('button').forEach(btn => btn.onclick = () => play(+btn.dataset.i));
  };
  const play = i => {
    if (over || b[i]) return;
    b[i] = 'O'; let w = winner(b);
    if (!w && b.includes('')) {                              // CPU: 이기는수→막는수→중앙/모서리
      let m = findMove(b, 'X'); if (m == null) m = findMove(b, 'O');
      if (m == null) m = [4,0,2,6,8,1,3,5,7].find(x => !b[x]);
      if (m != null) b[m] = 'X'; w = winner(b);
    }
    over = !!w || !b.includes('');
    document.getElementById('tMsg').textContent = w === 'O' ? '이겼어요! 🎉' : w === 'X' ? '졌어요 😢' : over ? '무승부 😐' : '당신(O) 차례';
    if (over) recordStat('ttt', { result: w === 'O' ? 'win' : w === 'X' ? 'loss' : 'draw' });
    draw();
  };
  document.getElementById('tReset').onclick = () => startTTT(el);
  draw();
}

// ── 미니게임: 국기 맞히기 ─────────────────────────────
// 공통 국가 DB: [국기, 나라, 수도, 난이도티어(1쉬움 ~ 3어려움)] — 국기·수도 게임이 공유
const COUNTRY_DB = [
  // tier 1 — 아주 익숙한 나라
  ['🇰🇷','대한민국','서울',1],['🇯🇵','일본','도쿄',1],['🇨🇳','중국','베이징',1],['🇺🇸','미국','워싱턴 D.C.',1],['🇬🇧','영국','런던',1],
  ['🇫🇷','프랑스','파리',1],['🇩🇪','독일','베를린',1],['🇮🇹','이탈리아','로마',1],['🇪🇸','스페인','마드리드',1],['🇨🇦','캐나다','오타와',1],
  ['🇧🇷','브라질','브라질리아',1],['🇦🇺','호주','캔버라',1],['🇮🇳','인도','뉴델리',1],['🇷🇺','러시아','모스크바',1],['🇪🇬','이집트','카이로',1],
  // tier 2 — 중간
  ['🇵🇹','포르투갈','리스본',2],['🇦🇷','아르헨티나','부에노스아이레스',2],['🇲🇽','멕시코','멕시코시티',2],['🇹🇭','태국','방콕',2],['🇻🇳','베트남','하노이',2],
  ['🇮🇩','인도네시아','자카르타',2],['🇵🇭','필리핀','마닐라',2],['🇸🇬','싱가포르','싱가포르',2],['🇹🇷','튀르키예','앙카라',2],['🇿🇦','남아공','프리토리아',2],
  ['🇳🇱','네덜란드','암스테르담',2],['🇸🇪','스웨덴','스톡홀름',2],['🇳🇴','노르웨이','오슬로',2],['🇨🇭','스위스','베른',2],['🇬🇷','그리스','아테네',2],
  ['🇵🇱','폴란드','바르샤바',2],['🇦🇹','오스트리아','빈',2],['🇮🇪','아일랜드','더블린',2],['🇳🇿','뉴질랜드','웰링턴',2],
  // tier 3 — 어려움
  ['🇫🇮','핀란드','헬싱키',3],['🇩🇰','덴마크','코펜하겐',3],['🇨🇿','체코','프라하',3],['🇭🇺','헝가리','부다페스트',3],['🇺🇦','우크라이나','키이우',3],
  ['🇸🇦','사우디아라비아','리야드',3],['🇦🇪','아랍에미리트','아부다비',3],['🇲🇾','말레이시아','쿠알라룸푸르',3],['🇵🇰','파키스탄','이슬라마바드',3],['🇳🇬','나이지리아','아부자',3],
  ['🇲🇦','모로코','라바트',3],['🇨🇱','칠레','산티아고',3],['🇵🇪','페루','리마',3],['🇨🇴','콜롬비아','보고타',3],['🇮🇸','아이슬란드','레이캬비크',3],['🇰🇪','케냐','나이로비',3],
  // ── 추가 국가 ──
  ['🇹🇼','대만','타이베이',2],['🇧🇪','벨기에','브뤼셀',2],['🇮🇷','이란','테헤란',2],['🇮🇱','이스라엘','예루살렘',2],['🇻🇪','베네수엘라','카라카스',2],['🇨🇺','쿠바','아바나',2],['🇷🇴','루마니아','부쿠레슈티',2],['🇲🇳','몽골','울란바토르',2],['🇰🇿','카자흐스탄','아스타나',2],['🇶🇦','카타르','도하',2],['🇮🇶','이라크','바그다드',2],['🇧🇩','방글라데시','다카',2],['🇳🇵','네팔','카트만두',2],['🇰🇭','캄보디아','프놈펜',2],
  ['🇷🇸','세르비아','베오그라드',3],['🇭🇷','크로아티아','자그레브',3],['🇧🇬','불가리아','소피아',3],['🇸🇰','슬로바키아','브라티슬라바',3],['🇸🇮','슬로베니아','류블랴나',3],['🇪🇪','에스토니아','탈린',3],['🇱🇻','라트비아','리가',3],['🇱🇹','리투아니아','빌뉴스',3],['🇦🇿','아제르바이잔','바쿠',3],['🇬🇪','조지아','트빌리시',3],['🇺🇿','우즈베키스탄','타슈켄트',3],['🇪🇹','에티오피아','아디스아바바',3],['🇬🇭','가나','아크라',3],['🇩🇿','알제리','알제',3],['🇹🇳','튀니지','튀니스',3],['🇺🇾','우루과이','몬테비데오',3],['🇪🇨','에콰도르','키토',3],['🇵🇾','파라과이','아순시온',3],['🇵🇦','파나마','파나마시티',3],['🇨🇷','코스타리카','산호세',3],['🇱🇺','룩셈부르크','룩셈부르크',3],['🇲🇲','미얀마','네피도',3],
];
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// 연속 정답(streak) 기반 레벨 구간 — 위로 갈수록 어려운 나라가 출제 풀에 추가됨
function levelFor(streak) {
  if (streak < 7)  return { lv: 1, label: '입문', maxTier: 1 };   // 0~6 (7)
  if (streak < 14) return { lv: 2, label: '초급', maxTier: 2 };   // 7~13 (7)
  if (streak < 24) return { lv: 3, label: '중급', maxTier: 3 };   // 14~23 (10)
  return { lv: 4, label: '고급', maxTier: 3, hardOnly: true };    // 24~ : 쉬운 1티어 제외
}
function quizPool(lv) {
  return lv.hardOnly ? COUNTRY_DB.filter(c => c[3] >= 2) : COUNTRY_DB.filter(c => c[3] <= lv.maxTier);
}

function startFlags(el) {
  let streak = 0;
  const round = () => {
    const lv = levelFor(streak), pool = quizPool(lv);
    const correct = pool[Math.floor(Math.random() * pool.length)];
    const opts = shuffle([correct, ...shuffle(pool.filter(c => c !== correct)).slice(0, 3)]);
    el.innerHTML = `<div class="mg flags">
      <div class="mg-msg" id="fMsg">이 국기는 어느 나라일까요?</div>
      <div class="flag-big">${correct[0]}</div>
      <div class="flag-opts">${opts.map(o => `<button data-name="${escapeHtml(o[1])}">${escapeHtml(o[1])}</button>`).join('')}</div>
      <div class="mg-score">Lv.${lv.lv} ${lv.label} · 연속 <b id="fStreak">${streak}</b></div>
    </div>`;
    const msg = document.getElementById('fMsg');
    el.querySelectorAll('.flag-opts button').forEach(b => b.onclick = () => {
      el.querySelectorAll('.flag-opts button').forEach(x => { x.disabled = true; if (x.dataset.name === correct[1]) x.classList.add('correct'); });
      if (b.dataset.name === correct[1]) {
        streak++; msg.textContent = '정답! 🎉'; recordStat('flags', { result: 'win', best: streak });
      } else {
        b.classList.add('wrong'); msg.textContent = `아쉬워요 😢 정답은 ${correct[1]}`; streak = 0; recordStat('flags', { result: 'loss' });
      }
      document.getElementById('fStreak').textContent = streak;
      setTimeout(round, 1100);
    });
  };
  round();
}

// ── 미니게임: 수도 맞히기 ─────────────────────────────
function startCapital(el) {
  let streak = 0;
  const round = () => {
    const lv = levelFor(streak), pool = quizPool(lv);
    const correct = pool[Math.floor(Math.random() * pool.length)];
    const opts = shuffle([correct, ...shuffle(pool.filter(c => c[2] !== correct[2])).slice(0, 3)]);
    el.innerHTML = `<div class="mg flags">
      <div class="mg-msg" id="cMsg">이 나라의 수도는?</div>
      <div class="quiz-country">${correct[0]} ${escapeHtml(correct[1])}</div>
      <div class="flag-opts">${opts.map(o => `<button data-cap="${escapeHtml(o[2])}">${escapeHtml(o[2])}</button>`).join('')}</div>
      <div class="mg-score">Lv.${lv.lv} ${lv.label} · 연속 <b id="cStreak">${streak}</b></div>
    </div>`;
    const msg = document.getElementById('cMsg');
    el.querySelectorAll('.flag-opts button').forEach(b => b.onclick = () => {
      el.querySelectorAll('.flag-opts button').forEach(x => { x.disabled = true; if (x.dataset.cap === correct[2]) x.classList.add('correct'); });
      if (b.dataset.cap === correct[2]) {
        streak++; msg.textContent = '정답! 🎉'; recordStat('capital', { result: 'win', best: streak });
      } else {
        b.classList.add('wrong'); msg.textContent = `아쉬워요 😢 정답은 ${correct[2]}`; streak = 0; recordStat('capital', { result: 'loss' });
      }
      document.getElementById('cStreak').textContent = streak;
      setTimeout(round, 1100);
    });
  };
  round();
}

// ── 미니게임: 지도 맞히기 ─────────────────────────────
// 국가 실루엣(mapsicon)을 가져와 회색으로 재색칠해 표시 → 4지선다
// [코드, 나라, 실루엣 식별 난이도(1쉬움 ~ 3어려움)]
const MAPS = [
  // tier 1 — 모양이 또렷
  ['kr','대한민국',1],['jp','일본',1],['it','이탈리아',1],['us','미국',1],['au','호주',1],
  ['in','인도',1],['gb','영국',1],['br','브라질',1],
  // tier 2 — 중간
  ['fr','프랑스',2],['de','독일',2],['es','스페인',2],['cn','중국',2],['ru','러시아',2],
  ['ca','캐나다',2],['eg','이집트',2],['mx','멕시코',2],['th','태국',2],['vn','베트남',2],['id','인도네시아',2],['ph','필리핀',2],
  // tier 3 — 작거나 밋밋해 어려움
  ['pt','포르투갈',3],['tr','튀르키예',3],['za','남아공',3],['nl','네덜란드',3],['se','스웨덴',3],
  ['no','노르웨이',3],['ch','스위스',3],['gr','그리스',3],['ar','아르헨티나',3],
  // ── 추가 지도 ──
  ['cl','칠레',1],['nz','뉴질랜드',1],
  ['ie','아일랜드',2],['is','아이슬란드',2],['sa','사우디아라비아',2],['ir','이란',2],['pk','파키스탄',2],['my','말레이시아',2],['mn','몽골',2],['ua','우크라이나',2],['pl','폴란드',2],['pe','페루',2],['co','콜롬비아',2],['ng','나이지리아',2],['ma','모로코',2],['fi','핀란드',2],['kz','카자흐스탄',2],['ve','베네수엘라',2],
  ['cu','쿠바',3],['ke','케냐',3],['dk','덴마크',3],['at','오스트리아',3],['ae','아랍에미리트',3],['sg','싱가포르',3],['lk','스리랑카',3],['kh','캄보디아',3],['np','네팔',3],['il','이스라엘',3],['be','벨기에',3],['cz','체코',3],['ro','루마니아',3],['hu','헝가리',3],
];
const mapPool = lv => lv.hardOnly ? MAPS.filter(c => c[2] >= 2) : MAPS.filter(c => c[2] <= lv.maxTier);
const _mapCache = {};
async function loadMapSVG(code) {
  if (_mapCache[code]) return _mapCache[code];
  // 동봉된 로컬 실루엣(SW가 프리캐시) → 완전 오프라인 동작
  const r = await fetch(`./assets/maps/${code}.svg`);
  if (!r.ok) throw new Error('map fetch failed');
  const t = await r.text();
  _mapCache[code] = t;
  return t;
}
function startMap(el) {
  let streak = 0;
  const round = async () => {
    const lv = levelFor(streak), pool = mapPool(lv);
    const correct = pool[Math.floor(Math.random() * pool.length)];
    const opts = shuffle([correct, ...shuffle(pool.filter(c => c[0] !== correct[0])).slice(0, 3)]);
    el.innerHTML = `<div class="mg flags">
      <div class="mg-msg" id="mMsg">이 지도는 어느 나라일까요?</div>
      <div class="map-shape" id="mShape">불러오는 중…</div>
      <div class="flag-opts">${opts.map(o => `<button data-code="${o[0]}">${escapeHtml(o[1])}</button>`).join('')}</div>
      <div class="mg-score">Lv.${lv.lv} ${lv.label} · 연속 <b id="mStreak">${streak}</b></div>
    </div>`;
    const msg = document.getElementById('mMsg');
    el.querySelectorAll('.flag-opts button').forEach(b => b.onclick = () => {
      el.querySelectorAll('.flag-opts button').forEach(x => { x.disabled = true; if (x.dataset.code === correct[0]) x.classList.add('correct'); });
      if (b.dataset.code === correct[0]) {
        streak++; msg.textContent = '정답! 🎉'; recordStat('mapq', { result: 'win', best: streak });
      } else {
        b.classList.add('wrong'); msg.textContent = `아쉬워요 😢 정답은 ${correct[1]}`; streak = 0; recordStat('mapq', { result: 'loss' });
      }
      document.getElementById('mStreak').textContent = streak;
      setTimeout(round, 1200);
    });
    try {
      const svg = await loadMapSVG(correct[0]);
      const shape = document.getElementById('mShape'); if (shape) shape.innerHTML = svg;
    } catch {
      const shape = document.getElementById('mShape'); if (shape) shape.textContent = '지도를 불러오지 못했어요';
    }
  };
  round();
}

// ── 미니게임: 3아웃 야구 (숫자야구) ───────────────────
// 컴퓨터가 정한 서로 다른 3자리 숫자 맞히기. S=숫자·자리 일치, B=숫자만 일치, 0S0B=아웃, 3아웃이면 패배.
function startBaseball(el) {
  const genSecret = () => shuffle(['0','1','2','3','4','5','6','7','8','9']).slice(0, 3);
  let secret = genSecret(), tries = 0, outs = 0, over = false;
  el.innerHTML = `<div class="mg bb">
    <div class="mg-msg" id="bbMsg">서로 다른 3자리 숫자를 맞혀봐요!</div>
    <div class="bb-outs" id="bbOuts"></div>
    <div class="bb-in">
      <input type="text" id="bbIn" inputmode="numeric" maxlength="3" placeholder="예: 381" autocomplete="off" />
      <button id="bbBtn">확인</button>
    </div>
    <div class="bb-log" id="bbLog"></div>
    <button class="btn ghost small" id="bbReset" hidden>새 게임</button>
  </div>`;
  const inp = el.querySelector('#bbIn'), msg = el.querySelector('#bbMsg');
  const outsEl = el.querySelector('#bbOuts'), log = el.querySelector('#bbLog');
  const btn = el.querySelector('#bbBtn'), resetBtn = el.querySelector('#bbReset');
  const drawOuts = () => { outsEl.innerHTML = '아웃 ' + '<span class="o-on">●</span>'.repeat(outs) + '<span class="o-off">○</span>'.repeat(3 - outs); };

  const endGame = (win) => {
    over = true; inp.disabled = true; btn.disabled = true; resetBtn.hidden = false;
    if (win) { msg.textContent = `정답! 🎉 ${tries}번 만에 맞혔어요`; recordStat('baseball', { result: 'win', best: tries }); }
    else { msg.textContent = `쓰리아웃! 😢 정답은 ${secret.join('')}`; recordStat('baseball', { result: 'loss' }); }
  };

  const guess = () => {
    if (over) return;
    const v = (inp.value || '').trim();
    if (!/^\d{3}$/.test(v)) { msg.textContent = '3자리 숫자를 입력하세요'; return; }
    const arr = v.split('');
    if (new Set(arr).size !== 3) { msg.textContent = '서로 다른 숫자 3개여야 해요'; return; }
    tries++;
    let strike = 0, ball = 0;
    for (let i = 0; i < 3; i++) {
      if (arr[i] === secret[i]) strike++;
      else if (secret.includes(arr[i])) ball++;
    }
    const out = strike === 0 && ball === 0;
    if (out) outs++;
    const label = strike === 3 ? '3S' : out ? '아웃' : `${strike}S ${ball}B`;
    const row = document.createElement('div');
    row.className = 'bb-row';
    row.innerHTML = `<span class="bb-g">${escapeHtml(v)}</span><span class="bb-r ${strike === 3 ? 'win' : out ? 'out' : ''}">${label}</span>`;
    log.prepend(row);
    drawOuts();
    inp.value = ''; inp.focus();
    if (strike === 3) endGame(true);
    else if (outs >= 3) endGame(false);
    else msg.textContent = out ? '아웃! 하나도 안 맞았어요' : '계속 도전!';
  };

  btn.onclick = guess;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') guess(); });
  resetBtn.onclick = () => startBaseball(el);
  drawOuts(); inp.focus();
}

// ── 미니게임: 오목 (5목, vs 컴퓨터) ───────────────────
function startOmok(el) {
  // 1) 난이도 선택 화면
  el.innerHTML = `<div class="mg omok-pick">
    <div class="mg-msg">난이도를 골라요 ⚫</div>
    <div class="omok-levels">
      ${OMOK_LEVELS.map(l => `<button data-k="${l.key}">${l.label}<small>${l.desc}</small></button>`).join('')}
    </div>
  </div>`;
  el.querySelectorAll('.omok-levels button').forEach(b =>
    b.onclick = () => runOmok(el, OMOK_LEVELS.find(l => l.key === b.dataset.k)));
}

function runOmok(el, level) {
  const N = 20, EMPTY = 0, ME = 1, CPU = 2;
  let board = Array(N * N).fill(EMPTY), over = false, busy = false;
  const history = [];   // 수순 기록 — 무르기용
  let recorded = false;   // 한 게임당 결과는 1회만 기록(무르기→재승리 중복 카운트 방지)
  const idx = (r, c) => r * N + c;
  const inb = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
  el.innerHTML = `<div class="mg omok">
    <div class="mg-msg" id="omMsg">[${level.label}] 당신(⚫) 차례 — 5개 먼저!</div>
    <div class="omok-grid" id="omGrid" style="grid-template-columns:repeat(${N},1fr)"></div>
    <div class="omok-btns">
      <button class="btn ghost small" id="omUndo">한 수 무르기</button>
      <button class="btn ghost small" id="omReset">새 게임</button>
      <button class="btn ghost small" id="omLevel">난이도 변경</button>
    </div>
  </div>`;
  const grid = el.querySelector('#omGrid'), msg = el.querySelector('#omMsg');

  const draw = () => {
    grid.innerHTML = board.map((v, i) => {
      const cls = v === ME ? 'me' : v === CPU ? 'cpu' : '';
      return `<button class="om-cell ${cls}" data-i="${i}" ${(v || over || busy) ? 'disabled' : ''}><span class="stone"></span></button>`;
    }).join('');
    grid.querySelectorAll('.om-cell').forEach(b => b.onclick = () => play(+b.dataset.i));
    const ub = el.querySelector('#omUndo'); if (ub) ub.disabled = busy || history.length === 0;
  };

  const fiveAt = (b, i, p) => {
    const r = (i / N | 0), c = i % N;
    for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      let cnt = 1;
      for (let s = 1; s < 5; s++) { const nr = r+dr*s, nc = c+dc*s; if (inb(nr,nc) && b[idx(nr,nc)] === p) cnt++; else break; }
      for (let s = 1; s < 5; s++) { const nr = r-dr*s, nc = c-dc*s; if (inb(nr,nc) && b[idx(nr,nc)] === p) cnt++; else break; }
      if (cnt >= 5) return true;
    }
    return false;
  };

  const finish = (result) => {
    over = true;
    const label = { win: '이겼어요! 🎉', loss: '졌어요 😢', draw: '무승부 😐' }[result];
    msg.textContent = `[${level.label}] ${label}`;
    if (!recorded) { recorded = true; recordStat(level.key, { result }); }   // 1회만 기록
    draw();
  };

  const patternScore = (cnt, open) => {
    if (cnt >= 5) return 1e6;
    if (open === 0) return 0;
    if (cnt === 4) return open === 2 ? 5e5 : 15000;
    if (cnt === 3) return open === 2 ? 6000 : 600;
    if (cnt === 2) return open === 2 ? 250 : 40;
    return open === 2 ? 12 : 3;
  };
  const scoreAt = (b, i, p) => {
    const r = (i / N | 0), c = i % N; let total = 0;
    for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
      let cnt = 1, open = 0, s = 1;
      for (; s < 5; s++) { const nr = r+dr*s, nc = c+dc*s; if (inb(nr,nc) && b[idx(nr,nc)] === p) cnt++; else break; }
      { const nr = r+dr*s, nc = c+dc*s; if (inb(nr,nc) && b[idx(nr,nc)] === EMPTY) open++; }
      let s2 = 1;
      for (; s2 < 5; s2++) { const nr = r-dr*s2, nc = c-dc*s2; if (inb(nr,nc) && b[idx(nr,nc)] === p) cnt++; else break; }
      { const nr = r-dr*s2, nc = c-dc*s2; if (inb(nr,nc) && b[idx(nr,nc)] === EMPTY) open++; }
      total += patternScore(cnt, open);
    }
    return total;
  };
  const center = (N - 1) / 2;
  const bias = i => (Math.abs((i / N | 0) - center) + Math.abs((i % N) - center)) * 1.2;
  // 돌 주변 빈 칸 후보(없으면 중앙)
  const candidates = (b) => {
    const set = new Set(); let any = false;
    for (let i = 0; i < N * N; i++) {
      if (!b[i]) continue; any = true;
      const r = i / N | 0, c = i % N;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { const nr = r+dr, nc = c+dc; if (inb(nr,nc) && !b[idx(nr,nc)]) set.add(idx(nr,nc)); }
    }
    return any ? [...set] : [idx(center | 0, center | 0)];
  };
  const bestBy = (cands, fn) => {
    let best = cands[0], bv = -Infinity;
    for (const i of cands) { const v = fn(i); if (v > bv) { bv = v; best = i; } }
    return best;
  };
  // 급수별 AI
  const chooseMove = () => {
    const cands = candidates(board);
    if (level.key === 'omok_easy') {
      // 초급: 절반은 랜덤, 나머지는 공격만(방어 약함) → 이기기 쉬움
      if (Math.random() < 0.5) return cands[Math.random() * cands.length | 0];
      return bestBy(cands, i => scoreAt(board, i, CPU) - bias(i));
    }
    if (level.key === 'omok_hard') {
      // 상급: 1수 앞 — 내가 둔 뒤 상대 최선 위협까지 차감
      return bestBy(cands, i => {
        const off = scoreAt(board, i, CPU); if (off >= 1e6) return 1e9;
        board[i] = CPU; let oppBest = 0;
        for (const j of candidates(board)) { const v = scoreAt(board, j, ME); if (v > oppBest) oppBest = v; }
        board[i] = EMPTY;
        return off + scoreAt(board, i, ME) * 1.1 - oppBest * 0.9 - bias(i);
      });
    }
    if (level.key === 'omok_pro') {
      // 프로: 2수 앞 — 내 수 → 상대 최선 응수 → 내 최선 후속까지. 위협 차단·연계 공격 강화.
      return bestBy(cands, i => {
        const off = scoreAt(board, i, CPU); if (off >= 1e6) return 1e9;     // 즉승
        const def = scoreAt(board, i, ME);
        board[i] = CPU;
        let oppBest = 0, jb = -1;
        for (const j of candidates(board)) { const v = scoreAt(board, j, ME); if (v > oppBest) { oppBest = v; jb = j; } }
        let follow = 0;
        if (jb >= 0) {
          board[jb] = ME;
          for (const k of candidates(board)) { const v = scoreAt(board, k, CPU); if (v > follow) follow = v; }
          board[jb] = EMPTY;
        }
        board[i] = EMPTY;
        return off + def * 1.15 + follow * 0.6 - oppBest * 1.0 - bias(i);
      });
    }
    // 중급: 공격 + 방어 (1수)
    return bestBy(cands, i => scoreAt(board, i, CPU) + scoreAt(board, i, ME) * 1.05 - bias(i));
  };

  const play = (i) => {
    if (over || busy || board[i]) return;
    board[i] = ME; history.push({ i, who: ME });
    if (fiveAt(board, i, ME)) { finish('win'); return; }
    if (!board.includes(EMPTY)) { finish('draw'); return; }
    busy = true; msg.textContent = '컴퓨터 생각 중…'; draw();
    setTimeout(() => {
      if (!el.querySelector('.omok')) return;   // 화면 이탈 시 중단
      const mv = chooseMove(); board[mv] = CPU; history.push({ i: mv, who: CPU }); busy = false;
      if (fiveAt(board, mv, CPU)) { finish('loss'); return; }
      if (!board.includes(EMPTY)) { finish('draw'); return; }
      msg.textContent = `[${level.label}] 당신(⚫) 차례`; draw();
    }, 350);
  };

  // 한 수 무르기 — 내 수 + 컴퓨터 응수를 함께 되돌려 다시 내 차례로
  const undo = () => {
    if (busy || !history.length) return;
    const last = history.pop(); board[last.i] = EMPTY;
    if (last.who === CPU && history.length) { const prev = history.pop(); board[prev.i] = EMPTY; }
    over = false; msg.textContent = `[${level.label}] 당신(⚫) 차례`; draw();
  };
  el.querySelector('#omUndo').onclick = undo;
  el.querySelector('#omReset').onclick = () => runOmok(el, level);
  el.querySelector('#omLevel').onclick = () => startOmok(el);
  draw();
}

// ── 미니게임: 틀린그림찾기 (이모지 그리드) ────────────
function startSpot(el) {
  const POOL = ['🌳','🐶','🍎','🌸','🚗','🐱','🌼','🏠','☁️','🦋','🍄','🐰','🌻','⚽','🎈','🐢','🌈','🍩','🚀','⭐','🐝','🍉','🎁','🐧','🌵','🍦','🎩','🐠'];
  const COLS = 5, ROWS = 5, N = COLS * ROWS, MISS_LIMIT = 3;
  let streak = 0;
  const round = () => {
    const K = Math.min(3 + Math.floor(streak / 2), 7);   // 연속 늘면 차이 개수 증가
    const base = Array.from({ length: N }, () => POOL[Math.random() * POOL.length | 0]);
    const mod = base.slice(), diffSet = new Set();
    while (diffSet.size < K) diffSet.add(Math.random() * N | 0);
    for (const i of diffSet) { let e; do { e = POOL[Math.random() * POOL.length | 0]; } while (e === base[i]); mod[i] = e; }
    const found = new Set(); let misses = 0;
    el.innerHTML = `<div class="mg spot">
      <div class="mg-msg" id="spMsg">아래 그림에서 다른 곳 ${K}군데를 찾아요!</div>
      <div class="spot-grids">
        <div class="spot-grid" id="spA" style="grid-template-columns:repeat(${COLS},1fr)"></div>
        <div class="spot-tag">↑ 원본 · ↓ 여기서 다른 곳 탭</div>
        <div class="spot-grid" id="spB" style="grid-template-columns:repeat(${COLS},1fr)"></div>
      </div>
      <div class="mg-score">연속 <b id="spStreak">${streak}</b> · 남은 오답 <b id="spMiss">${MISS_LIMIT}</b></div>
    </div>`;
    const A = el.querySelector('#spA'), B = el.querySelector('#spB'), msg = el.querySelector('#spMsg');
    A.innerHTML = base.map(e => `<div class="sp-cell">${e}</div>`).join('');
    B.innerHTML = mod.map((e, i) => `<button class="sp-cell" data-i="${i}">${e}</button>`).join('');
    const next = (ms) => setTimeout(() => { if (el.querySelector('.spot')) round(); }, ms);   // 화면 이탈 시 중단
    B.querySelectorAll('.sp-cell').forEach(b => b.onclick = () => {
      const i = +b.dataset.i;
      if (found.has(i) || b.disabled) return;
      if (diffSet.has(i)) {
        found.add(i); b.classList.add('found'); A.children[i].classList.add('found');
        if (found.size === K) {
          streak++; recordStat('spot', { result: 'win', best: streak });
          msg.textContent = '다 찾았다! 🎉'; el.querySelector('#spStreak').textContent = streak;
          B.querySelectorAll('.sp-cell').forEach(x => x.disabled = true); next(1000);
        } else msg.textContent = `좋아요! ${K - found.size}군데 남음`;
      } else {
        misses++; b.classList.add('miss'); setTimeout(() => b.classList.remove('miss'), 400);
        const left = MISS_LIMIT - misses; el.querySelector('#spMiss').textContent = Math.max(0, left);
        if (misses >= MISS_LIMIT) {
          recordStat('spot', { result: 'loss' }); streak = 0;
          msg.textContent = '오답 초과 😢 다시 시작!'; el.querySelector('#spStreak').textContent = streak;
          B.querySelectorAll('.sp-cell').forEach(x => x.disabled = true); next(1200);
        } else msg.textContent = `아니에요! (남은 오답 ${left})`;
      }
    });
  };
  round();
}

// ── 미니게임: 색칠하기 (SVG 도안, 기록 없음) ──────────
const COLOR_PICS = [
  { name: '꽃', svg: `
    <rect class="cregion" x="96" y="95" width="8" height="85" rx="4" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="78" cy="138" rx="22" ry="11" fill="#fff" stroke="#333" stroke-width="2" transform="rotate(-25 78 138)"/>
    <ellipse class="cregion" cx="122" cy="155" rx="22" ry="11" fill="#fff" stroke="#333" stroke-width="2" transform="rotate(25 122 155)"/>
    <circle class="cregion" cx="100" cy="48" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="138" cy="72" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="124" cy="112" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="76" cy="112" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="62" cy="72" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="80" r="22" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '집', svg: `
    <circle class="cregion" cx="165" cy="35" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="45" y="90" width="110" height="90" fill="#fff" stroke="#333" stroke-width="2"/>
    <polygon class="cregion" points="36,90 100,44 164,90" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="88" y="130" width="28" height="50" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="58" y="108" width="26" height="26" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="120" y="108" width="26" height="26" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '물고기', svg: `
    <circle class="cregion" cx="40" cy="52" r="8" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="56" cy="36" r="6" fill="#fff" stroke="#333" stroke-width="2"/>
    <polygon class="cregion" points="150,100 186,74 186,126" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="100" cy="100" rx="55" ry="35" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M92 66 Q110 50 128 68 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="74" cy="92" r="6" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="74" cy="92" r="2.5" fill="#333"/>` },
  { name: '나비', svg: `
    <path d="M100 70 Q92 50 84 46" fill="none" stroke="#333" stroke-width="2"/>
    <path d="M100 70 Q108 50 116 46" fill="none" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="68" cy="84" rx="31" ry="25" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="132" cy="84" rx="31" ry="25" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="76" cy="132" rx="24" ry="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="124" cy="132" rx="24" ry="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="100" cy="105" rx="9" ry="44" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '자동차', svg: `
    <circle class="cregion" cx="62" cy="142" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="140" cy="142" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="28" y="102" width="146" height="38" rx="12" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M60 102 L80 72 L126 72 L146 102 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="84" y="78" width="18" height="22" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="106" y="78" width="18" height="22" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '강아지', svg: `
    <ellipse class="cregion" cx="54" cy="76" rx="16" ry="30" fill="#fff" stroke="#333" stroke-width="2" transform="rotate(-20 54 76)"/>
    <ellipse class="cregion" cx="146" cy="76" rx="16" ry="30" fill="#fff" stroke="#333" stroke-width="2" transform="rotate(20 146 76)"/>
    <circle class="cregion" cx="100" cy="106" r="54" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="100" cy="126" rx="34" ry="26" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="80" cy="96" r="5" fill="#333"/>
    <circle cx="120" cy="96" r="5" fill="#333"/>
    <ellipse class="cregion" cx="100" cy="116" rx="9" ry="7" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M100 123 V135 M100 135 Q88 141 82 133 M100 135 Q112 141 118 133" fill="none" stroke="#333" stroke-width="2"/>` },
  { name: '고양이', svg: `
    <path class="cregion" d="M58 72 L52 34 L88 60 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M142 72 L148 34 L112 60 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="112" r="52" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse cx="80" cy="104" rx="6" ry="9" fill="#333"/>
    <ellipse cx="120" cy="104" rx="6" ry="9" fill="#333"/>
    <path class="cregion" d="M94 120 L106 120 L100 128 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M100 124 V132 M70 116 H40 M70 126 H42 M130 116 H160 M130 126 H158" fill="none" stroke="#333" stroke-width="2"/>` },
  { name: '케이크', svg: `
    <ellipse class="cregion" cx="100" cy="162" rx="70" ry="10" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="44" y="112" width="112" height="46" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="60" y="80" width="80" height="34" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="96" y="56" width="8" height="24" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M100 38 Q109 50 100 56 Q91 50 100 38 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '로켓', svg: `
    <path class="cregion" d="M100 28 Q130 60 130 122 L70 122 Q70 60 100 28 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="80" r="14" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M70 102 L48 142 L70 124 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M130 102 L152 142 L130 124 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="70" y="122" width="60" height="14" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M84 136 Q100 182 116 136 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '나무', svg: `
    <rect class="cregion" x="90" y="118" width="20" height="62" rx="4" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="66" cy="100" r="30" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="134" cy="100" r="30" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="70" r="36" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '공룡', svg: `
    <rect class="cregion" x="80" y="142" width="16" height="34" rx="4" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="116" y="142" width="16" height="34" rx="4" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="106" cy="120" rx="48" ry="28" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M72 112 Q40 102 46 64 Q48 48 64 50 Q76 52 72 68 Q68 94 98 106 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M150 120 Q182 110 190 134 Q172 128 150 132 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="58" cy="64" r="3.5" fill="#333"/>` },
  { name: '별', svg: `
    <polygon class="cregion" points="100,28 118,78 172,78 128,110 146,162 100,130 54,162 72,110 28,78 82,78" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '하트', svg: `
    <path class="cregion" d="M100 158 C50 118 44 74 72 62 C88 55 100 70 100 84 C100 70 112 55 128 62 C156 74 150 118 100 158 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '사과', svg: `
    <rect class="cregion" x="97" y="40" width="6" height="26" rx="3" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M103 54 Q128 40 134 60 Q112 64 103 54 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M100 64 C120 46 150 54 150 94 C150 132 124 162 100 162 C76 162 50 132 50 94 C50 54 80 46 100 64 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '돛단배', svg: `
    <path class="cregion" d="M40 142 L160 142 L140 170 L60 170 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="97" y="46" width="6" height="96" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M104 52 L152 134 L104 134 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M92 62 L50 134 L92 134 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '곰', svg: `
    <circle class="cregion" cx="60" cy="58" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="140" cy="58" r="20" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="108" r="58" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="100" cy="126" rx="30" ry="24" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="82" cy="98" r="5" fill="#333"/>
    <circle cx="118" cy="98" r="5" fill="#333"/>
    <ellipse class="cregion" cx="100" cy="118" rx="9" ry="7" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '눈사람', svg: `
    <circle class="cregion" cx="100" cy="130" r="42" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="66" r="30" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="72" y="30" width="56" height="8" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="84" y="8" width="32" height="24" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="90" cy="62" r="3.5" fill="#333"/>
    <circle cx="110" cy="62" r="3.5" fill="#333"/>
    <polygon class="cregion" points="100,70 120,74 100,78" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '태양', svg: `
    <circle class="cregion" cx="100" cy="100" r="42" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M100 28 V52 M100 148 V172 M28 100 H52 M148 100 H172 M49 49 L66 66 M151 49 L134 66 M49 151 L66 134 M151 151 L134 134" fill="none" stroke="#333" stroke-width="2"/>` },
  { name: '아이스크림', svg: `
    <circle class="cregion" cx="100" cy="60" r="28" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="78" cy="76" r="22" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="122" cy="76" r="22" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M62 92 L100 178 L138 92 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '로봇', svg: `
    <line x1="100" y1="50" x2="100" y2="30" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="26" r="7" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="60" y="50" width="80" height="64" rx="10" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="82" cy="78" r="7" fill="#333"/>
    <circle cx="118" cy="78" r="7" fill="#333"/>
    <rect class="cregion" x="80" y="96" width="40" height="8" rx="4" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="66" y="120" width="68" height="50" rx="8" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="40" y="128" width="18" height="40" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>
    <rect class="cregion" x="142" y="128" width="18" height="40" rx="6" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '펭귄', svg: `
    <ellipse class="cregion" cx="100" cy="112" rx="46" ry="58" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="100" cy="120" rx="28" ry="42" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="60" cy="120" rx="10" ry="26" fill="#fff" stroke="#333" stroke-width="2" transform="rotate(20 60 120)"/>
    <ellipse class="cregion" cx="140" cy="120" rx="10" ry="26" fill="#fff" stroke="#333" stroke-width="2" transform="rotate(-20 140 120)"/>
    <circle cx="88" cy="86" r="5" fill="#333"/>
    <circle cx="112" cy="86" r="5" fill="#333"/>
    <polygon class="cregion" points="92,98 108,98 100,110" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="86" cy="174" rx="14" ry="7" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="114" cy="174" rx="14" ry="7" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '토끼', svg: `
    <ellipse class="cregion" cx="82" cy="52" rx="14" ry="36" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="118" cy="52" rx="14" ry="36" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="114" r="50" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="84" cy="106" r="5" fill="#333"/>
    <circle cx="116" cy="106" r="5" fill="#333"/>
    <ellipse class="cregion" cx="100" cy="122" rx="7" ry="5" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M100 127 V135 M100 135 Q90 141 84 134 M100 135 Q110 141 116 134" fill="none" stroke="#333" stroke-width="2"/>` },
  { name: '병아리', svg: `
    <circle class="cregion" cx="100" cy="114" r="50" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M84 64 Q100 46 116 64" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="86" cy="106" r="5" fill="#333"/>
    <circle cx="114" cy="106" r="5" fill="#333"/>
    <polygon class="cregion" points="92,118 108,118 100,130" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M82 160 L76 172 M96 162 L96 174 M104 162 L104 174 M118 160 L124 172" fill="none" stroke="#333" stroke-width="2"/>` },
  { name: '부엉이', svg: `
    <path class="cregion" d="M52 66 L64 42 L82 60 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M148 66 L136 42 L118 60 Z" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="100" cy="110" rx="52" ry="60" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="80" cy="94" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="120" cy="94" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="80" cy="94" r="6" fill="#333"/>
    <circle cx="120" cy="94" r="6" fill="#333"/>
    <polygon class="cregion" points="92,106 108,106 100,120" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M66 142 Q100 158 134 142" fill="none" stroke="#333" stroke-width="2"/>` },
  { name: '문어', svg: `
    <ellipse class="cregion" cx="100" cy="82" rx="46" ry="44" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="86" cy="78" r="5" fill="#333"/>
    <circle cx="114" cy="78" r="5" fill="#333"/>
    <path d="M84 98 Q100 110 116 98" fill="none" stroke="#333" stroke-width="2"/>
    <path class="cregion" d="M56 104 Q54 152 42 164 Q64 160 68 132 Q74 158 84 162 Q92 154 88 128 Q98 158 100 162 Q102 158 112 128 Q116 154 116 162 Q126 158 132 132 Q136 160 158 164 Q146 152 144 104 Z" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '개구리', svg: `
    <circle class="cregion" cx="72" cy="64" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="128" cy="64" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="72" cy="64" r="6" fill="#333"/>
    <circle cx="128" cy="64" r="6" fill="#333"/>
    <ellipse class="cregion" cx="100" cy="118" rx="60" ry="48" fill="#fff" stroke="#333" stroke-width="2"/>
    <path d="M74 126 Q100 148 126 126" fill="none" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="52" cy="162" rx="20" ry="10" fill="#fff" stroke="#333" stroke-width="2"/>
    <ellipse class="cregion" cx="148" cy="162" rx="20" ry="10" fill="#fff" stroke="#333" stroke-width="2"/>` },
  { name: '무당벌레', svg: `
    <ellipse class="cregion" cx="100" cy="114" rx="54" ry="46" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="100" cy="72" r="18" fill="#fff" stroke="#333" stroke-width="2"/>
    <line x1="100" y1="74" x2="100" y2="160" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="78" cy="102" r="9" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="122" cy="102" r="9" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="76" cy="130" r="9" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle class="cregion" cx="124" cy="130" r="9" fill="#fff" stroke="#333" stroke-width="2"/>
    <circle cx="92" cy="68" r="3" fill="#333"/>
    <circle cx="108" cy="68" r="3" fill="#333"/>` },
];
const COLOR_PALETTE = [
  // 빨강·분홍
  '#7f1d1d', '#ef4444', '#f87171', '#ec4899', '#f9a8d4',
  // 주황·노랑
  '#c2410c', '#f97316', '#fdba74', '#eab308', '#facc15', '#fde047',
  // 초록
  '#4d7c0f', '#22c55e', '#86efac',
  // 청록·파랑
  '#0d9488', '#22d3ee', '#a5f3fc', '#1e40af', '#3b82f6', '#93c5fd',
  // 보라
  '#6d28d9', '#a78bfa', '#c084fc',
  // 갈색·살구
  '#92400e', '#b45309', '#d2a679', '#f5d0b5',
  // 무채색
  '#000000', '#9ca3af', '#e5e7eb', '#ffffff'
];

// #hex → [r,g,b]
function hexToRgb(hex) {
  hex = String(hex).replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// 캔버스 플러드필(물통) — 탭 지점의 색 영역을 fill 색으로. 어두운 선에서 멈춤.
function floodFill(ctx, w, h, x, y, fill, tol) {
  const image = ctx.getImageData(0, 0, w, h), data = image.data;
  const idx = (px, py) => (py * w + px) * 4;
  const si = idx(x, y);
  const tr = data[si], tg = data[si + 1], tb = data[si + 2], ta = data[si + 3];
  if (tr + tg + tb < 150) return;                                        // 어두운 선은 채우지 않음
  const [fr, fg, fb] = fill;
  if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 8) return;
  const match = (i) => (Math.abs(data[i] - tr) + Math.abs(data[i + 1] - tg) + Math.abs(data[i + 2] - tb) + Math.abs(data[i + 3] - ta)) <= tol;
  const stack = [[x, y]];
  while (stack.length) {
    const [cx0, cy] = stack.pop();
    let nx = cx0;
    while (nx >= 0 && match(idx(nx, cy))) nx--;
    nx++;
    let up = false, down = false;
    while (nx < w && match(idx(nx, cy))) {
      const i = idx(nx, cy);
      data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 255;
      if (cy > 0) { if (match(idx(nx, cy - 1))) { if (!up) { stack.push([nx, cy - 1]); up = true; } } else up = false; }
      if (cy < h - 1) { if (match(idx(nx, cy + 1))) { if (!down) { stack.push([nx, cy + 1]); down = true; } } else down = false; }
      nx++;
    }
  }
  ctx.putImageData(image, 0, 0);
}
function startColor(el) {
  let pic = 0, selected = COLOR_PALETTE[0];
  const render = () => {
    const imgs = galleryGet();
    const total = COLOR_PICS.length + imgs.length;
    if (pic >= total) pic = 0;
    const ci = pic - COLOR_PICS.length;          // ≥0이면 커스텀 사진 인덱스
    const custom = ci >= 0;
    const name = custom ? `내 그림 ${ci + 1}/${imgs.length}` : COLOR_PICS[pic].name;
    const stage = custom
      ? `<div class="color-canvas"><canvas id="colorCv"></canvas></div>`
      : `<div class="color-canvas"><svg viewBox="0 0 200 200" id="colorSvg">${COLOR_PICS[pic].svg}</svg></div>`;
    el.innerHTML = `<div class="mg color">
      <div class="mg-msg">${name} — 색을 고르고 ${custom ? '선 안쪽을' : '영역을'} 탭! 🎨</div>
      ${stage}
      <div class="color-palette" id="colorPal">${COLOR_PALETTE.map(c => `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <div class="color-btns">
        <button class="btn ghost small" id="colorPrev">◀ 이전</button>
        <button class="btn ghost small" id="colorUndo">지우기</button>
        <button class="btn ghost small" id="colorClear">전부삭제</button>
        <button class="btn ghost small" id="colorNext">다음 ▶</button>
      </div>
      <div class="color-btns">
        <button class="btn ghost small" id="colorLoad">🖼️ 내 사진 추가</button>
        <button class="btn ghost small" id="colorSave" title="사진첩(갤러리)에 저장">💾 저장하기</button>
        ${custom ? `<button class="btn ghost small" id="colorDelImg">🗑 이 사진 삭제</button>` : ''}
      </div>
      <input type="file" accept="image/*" multiple id="colorFile" style="display:none">
    </div>`;
    const pal = el.querySelector('#colorPal'), history = [];
    const marks = () => pal.querySelectorAll('.sw').forEach(s => s.classList.toggle('sel', s.dataset.c === selected));
    pal.querySelectorAll('.sw').forEach(s => s.onclick = () => { selected = s.dataset.c; marks(); });
    marks();
    if (custom) {
      const cv = el.querySelector('#colorCv');
      const cx = cv.getContext('2d', { willReadFrequently: true });
      let base = null;
      const im = new Image();
      im.onload = () => {
        const S = Math.max(im.naturalWidth, im.naturalHeight) || 600;   // 정사각 캔버스(왜곡·좌표오차 방지)
        cv.width = S; cv.height = S;
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, S, S);
        cx.drawImage(im, Math.round((S - im.naturalWidth) / 2), Math.round((S - im.naturalHeight) / 2));
        try { base = cx.getImageData(0, 0, S, S); } catch (e) {}
      };
      im.src = imgs[ci];
      cv.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (!cv.width) return;
        const r = cv.getBoundingClientRect();
        const x = Math.round((e.clientX - r.left) * (cv.width / r.width));
        const y = Math.round((e.clientY - r.top) * (cv.height / r.height));
        if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
        try { history.push(cx.getImageData(0, 0, cv.width, cv.height)); if (history.length > 10) history.shift(); } catch (e2) {}
        floodFill(cx, cv.width, cv.height, x, y, hexToRgb(selected), 50);
      });
      el.querySelector('#colorUndo').onclick = () => { const s = history.pop(); if (s) cx.putImageData(s, 0, 0); };
      el.querySelector('#colorClear').onclick = () => { if (base) cx.putImageData(base, 0, 0); history.length = 0; };
    } else {
      const svg = el.querySelector('#colorSvg');
      svg.querySelectorAll('.cregion').forEach(r => r.addEventListener('click', () => {
        history.push({ el: r, fill: r.getAttribute('fill') });
        r.setAttribute('fill', selected);
      }));
      el.querySelector('#colorUndo').onclick = () => { const last = history.pop(); if (last) last.el.setAttribute('fill', last.fill); };
      el.querySelector('#colorClear').onclick = () => { svg.querySelectorAll('.cregion').forEach(r => r.setAttribute('fill', '#ffffff')); history.length = 0; };
    }
    const n = total;
    el.querySelector('#colorPrev').onclick = () => { pic = (pic - 1 + n) % n; render(); };
    el.querySelector('#colorNext').onclick = () => { pic = (pic + 1) % n; render(); };
    const fileEl = el.querySelector('#colorFile');
    el.querySelector('#colorLoad').onclick = () => fileEl.click();
    fileEl.onchange = () => addFilesToGallery(fileEl, (added) => {
      if (added == null) return;                     // 취소
      const g = galleryGet();
      if (g.length) pic = COLOR_PICS.length + g.length - 1;   // 방금 추가한 마지막 사진으로 이동
      render();
    });
    const delImg = el.querySelector('#colorDelImg');
    if (delImg) delImg.onclick = () => { if (!confirm('이 사진을 삭제할까요?')) return; galleryRemoveAt(ci); pic = 0; render(); };
    // 저장하기 — 색칠 결과를 한 장으로 만들어 사진첩에 저장
    el.querySelector('#colorSave').onclick = () => {
      if (custom) saveCanvasToGallery(el.querySelector('#colorCv'), artFilename());
      else svgToCanvas(el.querySelector('#colorSvg'), 800, '#fff', (c) => saveCanvasToGallery(c, artFilename()));
    };
  };
  render();
}

// ── 미니게임: 붓칠하기 (자유 드로잉, 기록 없음) ───────
// 색칠하기와 같은 밑그림에 canvas로 자유롭게 붓칠. 외곽선은 위에 겹쳐 보이게(채움 없음).
// 붓칠하기 '내 사진' — 흰 배경에 다운스케일 후 dataURL (multiply 오버레이용)
function loadBrushImage(file, cb, errCb) {
  const fail = (msg) => { if (errCb) errCb(); else alert(msg); };
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const MAX = 1100;
    let w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);   // 투명 배경 → 흰색(멀티플라이 중립)
    cx.drawImage(img, 0, 0, w, h);
    let durl = '';
    try { durl = c.toDataURL('image/jpeg', 0.88); } catch (e) {}
    durl ? cb(durl) : fail('이미지 처리에 실패했어요.');
  };
  img.onerror = () => { URL.revokeObjectURL(url); fail('이미지를 열 수 없어요.'); };
  img.src = url;
}
// '내 사진' 갤러리 — 여러 장 보관. 붓칠하기·색칠하기가 공유. localStorage 배열(dataURL).
const GALLERY_KEY = 'gw-imgs', GALLERY_OLD = 'gw-brush-img';
function galleryGet() {
  try {
    const raw = localStorage.getItem(GALLERY_KEY);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) return a.filter(x => typeof x === 'string' && x); }
  } catch (e) {}
  try { const old = localStorage.getItem(GALLERY_OLD); if (old) return [old]; } catch (e) {}   // 구버전 단일 사진 이관
  return [];
}
function gallerySave(arr) {
  localStorage.setItem(GALLERY_KEY, JSON.stringify(arr));   // 용량초과 시 예외 → 호출부 처리
  try { localStorage.removeItem(GALLERY_OLD); } catch (e) {}
}
function galleryAdd(durl) {   // true=성공, false=용량초과
  const arr = galleryGet(); arr.push(durl);
  try { gallerySave(arr); return true; } catch (e) { return false; }
}
function galleryRemoveAt(i) {
  const arr = galleryGet();
  if (i >= 0 && i < arr.length) { arr.splice(i, 1); try { gallerySave(arr); } catch (e) {} }
  return galleryGet();
}
// 파일 여러 개를 순차로 갤러리에 추가. done(added|null) — null=취소. 열기 실패 파일은 건너뜀.
function addFilesToGallery(fileEl, done) {
  const files = Array.from(fileEl.files || []); fileEl.value = '';
  if (!files.length) { done(null); return; }
  let added = 0, full = false;
  const step = (i) => {
    if (i >= files.length) {
      if (full) alert('저장 공간이 부족해 일부 사진은 추가하지 못했어요. 사진을 몇 장 삭제한 뒤 다시 시도해주세요.');
      done(added);
      return;
    }
    loadBrushImage(files[i], (durl) => {
      if (!full) { if (galleryAdd(durl)) added++; else full = true; }
      step(i + 1);
    }, () => step(i + 1));
  };
  step(0);
}
// SVG 요소를 캔버스로 래스터화. bg=null이면 투명 배경. done(canvas|null).
function svgToCanvas(svgEl, size, bg, done) {
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('width', size);
  clone.setAttribute('height', size);
  if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', '0 0 200 200');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const cx = c.getContext('2d');
    if (bg) { cx.fillStyle = bg; cx.fillRect(0, 0, size, size); }
    cx.drawImage(img, 0, 0, size, size);
    done(c);
  };
  img.onerror = () => done(null);
  img.src = url;
}
function artFilename() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `내그림_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}
// 캔버스를 사진첩에 저장. 모바일은 공유시트('이미지 저장')로 사진 앱(갤러리)에 저장,
// 공유가 안 되거나 실패하면 PNG 파일 다운로드로 대체.
// ※ 웹앱은 저장 폴더(예: 스크린샷 폴더)를 지정할 수 없음 — OS가 위치를 결정.
function saveCanvasToGallery(canvas, filename) {
  if (!canvas) { alert('저장할 그림을 만들지 못했어요.'); return; }
  canvas.toBlob((blob) => {
    if (!blob) { alert('저장할 그림을 만들지 못했어요.'); return; }
    const download = () => {   // 폴백: 파일 다운로드
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: '내 그림' }).catch((err) => {
        if (err && err.name === 'AbortError') return;   // 사용자가 취소 → 그대로 둠
        download();                                      // 공유 실패(권한/제스처) → 다운로드로 저장
      });
      return;
    }
    download();
  }, 'image/png');
}
function startBrush(el) {
  const SIZES = [6, 14, 26], RES = 600, SCALE = RES / 200;
  let pic = 0, color = COLOR_PALETTE[0], size = SIZES[1];
  const render = () => {
    const imgs = galleryGet();
    const total = COLOR_PICS.length + imgs.length;
    if (pic >= total) pic = 0;
    const ci = pic - COLOR_PICS.length;          // ≥0이면 커스텀 사진 인덱스
    const custom = ci >= 0;
    const name = custom ? `내 그림 ${ci + 1}/${imgs.length}` : COLOR_PICS[pic].name;
    const overlay = custom
      ? `<img class="brush-outline brush-img" src="${imgs[ci]}" alt="내 그림">`
      : `<svg class="brush-outline" viewBox="0 0 200 200">${COLOR_PICS[pic].svg}</svg>`;
    el.innerHTML = `<div class="mg brush">
      <div class="mg-msg">${name} — 붓으로 칠해요 🖌️</div>
      <div class="brush-stage">
        <canvas id="brushCv"></canvas>
        ${overlay}
      </div>
      <div class="color-palette" id="brushPal">${COLOR_PALETTE.map(c => `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <div class="brush-sizes" id="brushSizes">${SIZES.map(s => `<button class="bsz" data-s="${s}"><span style="width:${s}px;height:${s}px"></span></button>`).join('')}</div>
      <div class="color-btns">
        <button class="btn ghost small" id="brushPrev">◀ 이전</button>
        <button class="btn ghost small" id="brushUndo">지우기</button>
        <button class="btn ghost small" id="brushClear">전부삭제</button>
        <button class="btn ghost small" id="brushNext">다음 ▶</button>
      </div>
      <div class="color-btns">
        <button class="btn ghost small" id="brushLoad">🖼️ 내 사진 추가</button>
        <button class="btn ghost small" id="brushSave" title="사진첩(갤러리)에 저장">💾 저장하기</button>
        ${custom ? `<button class="btn ghost small" id="brushDelImg">🗑 이 사진 삭제</button>` : ''}
      </div>
      <input type="file" accept="image/*" multiple id="brushFile" style="display:none">
    </div>`;
    const cv = el.querySelector('#brushCv');
    cv.width = RES; cv.height = RES;
    const ctx = cv.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let drawing = false, lastX = 0, lastY = 0;
    const history = [], HMAX = 20;   // 붓질 단위 되돌리기(스냅샷)
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) }; };
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault(); drawing = true; cv.setPointerCapture(e.pointerId);
      history.push(ctx.getImageData(0, 0, RES, RES)); if (history.length > HMAX) history.shift();   // 붓질 직전 상태 저장
      const p = pos(e); lastX = p.x; lastY = p.y;
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, size * SCALE / 2, 0, Math.PI * 2); ctx.fill();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drawing) return; e.preventDefault(); const p = pos(e);
      ctx.strokeStyle = color; ctx.lineWidth = size * SCALE;
      ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastX = p.x; lastY = p.y;
    });
    const end = () => { drawing = false; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    const pal = el.querySelector('#brushPal');
    const markC = () => pal.querySelectorAll('.sw').forEach(s => s.classList.toggle('sel', s.dataset.c === color));
    pal.querySelectorAll('.sw').forEach(s => s.onclick = () => { color = s.dataset.c; markC(); });
    markC();
    const szEl = el.querySelector('#brushSizes');
    const markS = () => szEl.querySelectorAll('.bsz').forEach(b => b.classList.toggle('sel', +b.dataset.s === size));
    szEl.querySelectorAll('.bsz').forEach(b => b.onclick = () => { size = +b.dataset.s; markS(); });
    markS();
    const n = total;
    el.querySelector('#brushPrev').onclick = () => { pic = (pic - 1 + n) % n; render(); };
    el.querySelector('#brushNext').onclick = () => { pic = (pic + 1) % n; render(); };
    el.querySelector('#brushUndo').onclick = () => { const s = history.pop(); if (s) ctx.putImageData(s, 0, 0); };
    el.querySelector('#brushClear').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); history.length = 0; };
    const fileEl = el.querySelector('#brushFile');
    el.querySelector('#brushLoad').onclick = () => fileEl.click();
    fileEl.onchange = () => addFilesToGallery(fileEl, (added) => {
      if (added == null) return;                     // 취소
      const g = galleryGet();
      if (g.length) pic = COLOR_PICS.length + g.length - 1;   // 방금 추가한 마지막 사진으로 이동
      render();
    });
    const delImg = el.querySelector('#brushDelImg');
    if (delImg) delImg.onclick = () => { if (!confirm('이 사진을 삭제할까요?')) return; galleryRemoveAt(ci); pic = 0; render(); };
    // 저장하기 — 붓칠(캔버스)과 외곽선을 한 장으로 합성해 사진첩에 저장
    el.querySelector('#brushSave').onclick = () => {
      const out = document.createElement('canvas'); out.width = RES; out.height = RES;
      const oc = out.getContext('2d');
      oc.fillStyle = '#fff'; oc.fillRect(0, 0, RES, RES);
      oc.drawImage(cv, 0, 0);   // 붓칠 획
      if (custom) {
        const im2 = new Image();
        im2.onload = () => {
          const s = Math.min(RES / im2.naturalWidth, RES / im2.naturalHeight);   // contain 배치
          const w = im2.naturalWidth * s, h = im2.naturalHeight * s;
          oc.globalCompositeOperation = 'multiply';   // 화면과 동일하게 외곽선을 곱하기 합성
          oc.drawImage(im2, (RES - w) / 2, (RES - h) / 2, w, h);
          oc.globalCompositeOperation = 'source-over';
          saveCanvasToGallery(out, artFilename());
        };
        im2.onerror = () => saveCanvasToGallery(out, artFilename());
        im2.src = imgs[ci];
      } else {
        const clone = el.querySelector('.brush-outline').cloneNode(true);
        clone.querySelectorAll('.cregion').forEach(r => r.setAttribute('fill', 'none'));   // 외곽선만(채움 제거)
        svgToCanvas(clone, RES, null, (sc) => { if (sc) oc.drawImage(sc, 0, 0); saveCanvasToGallery(out, artFilename()); });
      }
    };
  };
  render();
}

// ── 미니게임: 룰렛 (기록 없음) ───────────────────────
// 항목 수(2~8) 선택 + 각 항목 글자 입력. 가운데 '시작' 버튼을 누르는 동안 돌아가고, 놓으면 천천히 멈춤.
function startRoulette(el) {
  const COLORS = ['#f43f5e', '#fb923c', '#fbbf24', '#34d399', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6'];
  const MINN = 2, MAXN = 8;
  let n = 6;
  let labels = ['1', '2', '3', '4', '5', '6'];
  let angle = 0, vel = 0, holding = false, raf = null, spinning = false;

  el.innerHTML = `<div class="mg roulette">
    <div class="rl-count">
      <span>항목 수</span>
      <button class="btn ghost small" id="rlMinus">−</button>
      <b id="rlN">${n}</b>
      <button class="btn ghost small" id="rlPlus">＋</button>
    </div>
    <div class="rl-items" id="rlItems"></div>
    <div class="rl-wheelwrap">
      <div class="rl-pointer"></div>
      <canvas id="rlCanvas" width="320" height="320"></canvas>
      <button class="rl-spin" id="rlSpin">시작</button>
    </div>
    <div class="mg-msg rl-result" id="rlResult">가운데 <b>시작</b>을 꾹 누르면 돌아가요!</div>
  </div>`;

  const cv = el.querySelector('#rlCanvas'), ctx = cv.getContext('2d');
  const alive = () => !!el.querySelector('.roulette');
  const label = i => (labels[i] && labels[i].trim()) ? labels[i].trim() : String(i + 1);

  const draw = () => {
    const W = cv.width, cx = W / 2, cy = W / 2, R = W / 2 - 6, seg = 2 * Math.PI / n;
    ctx.clearRect(0, 0, W, W);
    for (let i = 0; i < n; i++) {
      const a0 = angle + i * seg, a1 = a0 + seg;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length]; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(a0 + seg / 2);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(12, 24 - n)}px sans-serif`;
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 3;
      ctx.fillText(label(i).slice(0, 8), R - 12, 0);
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(cx, cy, 30, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill();
  };

  const winnerIndex = () => {
    const seg = 2 * Math.PI / n;
    const p = (((1.5 * Math.PI - angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);  // 포인터=위쪽(12시)
    return Math.floor(p / seg) % n;
  };

  const loop = () => {
    if (!alive()) { raf = null; return; }
    if (holding) { vel = Math.min(0.42, vel + 0.028); }        // 누르는 동안 가속
    else {
      vel = vel * 0.985 - 0.0009;                              // 놓으면 서서히 감속
      if (vel <= 0) {
        vel = 0; spinning = false; draw();
        el.querySelector('#rlResult').innerHTML = `🎉 결과 — <b>${label(winnerIndex())}</b>`;
        raf = null; return;
      }
    }
    angle = (angle + vel) % (2 * Math.PI);
    draw();
    raf = requestAnimationFrame(loop);
  };

  const startSpin = () => {
    holding = true; spinning = true;
    el.querySelector('#rlResult').textContent = '돌리는 중… 놓으면 멈춰요';
    if (!raf) raf = requestAnimationFrame(loop);
  };
  const releaseSpin = () => { holding = false; };
  const spin = el.querySelector('#rlSpin');
  spin.addEventListener('pointerdown', (e) => { e.preventDefault(); try { spin.setPointerCapture(e.pointerId); } catch {} startSpin(); });
  spin.addEventListener('pointerup', releaseSpin);
  spin.addEventListener('pointercancel', releaseSpin);
  spin.addEventListener('contextmenu', (e) => e.preventDefault());

  const renderItems = () => {
    const box = el.querySelector('#rlItems');
    box.innerHTML = Array.from({ length: n }, (_, i) => `<input class="rl-inp" data-i="${i}" placeholder="항목 ${i + 1}" maxlength="8">`).join('');
    box.querySelectorAll('.rl-inp').forEach(inp => {
      const i = +inp.dataset.i;
      inp.value = labels[i] || '';
      inp.oninput = () => { labels[i] = inp.value; if (!spinning) draw(); };
    });
  };
  const setN = (nn) => {
    if (spinning) return;
    n = Math.max(MINN, Math.min(MAXN, nn));
    while (labels.length < n) labels.push(String(labels.length + 1));
    el.querySelector('#rlN').textContent = n;
    renderItems(); draw();
  };
  el.querySelector('#rlMinus').onclick = () => setN(n - 1);
  el.querySelector('#rlPlus').onclick = () => setN(n + 1);

  renderItems(); draw();
}

// ── 미니게임: 테트리스 (보드) ─────────────────────────
// 10x20 보드, 7종 블록(7-bag), 이동/회전(월킥)/소프트·하드드롭, 라인클리어·점수·레벨. 최고 점수 기록.
// 온라인 배틀: 방 통신(Worker+KV 폴링). 공정성 위해 시드 PRNG로 양쪽 블록 순서를 동일하게.
const tetSleep = ms => new Promise(r => setTimeout(r, ms));
function tetGenCode() { const s = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 4; i++) c += s[Math.floor(Math.random() * s.length)]; return c; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function roomPutMeta(code, meta) { return fetch(`${API_BASE}/api/room/${code}/meta`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) }); }
async function roomGetMeta(code) { const r = await fetch(`${API_BASE}/api/room/${code}/meta`, { cache: 'no-store' }); if (r.status === 404) return null; if (!r.ok) throw new Error('net'); return r.json(); }
function roomPut(code, slot, data) { return fetch(`${API_BASE}/api/room/${code}/${slot}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {}); }
async function roomGet(code) { try { const r = await fetch(`${API_BASE}/api/room/${code}`, { cache: 'no-store' }); if (r.ok) return r.json(); } catch (_) {} return null; }
const myTetName = () => { const u = getCurrentUser(); return (u && u.name) || '나'; };

function startTetris(el) {
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => showView('hub');
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">테트리스 🟦</div>
    <div class="omok-levels">
      <button data-m="solo">혼자 하기<small>최고 점수 도전 · 기록 저장</small></button>
      <button data-m="create">배틀 · 방 만들기<small>다른 폰과 대결 · 코드 공유</small></button>
      <button data-m="join">배틀 · 참가하기<small>받은 방 코드로 입장</small></button>
    </div>
  </div>`;
  el.querySelector('[data-m="solo"]').onclick = () => runTetris(el, { online: false });
  el.querySelector('[data-m="create"]').onclick = () => tetPickMode(el);
  el.querySelector('[data-m="join"]').onclick = () => tetJoin(el);
}
function tetPickMode(el) {
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">배틀 방식을 골라요</div>
    <div class="omok-levels">
      <button data-b="attack">⚔️ 라인 공격전<small>2줄 이상 지우면 상대에게 방해줄 · 먼저 무너지면 패</small></button>
      <button data-b="race">🏁 점수 레이스<small>같은 블록으로 2분간 · 점수 높은 사람 승</small></button>
    </div>
    <button class="btn ghost" id="tBack">◀ 뒤로</button>
  </div>`;
  el.querySelectorAll('[data-b]').forEach(b => b.onclick = () => tetHost(el, b.dataset.b));
  el.querySelector('#tBack').onclick = () => startTetris(el);
}
async function tetHost(el, mode) {
  const code = tetGenCode(), seed = (Math.random() * 4294967296) >>> 0, name = myTetName();
  el.innerHTML = `<div class="mg jg-pick tet-lobby"><div class="mg-msg">방 만드는 중…</div></div>`;
  try {
    const r = await roomPutMeta(code, { mode, seed, host: name, at: Date.now() });
    if (!r.ok) throw new Error('net');
    await roomPut(code, 'a', { name, alive: true, lines: 0, score: 0, garbage: 0, ended: false, at: Date.now() });
  } catch (_) {
    el.innerHTML = `<div class="mg jg-pick tet-lobby"><div class="mg-msg">연결 실패 😥<br><small>인터넷을 확인하고 다시 시도해 주세요</small></div><button class="btn ghost" id="tBack">◀ 뒤로</button></div>`;
    el.querySelector('#tBack').onclick = () => startTetris(el); return;
  }
  el.innerHTML = `<div class="mg jg-pick tet-lobby">
    <div class="mg-msg">방이 열렸어요</div>
    <div class="tet-code">${code}</div>
    <p class="tet-lobtip">상대에게 이 <b>코드</b>를 알려주세요<br><span class="tet-modechip">${mode === 'attack' ? '⚔️ 라인 공격전' : '🏁 점수 레이스'}</span></p>
    <div class="tet-wait">상대를 기다리는 중…</div>
    <button class="btn ghost" id="tCancel">취소</button>
  </div>`;
  let stop = false;
  el.querySelector('#tCancel').onclick = () => { stop = true; startTetris(el); };
  (async function wait() {
    while (!stop && el.querySelector('.tet-lobby')) {
      const room = await roomGet(code);
      if (room && room.b && room.b.name) { runTetris(el, { online: true, code, slot: 'a', mode, seed, myName: name, oppName: room.b.name }); return; }
      await tetSleep(700);
    }
  })();
}
function tetJoin(el) {
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">방 코드를 입력하세요</div>
    <input id="tCodeIn" class="tet-codein" maxlength="4" autocapitalize="characters" placeholder="ABCD" />
    <div id="tJoinMsg" class="tet-lobtip"></div>
    <div class="tet-joinbtns">
      <button class="btn primary" id="tJoinGo">참가</button>
      <button class="btn ghost" id="tBack">◀ 뒤로</button>
    </div>
  </div>`;
  const inp = el.querySelector('#tCodeIn');
  inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); };
  el.querySelector('#tBack').onclick = () => startTetris(el);
  el.querySelector('#tJoinGo').onclick = async () => {
    const code = inp.value.trim(), msg = el.querySelector('#tJoinMsg');
    if (code.length < 3) { msg.textContent = '코드를 정확히 입력해 주세요'; return; }
    msg.textContent = '방을 찾는 중…';
    let meta; try { meta = await roomGetMeta(code); } catch (_) { msg.textContent = '연결 실패 — 다시 시도해 주세요'; return; }
    if (!meta) { msg.textContent = '그런 방이 없어요. 코드를 확인해 주세요'; return; }
    const name = myTetName();
    await roomPut(code, 'b', { name, alive: true, lines: 0, score: 0, garbage: 0, ended: false, at: Date.now() });
    runTetris(el, { online: true, code, slot: 'b', mode: meta.mode, seed: meta.seed, myName: name, oppName: meta.host || '상대' });
  };
}

// 솔로/배틀 공용 엔진 — cfg.online 이면 상대 패널·방해줄·타이머가 붙는다
function runTetris(el, cfg) {
  const online = !!cfg.online, race = online && cfg.mode === 'race', attack = online && cfg.mode === 'attack';
  const RACE_SECONDS = 120;
  const COLS = 10, ROWS = 20, CELL = 30;
  const COLORS = { I: '#22d3ee', O: '#facc15', T: '#a78bfa', S: '#34d399', Z: '#f87171', J: '#60a5fa', L: '#fb923c' };
  const SHAPES = { I: [[1, 1, 1, 1]], O: [[1, 1], [1, 1]], T: [[0, 1, 0], [1, 1, 1]], S: [[0, 1, 1], [1, 1, 0]], Z: [[1, 1, 0], [0, 1, 1]], J: [[1, 0, 0], [1, 1, 1]], L: [[0, 0, 1], [1, 1, 1]] };
  const KEYS = Object.keys(SHAPES);
  const LINE_SCORE = [0, 100, 300, 500, 800];
  const ATTACK = [0, 0, 1, 2, 4];        // 지운 줄 수 → 상대에게 보내는 방해줄 수
  const GARB = '#64748b';                // 방해줄 색
  const rnd = online ? mulberry32(cfg.seed >>> 0) : Math.random;   // 배틀은 시드 공유(같은 순서)

  const oppPanel = online ? `<div class="tet-opp">
        <div class="tet-opp-h"><b id="tOppName">${escapeHtml(cfg.oppName || '상대')}</b><span id="tOppInfo"></span></div>
        <canvas id="tOppCv" width="${COLS * 6}" height="${ROWS * 6}"></canvas>
        <div class="tet-incoming hidden" id="tIncoming"></div>
      </div>` : '';
  const midHud = race ? '<span>남은 <b id="tTimer">2:00</b></span>' : '<span>레벨 <b id="tLevel">1</b></span>';
  const tip = online
    ? (attack ? '2줄 이상 지우면 상대에게 방해줄! 먼저 무너지면 패' : '2분 동안 더 높은 점수를 내면 승!')
    : '⟳ 모양바꾸기 · ◀▶ 이동 · ▼ 천천히 내리기 · ⤓ 빨리 내리기 · ⏸ 일시멈춤 (키보드 ↑←→↓·Space·P)';

  el.innerHTML = `<div class="mg tetris ${online ? 'tet-online' : ''}">
    <div class="tet-hud">
      <span>점수 <b id="tScore">0</b></span>
      <span>라인 <b id="tLines">0</b></span>
      ${midHud}
      <span class="tet-next">다음 <canvas id="tNext" width="40" height="22"></canvas></span>
    </div>
    <div class="tet-stagewrap">
      <div class="tet-stage">
        <canvas id="tCv" width="${COLS * CELL}" height="${ROWS * CELL}"></canvas>
        <div class="tet-msg hidden" id="tMsg"></div>
        <div class="tet-count hidden" id="tCount"></div>
      </div>
      ${oppPanel}
    </div>
    <div class="tet-ctrl">
      <button class="btn tet-up" id="tRot">⟳</button>
      <button class="btn tet-pause" id="tPause">⏸</button>
      <button class="btn tet-left" id="tLeft">◀</button>
      <button class="btn tet-right" id="tRight">▶</button>
      <button class="btn tet-drop" id="tDrop">⤓</button>
      <button class="btn tet-down" id="tDown">▼</button>
    </div>
    <div class="tet-tip">${tip}</div>
  </div>`;

  const cv = el.querySelector('#tCv'), ctx = cv.getContext('2d');
  const ncv = el.querySelector('#tNext'), nctx = ncv.getContext('2d');
  const $score = el.querySelector('#tScore'), $lines = el.querySelector('#tLines'), $level = el.querySelector('#tLevel'), $msg = el.querySelector('#tMsg');
  const $pause = el.querySelector('#tPause'), $timer = el.querySelector('#tTimer'), $count = el.querySelector('#tCount');
  const oppCv = el.querySelector('#tOppCv'), octx = oppCv ? oppCv.getContext('2d') : null;
  const $oppInfo = el.querySelector('#tOppInfo'), $incoming = el.querySelector('#tIncoming');
  const alive = () => !!el.querySelector('.tetris');

  let grid, cur, bag, nextKey, score, lines, level, over, paused, dropAcc, lastT;
  let started = !online, ended = false, toppedOut = false, battleDone = false;
  let garbageSent = 0, appliedGarbage = 0, pendingGarbage = 0, raceEnd = 0, netIv = null, pushBusy = false;

  function refillBag() { const b = KEYS.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } bag.push(...b); }
  function fromBag() { if (bag.length < 1) refillBag(); return bag.shift(); }
  function collide(shape, x, y) {
    for (let r = 0; r < shape.length; r++) for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const nx = x + c, ny = y + r;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (ny >= 0 && grid[ny][nx]) return true;
    }
    return false;
  }
  function rotateCW(m) { const R = m.length, C = m[0].length; const n = Array.from({ length: C }, () => Array(R).fill(0)); for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) n[c][R - 1 - r] = m[r][c]; return n; }
  function spawn() {
    const k = nextKey; nextKey = fromBag();
    const shape = SHAPES[k].map(r => r.slice());
    cur = { color: COLORS[k], shape, x: Math.floor((COLS - shape[0].length) / 2), y: 0 };
    drawNext();
    if (collide(cur.shape, cur.x, cur.y)) gameOver();
  }
  function merge() { for (let r = 0; r < cur.shape.length; r++) for (let c = 0; c < cur.shape[r].length; c++) { if (cur.shape[r][c]) { const ny = cur.y + r; if (ny >= 0) grid[ny][cur.x + c] = cur.color; } } }
  function clearLines() {
    let n = 0;
    for (let r = ROWS - 1; r >= 0; r--) { if (grid[r].every(c => c)) { grid.splice(r, 1); grid.unshift(Array(COLS).fill(0)); n++; r++; } }
    if (n) { lines += n; score += LINE_SCORE[n] * level; level = Math.min(10, Math.floor(lines / 10) + 1); updateHud(); }
    return n;
  }
  function addGarbage(nRows) {   // 바닥에서 방해줄을 밀어올린다. 천장을 넘기면 true(=게임오버)
    for (let k = 0; k < nRows; k++) {
      if (grid[0].some(c => c)) return true;
      grid.shift();
      const hole = Math.floor(Math.random() * COLS), row = Array(COLS).fill(GARB); row[hole] = 0;
      grid.push(row);
    }
    return false;
  }
  function lock() {
    merge(); const cleared = clearLines();
    if (attack) {
      if (cleared >= 1) garbageSent += ATTACK[cleared];
      if (pendingGarbage > 0) { const n = pendingGarbage; pendingGarbage = 0; updateIncoming(); if (addGarbage(n)) { gameOver(); return; } }
      if (cleared >= 2) pushNow();   // 공격은 곧바로 상대에게 반영
    }
    if (!over) spawn();
  }
  function move(dx) { if (over || paused || !started) return; if (!collide(cur.shape, cur.x + dx, cur.y)) { cur.x += dx; draw(); } }
  function gravity() { if (!collide(cur.shape, cur.x, cur.y + 1)) cur.y++; else lock(); }
  function softDrop() { if (over || paused || !started) return; if (!collide(cur.shape, cur.x, cur.y + 1)) { cur.y++; score += 1; updateHud(); } else lock(); draw(); }
  function hardDrop() { if (over || paused || !started) return; let d = 0; while (!collide(cur.shape, cur.x, cur.y + 1)) { cur.y++; d++; } score += d * 2; updateHud(); lock(); draw(); }
  function rotate() { if (over || paused || !started) return; const nr = rotateCW(cur.shape); for (const off of [0, -1, 1, -2, 2]) { if (!collide(nr, cur.x + off, cur.y)) { cur.shape = nr; cur.x += off; draw(); return; } } }
  function ghostY() { let y = cur.y; while (!collide(cur.shape, cur.x, y + 1)) y++; return y; }

  function cell(g, x, y, color) { g.fillStyle = color; g.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2); g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, 4); }
  function draw() {
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(148,163,184,.08)'; ctx.lineWidth = 1;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { if (grid[r][c]) cell(ctx, c, r, grid[r][c]); }
    if (cur && !over) {
      const gy = ghostY();
      for (let r = 0; r < cur.shape.length; r++) for (let c = 0; c < cur.shape[r].length; c++) {
        if (!cur.shape[r][c]) continue;
        if (gy !== cur.y) { ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect((cur.x + c) * CELL + 1, (gy + r) * CELL + 1, CELL - 2, CELL - 2); }
        if (cur.y + r >= 0) cell(ctx, cur.x + c, cur.y + r, cur.color);
      }
    }
  }
  function drawNext() {
    nctx.clearRect(0, 0, ncv.width, ncv.height);
    // 캔버스가 HUD 한 줄 높이(납작)라 칸 크기를 폭·높이 양쪽에 맞춰 잡는다
    const s = SHAPES[nextKey];
    const u = Math.min(9, Math.floor(ncv.width / s[0].length), Math.floor(ncv.height / s.length));
    const ox = (ncv.width - s[0].length * u) / 2, oy = (ncv.height - s.length * u) / 2;
    nctx.fillStyle = COLORS[nextKey];
    for (let r = 0; r < s.length; r++) for (let c = 0; c < s[r].length; c++) if (s[r][c]) nctx.fillRect(ox + c * u + 1, oy + r * u + 1, u - 2, u - 2);
  }
  function updateHud() { $score.textContent = score.toLocaleString('ko-KR'); $lines.textContent = lines; if ($level) $level.textContent = level; }
  function dropInterval() { return Math.max(120, 800 - (level - 1) * 70); }
  // ── 온라인: 내 보드 인코딩 / 상대 그리기 / 상태 교환 ──
  function boardStr() {
    const g = grid.map(r => r.slice());
    if (cur && !over) for (let r = 0; r < cur.shape.length; r++) for (let c = 0; c < cur.shape[r].length; c++) {
      if (cur.shape[r][c]) { const y = cur.y + r, x = cur.x + c; if (y >= 0 && y < ROWS && x >= 0 && x < COLS) g[y][x] = cur.color; }
    }
    let s = ''; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) s += g[r][c] ? '1' : '0';
    return s;
  }
  function updateIncoming() { if (!$incoming) return; if (pendingGarbage > 0) { $incoming.textContent = `⚠ 방해줄 +${pendingGarbage}`; $incoming.classList.remove('hidden'); } else $incoming.classList.add('hidden'); }
  function renderOpp(o) {
    if (!octx) return;
    octx.fillStyle = '#0b1220'; octx.fillRect(0, 0, oppCv.width, oppCv.height);
    const b = o.board || '', u = 6, ko = o.alive === false;
    for (let i = 0; i < b.length && i < ROWS * COLS; i++) { if (b[i] === '1') { octx.fillStyle = ko ? '#475569' : '#38bdf8'; octx.fillRect((i % COLS) * u, ((i / COLS) | 0) * u, u - 1, u - 1); } }
    if ($oppInfo) $oppInfo.textContent = ko ? ' KO' : (race ? ` ${(o.score || 0).toLocaleString('ko-KR')}점` : ` ${o.lines || 0}줄`);
  }
  function myPayload() { return { name: cfg.myName, alive: !toppedOut, lines, score, level, board: boardStr(), garbage: garbageSent, ended, at: Date.now() }; }
  function pushNow() { if (online) roomPut(cfg.code, cfg.slot, myPayload()); }
  async function netTick() {
    if (!online || battleDone || !alive()) return;
    if (!pushBusy) { pushBusy = true; try { await roomPut(cfg.code, cfg.slot, myPayload()); } finally { pushBusy = false; } }
    const room = await roomGet(cfg.code); if (!room) return;
    const o = cfg.slot === 'a' ? room.b : room.a; if (!o) return;
    renderOpp(o);
    const stale = Date.now() - (o.at || 0) > 12000;
    if (attack) {
      if (typeof o.garbage === 'number' && o.garbage > appliedGarbage) { pendingGarbage += (o.garbage - appliedGarbage); appliedGarbage = o.garbage; updateIncoming(); }
      if (!over) { if (o.ended && o.alive === false) return finishAttack('win', '상대가 먼저 무너졌어요! 🎉'); if (stale) return finishAttack('win', '상대 연결이 끊겼어요'); }
    } else if (race) {
      if (over && (o.ended || stale)) return settleRace(o);
    }
  }
  function stopNet() { if (netIv) { clearInterval(netIv); netIv = null; } }
  function showResult(title, sub) {
    $msg.innerHTML = `${title}<br><span class="tet-sub">${sub}</span><br><button class="btn" id="tAgain">처음으로</button>`;
    $msg.classList.remove('hidden');
    const a = el.querySelector('#tAgain'); if (a) a.onclick = () => startTetris(el);
  }
  function finishAttack(result, why) {
    if (battleDone) return; battleDone = true; over = true; ended = true; stopNet(); pushNow();
    recordStat('tetris', { best: score, result: result === 'win' ? 'win' : undefined });
    showResult(result === 'win' ? '🎉 승리!' : '패배', `${why}<br><small>내 ${lines}줄 · ${score.toLocaleString('ko-KR')}점</small>`);
  }
  function finishRace() {
    if (ended) return; ended = true; over = true; pushNow();
    $msg.innerHTML = `시간 종료 ⏱<br><b>${score.toLocaleString('ko-KR')}점 · ${lines}줄</b><br><span class="tet-waitres">상대 결과 기다리는 중…</span>`;
    $msg.classList.remove('hidden');
  }
  function settleRace(o) {
    if (battleDone) return; battleDone = true; stopNet();
    const mine = score, theirs = o.score || 0, draw = mine === theirs, win = mine > theirs;
    recordStat('tetris', { best: score, result: win ? 'win' : undefined });
    showResult(draw ? '무승부' : (win ? '🎉 승리!' : '패배'), `나 ${mine.toLocaleString('ko-KR')}점 · 상대 ${theirs.toLocaleString('ko-KR')}점`);
  }
  function gameOver() {
    over = true; toppedOut = true; paused = false; syncPauseBtn();
    if (race) return finishRace();
    if (attack) { pushNow(); return finishAttack('lose', '꼭대기까지 쌓였어요 😥'); }
    ended = true; recordStat('tetris', { best: score, result: score > 0 ? 'win' : undefined });
    $msg.innerHTML = `게임 오버<br><b>${score.toLocaleString('ko-KR')}점</b><br><button class="btn" id="tAgain">다시하기</button>`;
    $msg.classList.remove('hidden');
    const a = el.querySelector('#tAgain'); if (a) a.onclick = reset;
  }
  function syncPauseBtn() { $pause.textContent = paused ? '▶' : '⏸'; $pause.setAttribute('aria-label', paused ? '계속하기' : '일시멈춤'); }
  function setPaused(p) {
    if (over || paused === p || online) return;   // 배틀은 일시정지 없음(상대는 계속 진행)
    paused = p; syncPauseBtn();
    if (paused) {
      $msg.innerHTML = `일시정지<br><button class="btn" id="tResume">계속하기</button>`;
      $msg.classList.remove('hidden');
      const r = el.querySelector('#tResume'); if (r) r.onclick = () => setPaused(false);
    } else {
      $msg.classList.add('hidden'); dropAcc = 0; lastT = 0;
    }
  }
  function reset() {
    grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    bag = []; nextKey = fromBag(); score = 0; lines = 0; level = 1; over = false; paused = false; dropAcc = 0; lastT = 0;
    ended = false; toppedOut = false;
    $msg.classList.add('hidden'); syncPauseBtn(); updateHud(); spawn(); draw();
  }

  function fmtClock(ms) { const s = Math.ceil(ms / 1000); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; }
  function cleanup() { window.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onHide); stopNet(); }
  function loop(t) {
    if (!alive()) { cleanup(); return; }
    if (race && started && !ended) { const rem = Math.max(0, raceEnd - performance.now()); if ($timer) $timer.textContent = fmtClock(rem); if (rem <= 0) finishRace(); }
    if (!over && !paused && started) {
      if (!lastT) lastT = t;
      dropAcc += Math.min(t - lastT, 100); lastT = t;
      const iv = dropInterval();
      while (dropAcc >= iv && !over) { dropAcc -= iv; gravity(); }
      draw();
    } else lastT = t;
    requestAnimationFrame(loop);
  }

  // 입력
  const holdBtn = (id, fn) => { const b = el.querySelector(id); let iv = null; const stop = () => { if (iv) { clearInterval(iv); iv = null; } }; b.addEventListener('pointerdown', e => { e.preventDefault(); fn(); iv = setInterval(fn, 130); }); b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop); };
  const tapBtn = (id, fn) => el.querySelector(id).addEventListener('pointerdown', e => { e.preventDefault(); fn(); });
  holdBtn('#tLeft', () => move(-1)); holdBtn('#tRight', () => move(1)); holdBtn('#tDown', softDrop);
  tapBtn('#tRot', rotate); tapBtn('#tDrop', hardDrop); tapBtn('#tPause', () => setPaused(!paused));
  function onKey(e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); softDrop(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (!e.repeat) rotate(); }
    else if (e.key === ' ') { e.preventDefault(); if (!e.repeat) hardDrop(); }
    else if (e.code === 'KeyP' || e.key === 'Escape') { e.preventDefault(); if (!e.repeat) setPaused(!paused); }
  }
  // 다른 탭·앱으로 전환하면 자동으로 일시정지
  function onHide() { if (document.hidden && !online) setPaused(true); }
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onHide);

  // 배틀은 3·2·1 카운트다운 뒤 동시에 시작(초기 지연을 가림), 그때부터 상태 교환
  function startBattle() {
    if ($pause) $pause.classList.add('hidden');
    let n = 3; $count.classList.remove('hidden'); $count.textContent = n;
    const iv = setInterval(() => {
      if (!alive()) { clearInterval(iv); return; }
      n--;
      if (n > 0) $count.textContent = n;
      else if (n === 0) $count.textContent = '시작!';
      else { clearInterval(iv); $count.classList.add('hidden'); started = true; lastT = 0; raceEnd = performance.now() + RACE_SECONDS * 1000; netIv = setInterval(netTick, 500); netTick(); }
    }, 800);
  }

  reset();
  if (online) startBattle();
  requestAnimationFrame(loop);
}

// ── 미니게임: 10초 맞추기 ─────────────────────────────
// 시작 후 시간이 흐르는 동안(숨김) 기다렸다가 멈추기 → 10초에 가까울수록 좋은 기록
function startTimer10(el) {
  let startT = 0, phase = 'idle', raf = 0;
  el.innerHTML = `<div class="mg timer10">
    <div class="mg-msg" id="t10Msg">시작을 누르고 10초에 멈춰보세요!</div>
    <div class="t10-display" id="t10Disp">0.00초</div>
    <button class="btn primary" id="t10Btn">시작</button>
    <div class="mg-score">내 최고 ±<b id="t10Best">-</b>초</div>
  </div>`;
  const disp = el.querySelector('#t10Disp'), btn = el.querySelector('#t10Btn'), msg = el.querySelector('#t10Msg');
  const showBest = () => { const s = getStat('timer10'); el.querySelector('#t10Best').textContent = s && s.best != null ? (s.best / 1000).toFixed(2) : '-'; };
  const tick = () => {
    if (phase !== 'running') return;
    if (!el.querySelector('.timer10')) { phase = 'done'; return; }   // 화면 이탈 시 중단
    disp.textContent = ((performance.now() - startT) / 1000).toFixed(2) + '초';
    raf = requestAnimationFrame(tick);
  };
  btn.onclick = () => {
    if (phase === 'idle' || phase === 'done') {
      phase = 'running'; startT = performance.now();
      disp.classList.remove('reveal'); disp.textContent = '0.00초';
      msg.textContent = '10초에 멈춰요!'; btn.textContent = '멈추기!';
      raf = requestAnimationFrame(tick);
    } else {   // running → stop
      cancelAnimationFrame(raf); phase = 'done';
      const elapsed = performance.now() - startT, diff = Math.abs(elapsed - 10000);
      disp.classList.add('reveal'); disp.textContent = (elapsed / 1000).toFixed(2) + '초';
      msg.textContent = `10초에서 ${(diff / 1000).toFixed(2)}초 ${elapsed > 10000 ? '초과' : '부족'} ${diff < 300 ? '🎉' : diff < 1000 ? '👍' : '😅'}`;
      recordStat('timer10', { best: Math.round(diff) });
      showBest(); btn.textContent = '다시';
    }
  };
  showBest();
}

// ── 미니게임: 장기 (vs 컴퓨터 / 2인) ──────────────────
// 판 10행×9열(교차점). side 'T'=초(위·초록), 'B'=한(아래·빨강). B 선수.
// 단순화: 차·포의 궁성 대각선 이동, 빅장(장 대면) 룰은 미구현.
const JG_VALUE = { cha: 13, po: 7, ma: 5, sang: 3, sa: 3, jol: 2, jang: 1000 };
const JG_ORTH = [[-1,0],[1,0],[0,-1],[0,1]];
function jgInit() {
  const b = Array.from({ length: 10 }, () => Array(9).fill(null));
  const back = ['cha','ma','sang','sa',null,'sa','sang','ma','cha'];
  for (let c = 0; c < 9; c++) if (back[c]) { b[0][c] = { side:'T', type:back[c] }; b[9][c] = { side:'B', type:back[c] }; }
  b[1][4] = { side:'T', type:'jang' }; b[8][4] = { side:'B', type:'jang' };
  b[2][1] = { side:'T', type:'po' }; b[2][7] = { side:'T', type:'po' };
  b[7][1] = { side:'B', type:'po' }; b[7][7] = { side:'B', type:'po' };
  for (const c of [0,2,4,6,8]) { b[3][c] = { side:'T', type:'jol' }; b[6][c] = { side:'B', type:'jol' }; }
  return b;
}
function jgGlyph(p) {
  // 전통 한자 — 진영별로 포(砲/包)·졸(卒/兵)·장(楚/漢) 글자가 다름
  const T = { jang:'楚', cha:'車', po:'砲', ma:'馬', sang:'象', sa:'士', jol:'卒' };
  const B = { jang:'漢', cha:'車', po:'包', ma:'馬', sang:'象', sa:'士', jol:'兵' };
  return (p.side === 'T' ? T : B)[p.type];
}
// 장기판 선(SVG) — 9열×10행 격자 + 궁성 대각선. viewBox 0..8 / 0..9 (점=정수좌표)
const JG_LINES = (() => {
  let s = '';
  for (let c = 0; c < 9; c++) s += `<line x1="${c}" y1="0" x2="${c}" y2="9"/>`;
  for (let r = 0; r < 10; r++) s += `<line x1="0" y1="${r}" x2="8" y2="${r}"/>`;
  s += '<line x1="3" y1="0" x2="5" y2="2"/><line x1="5" y1="0" x2="3" y2="2"/>';   // 위 궁성 X
  s += '<line x1="3" y1="7" x2="5" y2="9"/><line x1="5" y1="7" x2="3" y2="9"/>';   // 아래 궁성 X
  return `<svg class="jg-lines" viewBox="0 0 8 9" preserveAspectRatio="none">${s}</svg>`;
})();
const jgIn = (r,c) => r>=0 && r<10 && c>=0 && c<9;
const jgInPalace = (side,r,c) => c>=3 && c<=5 && (side==='T' ? r<=2 : r>=7);
function jgPalaceDiag(r,c) {
  if (r===1 && c===4) return [[0,3],[0,5],[2,3],[2,5]];
  if (r===8 && c===4) return [[7,3],[7,5],[9,3],[9,5]];
  if (c===3 || c===5) { if (r===0||r===2) return [[1,4]]; if (r===7||r===9) return [[8,4]]; }
  return [];
}
// 한 칸의 의사 이동(자기왕 장군 여부는 미고려)
function jgPseudo(board, r, c) {
  const p = board[r][c]; if (!p) return [];
  const side = p.side, res = [];
  const own = (tr,tc) => board[tr][tc] && board[tr][tc].side === side;
  const add = (tr,tc) => { if (jgIn(tr,tc) && !own(tr,tc)) res.push([tr,tc]); };
  if (p.type === 'jang' || p.type === 'sa') {
    for (const [dr,dc] of JG_ORTH) { const tr=r+dr, tc=c+dc; if (jgInPalace(side,tr,tc)) add(tr,tc); }
    for (const [tr,tc] of jgPalaceDiag(r,c)) if (jgInPalace(side,tr,tc)) add(tr,tc);
  } else if (p.type === 'jol') {
    const fwd = side === 'B' ? -1 : 1;
    add(r+fwd, c); add(r, c-1); add(r, c+1);
    const enemy = side === 'B' ? 'T' : 'B';
    if (jgInPalace(enemy, r, c)) for (const [tr,tc] of jgPalaceDiag(r,c))
      if (jgInPalace(enemy,tr,tc) && (side==='B' ? tr<r : tr>r)) add(tr,tc);
  } else if (p.type === 'ma') {
    for (const [mr,mc,lr,lc] of [[-2,-1,-1,0],[-2,1,-1,0],[2,-1,1,0],[2,1,1,0],[-1,-2,0,-1],[1,-2,0,-1],[-1,2,0,1],[1,2,0,1]]) {
      const l = [r+lr,c+lc]; if (jgIn(l[0],l[1]) && !board[l[0]][l[1]]) add(r+mr, c+mc);
    }
  } else if (p.type === 'sang') {
    for (const [tr,tc,a,b,d,e] of [[-3,-2,-1,0,-2,-1],[-3,2,-1,0,-2,1],[3,-2,1,0,2,-1],[3,2,1,0,2,1],[-2,-3,0,-1,-1,-2],[2,-3,0,-1,1,-2],[-2,3,0,1,-1,2],[2,3,0,1,1,2]]) {
      const l1=[r+a,c+b], l2=[r+d,c+e];
      if (jgIn(l1[0],l1[1]) && !board[l1[0]][l1[1]] && jgIn(l2[0],l2[1]) && !board[l2[0]][l2[1]]) add(r+tr, c+tc);
    }
  } else if (p.type === 'cha') {
    for (const [dr,dc] of JG_ORTH) { let tr=r+dr, tc=c+dc;
      while (jgIn(tr,tc)) { const q=board[tr][tc]; if (!q) res.push([tr,tc]); else { if (q.side!==side) res.push([tr,tc]); break; } tr+=dr; tc+=dc; } }
  } else if (p.type === 'po') {
    for (const [dr,dc] of JG_ORTH) { let tr=r+dr, tc=c+dc, screen=false;
      while (jgIn(tr,tc)) { const q=board[tr][tc];
        if (!screen) { if (q) { if (q.type==='po') break; screen=true; } }
        else { if (!q) res.push([tr,tc]); else { if (q.type!=='po' && q.side!==side) res.push([tr,tc]); break; } }
        tr+=dr; tc+=dc; } }
  }
  return res;
}
function jgGenPos(board, side) {
  for (let r=0;r<10;r++) for (let c=0;c<9;c++) { const p=board[r][c]; if (p && p.side===side && p.type==='jang') return [r,c]; }
  return null;
}
function jgInCheck(board, side) {
  const g = jgGenPos(board, side); if (!g) return true;
  const enemy = side==='B'?'T':'B';
  for (let r=0;r<10;r++) for (let c=0;c<9;c++) { const p=board[r][c];
    if (p && p.side===enemy) for (const [tr,tc] of jgPseudo(board,r,c)) if (tr===g[0] && tc===g[1]) return true; }
  return false;
}
function jgApply(board, fr,fc,tr,tc) { const cap=board[tr][tc]; board[tr][tc]=board[fr][fc]; board[fr][fc]=null; return cap; }
function jgUndo(board, fr,fc,tr,tc,cap) { board[fr][fc]=board[tr][tc]; board[tr][tc]=cap; }
function jgLegalFrom(board, r, c) {
  const p = board[r][c]; if (!p) return [];
  const out = [];
  for (const [tr,tc] of jgPseudo(board,r,c)) { const cap=jgApply(board,r,c,tr,tc); if (!jgInCheck(board,p.side)) out.push([tr,tc]); jgUndo(board,r,c,tr,tc,cap); }
  return out;
}
function jgAllLegal(board, side) {
  const out = [];
  for (let r=0;r<10;r++) for (let c=0;c<9;c++) { const p=board[r][c];
    if (p && p.side===side) for (const [tr,tc] of jgLegalFrom(board,r,c)) out.push({ fr:r, fc:c, tr, tc, cap:board[tr][tc] }); }
  return out;
}
// 간단 AI (T측): 잡기 가치 + 장군 - 상대 최선 반격
function jgEval(b) {   // T(컴퓨터) 관점 기물 가치 합
  let s = 0;
  for (let r=0;r<10;r++) for (let c=0;c<9;c++) { const p=b[r][c]; if (p) s += (p.side==='T' ? 1 : -1) * JG_VALUE[p.type]; }
  return s;
}
function jgNegamax(b, side, depth, alpha, beta) {
  if (depth === 0) return (side==='T' ? 1 : -1) * jgEval(b);
  const moves = jgAllLegal(b, side); if (!moves.length) return -100000;   // 둘 수 없음 = 자기 패배
  moves.sort((x,y) => (y.cap?JG_VALUE[y.cap.type]:0) - (x.cap?JG_VALUE[x.cap.type]:0));   // 잡기 우선(가지치기 효율)
  let best = -Infinity;
  for (const m of moves) {
    const cap = jgApply(b, m.fr, m.fc, m.tr, m.tc);
    const val = -jgNegamax(b, side==='T'?'B':'T', depth-1, -beta, -alpha);
    jgUndo(b, m.fr, m.fc, m.tr, m.tc, cap);
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}
// 레벨별 AI (T측). ai: 'easy'|'mid'|'adv'|'pro'
function jgBestMove(board, ai) {
  const moves = jgAllLegal(board, 'T'); if (!moves.length) return null;
  if (ai === 'easy') {   // 초급: 절반 이상 랜덤 + 약한 잡기 선호
    if (Math.random() < 0.55) return moves[Math.random() * moves.length | 0];
    let best = null, bv = -Infinity;
    for (const m of moves) { const v = (m.cap ? JG_VALUE[m.cap.type] : 0) + Math.random()*0.5; if (v > bv) { bv = v; best = m; } }
    return best;
  }
  const depth = ai === 'pro' ? 4 : ai === 'adv' ? 3 : 2;   // 중급2·고급3·프로4 수 탐색
  moves.sort((x,y) => (y.cap?JG_VALUE[y.cap.type]:0) - (x.cap?JG_VALUE[x.cap.type]:0));
  let best = null, bv = -Infinity;
  for (const m of moves) {
    const cap = jgApply(board, m.fr, m.fc, m.tr, m.tc);
    const val = -jgNegamax(board, 'B', depth-1, -Infinity, Infinity) + Math.random()*0.01;
    jgUndo(board, m.fr, m.fc, m.tr, m.tc, cap);
    if (val > bv) { bv = val; best = m; }
  }
  return best;
}

function startJanggi(el) {
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">상대를 골라요 ♟️</div>
    <div class="omok-levels">
      ${JANGGI_LEVELS.map(l => `<button data-k="${l.key}">vs 컴퓨터 · ${l.label}<small>${l.desc}</small></button>`).join('')}
      <button data-k="two">2인 대국<small>번갈아 두기</small></button>
    </div>
  </div>`;
  el.querySelectorAll('.omok-levels button').forEach(b => b.onclick = () => {
    if (b.dataset.k === 'two') runJanggi(el, 'two', null);
    else runJanggi(el, 'cpu', JANGGI_LEVELS.find(l => l.key === b.dataset.k));
  });
}
function runJanggi(el, mode, level) {
  let board = jgInit(), turn = 'B', over = false, selR = null, selC = null, targets = [], resultMsg = '';
  const history = [];            // {fr,fc,tr,tc,cap,side} — 무르기용
  let recorded = false, busy = false;   // 결과 1회만 기록 / CPU 생각 중 입력 차단

  const updateMsg = () => {
    const m = el.querySelector('#jgMsg'); if (!m) return;
    if (over) { m.textContent = resultMsg; return; }
    const chk = jgInCheck(board, turn);
    if (mode === 'cpu') m.textContent = turn === 'B' ? (chk ? `⚠️ 장군! 내 차례 · ${level.label}` : `내 차례 (한·빨강) · ${level.label}`) : '컴퓨터 생각 중…';
    else m.textContent = (chk ? '⚠️ 장군! ' : '') + (turn === 'B' ? '한(아래·빨강)' : '초(위·초록)') + ' 차례';
  };
  const render = () => {
    el.innerHTML = `<div class="mg janggi">
      <div class="mg-msg" id="jgMsg"></div>
      <div class="jg-board"><div class="jg-inner" id="jgBoard"></div></div>
      <div class="omok-btns">
        <button class="btn ghost small" id="jgUndo">한 수 무르기</button>
        <button class="btn ghost small" id="jgNew">새 게임</button>
        <button class="btn ghost small" id="jgMode">상대 변경</button>
      </div>
    </div>`;
    let html = '';
    for (let r=0;r<10;r++) for (let c=0;c<9;c++) {
      const p = board[r][c];
      const sel = (r===selR && c===selC) ? ' sel' : '';
      const tgt = targets.some(t => t[0]===r && t[1]===c) ? ' tgt' : '';
      const piece = p ? `<span class="jg-piece ${p.side==='B'?'b':'t'}${p.type==='jang'?' gen':''}">${jgGlyph(p)}</span>` : '';
      // 교차점에 배치: 가로 8칸·세로 9칸 기준 % 좌표
      const left = (c / 8 * 100).toFixed(3), top = (r / 9 * 100).toFixed(3);
      html += `<button class="jg-pt${sel}${tgt}" style="left:${left}%;top:${top}%" data-r="${r}" data-c="${c}">${piece}</button>`;
    }
    const bd = el.querySelector('#jgBoard'); bd.innerHTML = JG_LINES + html;
    bd.querySelectorAll('.jg-pt').forEach(b => b.onclick = () => onTap(+b.dataset.r, +b.dataset.c));
    const ub = el.querySelector('#jgUndo'); ub.onclick = undo; ub.disabled = busy || history.length === 0;
    el.querySelector('#jgNew').onclick = () => runJanggi(el, mode, level);
    el.querySelector('#jgMode').onclick = () => startJanggi(el);
    updateMsg();
  };
  const afterMove = () => {
    turn = turn === 'B' ? 'T' : 'B';
    if (jgAllLegal(board, turn).length === 0) {     // 둘 수 없음 → 그 측 패배(외통)
      over = true; const winner = turn === 'B' ? 'T' : 'B';
      if (mode === 'cpu') {
        resultMsg = `[${level.label}] ` + (winner === 'B' ? '이겼어요! 🎉 (외통)' : '졌어요 😢 (외통)');
        if (!recorded) { recorded = true; recordStat(level.key, { result: winner === 'B' ? 'win' : 'loss' }); }   // 급수별 1회만
      } else resultMsg = (winner === 'B' ? '한(빨강)' : '초(초록)') + ' 승리! 🎉 (외통)';
      render(); return;
    }
    render();
    if (mode === 'cpu' && turn === 'T') { busy = true; setTimeout(() => {
      if (!el.querySelector('.janggi')) return;     // 화면 이탈
      const m = jgBestMove(board, level.ai);
      if (m) { const cap = jgApply(board, m.fr, m.fc, m.tr, m.tc); history.push({ fr:m.fr, fc:m.fc, tr:m.tr, tc:m.tc, cap, side:'T' }); }
      busy = false; afterMove();
    }, 350); }
  };
  // 한 수 무르기 — 2인: 직전 1수 / vs컴퓨터: 컴퓨터 응수 + 내 수를 함께 되돌려 내 차례로
  const undo = () => {
    if (busy || !history.length) return;
    if (mode === 'cpu') {
      const m1 = history.pop(); jgUndo(board, m1.fr, m1.fc, m1.tr, m1.tc, m1.cap);
      if (m1.side === 'T' && history.length) { const m2 = history.pop(); jgUndo(board, m2.fr, m2.fc, m2.tr, m2.tc, m2.cap); }
      turn = 'B';
    } else {
      const m1 = history.pop(); jgUndo(board, m1.fr, m1.fc, m1.tr, m1.tc, m1.cap); turn = m1.side;
    }
    over = false; selR = selC = null; targets = []; render();
  };
  const onTap = (r, c) => {
    if (over || busy) return;
    if (mode === 'cpu' && turn === 'T') return;
    const p = board[r][c];
    if (selR !== null && targets.some(t => t[0]===r && t[1]===c)) {
      const cap = jgApply(board, selR, selC, r, c);
      history.push({ fr:selR, fc:selC, tr:r, tc:c, cap, side: turn });
      selR = selC = null; targets = []; afterMove(); return;
    }
    if (p && p.side === turn) { selR = r; selC = c; targets = jgLegalFrom(board, r, c); render(); }
    else { selR = selC = null; targets = []; render(); }
  };
  render();
}

// ══ 체스 ══════════════════════════════════════════════
// 좌표 r=0(위·흑)~7(아래·백). 사람=백(W, 아래), 컴퓨터=흑(B, 위).
const CH_GLYPH = { K:'♚', Q:'♛', R:'♜', B:'♝', N:'♞', P:'♟' };   // 흰/검은 색은 CSS로 구분
const CH_VAL = { P:100, N:320, B:330, R:500, Q:900, K:20000 };
const chIn = (r,c) => r>=0 && r<8 && c>=0 && c<8;
const chOpp = s => s==='W' ? 'B' : 'W';
function chInit() {
  const back = ['R','N','B','Q','K','B','N','R'];
  const b = Array.from({length:8}, () => Array(8).fill(null));
  for (let c=0;c<8;c++){ b[0][c]={side:'B',type:back[c]}; b[1][c]={side:'B',type:'P'}; b[6][c]={side:'W',type:'P'}; b[7][c]={side:'W',type:back[c]}; }
  return { board:b, turn:'W', castle:{WK:true,WQ:true,BK:true,BQ:true}, ep:null };
}
// by 측이 (r,c)를 공격하는가 (캐슬링 판정에도 사용)
function chAttacked(board, r, c, by) {
  const pd = by==='W' ? 1 : -1;   // by 폰이 있는 칸은 목표의 (앞) — 백 폰은 아래(row 큰)에서 위 공격
  for (const dc of [-1,1]){ const rr=r+pd, cc=c+dc; if(chIn(rr,cc)){ const p=board[rr][cc]; if(p&&p.side===by&&p.type==='P') return true; } }
  for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){ const rr=r+dr,cc=c+dc; if(chIn(rr,cc)){const p=board[rr][cc]; if(p&&p.side===by&&p.type==='N')return true;} }
  for (const [dr,dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]){ let rr=r+dr,cc=c+dc; while(chIn(rr,cc)){const p=board[rr][cc]; if(p){ if(p.side===by&&(p.type==='B'||p.type==='Q'))return true; break;} rr+=dr;cc+=dc;} }
  for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]){ let rr=r+dr,cc=c+dc; while(chIn(rr,cc)){const p=board[rr][cc]; if(p){ if(p.side===by&&(p.type==='R'||p.type==='Q'))return true; break;} rr+=dr;cc+=dc;} }
  for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]){ const rr=r+dr,cc=c+dc; if(chIn(rr,cc)){const p=board[rr][cc]; if(p&&p.side===by&&p.type==='K')return true;} }
  return false;
}
function chKing(board, side){ for(let r=0;r<8;r++)for(let c=0;c<8;c++){const p=board[r][c]; if(p&&p.side===side&&p.type==='K')return [r,c];} return null; }
function chInCheck(s, side){ const k=chKing(s.board, side); return k ? chAttacked(s.board,k[0],k[1],chOpp(side)) : false; }
// 유사합법 수 (킹 안전 미검증)
function chPseudo(s, side) {
  const b=s.board, mv=[]; const add=(fr,fc,tr,tc,ex)=>mv.push(Object.assign({fr,fc,tr,tc},ex||{}));
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){ const p=b[r][c]; if(!p||p.side!==side)continue;
    if(p.type==='P'){ const dir=side==='W'?-1:1, start=side==='W'?6:1, last=side==='W'?0:7;
      if(chIn(r+dir,c)&&!b[r+dir][c]){ if(r+dir===last)for(const pr of ['Q','R','B','N'])add(r,c,r+dir,c,{promo:pr}); else add(r,c,r+dir,c);
        if(r===start&&!b[r+2*dir][c])add(r,c,r+2*dir,c,{dbl:true}); }
      for(const dc of [-1,1]){ const rr=r+dir,cc=c+dc; if(!chIn(rr,cc))continue; const t=b[rr][cc];
        if(t&&t.side!==side){ if(rr===last)for(const pr of ['Q','R','B','N'])add(r,c,rr,cc,{promo:pr}); else add(r,c,rr,cc); }
        else if(s.ep&&s.ep[0]===rr&&s.ep[1]===cc)add(r,c,rr,cc,{ep:true}); }
    } else if(p.type==='N'){ for(const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]){const rr=r+dr,cc=c+dc; if(chIn(rr,cc)){const t=b[rr][cc]; if(!t||t.side!==side)add(r,c,rr,cc);}}
    } else if(p.type==='K'){ for(const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]){const rr=r+dr,cc=c+dc; if(chIn(rr,cc)){const t=b[rr][cc]; if(!t||t.side!==side)add(r,c,rr,cc);}}
      const rank=side==='W'?7:0, opp=chOpp(side);
      if(s.castle[side+'K']&&!b[rank][5]&&!b[rank][6]&&b[rank][7]&&b[rank][7].type==='R'&&b[rank][7].side===side&&!chAttacked(b,rank,4,opp)&&!chAttacked(b,rank,5,opp)&&!chAttacked(b,rank,6,opp))add(rank,4,rank,6,{castle:'K'});
      if(s.castle[side+'Q']&&!b[rank][1]&&!b[rank][2]&&!b[rank][3]&&b[rank][0]&&b[rank][0].type==='R'&&b[rank][0].side===side&&!chAttacked(b,rank,4,opp)&&!chAttacked(b,rank,3,opp)&&!chAttacked(b,rank,2,opp))add(rank,4,rank,2,{castle:'Q'});
    } else { const dirs=p.type==='B'?[[-1,-1],[-1,1],[1,-1],[1,1]]:p.type==='R'?[[-1,0],[1,0],[0,-1],[0,1]]:[[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for(const [dr,dc] of dirs){let rr=r+dr,cc=c+dc; while(chIn(rr,cc)){const t=b[rr][cc]; if(!t)add(r,c,rr,cc); else {if(t.side!==side)add(r,c,rr,cc); break;} rr+=dr;cc+=dc;}}
    }
  }
  return mv;
}
function chApply(s, m) {
  const b=s.board, p=b[m.fr][m.fc], side=p.side;
  const u={ m, cap:b[m.tr][m.tc], epPawn:null, castle:{...s.castle}, ep:s.ep };
  b[m.tr][m.tc]= m.promo ? {side,type:m.promo} : p; b[m.fr][m.fc]=null;
  if(m.ep){ u.epPawn={r:m.fr,c:m.tc,piece:b[m.fr][m.tc]}; b[m.fr][m.tc]=null; }
  if(m.castle){ const rk=m.fr; if(m.castle==='K'){b[rk][5]=b[rk][7]; b[rk][7]=null;} else {b[rk][3]=b[rk][0]; b[rk][0]=null;} }
  if(p.type==='K'){ s.castle[side+'K']=false; s.castle[side+'Q']=false; }
  if(p.type==='R'){ const rk=side==='W'?7:0; if(m.fr===rk&&m.fc===0)s.castle[side+'Q']=false; if(m.fr===rk&&m.fc===7)s.castle[side+'K']=false; }
  const ork=side==='W'?0:7, o=chOpp(side); if(m.tr===ork){ if(m.tc===0)s.castle[o+'Q']=false; if(m.tc===7)s.castle[o+'K']=false; }
  s.ep = m.dbl ? [(m.fr+m.tr)/2, m.fc] : null; s.turn=chOpp(side);
  return u;
}
function chUndoMove(s, u) {
  const m=u.m, b=s.board; s.turn=chOpp(s.turn); s.castle=u.castle; s.ep=u.ep;
  const moved=b[m.tr][m.tc]; b[m.fr][m.fc]= m.promo ? {side:moved.side,type:'P'} : moved; b[m.tr][m.tc]=u.cap;
  if(m.ep) b[u.epPawn.r][u.epPawn.c]=u.epPawn.piece;
  if(m.castle){ const rk=m.fr; if(m.castle==='K'){b[rk][7]=b[rk][5]; b[rk][5]=null;} else {b[rk][0]=b[rk][3]; b[rk][3]=null;} }
}
function chLegal(s, side){ const out=[]; for(const m of chPseudo(s,side)){ const u=chApply(s,m); if(!chInCheck(s,side))out.push(m); chUndoMove(s,u); } return out; }
function chLegalFrom(s, r, c){ const p=s.board[r][c]; if(!p)return []; return chLegal(s,p.side).filter(m=>m.fr===r&&m.fc===c); }
function chEval(s){ let sc=0; for(let r=0;r<8;r++)for(let c=0;c<8;c++){ const p=s.board[r][c]; if(!p)continue; let v=CH_VAL[p.type];
  if(p.type==='P'||p.type==='N'){ v += (3.5-Math.abs(3.5-c)) + (3.5-Math.abs(3.5-r)); } sc += p.side==='W'?v:-v; } return sc; }
function chSearch(s, side, depth, alpha, beta, bud){ bud.n++;
  if(depth===0 || bud.n>bud.max){ const e=chEval(s); return side==='W'?e:-e; }
  const moves=chLegal(s, side);
  if(!moves.length) return chInCheck(s,side) ? -100000-depth : 0;
  moves.sort((a,b)=>{const ca=s.board[a.tr][a.tc]?CH_VAL[s.board[a.tr][a.tc].type]:0; const cb=s.board[b.tr][b.tc]?CH_VAL[s.board[b.tr][b.tc].type]:0; return cb-ca;});
  let best=-1e9;
  for(const m of moves){ const u=chApply(s,m); const sc=-chSearch(s,chOpp(side),depth-1,-beta,-alpha,bud); chUndoMove(s,u); if(sc>best)best=sc; if(best>alpha)alpha=best; if(alpha>=beta)break; }
  return best;
}
function chBestMove(s, side, depth){ const moves=chLegal(s, side); if(!moves.length)return null;
  const bud={n:0, max: depth<=1?3000 : depth===2?40000 : depth===3?200000 : 600000};
  moves.sort((a,b)=>{const ca=s.board[a.tr][a.tc]?CH_VAL[s.board[a.tr][a.tc].type]:0; const cb=s.board[b.tr][b.tc]?CH_VAL[s.board[b.tr][b.tc].type]:0; return cb-ca;});
  let best=[], bestSc=-1e9;
  for(const m of moves){ const u=chApply(s,m); const sc=-chSearch(s,chOpp(side),depth-1,-1e9,1e9,bud); chUndoMove(s,u);
    if(sc>bestSc+1e-6){ bestSc=sc; best=[m]; } else if(Math.abs(sc-bestSc)<=1e-6) best.push(m); }
  return best[Math.floor(Math.random()*best.length)];   // 동점은 랜덤 → 다양성
}
function startChess(el){
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">상대를 골라요 ♞</div>
    <div class="omok-levels">
      ${CHESS_LEVELS.map(l=>`<button data-k="${l.key}">vs 컴퓨터 · ${l.label}<small>${l.desc}</small></button>`).join('')}
      <button data-k="two">2인 대국<small>번갈아 두기</small></button>
    </div>
    <button class="btn ghost small ch-guide-btn" id="chGuideBtn">♟ 기물 이동 설명</button>
    </div>`;
  el.querySelectorAll('.omok-levels button').forEach(b=>b.onclick=()=>{
    if(b.dataset.k==='two') runChess(el,'two',null);
    else runChess(el,'cpu',CHESS_LEVELS.find(l=>l.key===b.dataset.k));
  });
  el.querySelector('#chGuideBtn').onclick=()=>openChessGuide();
}
// 프로모션(승격) 기물 선택 팝업 — 사람 차례에서만 호출
function showPromo(el, side, cb){
  const cls = side==='W' ? 'w' : 'b';
  const ov=document.createElement('div'); ov.className='ch-promo';
  ov.innerHTML=`<div class="ch-promo-card"><div class="ch-promo-title">승격할 기물 선택</div>
    <div class="ch-promo-row">${['Q','R','B','N'].map(t=>`<button data-t="${t}"><span class="ch-pc ${cls}">${CH_GLYPH[t]}</span></button>`).join('')}</div></div>`;
  ov.querySelectorAll('button').forEach(b=>b.onclick=()=>{ ov.remove(); cb(b.dataset.t); });
  el.appendChild(ov);
}
// 기물 이동 설명 탭
// 기물 설명 — 오버레이(팝업). 시작화면·게임 중 어디서든 열고 닫아도 밑 화면(게임) 유지.
function openChessGuide(){
  const rows=[
    ['K','킹 (King)','상하·좌우·대각선으로 한 칸씩. 절대 잡히면 안 되는 말 (특수: 캐슬링).'],
    ['Q','퀸 (Queen)','상하·좌우·대각선 어느 방향이든 원하는 만큼. 가장 강력한 말.'],
    ['R','룩 (Rook)','상하·좌우 직선으로 원하는 만큼 (캐슬링에 참여).'],
    ['B','비숍 (Bishop)','대각선으로 원하는 만큼. 시작한 칸 색만 다님.'],
    ['N','나이트 (Knight)','L자(한 방향 2칸 + 옆 1칸)로 이동. 다른 말을 뛰어넘음.'],
    ['P','폰 (Pawn)','앞으로 한 칸(첫 수는 두 칸까지). 잡을 때만 대각 앞 한 칸. 끝 줄에 닿으면 승격.'],
  ];
  const ov=document.createElement('div'); ov.className='ch-guide-ov';
  ov.innerHTML=`<div class="ch-guide-card">
    <div class="ch-guide-head"><b>♟ 기물 이동 설명</b><button class="ch-guide-x" aria-label="닫기">×</button></div>
    <div class="ch-guide-list">${rows.map(([t,name,desc])=>
      `<div class="ch-guide-row"><span class="ch-guide-glyph">${CH_GLYPH[t]}</span><div class="ch-guide-txt"><b>${name}</b><small>${desc}</small></div></div>`).join('')}</div>
    <div class="ch-guide-note"><b>특수 규칙</b> · 캐슬링: 킹과 룩을 한 번에 이동해 킹을 안전하게 · 앙파상: 두 칸 전진한 상대 폰을 지나치며 잡기 · 프로모션: 폰이 끝 줄에 닿으면 원하는 기물로 승격 · 상대 킹을 피할 수 없게 공격하면 <b>체크메이트(승리)</b>.</div>
  </div>`;
  const close=()=>ov.remove();
  ov.querySelector('.ch-guide-x').onclick=close;
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  document.body.appendChild(ov);
}
function runChess(el, mode, level){
  let s=chInit(), over=false, sel=null, targets=[], resultMsg='', recorded=false, busy=false;
  const history=[]; const human='W';
  const updateMsg=()=>{ const m=el.querySelector('#chMsg'); if(!m)return;
    if(over){ m.textContent=resultMsg; return; }
    const chk=chInCheck(s,s.turn);
    if(mode==='cpu') m.textContent = s.turn===human ? (chk?`⚠️ 체크! 내 차례 · ${level.label}`:`내 차례 (백) · ${level.label}`) : '컴퓨터 생각 중…';
    else m.textContent=(chk?'⚠️ 체크! ':'')+(s.turn==='W'?'백(아래)':'흑(위)')+' 차례';
  };
  const render=()=>{
    el.innerHTML=`<div class="mg chess">
      <div class="mg-msg" id="chMsg"></div>
      <div class="chess-board" id="chBoard"></div>
      <div class="omok-btns">
        <button class="btn ghost small" id="chUndo">한 수 무르기</button>
        <button class="btn ghost small" id="chNew">새 게임</button>
        <button class="btn ghost small" id="chMode">상대 변경</button>
        <button class="btn ghost small" id="chGuide">❓ 설명</button>
      </div></div>`;
    let html='';
    for(let r=0;r<8;r++)for(let c=0;c<8;c++){ const p=s.board[r][c];
      const dark=(r+c)%2===1, se=(sel&&sel[0]===r&&sel[1]===c)?' sel':'', tg=targets.some(t=>t[0]===r&&t[1]===c)?' tgt':'';
      const pc=p?`<span class="ch-pc ${p.side==='W'?'w':'b'}">${CH_GLYPH[p.type]}</span>`:'';
      html+=`<button class="ch-sq ${dark?'d':'l'}${se}${tg}" data-r="${r}" data-c="${c}">${pc}</button>`;
    }
    const bd=el.querySelector('#chBoard'); bd.innerHTML=html;
    bd.querySelectorAll('.ch-sq').forEach(b=>b.onclick=()=>onTap(+b.dataset.r,+b.dataset.c));
    const ub=el.querySelector('#chUndo'); ub.onclick=undo; ub.disabled=busy||history.length===0;
    el.querySelector('#chNew').onclick=()=>runChess(el,mode,level);
    el.querySelector('#chMode').onclick=()=>startChess(el);
    el.querySelector('#chGuide').onclick=()=>openChessGuide();
    updateMsg();
  };
  const finishIfOver=()=>{
    if(chLegal(s, s.turn).length) return false;
    over=true; const loser=s.turn, winner=chOpp(loser);
    if(chInCheck(s,loser)){
      if(mode==='cpu'){ const win=winner===human; resultMsg=`[${level.label}] `+(win?'체크메이트! 이겼어요 🎉':'체크메이트… 졌어요 😢'); if(!recorded){recorded=true; recordStat(level.key,{result:win?'win':'loss'});} }
      else resultMsg=(winner==='W'?'백':'흑')+' 체크메이트 승리! 🎉';
    } else {
      if(mode==='cpu'){ resultMsg=`[${level.label}] 스테일메이트 · 무승부 🤝`; if(!recorded){recorded=true; recordStat(level.key,{result:'draw'});} }
      else resultMsg='스테일메이트 · 무승부 🤝';
    }
    return true;
  };
  const afterMove=()=>{
    if(finishIfOver()){ render(); return; }
    render();
    if(mode==='cpu' && s.turn!==human){ busy=true; setTimeout(()=>{
      if(!el.querySelector('.chess')) return;
      const m=chBestMove(s, s.turn, level.ai); if(m){ history.push(chApply(s,m)); }
      busy=false; finishIfOver(); render();
    }, 300); }
  };
  const undo=()=>{ if(busy||!history.length)return;
    if(mode==='cpu'){ chUndoMove(s, history.pop()); if(s.turn!==human && history.length) chUndoMove(s, history.pop()); }
    else chUndoMove(s, history.pop());
    over=false; sel=null; targets=[]; render();
  };
  const doMove=(mv)=>{ history.push(chApply(s,mv)); sel=null; targets=[]; afterMove(); };
  const onTap=(r,c)=>{ if(over||busy)return; if(mode==='cpu'&&s.turn!==human)return;
    if(sel && targets.some(t=>t[0]===r&&t[1]===c)){
      const cands=chLegalFrom(s, sel[0], sel[1]).filter(m=>m.tr===r&&m.tc===c);
      const promoCands=cands.filter(m=>m.promo);
      if(promoCands.length){ showPromo(el, s.turn, pt=>doMove(promoCands.find(m=>m.promo===pt)||promoCands[0])); return; }
      doMove(cands[0]); return;
    }
    const p=s.board[r][c];
    if(p&&p.side===s.turn){ sel=[r,c]; targets=chLegalFrom(s,r,c).map(m=>[m.tr,m.tc]); render(); }
    else { sel=null; targets=[]; render(); }
  };
  render();
}

// ── 프로필 ────────────────────────────────────────────
function renderProfile() {
  const u = getCurrentUser(); if (!u) { showReg(); return; }
  document.getElementById('profName').value = u.name;
  setAvatar('profAvatarImg', 'profAvatarFallback', u);
  document.getElementById('syncHint').textContent = getToken() ? '동기화 켜짐' : '동기화하려면 비밀번호 설정';
  renderRecords(u);
}

// ── 프로필: 이름별 누적 기록 ──────────────────────────
function renderRecords(u) {
  u = u || getCurrentUser();
  const nameEl = document.getElementById('recName'); if (nameEl) nameEl.textContent = u ? `· ${u.name}` : '';
  const box = document.getElementById('profRecords'); if (!box) return;
  box.innerHTML = GAMES.map(g => {
    const s = getStat(g.id, u);
    return `<div class="record-row"><span class="rec-game">${g.emoji} ${escapeHtml(g.name)}</span><span class="rec-stat">${g.fmtStat(s)}</span></div>`;
  }).join('');
}

// ── 사용자 등록/선택 오버레이 ─────────────────────────
let regPhotoData = '';
function showReg() {
  regPhotoData = '';
  const ov = document.getElementById('regOverlay');
  const ex = document.getElementById('regExisting');
  const divider = document.getElementById('regDivider');
  document.getElementById('regName').value = '';
  setAvatar('regAvatarImg', 'regAvatarFallback', null);
  if (state.users.length) {
    // 기존 사용자 카드 + 새 등록 폼을 처음부터 함께 노출
    document.getElementById('regTitle').textContent = '누구로 할까요?';
    document.getElementById('regSub').textContent = '기존 사용자를 고르거나 새로 등록하세요.';
    ex.classList.remove('hidden');
    ex.innerHTML = state.users.map(u => `<button class="reg-user" data-id="${u.id}">${avatarInner(u)}<span>${escapeHtml(u.name)}</span></button>`).join('');
    ex.querySelectorAll('.reg-user').forEach(b => b.onclick = () => { setCurrentUser(b.dataset.id); ov.classList.add('hidden'); showView('hub'); });
    divider.classList.remove('hidden');
  } else {
    document.getElementById('regTitle').textContent = '사용자 등록';
    document.getElementById('regSub').textContent = '이름을 입력하면 그 이름으로 게임을 즐길 수 있어요.';
    ex.classList.add('hidden'); ex.innerHTML = '';
    divider.classList.add('hidden');
  }
  ov.classList.remove('hidden');
}

// ── 부트 ──────────────────────────────────────────────
async function bootstrap() {
  const verEl = document.getElementById('ver'); if (verEl) verEl.textContent = BUILD;
  // 저장소가 비워지지 않도록 영구 저장 요청(지원 브라우저)
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}

  document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => showView(b.dataset.view));
  document.getElementById('gameBack').onclick = () => showView('hub');

  // 프로필
  document.getElementById('profSave').onclick = () => {
    const u = getCurrentUser(); if (!u) return;
    const name = document.getElementById('profName').value.trim();
    if (!name) { alert('이름을 입력하세요.'); return; }
    u.name = name; save(); renderProfile(); setSync(getToken() ? '동기화 중…' : '저장됨');
  };
  document.getElementById('profPhoto').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const u = getCurrentUser(); u.photo = await resizePhoto(f); save(); setAvatar('profAvatarImg', 'profAvatarFallback', u); } catch {}
    e.target.value = '';
  };
  document.getElementById('profSwitch').onclick = showReg;
  document.getElementById('profDelete').onclick = () => {
    const u = getCurrentUser(); if (!u) return;
    const pw = prompt(`'${u.name}' 사용자를 삭제하려면 비밀번호를 입력하세요.`);
    if (pw === null) return;
    if (pw !== DELETE_PW) { alert('비밀번호가 올바르지 않습니다.'); return; }
    if (!confirm(`'${u.name}'와(과) 모든 기록이 삭제됩니다. 계속할까요?`)) return;
    deleteUser(u.id);
    showReg();   // 삭제 후 남은 사용자 선택/새 등록 화면으로
  };
  document.getElementById('profToken').onclick = () => {
    const cur = getToken();
    const v = prompt('동기화 비밀번호 (여러 기기에서 같은 값 사용, 비우면 끄기):', cur);
    if (v === null) return;
    if (v.trim()) localStorage.setItem(TOKEN_KEY, v.trim()); else localStorage.removeItem(TOKEN_KEY);
    renderProfile(); pushToServer();
  };

  // 등록 오버레이
  document.getElementById('regPhoto').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { regPhotoData = await resizePhoto(f); document.getElementById('regAvatarImg').src = regPhotoData; document.getElementById('regAvatarImg').style.display = ''; document.getElementById('regAvatarFallback').style.display = 'none'; } catch {}
    e.target.value = '';
  };
  document.getElementById('regCreate').onclick = () => {
    const name = document.getElementById('regName').value.trim();
    if (!name) { alert('이름을 입력하세요.'); return; }
    // 같은 이름이 이미 있으면 새로 만들지 않고 그 사용자로 들어감(중복 방지)
    const existing = state.users.find(u => normName(u.name) === normName(name));
    if (existing) {
      if (!existing.photo && regPhotoData) { existing.photo = regPhotoData; save(); }
      setCurrentUser(existing.id);
      document.getElementById('regOverlay').classList.add('hidden');
      showView('hub');
      return;
    }
    const u = { id: uid(), name, photo: regPhotoData || '', created_at: new Date().toISOString() };
    state.users.push(u); setCurrentUser(u.id); save();
    document.getElementById('regOverlay').classList.add('hidden');
    showView('hub');
  };

  // 포그라운드 복귀 시 자동 재동기화 (다른 기기 기록 반영)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resyncFromServer(); });
  window.addEventListener('focus', resyncFromServer);

  setSync('불러오는 중…');
  await loadInitial();
  if (!getCurrentUser()) showReg();
  renderHub();
}

// ── 미니게임: 프로야구 (KBO 도시팀) ──────────────────────
// 팀 선택(유저=원정/선공) → 1회초~9회말. 타격=타이밍 스윙, 수비=구종·코스 선택.
const KBO_TEAMS = [
  { name:'서울 LG',   c1:'#c30452', c2:'#ffffff' },
  { name:'서울 두산', c1:'#12173f', c2:'#ffffff' },
  { name:'서울 키움', c1:'#68222b', c2:'#c8a96b' },
  { name:'인천 SSG',  c1:'#ce0e2d', c2:'#f5c518' },
  { name:'수원 KT',   c1:'#2b2b2b', c2:'#e01f26' },
  { name:'대전 한화', c1:'#fc4e00', c2:'#111111' },
  { name:'대구 삼성', c1:'#0a4da2', c2:'#c9d2da' },
  { name:'부산 롯데', c1:'#0a2856', c2:'#d2001c' },
  { name:'광주 KIA',  c1:'#ea0029', c2:'#111111' },
  { name:'창원 NC',   c1:'#1d467f', c2:'#a99274' },
];
const KBO_PITCHES = [
  { key:'ff', name:'직구',    spd:2.7 },
  { key:'sl', name:'슬라이더', spd:2.05 },
  { key:'cu', name:'커브',    spd:1.5 },
  { key:'ch', name:'체인지업', spd:1.75 },
];
function startKbo(el){
  const G = { away:0, home:1, inning:1, half:0, outs:0, b:0, s:0, bases:[false,false,false],
              rA:0, rH:0, over:false, raf:null, msg:'' };
  const stopAnim = ()=>{ if (G.raf){ cancelAnimationFrame(G.raf); G.raf=null; } };
  let keyoff=null;                                   // 타석 키보드 조작 해제 함수(화면 전환 때 정리)
  const killKeys = ()=>{ if (keyoff){ keyoff(); keyoff=null; } };
  const battingIsUser = ()=> G.half===0;           // 유저=원정: 초 공격 / 말 수비
  const battingTeam   = ()=> G.half===0 ? G.away : G.home;
  const scoreRun = (n)=>{ if (G.half===0) G.rA+=n; else G.rH+=n; };
  const resetCount = ()=>{ G.b=0; G.s=0; };
  function advanceN(n){ // n=1 단타·2 2루타·3 3루타·4 홈런
    let runs=0; const nb=[false,false,false];
    for(let i=0;i<3;i++){ if(G.bases[i]){ const to=i+1+n; if(to>=4) runs++; else nb[to-1]=true; } }
    if(n>=4) runs++; else nb[n-1]=true;
    G.bases=nb; scoreRun(runs); return runs; }
  function advanceWalk(){ let r=0;
    if (G.bases[0]&&G.bases[1]&&G.bases[2]) r++;
    if (G.bases[0]&&G.bases[1]) G.bases[2]=true;
    if (G.bases[0]) G.bases[1]=true;
    G.bases[0]=true; scoreRun(r); return r; }
  const HITNAME = { single:'안타', double:'2루타', triple:'3루타', hr:'홈런' };
  const OUTNAME = { flyout:'뜬공 아웃', groundout:'땅볼 아웃', lineout:'직선타 아웃', out:'범타 아웃' };
  const isOut = t => t==='out'||t==='flyout'||t==='groundout'||t==='lineout';
  // 잘 맞은 타구도 야수 정면이면 잡힌다 — 타구질이 좋을수록 살아나갈 확률이 높다.
  // 값을 올리면 투수전, 내리면 타격전이 된다.
  const FIELD_OUT = { single:0.36, double:0.24, triple:0.14, hr:0.05 };
  function fieldedOut(q){                                   // q: 타구질(0~5) — 강할수록 뜬공/직선타
    if (q>=4) return Math.random()<0.72 ? 'flyout' : 'lineout';
    if (q===3) return Math.random()<0.50 ? 'flyout' : (Math.random()<0.55 ? 'lineout' : 'groundout');
    return Math.random()<0.66 ? 'groundout' : 'flyout';
  }
  const fieldTeam = ()=> G.half===0 ? G.home : G.away;      // 수비 팀(유니폼 색)

  function outcome(type){
    if (type==='ball'){ G.b++; if (G.b>=4){ const r=advanceWalk(); G.msg='볼넷! 출루'+(r?` (${r}점)`:''); resetCount(); return afterPlay(); } G.msg='볼'; }
    else if (type==='strike'){ G.s++; if (G.s>=3){ G.outs++; G.msg='삼진 아웃! ⚾'; resetCount(); return afterOut(); } G.msg='스트라이크'; }
    else if (type==='foul'){ if (G.s<2) G.s++; G.msg='파울'; }
    else if (isOut(type)){
      resetCount(); G.outs++; let extra='';
      if (type==='groundout' && G.bases[0] && G.outs<3 && Math.random()<0.42){
        G.bases[0]=false; G.outs++; extra=' 병살타… 😱';                 // 1루 주자 있으면 병살
      } else if (type==='flyout' && G.bases[2] && G.outs<3 && Math.random()<0.55){
        G.bases[2]=false; scoreRun(1); extra=' 희생플라이 1점! 🏃';       // 3루 주자는 태그업 득점
      }
      G.msg = (OUTNAME[type]||'범타 아웃')+'! 🧤'+extra;
      return afterOut(); }
    else if (type==='single'||type==='double'||type==='triple'||type==='hr'){
      const n = type==='single'?1 : type==='double'?2 : type==='triple'?3 : 4;
      const r = advanceN(n); G.msg = `${HITNAME[type]}${type==='hr'?'!! 💥':'! 🙌'}` + (r?` ${r}점`:''); resetCount(); return afterPlay(); }
    render();
  }
  function afterOut(){ if (G.outs>=3) endHalf(); else render(); }
  function afterPlay(){ if (G.half===1 && G.inning>=9 && G.rH>G.rA) return gameOver(); render(); }
  function endHalf(){
    G.outs=0; resetCount(); G.bases=[false,false,false];
    if (G.half===0){ if (G.inning>=9 && G.rH>G.rA) return gameOver(); G.half=1; }
    else { if (G.inning>=9 && G.rA!==G.rH) return gameOver(); if (G.inning>=12) return gameOver(); G.inning++; G.half=0; }
    G.msg = `${G.inning}회 ${G.half===0?'초':'말'} — ${KBO_TEAMS[battingTeam()].name} 공격`;
    render();
  }
  function gameOver(){ G.over=true; stopAnim();
    const res = G.rA>G.rH ? 'win' : (G.rA<G.rH ? 'loss' : 'draw');
    recordStat('kbo', { result:res, best:G.rA }); render(); }

  function weighted(w){ const ks=Object.keys(w); let t=0; ks.forEach(k=>t+=w[k]); let x=Math.random()*t;
    for (const k of ks){ x-=w[k]; if (x<0) return k; } return ks[0]; }
  function cpuBat(pitchKey, inZone, cell){
    const breaking = pitchKey!=='ff', center = cell===4;
    if (!inZone){ if (Math.random()>0.30) return 'ball';    // 유인구에 안 속음
      return weighted({hr:1,triple:1,double:3,single:6,foul:18,out:24,strike:47}); }
    if (Math.random()>0.76) return 'strike';                // 루킹 스트라이크
    const g = center ? 1.3 : 1;                             // 한가운데면 잘 맞음
    return weighted({ hr:(breaking?4:7)*g, triple:2*g, double:6*g, single:(breaking?15:20)*g,
      foul:15, out:(breaking?40:34), strike:24 });
  }

  function diamond(){
    return `<svg class="kbo-diamond" viewBox="0 0 100 100" aria-label="주자">
      <polygon points="50,10 90,50 50,90 10,50" fill="none" stroke="#94a3b8" stroke-width="2"/>
      <rect class="b ${G.bases[1]?'on':''}" x="40" y="6"  width="20" height="20" transform="rotate(45 50 16)"/>
      <rect class="b ${G.bases[0]?'on':''}" x="76" y="40" width="20" height="20" transform="rotate(45 86 50)"/>
      <rect class="b ${G.bases[2]?'on':''}" x="4"  y="40" width="20" height="20" transform="rotate(45 14 50)"/>
    </svg>`;
  }
  function scoreboard(){
    const A=KBO_TEAMS[G.away], H=KBO_TEAMS[G.home];
    const dots=(n,on)=>Array.from({length:n},(_,i)=>`<i class="${i<on?'on':''}"></i>`).join('');
    return `<div class="kbo-board">
      <div class="kbo-teams">
        <div class="kbo-trow ${G.half===0?'bat':''}"><span class="kbo-badge" style="background:${A.c1};color:${A.c2}">원정</span><b>${escapeHtml(A.name)}</b><span class="kbo-run">${G.rA}</span></div>
        <div class="kbo-trow ${G.half===1?'bat':''}"><span class="kbo-badge" style="background:${H.c1};color:${H.c2}">홈</span><b>${escapeHtml(H.name)}</b><span class="kbo-run">${G.rH}</span></div>
      </div>
      <div class="kbo-info">
        <div class="kbo-inn">${G.inning}회 ${G.half===0?'▲초':'▼말'}</div>
        ${diamond()}
        <div class="kbo-count"><span>B<div class="kbo-dots b">${dots(3,G.b)}</div></span><span>S<div class="kbo-dots s">${dots(2,G.s)}</div></span><span>O<div class="kbo-dots o">${dots(2,G.outs)}</div></span></div>
      </div>
    </div>`;
  }
  // ===== 그래픽 (세련된 2.5D · 투수/타자 시점) =====
  // SW·SH는 '월드 좌표'(그리기 기준). 캔버스는 ZOOM배 확대해서 그리므로 화면에선 30% 크게 보인다.
  // 세로는 장면 전체(232)를 그대로 담고, 가로만 양옆 VX씩 잘라낸다(잘리는 건 외야 잔디·관중석뿐).
  const SW=320, SH=232, TARGET_P=0.94;
  const ZOOM=1.3, CW=SW, CH=Math.round(SH*ZOOM), VX=(SW-CW/ZOOM)/2;
  const stepOf = k => k==='ff'?0.013 : k==='sl'?0.0105 : k==='ch'?0.0085 : 0.0072;   // 공이 날아오는 속도(작을수록 느림)
  const PREP = 46;                        // 투구와 투구 사이 인터벌(프레임) — 다음 공까지 한 박자 쉬어간다
  const ZC=18, ZGX=SW/2-27, ZGY=52;
  const cellXY=i=>({ x: ZGX+(i%3)*ZC+ZC/2, y: ZGY+((i/3|0))*ZC+ZC/2 });
  const HB=[SW/2,196], B1=[SW/2+64,152], B2=[SW/2,120], B3=[SW/2-64,152], MND=[SW/2,140];
  function rr(c,x,y,w,h,r){ r=Math.min(r,w/2,h/2); c.beginPath(); c.moveTo(x+r,y);
    c.arcTo(x+w,y,x+w,y+h,r); c.arcTo(x+w,y+h,x,y+h,r); c.arcTo(x,y+h,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }
  function shadow(c,x,y,rx){ c.save(); c.fillStyle='rgba(0,0,0,.20)'; c.beginPath(); c.ellipse(x,y,rx,rx*0.42,0,0,7); c.fill(); c.restore(); }
  function ball(c,x,y,r){ r=Math.max(2.5,r); c.save();
    c.fillStyle='rgba(0,0,0,.25)'; c.beginPath(); c.ellipse(x,y+r*0.9,r*1.05,r*0.5,0,0,7); c.fill();
    const g=c.createRadialGradient(x-r*0.35,y-r*0.35,r*0.2,x,y,r); g.addColorStop(0,'#fff'); g.addColorStop(1,'#cbd3dd');
    c.fillStyle=g; c.beginPath(); c.arc(x,y,r,0,7); c.fill();
    c.strokeStyle='#e11d48'; c.lineWidth=Math.max(1,r*0.16); c.beginPath(); c.arc(x-r*0.5,y,r*0.95,-0.7,0.7); c.stroke(); c.restore(); }
  const skin='#f6cca0';
  function bg(c){
    let s=c.createLinearGradient(0,0,0,44); s.addColorStop(0,'#152a44'); s.addColorStop(1,'#2c4a78'); c.fillStyle=s; c.fillRect(0,0,SW,44);
    c.fillStyle='#3c4a63'; c.fillRect(0,40,SW,40);                    // 스탠드
    for(let y=46;y<76;y+=5) for(let x=(y%2?0:4);x<SW;x+=8){ c.fillStyle=(x+y)%3?'#47587a':'#556894'; c.fillRect(x,y,4,3); }
    c.fillStyle='#eef2f7'; c.fillRect(0,74,SW,7);                     // 광고판
    c.fillStyle='#22406e'; c.fillRect(0,79,SW,8);                     // 외야 펜스
    let g=c.createLinearGradient(0,87,0,SH); g.addColorStop(0,'#42a049'); g.addColorStop(1,'#4fb857'); c.fillStyle=g; c.fillRect(0,87,SW,SH-87);
    c.save(); c.globalAlpha=0.07;                                     // 부채꼴 잔디 무늬
    for(let i=-3;i<9;i++){ c.fillStyle=i%2?'#fff':'#0a3a12'; c.beginPath(); c.moveTo(SW/2,110); c.lineTo(SW/2-180+i*44,SH); c.lineTo(SW/2-140+i*44,SH); c.closePath(); c.fill(); } c.restore();
  }
  function infield(c){                                               // 흙 다이아 + 베이스라인
    c.fillStyle='#cf9a5e'; c.beginPath();
    c.moveTo(HB[0],HB[1]+12); c.lineTo(B1[0]+16,B1[1]); c.lineTo(B2[0],B2[1]-16); c.lineTo(B3[0]-16,B3[1]); c.closePath(); c.fill();
    c.save(); c.fillStyle='#4fb857';                                 // 다이아 안쪽 잔디
    c.beginPath(); c.moveTo(HB[0],HB[1]-2); c.lineTo(B1[0]-10,B1[1]); c.lineTo(B2[0],B2[1]+10); c.lineTo(B3[0]+10,B3[1]); c.closePath(); c.fill(); c.restore();
    c.strokeStyle='rgba(255,255,255,.85)'; c.lineWidth=2; c.beginPath();
    c.moveTo(HB[0],HB[1]); c.lineTo(B1[0],B1[1]); c.lineTo(B2[0],B2[1]); c.lineTo(B3[0],B3[1]); c.closePath(); c.stroke();
    c.strokeStyle='rgba(255,255,255,.92)'; c.lineWidth=2;               // 1·3루측 파울라인(외야까지 연장)
    c.beginPath(); c.moveTo(HB[0],HB[1]); c.lineTo(SW/2+154,90); c.stroke();
    c.beginPath(); c.moveTo(HB[0],HB[1]); c.lineTo(SW/2-154,90); c.stroke();
    c.fillStyle='#cf9a5e'; c.beginPath(); c.ellipse(MND[0],MND[1],20,10,0,0,7); c.fill(); // 마운드
  }
  function base(c,p,on){ c.save(); c.translate(p[0],p[1]); c.rotate(Math.PI/4);
    c.fillStyle='#fff'; c.fillRect(-5,-5,10,10); c.restore();
    if(on) runnerFig(c,p[0]-9,p[1]-1,0); }                 // 베이스 위 주자
  // 주자 캐릭터 — run>0이면 팔다리를 흔들며 달린다
  function runnerFig(c,x,y,run){
    const t=KBO_TEAMS[battingTeam()], body=t.c1, cap=t.c2;
    shadow(c,x,y+5,6.5);
    const sw = run>0 ? Math.sin(run*Math.PI*2) : 0.25;
    c.save(); c.lineCap='round';
    c.strokeStyle='#20293a'; c.lineWidth=2.6;                                       // 다리
    c.beginPath(); c.moveTo(x,y-1); c.lineTo(x-3.6*sw, y+5); c.stroke();
    c.beginPath(); c.moveTo(x,y-1); c.lineTo(x+3.6*sw, y+5); c.stroke();
    c.fillStyle=body; rr(c,x-3.8,y-10,7.6,10,3); c.fill();                          // 몸통
    c.strokeStyle=skin; c.lineWidth=2.4;                                            // 팔
    c.beginPath(); c.moveTo(x-2,y-8); c.lineTo(x-2-3.4*sw, y-3.5); c.stroke();
    c.beginPath(); c.moveTo(x+2,y-8); c.lineTo(x+2+3.4*sw, y-3.5); c.stroke();
    c.fillStyle=skin; c.beginPath(); c.arc(x,y-13.4,4,0,7); c.fill();               // 머리
    c.fillStyle=cap; c.beginPath(); c.arc(x,y-14.2,4.2,Math.PI*0.97,Math.PI*2.03); c.fill();
    c.fillStyle=cap; rr(c,x-6,y-15.2,4.5,2,1); c.fill();                            // 모자 챙
    c.restore(); }
  // 야수 — 타구 낙하지점에서 기다리다 마지막에 글러브를 들어 잡는다(뜬공은 위로·땅볼은 아래로)
  function fielderFig(c,x,y,catching,low){
    const t=KBO_TEAMS[fieldTeam()], body=t.c1, cap=t.c2;
    shadow(c,x,y+5,7);
    c.save(); c.lineCap='round';
    c.strokeStyle='#20293a'; c.lineWidth=2.6;                                       // 다리
    c.beginPath(); c.moveTo(x,y-1); c.lineTo(x-3,y+5); c.stroke();
    c.beginPath(); c.moveTo(x,y-1); c.lineTo(x+3,y+5); c.stroke();
    c.fillStyle=body; rr(c,x-4,y-11,8,11,3); c.fill();                              // 몸통
    const gy = low ? (catching? y+2 : y-4) : (catching? y-21 : y-10);               // 글러브 높이
    c.strokeStyle=skin; c.lineWidth=2.4;                                            // 글러브 든 팔
    c.beginPath(); c.moveTo(x-2,y-9); c.lineTo(x-5,gy+3); c.stroke();
    c.beginPath(); c.moveTo(x+2,y-9); c.lineTo(x+4,y-4); c.stroke();
    c.fillStyle=skin; c.beginPath(); c.arc(x,y-14.4,4.2,0,7); c.fill();             // 머리
    c.fillStyle=cap; c.beginPath(); c.arc(x,y-15.2,4.4,Math.PI*0.97,Math.PI*2.03); c.fill();
    c.fillStyle=cap; rr(c,x-6,y-16.2,4.5,2,1); c.fill();                            // 모자 챙
    c.fillStyle='#8b5a2b'; c.beginPath(); c.arc(x-6.5,gy,4,0,7); c.fill();          // 글러브
    if(catching){ c.strokeStyle='#fde047'; c.lineWidth=2; c.globalAlpha=0.9;        // 포구 임팩트
      for(let i=0;i<6;i++){ const a=i*Math.PI/3; c.beginPath();
        c.moveTo(x-6.5+Math.cos(a)*6, gy+Math.sin(a)*6);
        c.lineTo(x-6.5+Math.cos(a)*11, gy+Math.sin(a)*11); c.stroke(); } }
    c.restore(); }
  // 주루 경로: 홈 → 1루 → 2루 → 3루 → 홈
  const BPATH=[HB,B1,B2,B3,HB];
  function runnersFor(n){                                  // n=진루 수. 뒤 주자부터 앞 주자 순
    const list=[{from:0,to:Math.min(4,n)}];                // 홈(4)을 넘어가면 득점이므로 홈에서 멈춘다
    for(let i=2;i>=0;i--) if(G.bases[i]) list.push({from:i+1,to:Math.min(4,i+1+n)});
    return list; }
  function runnerPos(r,u){
    const segs=r.to-r.from, d=Math.min(segs, u*segs);
    const i=Math.min(segs-1, Math.floor(d)), f=d-i;
    const a=BPATH[r.from+i], b=BPATH[r.from+i+1];
    return [a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f]; }
  function homeplate(c){ const [x,y]=HB; c.fillStyle='#fff'; c.beginPath();
    c.moveTo(x-8,y-5); c.lineTo(x+8,y-5); c.lineTo(x+8,y+1); c.lineTo(x,y+8); c.lineTo(x-8,y+1); c.closePath(); c.fill(); }
  // ── 캐릭터(둥근 파워프로풍) ──
  // 타석에서 마주보는 투수(정면) — ph: 0 셋업 → 1 릴리스, s: 축척(멀수록 작게)
  function pitcherBig(c,x,y,body,cap,ph,s){ ph=ph||0;
    c.save(); c.translate(x,y); c.scale(s||1,s||1); c.translate(-x,-y);
    shadow(c,x,y+3,17);
    c.fillStyle='#20293a'; rr(c,x-8,y-15,7,16,3); c.fill();                          // 다리
    if(ph>0.15&&ph<0.72){ c.save(); c.translate(x+3,y-13); c.rotate(-0.75);          // 들어올린 다리
      c.fillStyle='#20293a'; rr(c,0,-3.5,16,7,3.5); c.fill(); c.restore(); }
    else { c.fillStyle='#20293a'; rr(c,x+1,y-15,7,16,3); c.fill(); }
    c.fillStyle=body; rr(c,x-11,y-35,22,22,7); c.fill();                             // 몸통
    c.save(); c.translate(x-3,y-31); c.rotate(-2.45+ph*3.05);                        // 투구 팔
    c.fillStyle=body; rr(c,0,-3,13,6,3); c.fill();
    c.fillStyle=skin; c.beginPath(); c.arc(14,0,3.8,0,7); c.fill(); c.restore();
    c.fillStyle=skin; c.beginPath(); c.arc(x,y-42,8.2,0,7); c.fill();                // 머리
    c.fillStyle=cap; c.beginPath(); c.arc(x,y-43,8.5,Math.PI*0.97,Math.PI*2.03); c.fill();
    c.fillStyle=cap; rr(c,x-9,y-44.4,18,3.4,1.7); c.fill();                          // 모자 챙(정면)
    c.restore(); }
  function batterFront(c,x,y,body,cap,sw){ shadow(c,x,y+11,10);
    c.fillStyle='#20293a'; rr(c,x-5,y,4,10,2); c.fill(); rr(c,x+2,y,4,10,2); c.fill();
    c.fillStyle=body; rr(c,x-7,y-13,14,15,5); c.fill();
    c.fillStyle=skin; c.beginPath(); c.arc(x,y-19,6.4,0,7); c.fill();
    c.fillStyle=cap; c.beginPath(); c.arc(x,y-20,6.6,Math.PI*1.02,Math.PI*1.98); c.fill();
    c.save(); c.translate(x-7,y-11); c.rotate(-2.2+(sw||0)*2.6);
    c.fillStyle=skin; rr(c,-3,-2,7,4,2); c.fill(); c.fillStyle='#111827'; rr(c,2,-2.5,20,5,2.5); c.fill(); c.restore(); }
  function bigBatter(c,x,y,body,cap,sw){                            // 전경 타자(등)
    shadow(c,x+2,y+30,28);
    c.fillStyle='#eef2f7'; rr(c,x-12,y+4,11,26,5); c.fill(); rr(c,x+2,y+4,11,26,5); c.fill();
    let g=c.createLinearGradient(x-20,0,x+20,0); g.addColorStop(0,body); g.addColorStop(1,shade(body,-18));
    c.fillStyle=g; rr(c,x-20,y-26,40,36,12); c.fill();
    c.fillStyle='rgba(255,255,255,.92)'; c.font='bold 13px sans-serif'; c.textAlign='center'; c.textBaseline='middle'; c.fillText('53',x,y-6);
    c.fillStyle=skin; c.beginPath(); c.arc(x,y-36,15,0,7); c.fill();
    let hg=c.createLinearGradient(x-15,y-50,x+15,y-30); hg.addColorStop(0,shade(cap,14)); hg.addColorStop(1,cap);
    c.fillStyle=hg; c.beginPath(); c.arc(x,y-38,15.5,Math.PI*0.96,Math.PI*2.04); c.fill();
    c.save(); c.translate(x+12,y-22); c.rotate(-2.35+(sw||0)*2.8);   // 평소 뒤로 코킹 → 스윙 시 앞으로
    c.fillStyle=skin; rr(c,-3,-5,15,10,5); c.fill();                  // 손/팔
    c.fillStyle='#0f1520'; rr(c,10,-3.5,34,7,3.5); c.fill();          // 배트
    c.fillStyle='#8b939f'; rr(c,40,-3.5,7,7,2); c.fill(); c.restore(); }
  function catcher(c,x,y){ shadow(c,x,y+7,9); c.fillStyle='#2f3a4d'; rr(c,x-8,y-8,16,15,6); c.fill();
    c.fillStyle='#9aa4b4'; c.beginPath(); c.arc(x,y-11,5.5,0,7); c.fill(); c.fillStyle='#1e2635'; rr(c,x-6,y-15,12,4,2); c.fill(); }
  function umpire(c,x,y){ shadow(c,x,y+6,6); c.fillStyle='#111827'; rr(c,x-5,y-7,10,11,4); c.fill();
    c.fillStyle=skin; c.beginPath(); c.arc(x,y-10,4.4,0,7); c.fill(); }
  function shade(hex,d){ const n=parseInt(hex.slice(1),16); let r=(n>>16)+d,g=((n>>8)&255)+d,b=(n&255)+d;
    r=Math.max(0,Math.min(255,r)); g=Math.max(0,Math.min(255,g)); b=Math.max(0,Math.min(255,b));
    return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1); }
  function drawZone(c,aim,cursor){
    c.save(); c.globalAlpha=0.22; c.fillStyle='#0b1020'; rr(c,ZGX,ZGY,ZC*3,ZC*3,4); c.fill(); c.globalAlpha=1;
    for(let i=0;i<9;i++){ const cx=ZGX+(i%3)*ZC, cy=ZGY+((i/3|0))*ZC;
      if(aim===i){ c.globalAlpha=0.5; c.fillStyle='#22c55e'; c.fillRect(cx,cy,ZC,ZC); c.globalAlpha=1; }
      if(cursor===i){ c.strokeStyle='#fde047'; c.lineWidth=2.5; c.strokeRect(cx+1.5,cy+1.5,ZC-3,ZC-3); } }
    c.strokeStyle='rgba(255,255,255,.9)'; c.lineWidth=1;
    for(let k=0;k<=3;k++){ c.beginPath(); c.moveTo(ZGX+k*ZC,ZGY); c.lineTo(ZGX+k*ZC,ZGY+3*ZC); c.stroke();
      c.beginPath(); c.moveTo(ZGX,ZGY+k*ZC); c.lineTo(ZGX+3*ZC,ZGY+k*ZC); c.stroke(); } c.restore(); }
  // ══ 타자 시점(정면) — 9분할 존 화면에 투수가 겹쳐 보인다 ══
  // 존은 화면 아래쪽(타자 앞), 투수는 그보다 위에 작게 — 겹쳐 보이지 않게 위아래로 갈라 놓는다.
  const ZC2=38, ZGX2=SW/2-ZC2*1.5, ZGY2=112;                // 타석 존(투수 시점보다 크게)
  const PMB=[SW/2,98], PSC=0.70;                            // 정면 투수 발 위치·축척(멀리 있어 작다)
  const cell2XY=i=>({ x: ZGX2+(i%3)*ZC2+ZC2/2, y: ZGY2+((i/3|0))*ZC2+ZC2/2 });
  function cellOfPt(x,y){                                   // 도착 지점 → 존 칸(+스트라이크 여부)
    const gx=Math.floor((x-ZGX2)/ZC2), gy=Math.floor((y-ZGY2)/ZC2);
    return { cell: Math.max(0,Math.min(2,gy))*3+Math.max(0,Math.min(2,gx)),
             inZone: gx>=0&&gx<=2&&gy>=0&&gy<=2 }; }
  function zoneGrid2(c,cursor,hit){                         // hit: 공이 지나간 칸(파란 표시)
    c.save();
    c.globalAlpha=0.20; c.fillStyle='#0b1020'; rr(c,ZGX2,ZGY2,ZC2*3,ZC2*3,6); c.fill(); c.globalAlpha=1;
    if(hit!=null){ const h=cell2XY(hit); c.globalAlpha=0.42; c.fillStyle='#38bdf8';
      c.fillRect(h.x-ZC2/2,h.y-ZC2/2,ZC2,ZC2); c.globalAlpha=1; }
    c.strokeStyle='rgba(255,255,255,.9)'; c.lineWidth=1.2;
    for(let k=0;k<=3;k++){ c.beginPath(); c.moveTo(ZGX2+k*ZC2,ZGY2); c.lineTo(ZGX2+k*ZC2,ZGY2+3*ZC2); c.stroke();
      c.beginPath(); c.moveTo(ZGX2,ZGY2+k*ZC2); c.lineTo(ZGX2+3*ZC2,ZGY2+k*ZC2); c.stroke(); }
    c.strokeStyle='rgba(255,255,255,.95)'; c.lineWidth=2.4; c.strokeRect(ZGX2,ZGY2,ZC2*3,ZC2*3);
    if(cursor!=null){ const p=cell2XY(cursor);               // 노란 조준 커서(오른쪽 원형키로 이동)
      c.strokeStyle='#fde047'; c.lineWidth=3; c.strokeRect(p.x-ZC2/2+2,p.y-ZC2/2+2,ZC2-4,ZC2-4);
      c.strokeStyle='rgba(253,224,71,.7)'; c.lineWidth=1.6;
      c.beginPath(); c.arc(p.x,p.y,ZC2*0.28,0,7); c.stroke();
      c.beginPath(); c.moveTo(p.x-7,p.y); c.lineTo(p.x+7,p.y); c.moveTo(p.x,p.y-7); c.lineTo(p.x,p.y+7); c.stroke(); }
    c.restore(); }
  // 1인칭 배트 — sw: 0 코킹 → 1 스윙 완료(오른쪽에서 왼쪽으로 쓸어친다)
  function frontBat(c,sw){ const px=SW/2+72, py=SH+16, L=168, a=-1.12-(sw||0)*1.78;
    c.save(); c.translate(px,py); c.rotate(a);
    if(sw>0.08&&sw<0.98){ c.save(); c.globalAlpha=0.15; c.fillStyle='#fff';           // 스윙 잔상
      for(let i=1;i<=3;i++){ c.save(); c.rotate(i*0.17); rr(c,0,-8,L,16,8); c.fill(); c.restore(); } c.restore(); }
    c.fillStyle='#0f1520'; rr(c,0,-6.5,30,13,6.5); c.fill();                          // 그립
    c.fillStyle='#a5713c'; rr(c,24,-5,L-46,10,5); c.fill();                           // 배트
    c.fillStyle='#c8956a'; rr(c,L-26,-6.5,26,13,6.5); c.fill();                       // 배트 헤드
    c.restore(); }
  function drawBatterZoneView(c,o){ o=o||{}; bg(c);
    c.strokeStyle='rgba(255,255,255,.75)'; c.lineWidth=2;                             // 파울라인(원근)
    c.beginPath(); c.moveTo(SW/2,SH+26); c.lineTo(-34,96); c.stroke();
    c.beginPath(); c.moveTo(SW/2,SH+26); c.lineTo(SW+34,96); c.stroke();
    c.fillStyle='#cf9a5e'; c.beginPath(); c.ellipse(PMB[0],PMB[1]+4,33,10,0,0,7); c.fill();   // 마운드
    c.beginPath(); c.ellipse(SW/2,SH+34,146,64,0,0,7); c.fill();                      // 타석 주변 흙(전경)
    pitcherBig(c,PMB[0],PMB[1],o.pitcher||'#1e3a8a','#0e2350',o.phase||0,PSC);
    zoneGrid2(c,o.cursor,o.hit);
    if(o.trail) for(const t of o.trail) ballGhost(c,t.x,t.y,t.r,t.a);
    if(o.ball) ball(c,o.ball.x,o.ball.y,o.ball.r);
    frontBat(c,o.swing||0);
    if(o.contact){ c.save(); c.globalAlpha=0.9; c.strokeStyle='#fde047'; c.lineWidth=3;   // 타격 임팩트
      for(let i=0;i<8;i++){ const a=i*Math.PI/4; c.beginPath();
        c.moveTo(o.contact.x+Math.cos(a)*11,o.contact.y+Math.sin(a)*11);
        c.lineTo(o.contact.x+Math.cos(a)*22,o.contact.y+Math.sin(a)*22); c.stroke(); } c.restore(); } }
  // 투구 궤적(정면) — 원근감: 손을 떠날 땐 작고 천천히, 가까워질수록 급격히 커진다(거듭제곱 이징).
  // 구종별 변화는 '겉보기 조준점(aim)'으로 오다가 도착 직전에 실제 도착점(arr)으로 휘는 방식.
  const REL2=[SW/2+6, 82];                                   // 릴리스 포인트(정면 투수의 손)
  const PITCH_BREAK={ ff:[0,-6], sl:[-30,9], cu:[5,32], ch:[12,19] };   // 존 한 칸 = 38px
  function ballToZone(p, aim, arr){
    p = Math.max(0, Math.min(1, p));
    const e = Math.pow(p, 1.55);                     // 위치 이징
    const s = Math.pow(p, 2.30);                     // 크기 이징(막판에 확 커진다)
    const b = Math.pow(p, 2.80);                     // 변화량 — 홈플레이트 앞에서 급격히 휜다
    return { x: REL2[0] + (aim.x-REL2[0])*e + (arr.x-aim.x)*b,
             y: REL2[1] + (aim.y-REL2[1])*e + (arr.y-aim.y)*b,
             r: 2.0 + 10.5*s };
  }
  function trailOf2(bp, aim, arr){
    if(bp==null) return null;
    return [0.07,0.15,0.24].map((d,i)=>{ const q=bp-d; if(q<=0) return null;
      const g=ballToZone(q,aim,arr); g.a=0.32-i*0.09; return g; }).filter(Boolean);
  }
  function ballGhost(c,x,y,r,a){ c.save(); c.globalAlpha=a; c.fillStyle='#fff';
    c.beginPath(); c.arc(x,y,Math.max(1.5,r*0.92),0,7); c.fill(); c.restore(); }
  // 투수 시점(마운드에서 타석) — 9분할 존
  function drawPitcherView(c,o){ o=o||{}; bg(c);
    c.strokeStyle='rgba(255,255,255,.85)'; c.lineWidth=2;              // 홈→1·3루 베이스라인+파울라인 연장(원근)
    c.beginPath(); c.moveTo(SW/2,104); c.lineTo(SW-24,SH); c.stroke();
    c.beginPath(); c.moveTo(SW/2,104); c.lineTo(24,SH); c.stroke();
    c.fillStyle='#cf9a5e'; c.beginPath(); c.ellipse(SW/2,96,46,26,0,0,7); c.fill();   // 홈 주변 흙
    homeAt(c,SW/2,104);
    umpire(c,SW/2+26,74); catcher(c,SW/2+6,112);
    batterFront(c,SW/2-20,104,o.batter||'#c30452','#7f1020',o.swing||0);
    if(o.grid) drawZone(c,o.aim,o.cursor);
    c.fillStyle='#cf9a5e'; c.beginPath(); c.ellipse(SW/2,SH-14,40,16,0,0,7); c.fill();  // 마운드(가까이)
    if(o.ball) ball(c,o.ball.x,o.ball.y,o.ball.r); }
  function homeAt(c,x,y){ c.fillStyle='#fff'; c.beginPath();
    c.moveTo(x-7,y-4); c.lineTo(x+7,y-4); c.lineTo(x+7,y+1); c.lineTo(x,y+6); c.lineTo(x-7,y+1); c.closePath(); c.fill(); }
  // 타구 뷰(공통) — 외야로 뻗는 공
  function drawHitView(c,o){ o=o||{}; bg(c); infield(c);
    const st = o.runners ? [false,false,false] : G.bases;   // 주루 중엔 베이스 위 정지 주자를 그리지 않는다
    base(c,B1,st[0]); base(c,B2,st[1]); base(c,B3,st[2]); homeplate(c);
    if(o.runners) for(const r of o.runners) runnerFig(c,r.x,r.y,r.run);
    if(o.fielder) fielderFig(c,o.fielder.x,o.fielder.y,o.fielder.catching,o.fielder.low);
    if(!o.hideBatter) bigBatter(c,SW/2-44,210,o.batter||'#1d4ed8','#0b2a6b',1);
    if(o.ball) ball(c,o.ball.x,o.ball.y,o.ball.r); }
  // 타구 낙하지점 — 페어는 외야 그라운드, 파울은 파울라인 바깥, 홈런은 펜스 너머 관중석
  function landSpot(type){
    const R2=(a,b)=>a+Math.random()*(b-a), cx=x=>Math.max(48,Math.min(272,x));
    if(type==='hr') return { x:cx(R2(70,250)), y:R2(52,76) };
    const y = type==='triple' ? R2(92,108) : type==='double' ? R2(104,126)
            : type==='foul'   ? R2(140,175)
            : type==='flyout' ? R2(94,122)                     // 외야 뜬공
            : type==='lineout'? R2(116,138)                    // 외야 앞 직선타
            : type==='groundout' ? R2(146,166)                 // 내야 땅볼
            : R2(126,152);
    const half = 154*(HB[1]-y)/106;                       // 그 깊이에서 홈~파울라인까지의 거리
    if(type==='foul') return { x:cx(HB[0] + (Math.random()<0.5?-1:1)*(half+R2(14,54))), y };
    const inner = Math.max(10, half-14);
    const x = type==='triple' ? HB[0] + (Math.random()<0.5?-1:1)*R2(inner*0.72, inner)   // 3루타는 라인 쪽으로
                              : HB[0] + R2(-inner, inner);
    return { x:cx(x), y };
  }
  // 타구가 외야로 포물선을 그리며 날아가고, 그동안 주자들이 각 베이스로 달려간다
  function hitAnim(c, type, batC, cb){
    const bl=document.getElementById('kboBelow');
    const label = type==='hr'?'홈런!! 💥' : type==='foul'?'파울! 😬'
                : isOut(type) ? (OUTNAME[type]||'범타 아웃')+'! 🧤' : HITNAME[type]+'! 🙌';
    if(bl) bl.innerHTML=`<div class="kbo-note kbo-hit">${label}</div>`;
    const n = { single:1, double:2, triple:3, hr:4 }[type] || 0;                  // 파울·아웃은 진루 없음
    const FR = type==='hr'?150 : type==='triple'?128 : type==='double'?96 : type==='foul'?64
             : type==='flyout'?116 : type==='lineout'?66 : type==='groundout'?74 : 70;
    const BF = Math.round(FR*0.9);                                                // 타구 비행 — 종전(0.6)보다 50% 느리게
    const arc = type==='hr'?78 : type==='triple'?52 : type==='double'?42 : type==='foul'?30
              : type==='flyout'?66 : type==='lineout'?10 : type==='groundout'?5 : 32;
    const land = landSpot(type);
    // 아웃 타구는 낙하지점에 야수가 서 있다가 공이 닿는 순간 잡는다
    const fld = isOut(type) ? { x:land.x, y:land.y+3, low: type!=='flyout' } : null;
    const runs = n ? runnersFor(n) : null;
    const maxSeg = runs ? Math.max(...runs.map(r => r.to-r.from)) : 1;            // 모든 주자가 같은 속도로 달리고
    const sx=HB[0]-6, sy=HB[1]-8; let f=0;
    (function fr(){ f++;
      const tb=Math.min(1,f/BF), u=Math.min(1,f/FR);
      let ru=null;
      if(runs){ ru=[];
        for(const r of runs){
          const segs = r.to-r.from;
          const ur = Math.min(1, u*maxSeg/segs);                                  // 가까운 베이스면 먼저 도착해 선다
          if(ur>=1 && r.to>=4) continue;                                          // 홈까지 들어온 주자는 득점 처리
          const [x,y]=runnerPos(r,ur); ru.push({ x, y, run: ur>=1 ? 0 : f*0.11 });
        } }
      drawHitView(c,{ batter:batC, runners:ru, hideBatter: !!runs && f>9,
        fielder: fld && tb>0.12 ? Object.assign({ catching: tb>0.9 }, fld) : null,
        ball: { x: sx+(land.x-sx)*tb,
                y: sy+(land.y-sy)*tb - arc*Math.sin(Math.PI*tb),                  // 포물선
                r: Math.max(2.2, 7-4.6*tb) } });
      if(f<FR){ G.raf=requestAnimationFrame(fr);} else { stopAnim(); setTimeout(cb,560); } })(); }
  function makeCanvas(act){
    act.innerHTML = `<div class="kbo-stage"><canvas class="kbo-canvas" width="${CW}" height="${CH}"></canvas>
      <div class="kbo-pads" id="kboPads"></div></div><div class="kbo-below" id="kboBelow"></div>`;
    const cv=act.querySelector('.kbo-canvas'), ctx=cv.getContext('2d');
    ctx.setTransform(ZOOM,0,0,ZOOM,-VX*ZOOM,0);        // 이후 모든 그리기는 월드 좌표 그대로 쓴다
    return { ctx, cv, below:act.querySelector('#kboBelow'), pads:act.querySelector('#kboPads') }; }

  // 타자 시점: 9분할 존 화면(투수 겹침) — 오른쪽 원형키로 코스를 맞추고 왼쪽 원형키로 스윙.
  // 구종마다 도착 직전 휘는 방향이 다르므로, 그 변화를 읽고 커서를 미리 옮겨두면 잘 맞는다.
  function batUI(act){
    const pitch=KBO_PITCHES[Math.floor(Math.random()*KBO_PITCHES.length)];
    const BRK=PITCH_BREAK[pitch.key];
    const R2=(a,b)=>a+Math.random()*(b-a);
    const base0=cell2XY(Math.random()*9|0);
    let arr;                                           // 실제 도착 지점
    if(Math.random()<0.60) arr={ x:base0.x+R2(-7,7), y:base0.y+R2(-7,7) };                      // 스트라이크 존
    else if(Math.random()<0.5) arr={ x:base0.x+(Math.random()<0.5?-1:1)*R2(ZC2,ZC2*1.5), y:base0.y+R2(-10,10) };
    else arr={ x:base0.x+R2(-10,10), y:base0.y+(Math.random()<0.5?-1:1)*R2(ZC2,ZC2*1.5) };      // 유인구
    arr={ x:Math.max(ZGX2-ZC2*1.4,Math.min(ZGX2+ZC2*4.4,arr.x)),
          y:Math.max(ZGY2-ZC2*1.4,Math.min(ZGY2+ZC2*4.4,arr.y)) };
    const aim={ x:arr.x-BRK[0], y:arr.y-BRK[1] };      // 겉보기 조준점(변화 전)
    const land=cellOfPt(arr.x,arr.y);

    const { ctx, cv, below, pads } = makeCanvas(act);
    const myC=KBO_TEAMS[G.away].c1, opC=KBO_TEAMS[G.home].c1;
    let cursor = G.aimCell==null ? 4 : G.aimCell;
    below.innerHTML=`<div class="kbo-note"><b>${pitch.name}!</b> 왼쪽 스틱을 밀어 코스를 맞추고 오른쪽 키로 스윙</div>`;
    pads.innerHTML=`<div class="kbo-pad kbo-stickpad" id="aimStick">
        <span class="ar" data-d="u">▲</span><span class="ar" data-d="l">◀</span>
        <span class="ar" data-d="r">▶</span><span class="ar" data-d="d">▼</span>
        <span class="kbo-knob" id="aimKnob"></span>
      </div>
      <button class="kbo-pad kbo-swingpad" id="swPad">🏏<b>스윙</b></button>`;
    const WIND=0.30;                                   // 와인드업 구간(나머지가 공이 날아오는 구간)
    let p=0, done=false, swung=false, wait=PREP; const step=stepOf(pitch.key);
    let sw=0, swType=null, bpSwing=0;                  // 배트 스윙 진행도 / 스윙 결과 / 휘두른 시점
    const paint=o=> drawBatterZoneView(ctx, Object.assign({ pitcher:opC, cursor }, o||{}));
    const move=d=>{ if(done||swung) return;
      const cx=cursor%3, cy=(cursor/3|0);
      const nx=Math.max(0,Math.min(2, cx+(d==='l'?-1:d==='r'?1:0)));
      const ny=Math.max(0,Math.min(2, cy+(d==='u'?-1:d==='d'?1:0)));
      cursor=ny*3+nx; G.aimCell=cursor; };
    const key=e=>{ const k=e.key;
      if(k==='ArrowUp') move('u'); else if(k==='ArrowDown') move('d');
      else if(k==='ArrowLeft') move('l'); else if(k==='ArrowRight') move('r');
      else if(k===' '||k==='Enter') doSwing(); else return;
      e.preventDefault(); };
    const unbind=()=> killKeys();
    killKeys(); document.addEventListener('keydown',key);
    keyoff=()=> document.removeEventListener('keydown',key);
    // 맞히기 판정 — 타이밍(3단계) + 코스 일치(커서와 도착 칸의 거리)
    function judge(bp){
      const d=Math.max(Math.abs(cursor%3-land.cell%3), Math.abs((cursor/3|0)-(land.cell/3|0)));
      if(d>=2) return 'strike';                                          // 코스가 크게 어긋남 → 헛스윙
      const err=Math.abs(bp-TARGET_P);
      let t = err<=0.05?3 : err<=0.10?2 : err<=0.17?1 : err<=0.26?0 : -1;
      if(t<0) return 'strike';                                           // 타이밍 실패 → 헛스윙
      let z = d===0?2:1;
      if(!land.inZone){ z--; if(t>2) t=2; }                              // 유인구는 제대로 맞히기 어렵다
      const q=t+z;
      if (q<=0) return Math.random()<0.5 ? 'foul' : fieldedOut(0);       // 빗맞은 타구
      if (q===1) return 'foul';
      const hit = q>=5?'hr' : q===4?'triple' : q===3?'double' : 'single';
      // 안타성 타구여도 수비에 걸릴 수 있다 — 타구가 강할수록 잡힐 확률이 낮다
      if (Math.random() < FIELD_OUT[hit]) return fieldedOut(q);
      return hit;
    }
    // 스윙은 한 타석에 한 번. 배트와 공은 서로 독립적으로 움직인다 —
    // 공보다 일찍 휘두르면 배트만 먼저 헛돌고, 공은 제 속도로 계속 날아와 존을 지나간다.
    function doSwing(){ if(done||swung) return; swung=true; unbind();
      bpSwing = p>WIND ? (p-WIND)/(1-WIND) : 0;        // 휘두른 순간 공이 와 있던 지점
      swType = judge(bpSwing);                         // 타이밍·코스가 어긋나면 'strike'(헛스윙)
      sw = 0.001; }                                    // 루프가 배트를 휘두르기 시작한다
    (function fr(){ if(done) return;
      if(wait>0) wait--;                               // 투구 사이 인터벌 — 투수가 셋업하는 동안 잠깐 쉼
      else if(p<1) p+=step;
      const phase = wait>0 ? 0 : Math.min(1,p/WIND);
      const bp = (wait<=0 && p>WIND) ? (p-WIND)/(1-WIND) : null;
      const b  = bp!=null ? ballToZone(Math.min(1,bp),aim,arr) : null;
      if(sw>0 && sw<1){
        if(swType==='strike' || bpSwing>=TARGET_P) sw=Math.min(1,sw+0.16);   // 헛스윙·늦은 스윙 — 그대로 휘두른다
        else {                                         // 맞는 스윙 — 공이 오는 만큼 배트를 끌고 와 도착 시점에 만나게 한다
          const prog=(bp==null?0:(bp-bpSwing)/Math.max(0.001,TARGET_P-bpSwing));
          sw=Math.min(1, Math.max(sw+0.02, 0.6*Math.max(0,prog))); } }
      // 맞는 스윙: 공이 배트에 닿는 순간 타구 화면으로 넘어간다
      if(swType && swType!=='strike' && bp!=null && bp>=TARGET_P){
        done=true; stopAnim();
        paint({ phase:1, ball:b, swing:Math.max(sw,0.6), hit:land.cell, contact:b });
        return setTimeout(()=>hitAnim(ctx,swType,myC,()=>outcome(swType)),200); }
      paint({ phase, ball:b, trail:trailOf2(bp,aim,arr), swing:sw });
      if(p>=1){ done=true; stopAnim(); unbind();       // 공이 포수 미트까지 도달 — 도착 칸을 보여준다
        const res = swung ? 'strike' : (land.inZone?'strike':'ball');   // 헛스윙은 코스와 무관하게 스트라이크
        paint({ phase:1, ball:ballToZone(1,aim,arr), swing:sw, hit:land.cell });
        return setTimeout(()=>outcome(res),420); }
      G.raf=requestAnimationFrame(fr); })();
    // 조준 스틱 — 누른 채 손가락을 떼지 않고 움직이면 민 방향 그대로 커서가 따라온다.
    // 스틱 중심 기준 오프셋을 3×3으로 양자화해 존 칸에 1:1로 대응시킨다(가운데를 누르면 한가운데 칸).
    const stick=pads.querySelector('#aimStick'), knob=pads.querySelector('#aimKnob');
    const aimAt=(px,py)=>{ if(done||swung) return;
      const r=stick.getBoundingClientRect(), RX=r.width/2, RY=r.height/2;
      const dx=(px-(r.left+RX))/RX, dy=(py-(r.top+RY))/RY, T=0.33;
      cursor=(dy<-T?0:dy>T?2:1)*3 + (dx<-T?0:dx>T?2:1); G.aimCell=cursor;
      const m=Math.hypot(dx,dy), k=m>0.62?0.62/m:1;    // 노브는 패드 밖으로 나가지 않게 잡아둔다
      knob.style.transform=`translate(${dx*k*RX}px, ${dy*k*RY}px)`; };
    let dragId=null;                                   // 캡처가 풀려도 조준이 끊기지 않게 직접 추적한다
    stick.onpointerdown=e=>{ e.preventDefault(); dragId=e.pointerId;
      try{ stick.setPointerCapture(e.pointerId); }catch(_){}   // 스틱 밖으로 손가락이 나가도 계속 따라오도록
      aimAt(e.clientX,e.clientY); };
    stick.onpointermove=e=>{ if(dragId===null||e.pointerId!==dragId) return;
      e.preventDefault(); aimAt(e.clientX,e.clientY); };
    const drop=e=>{ if(dragId===null) return; dragId=null;
      try{ stick.releasePointerCapture(e.pointerId); }catch(_){}
      knob.style.transform=''; };                      // 손을 떼면 노브만 중앙 복귀(고른 칸은 유지)
    stick.onpointerup=drop; stick.onpointercancel=drop;
    pads.querySelector('#swPad').onpointerdown=e=>{ e.preventDefault(); doSwing(); };
    cv.onclick=e=>{ if(done||swung) return;            // 존을 직접 눌러 커서를 옮겨도 된다
      const r=cv.getBoundingClientRect();
      const wx=(e.clientX-r.left)*(CW/r.width)/ZOOM + VX, wy=(e.clientY-r.top)*(CH/r.height)/ZOOM;
      const gx=Math.floor((wx-ZGX2)/ZC2), gy=Math.floor((wy-ZGY2)/ZC2);
      if(gx<0||gx>2||gy<0||gy>2) return;
      cursor=gy*3+gx; G.aimCell=cursor; };
  }

  // 투수 시점: 구종 선택 → 9칸 커서 조준 → 게이지 → 투구 → CPU 타자 결과
  function pitchUI(act){
    const { ctx, cv, below } = makeCanvas(act);
    const batC=KBO_TEAMS[G.home].c1;
    let pitch=null, aim=4, cursor=0, phase='pick';
    const draw=extra=> drawPitcherView(ctx, Object.assign({ batter:batC, grid:true,
      aim:(phase==='gauge'||phase==='throw')?aim:undefined, cursor:phase==='aim'?cursor:undefined }, extra||{}));
    function pick(){ phase='pick'; draw();
      below.innerHTML=`<div class="kbo-note">${KBO_TEAMS[G.home].name} 타석 — 구종 선택</div>
        <div class="kbo-pbtns">${KBO_PITCHES.map(p=>`<button data-k="${p.key}">${p.name}</button>`).join('')}</div>`;
      below.querySelectorAll('button').forEach(b=>b.onclick=()=>{ pitch=KBO_PITCHES.find(x=>x.key===b.dataset.k); aimPhase(); }); }
    // 조준: 방향키 없이 존을 손으로 직접 눌러 코스를 고른다
    function aimPhase(){ phase='aim'; cursor=4; stopAnim(); draw();
      below.innerHTML=`<div class="kbo-note">${pitch.name} — 던질 코스를 존에서 직접 누르고 '결정'</div>
        <div class="kbo-btns"><button id="aimBtn" class="prime">결정</button></div>`;
      cv.onclick=e=>{ if(phase!=='aim') return;                       // 캔버스 좌표 → 월드 좌표 → 존 칸
        const r=cv.getBoundingClientRect();
        const wx=(e.clientX-r.left)*(CW/r.width)/ZOOM + VX, wy=(e.clientY-r.top)*(CH/r.height)/ZOOM;
        const gx=Math.floor((wx-ZGX)/ZC), gy=Math.floor((wy-ZGY)/ZC);
        if(gx<0||gx>2||gy<0||gy>2) return;
        cursor=gy*3+gx; draw(); };
      below.querySelector('#aimBtn').onclick=()=>{ if(phase!=='aim')return; stopAnim(); cv.onclick=null; aim=cursor; gaugePhase(); }; }
    function gaugePhase(){ phase='gauge'; draw();
      below.innerHTML=`<div class="kbo-note">가운데일수록 겨냥한 코스로! '던지기'</div>
        <div class="kbo-meter"><div class="kbo-marker" id="gm"></div></div>
        <div class="kbo-btns"><button id="thr" class="prime">⚾ 던지기</button></div>`;
      const gm=below.querySelector('#gm'); let pos=0,dir=1;
      (function loop(){ if(phase!=='gauge')return; pos+=dir*2.6; if(pos>=100){pos=100;dir=-1;}else if(pos<=0){pos=0;dir=1;} gm.style.left=pos+'%'; G.raf=requestAnimationFrame(loop); })();
      below.querySelector('#thr').onclick=()=>{ if(phase!=='gauge')return; stopAnim(); throwIt(1-Math.abs(pos-50)/50); }; }
    function throwIt(acc){ phase='throw';
      below.innerHTML=`<div class="kbo-note">${pitch.name} 투구!</div>`;
      let cell=aim, inZone=true;
      if(Math.random() > acc*0.8+0.15){ cell=Math.random()*9|0; if(Math.random()>acc) inZone=Math.random()<0.5; }
      const tgt = inZone ? cellXY(cell) : { x: cellXY(cell).x+(Math.random()<.5?-24:24), y: cellXY(cell).y+(Math.random()<.5?-6:14) };
      let res = cpuBat(pitch.key, inZone, cell);
      if (res==='out') res = fieldedOut(Math.random()<0.35 ? 4 : 2);       // 범타도 뜬공·땅볼·직선타로 갈린다
      else if (HITNAME[res] && Math.random() < FIELD_OUT[res]*0.5) res = fieldedOut(3);  // CPU 안타성도 가끔 잡힘
      const swing = (res!=='ball'&&res!=='strike') || (res==='strike'&&Math.random()<0.55);
      const sx=SW/2, sy=SH-24; let p=0;
      (function fr(){ p+=0.030;
        // 멀어지는 공: 손을 떠날 땐 빠르고 크게, 타석에 닿을수록 느리고 작게(원근)
        const e=1-Math.pow(1-Math.min(1,p),1.9), q=Math.pow(1-Math.min(1,p),1.5);
        const x=sx+(tgt.x-sx)*e, y=sy+(tgt.y-sy)*e, r=2+4.6*q;
        drawPitcherView(ctx,{batter:batC,grid:true,aim:inZone?cell:undefined,ball:{x,y,r},swing: swing&&p>0.72?Math.min(1,(p-0.72)/0.28):0});
        if(p<1){ G.raf=requestAnimationFrame(fr);} else { stopAnim();
          if(res!=='ball' && res!=='strike') hitAnim(ctx,res,batC,()=>outcome(res));   // 파울·범타도 타구를 보여준다
          else setTimeout(()=>outcome(res),550); } })(); }
    pick();
  }
  const gb = () => document.getElementById('gameBack');
  function showQuit(){
    if (el.querySelector('.kbo-quit')) return;
    stopAnim(); killKeys();
    const ov=document.createElement('div'); ov.className='kbo-quit';
    ov.innerHTML=`<div class="kbo-quit-box"><p>게임을 종료하시겠습니까?</p>
      <div class="kbo-quit-btns"><button id="qYes" class="prime">네</button><button id="qNo">아니오</button></div></div>`;
    el.appendChild(ov);
    ov.querySelector('#qYes').onclick=()=>{ ov.remove(); selectScreen(); };
    ov.querySelector('#qNo').onclick=()=>{ ov.remove(); render(); };
  }
  function render(){
    stopAnim(); killKeys();
    if (gb()) gb().onclick = G.over ? (()=>showView('hub')) : (()=>showQuit());
    if (G.over){
      el.innerHTML = `<div class="mg kbo">${scoreboard()}
        <div class="kbo-final">${G.rA>G.rH?'🎉 승리!':G.rA<G.rH?'😢 패배':'🤝 무승부'}<br>
          ${escapeHtml(KBO_TEAMS[G.away].name)} ${G.rA} : ${G.rH} ${escapeHtml(KBO_TEAMS[G.home].name)}</div>
        <button class="kbo-again" id="kboAgain">다시하기</button></div>`;
      el.querySelector('#kboAgain').onclick = selectScreen;
      return;
    }
    el.innerHTML = `<div class="mg kbo">${scoreboard()}
      <div class="kbo-msg">${escapeHtml(G.msg||'')}</div>
      <div class="kbo-action" id="kboAct"></div></div>`;
    const act = el.querySelector('#kboAct');
    if (battingIsUser()) batUI(act); else pitchUI(act);
  }
  function selectScreen(){
    stopAnim(); killKeys();
    if (gb()) gb().onclick = () => showView('hub');   // 팀선택 화면에선 뒤로가기=허브
    Object.assign(G, { away:0, home:1, inning:1, half:0, outs:0, b:0, s:0, bases:[false,false,false], rA:0, rH:0, over:false, msg:'', aimCell:4 });
    el.innerHTML = `<div class="mg kbo kbo-select">
      <div class="kbo-banner"><div class="kbo-msg">응원할 팀을 골라요 (선공·원정)</div></div>
      <div class="kbo-teamsel">${KBO_TEAMS.map((t,i)=>
        `<button data-i="${i}" style="--tc:${t.c1};--tc2:${t.c2}"><span class="kbo-cap"></span>${escapeHtml(t.name)}</button>`).join('')}</div>
      <div class="kbo-note">3볼 2스트라이크·3아웃 · 1회초~9회말<br>타격은 9분할 존 조준(오른쪽 키)+스윙(왼쪽 키), 수비는 구종 선택</div>
    </div>`;
    el.querySelectorAll('.kbo-teamsel button').forEach(b=> b.onclick=()=>{
      G.away=+b.dataset.i;
      do { G.home=Math.floor(Math.random()*KBO_TEAMS.length); } while (G.home===G.away);
      G.msg=`플레이볼! 1회초 — ${KBO_TEAMS[G.away].name} 공격`;
      render();
    });
  }
  selectScreen();
}
// ══════════════════════════ 🎯 양궁 ══════════════════════════
function startArchery(el){
  const SW=300, SH=300, cx=150, cy=150, R=132;
  const OPP=[
    {n:'일본',f:'🇯🇵',player:'나카무라',city:'도쿄',age:32,team:'국가대표'},
    {n:'스페인',f:'🇪🇸',player:'토레스',city:'바르셀로나',age:28,team:'국가대표'},
    {n:'호주',f:'🇦🇺',player:'피어런',city:'멜버른',age:29,team:'국가대표'},
    {n:'프랑스',f:'🇫🇷',player:'뚜레',city:'마르세유',age:35,team:'국가대표'},
    {n:'우크라이나',f:'🇺🇦',player:'세브첸코',city:'키이우',age:21,team:'국가대표'},
    {n:'핀란드',f:'🇫🇮',player:'소피아',city:'헬싱키',age:48,team:'국가대표'},
    {n:'러시아',f:'🇷🇺',player:'알렉세이',city:'블라디보스톡',age:19,team:'국가대표'},
    {n:'중국',f:'🇨🇳',player:'자오즈밍',city:'상하이',age:29,team:'국가대표'},
    {n:'이탈리아',f:'🇮🇹',player:'크리스토퍼',city:'쏘렌토',age:31,team:'국가대표'},
    {n:'미국',f:'🇺🇸',player:'제임스',city:'애틀란타',age:22,team:'국가대표'},
  ];
  const ME={ '준영':{city:'마산',age:44,team:'국가대표'},
             '승호':{city:'청주',age:12,team:'청소년대표'},
             '승아':{city:'이천',age:7,team:'어린이대표'} };
  const u=getCurrentUser(); let uname=(u&&u.name)?u.name:'선수';
  for(const g of Object.keys(ME)){ if(uname.endsWith(g)){ uname=g; break; } }   // 성 제거 → 준영/승호/승아
  const me = ME[uname] || {city:'서울', age:'-', team:'국가대표'};

  const G={ level:1, arrow:0, userScores:[], userMarks:[], cpuScores:[], cpuMarks:[],
            phase:'ready', reticle:null, aiming:false, over:false, msg:'', raf:null, cpuTimer:null,
            holdStart:0, startPos:null, wx:null, wy:null, ctx:null, cv:null };

  const clamp = v => Math.max(8, Math.min(SW-8, v));
  const sum = a => a.reduce((x,y)=>x+y,0);
  const scoreAt = (x,y)=>{ const d=Math.hypot(x-cx,y-cy); if(d>R) return 0; return Math.max(0,10-Math.floor(d/(R/10))); };
  const stopAnim = ()=>{ if(G.raf){ cancelAnimationFrame(G.raf); G.raf=null; } if(G.cpuTimer){ clearInterval(G.cpuTimer); G.cpuTimer=null; } };
  function gauss(){ const u1=Math.random()||1e-9, u2=Math.random(); return Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2); }
  function cpuArrow(level){ let sd=R*(0.52-level*0.043); sd=Math.max(R*0.045,sd);
    const x=cx+gauss()*sd, y=cy+gauss()*sd; return { x, y, s:scoreAt(x,y) }; }

  // ── 그리기 ──
  const ringColor = s => s>=9?'#f6d21a' : s>=7?'#e23b3b' : s>=5?'#2b6fd6' : s>=3?'#151b26' : '#eef2f7';
  function drawHit(c,x,y,col,isUser){ c.save(); c.beginPath(); c.arc(x,y,4.3,0,7); c.fillStyle=col; c.fill();
    c.lineWidth=1.6; c.strokeStyle=isUser?'#fff':'#374151'; c.stroke(); c.restore(); }
  function drawReticle(c,x,y){ c.save(); c.strokeStyle='rgba(34,211,238,.95)'; c.lineWidth=2;
    c.beginPath(); c.arc(x,y,13,0,7); c.stroke(); c.beginPath(); c.arc(x,y,4,0,7); c.stroke();
    c.beginPath(); c.moveTo(x-18,y); c.lineTo(x-6,y); c.moveTo(x+6,y); c.lineTo(x+18,y);
    c.moveTo(x,y-18); c.lineTo(x,y-6); c.moveTo(x,y+6); c.lineTo(x,y+18); c.stroke();
    c.fillStyle='rgba(34,211,238,.95)'; c.beginPath(); c.arc(x,y,1.6,0,7); c.fill(); c.restore(); }
  function drawScene(){ const c=G.ctx; if(!c) return;
    c.fillStyle='#0f1630'; c.fillRect(0,0,SW,SH);
    for(let s=1;s<=10;s++){ const rad=(11-s)/10*R; c.beginPath(); c.arc(cx,cy,rad,0,7); c.fillStyle=ringColor(s); c.fill(); }
    for(let s=1;s<=10;s++){ const rad=(11-s)/10*R; c.beginPath(); c.arc(cx,cy,rad,0,7);
      c.lineWidth=1; c.strokeStyle=(s>=3&&s<=4)?'rgba(255,255,255,.45)':'rgba(0,0,0,.28)'; c.stroke(); }
    c.strokeStyle='rgba(0,0,0,.55)'; c.lineWidth=1;                       // 중앙 X
    c.beginPath(); c.moveTo(cx-5,cy); c.lineTo(cx+5,cy); c.moveTo(cx,cy-5); c.lineTo(cx,cy+5); c.stroke();
    for(const m of G.cpuMarks) drawHit(c,clamp(m.x),clamp(m.y),'#c7ccd6',false);
    for(const m of G.userMarks) drawHit(c,m.x,m.y,'#16a34a',true);
    if(G.aiming && G.reticle) drawReticle(c,G.reticle.x,G.reticle.y);
  }

  // ── 조준(준비 꾹 누르기): 처음 5초 천천히 중앙으로, 이후 5초마다 빨라지며 상하좌우 랜덤 ──
  const AIM_BASE=2.05;                             // 기본 이동속도(레벨0) — 흔들림 세기 상향(난이도↑)
  const CENTER_FREQ=0.10;                          // 중앙으로 향하는 빈도(↑=쉬움)
  function beginAim(){ if(G.phase!=='ready'||G.over) return;
    G.holdStart=performance.now();
    const ang=Math.random()*Math.PI*2, rr=R*(0.5+Math.random()*0.42);   // 과녁 안 랜덤 위치에서 시작
    G.reticle={ x:clamp(cx+Math.cos(ang)*rr), y:clamp(cy+Math.sin(ang)*rr) };
    const a2=Math.random()*Math.PI*2; G.vx=Math.cos(a2)*AIM_BASE; G.vy=Math.sin(a2)*AIM_BASE;
    G.phase='aim'; G.aiming=true; setMsg('조준 중… 손을 떼면 발사 🏹');
    loop();
  }
  function loop(){ if(G.phase!=='aim'){ return; }
    if(G.cv && !document.body.contains(G.cv)){ stopAnim(); return; }   // 화면 이탈 시 정리
    const t=(performance.now()-G.holdStart)/1000;
    const level=Math.floor(t/5);                                       // 5초마다 단계 상승
    const spd=1+level*0.4;                                             // 속도 순차 가속(완화)
    const turn=1.65;                                                  // 방향 요동 세기 — 흔들림 상향
    G.vx+=(Math.random()-0.5)*turn; G.vy+=(Math.random()-0.5)*turn;    // 방향을 계속 요동 → 지그재그
    if(Math.random()<0.06) G.vx=-G.vx;                                 // 가끔 급반전(뒤죽박죽)
    if(Math.random()<0.06) G.vy=-G.vy;
    const mag=Math.hypot(G.vx,G.vy)||1;                                // 속도 크기는 일정(방향만 요동)
    G.vx=G.vx/mag*AIM_BASE; G.vy=G.vy/mag*AIM_BASE;
    if(Math.random()<CENTER_FREQ){                                     // 가끔 중앙 쪽으로 방향 전환(맞히기 쉽게)
      const a=Math.atan2(cy-G.reticle.y, cx-G.reticle.x);
      G.vx=Math.cos(a)*AIM_BASE; G.vy=Math.sin(a)*AIM_BASE; }
    let nx=G.reticle.x+G.vx*spd, ny=G.reticle.y+G.vy*spd;
    const Rlim=R*0.94, dx=nx-cx, dy=ny-cy, dd=Math.hypot(dx,dy)||1;    // 과녁 경계에서 반사
    if(dd>Rlim){ const nX=dx/dd, nY=dy/dd, dot=G.vx*nX+G.vy*nY;
      G.vx-=2*dot*nX; G.vy-=2*dot*nY; nx=cx+nX*Rlim; ny=cy+nY*Rlim; }
    G.reticle.x=clamp(nx); G.reticle.y=clamp(ny);
    drawScene(); G.raf=requestAnimationFrame(loop);
  }
  function endAim(){ if(G.phase!=='aim') return; stopAnim(); G.aiming=false; fire(G.reticle.x,G.reticle.y); }
  function fire(x,y){ const s=scoreAt(x,y);
    G.userMarks.push({ x:clamp(x), y:clamp(y), s }); G.userScores.push(s); G.arrow++;
    if(G.arrow>=5){ startCpu(); }
    else { G.phase='ready'; G.msg=`${s}점! 다음 화살(${G.arrow+1}/5) 준비`; render(); }
  }

  function startCpu(){ const opp=OPP[G.level-1];
    G.phase='cpu'; G.msg=`${opp.n} 사격 중…`; render();
    let i=0;
    G.cpuTimer=setInterval(()=>{
      if(i>=5){ stopAnim(); finishMatch(); return; }
      const m=cpuArrow(G.level); G.cpuMarks.push(m); G.cpuScores.push(m.s);
      setMsg(`${opp.n} ${i+1}번째 화살 · ${m.s}점`); drawScene(); i++;
    }, 430);
  }
  function finishMatch(){ const ut=sum(G.userScores), ct=sum(G.cpuScores), opp=OPP[G.level-1];
    let result = ut>ct ? 'win' : (ut<ct ? 'loss' : 'draw');
    G.result=result; G.over=(result==='win' && G.level>=10);
    recordStat('archery', result==='win' ? { result:'win', best:G.level } : { result });
    if(result==='win' && G.level>=10) G.msg=`🏆 ${ut} : ${ct}  세계 제패! 미국까지 꺾은 대한민국 국가대표!`;
    else if(result==='win') G.msg=`🎯 ${ut} : ${ct}  승리! ${opp.n} 격파 → 다음 상대 ${OPP[G.level].n}`;
    else if(result==='draw') G.msg=`${ut} : ${ct}  무승부 — 재경기`;
    else G.msg=`${ut} : ${ct}  아쉬운 패배 — ${opp.n}에게 재도전!`;
    G.phase='result'; render();
  }
  function archConfirm(msg, onYes){
    const ov=document.createElement('div'); ov.className='arch-modal';
    ov.innerHTML=`<div class="arch-modal-box"><p>${escapeHtml(msg)}</p>
      <div class="arch-modal-btns"><button class="am-no">아니오</button><button class="am-yes">예</button></div></div>`;
    document.body.appendChild(ov);
    const close=()=>ov.remove();
    ov.addEventListener('click',e=>{ if(e.target===ov) close(); });
    ov.querySelector('.am-no').onclick=close;
    ov.querySelector('.am-yes').onclick=()=>{ close(); onYes(); };
  }
  function newMatch(){ G.arrow=0; G.userScores=[]; G.userMarks=[]; G.cpuScores=[]; G.cpuMarks=[];
    G.phase='ready'; G.aiming=false; G.reticle=null; G.over=false;
    G.msg=`${G.level}단계 · ${OPP[G.level-1].n} 국가대표와 대결! 준비를 꾹 눌러 조준`; render(); }

  const setMsg = t => { const m=el.querySelector('.arch-msg'); if(m) m.textContent=t; };
  const profileCard = (flag, player, country, city, age, team, sub) => `<aside class="arch-profile">
      <div class="arch-flag">${flag}</div>
      <div class="arch-name">${escapeHtml(player)}</div>
      <dl>
        <div><dt>국가</dt><dd>${escapeHtml(country)}</dd></div>
        <div><dt>도시</dt><dd>${escapeHtml(city)}</dd></div>
        <div><dt>나이</dt><dd>${age}세</dd></div>
        <div><dt>소속</dt><dd>${escapeHtml(team)}</dd></div>
      </dl>
      <div class="arch-vs">${sub}</div>
    </aside>`;

  function render(){ const opp=OPP[G.level-1];
    const ut=sum(G.userScores), ct=sum(G.cpuScores);
    let controls;
    if(G.phase==='result'){
      if(G.over) controls=`<button class="arch-btn pri" data-a="restart">🏆 처음부터</button>`;
      else if(G.result==='win') controls=`<button class="arch-btn pri" data-a="next">다음 상대 →</button>`;
      else controls=`<button class="arch-btn" data-a="skip">다음 단계 ▶</button><button class="arch-btn pri" data-a="retry">재도전</button><button class="arch-btn" data-a="restart">처음부터</button>`;
    } else {
      const dis=G.phase==='cpu'?'disabled':'';
      controls=`<button class="arch-ready" ${dis}>${G.phase==='cpu'?'상대 사격 중…':'준비 (꾹 눌러 조준)'}</button>`;
    }
    el.innerHTML=`<div class="mg arch">
      <div class="arch-players">
        ${profileCard('🇰🇷', uname, '대한민국', me.city, me.age, me.team, 'HOME 🏹')}
        <div class="arch-vsbadge">VS</div>
        ${profileCard(opp.f, opp.player, opp.n, opp.city, opp.age, opp.team, `${G.level}단계 / 10`)}
      </div>
      <div class="arch-stage"><canvas class="arch-canvas" width="${SW}" height="${SH}"></canvas></div>
      <div class="arch-hud">
        <div class="arch-sc"><b>${escapeHtml(uname)}</b> ${ut} <span>vs</span> ${ct} <b>${escapeHtml(opp.n)}</b></div>
        <div class="arch-arrows">화살 ${G.arrow}/5${G.userScores.length?' · '+G.userScores.join(' '):''}</div>
        <div class="arch-msg">${escapeHtml(G.msg)}</div>
      </div>
      <div class="arch-controls">${controls}</div>
    </div>`;
    G.cv=el.querySelector('.arch-canvas'); G.ctx=G.cv?G.cv.getContext('2d'):null; drawScene();
    const btn=el.querySelector('.arch-ready');
    if(btn){
      btn.onpointerdown=e=>{ e.preventDefault(); if(G.phase!=='ready'||G.over) return;
        try{ btn.setPointerCapture(e.pointerId); }catch(_){} beginAim(); };
      btn.onpointerup=()=>{ if(G.phase==='aim') endAim(); };
      btn.onpointercancel=()=>{ if(G.phase==='aim') endAim(); };
      btn.oncontextmenu=e=>{ e.preventDefault(); return false; };   // 길게 눌러도 인쇄/공유 메뉴 안 뜨게
      btn.ondragstart=e=>e.preventDefault();
    }
    const acv=el.querySelector('.arch-canvas');
    if(acv) acv.oncontextmenu=e=>{ e.preventDefault(); return false; };
    el.querySelectorAll('.arch-controls .arch-btn').forEach(b=> b.onclick=()=>{
      const a=b.dataset.a;
      if(a==='restart'){ archConfirm('정말 처음부터 하시겠습니까?', ()=>{ G.level=1; newMatch(); }); return; }
      if(a==='next'||a==='skip') G.level=Math.min(10,G.level+1);   // skip=이번 판 건너뛰고 다음 단계
      newMatch();
    });
  }

  newMatch();
}

// ══════════════════════════ 🎱 포켓볼 ══════════════════════════
// 6포켓 테이블 · 공 16개(색공7·줄공7·검은8번 + 흰 큐볼) = 실제 규격.
// 진행: 조준(점선으로 방향 조절) → 파워(게이지가 최저↔최고 왕복) → 발사 → 공이 다 멈추면 다음 샷.
// 물리: 등질량 탄성충돌 + 구름마찰 + 쿠션 반발. 프레임당 서브스텝으로 통과(터널링) 방지.
// 규칙: 색공·줄공 14개를 먼저 모두 넣고 마지막에 8번(검은공) → 클리어. 8번을 먼저 넣으면 패배.
//       흰공이 빠지면(스크래치) 헤드스팟 복귀 + 벌타 1.
// TODO(다음 단계): 양궁처럼 컴퓨터와 번갈아 치는 대전 모드(색공/줄공 그룹 배정, CPU 조준 정확도 = 난이도).
function startPocket(el){
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => showView('hub');
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">모드를 골라요 🎱</div>
    <div class="omok-levels">
      <button data-m="solo">연습<small>혼자 최소타 도전 · 기록 저장</small></button>
      <button data-m="two">대결 · 2인<small>한 기기에서 번갈아 치기 · 많이 넣는 사람 승</small></button>
    </div>
  </div>`;
  el.querySelectorAll('.omok-levels button').forEach(b => b.onclick = () => pickFormation(el, b.dataset.m));
}
// 모드 선택 뒤: 시작 전에 공 배치(랙 형태)를 고른다
function pickFormation(el, mode){
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">공 배치를 골라요 🎱</div>
    <div class="omok-levels pk-forms">
      <button data-f="triangle">▲ 삼각형<small>기본 15구 랙</small></button>
      <button data-f="diamond">◆ 다이아몬드<small>마름모꼴</small></button>
      <button data-f="ring">◎ 원형<small>가운데 8번 · 링 배치</small></button>
      <button data-f="grid">▦ 격자<small>5×3 바둑판</small></button>
      <button data-f="random">✦ 무작위<small>매판 다르게 흩뿌림</small></button>
    </div>
    <button class="btn ghost pk-backmode" id="pkBackMode">◀ 모드 다시 고르기</button>
  </div>`;
  el.querySelectorAll('.pk-forms button').forEach(b => b.onclick = () => runPocket(el, { mode, formation: b.dataset.f }));
  const bk = el.querySelector('#pkBackMode'); if(bk) bk.onclick = () => startPocket(el);
}
function runPocket(el, cfg){
  const two = cfg.mode === 'two';         // 2인 핫시트 대결
  const FORMATION = cfg.formation || 'triangle';   // 공 배치 형태
  const who = i => `${i + 1}P`;
  const W = 320, H = 568;                 // 캔버스 크기(세로형 테이블)
  const CU = 15;                          // 쿠션(레일) 두께
  const L = CU, T = CU, RT = W - CU, BT = H - CU;   // 플레이 영역 경계
  const R = 8.6;                          // 공 반지름
  const AIM_CONE = 0.6;                   // 쿠션에 닿을 때 이 정도로 포켓을 향하고 있으면 빨려든다(cos)
  const SUB = 8;                          // 프레임당 물리 서브스텝(최고 속도에서도 공을 통과하지 않게)
  const DECEL = 0.067;                    // 구름 마찰(프레임당 등감속) — 세게 칠수록 멀리(거리 ∝ 속도²)
  const STOP = 0.05;                      // 정지 임계 속도
  const CUSH_E = 0.72, BALL_E = 0.95;     // 쿠션/공 반발계수
  const PMIN = 3.2, PMAX = 21;            // 발사 속도(px/프레임) — 최대 파워면 브레이크로 랙이 확 흩어진다
  const PSPD = 0.022;                     // 파워 게이지 왕복 속도(프레임당)
  // 실제 당구공 색: 1·9=노랑, 2·10=파랑, 3·11=빨강, 4·12=보라, 5·13=주황, 6·14=초록, 7·15=밤색
  const HUES = ['#f5c518','#2563eb','#dc2626','#7c3aed','#ea580c','#15803d','#7f1d1d'];
  const SOLIDS  = HUES.map((c,i)=>({ n:i+1, c }));   // 색공 1~7
  const STRIPES = HUES.map((c,i)=>({ n:i+9, c }));   // 줄공 9~15
  // r=그리기 반지름 · grab=가만히 있어도 빨려드는 거리 · reach=쿠션에서 포켓으로 인정하는 자키 범위
  const POCKETS = [
    { x:L,     y:T,   r:15, grab:12, reach:42 },  { x:RT,     y:T,   r:15, grab:12, reach:42 },
    { x:L-4,   y:H/2, r:13, grab:11, reach:20 },  { x:RT+4,   y:H/2, r:13, grab:11, reach:20 },
    { x:L,     y:BT,  r:15, grab:12, reach:42 },  { x:RT,     y:BT,  r:15, grab:12, reach:42 },
  ];
  const CUE_SPOT = { x: W/2, y: T + (BT-T)*0.80 };

  const G = { balls:[], phase:'aim', angle:-Math.PI/2, power:0, pdir:1, shots:0,
              turn:0, score:[0,0], evt:null, over:false, raf:null };
  let cv, ctx, $shots, $left, $msg, $fill, $act, $cancel, $tip, $s0, $s1, $hud;
  function updateHud(){
    if(two){
      if($s0) $s0.textContent = G.score[0];
      if($s1) $s1.textContent = G.score[1];
      if($hud){ $hud.classList.toggle('t0', G.turn===0); $hud.classList.toggle('t1', G.turn===1); }
    } else if($shots){ $shots.textContent = G.shots; }
    if($left) $left.textContent = ballsLeft();
  }

  // ── 선택한 형태(FORMATION)대로 15개 슬롯을 만든다 ──
  function makeSlots(formation){
    const d = 2*R + 1;                                  // 공 간격(살짝 띄움)
    const cx = W/2, topY = T + (BT-T)*0.13;
    const put = counts => { const s=[]; counts.forEach((c,i)=>{ for(let k=0;k<c;k++) s.push({ x: cx+(k-(c-1)/2)*d, y: topY + i*d*0.9 }); }); return s; };
    if(formation==='diamond') return put([1,2,3,4,3,2]);          // ◆ 15
    if(formation==='grid'){                                       // ▦ 5×3
      const cols=5, rows=3, gx=d, gy=d*0.95, ox=cx-(cols-1)/2*gx, s=[];
      for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) s.push({ x: ox+c*gx, y: topY + r*gy });
      return s;
    }
    if(formation==='ring'){                                       // ◎ 가운데1 + 안6 + 밖8
      const cy = topY + d*2.4, s=[{ x:cx, y:cy }];
      const ring=(n,rr,ph)=>{ for(let i=0;i<n;i++){ const a=ph+i/n*Math.PI*2; s.push({ x:cx+Math.cos(a)*rr, y:cy+Math.sin(a)*rr }); } };
      ring(6, d*1.28, -Math.PI/2); ring(8, d*2.5, -Math.PI/2);
      return s;
    }
    if(formation==='random'){                                     // ✦ 겹치지 않게 흩뿌리기
      const s=[], y0=topY, y1=topY+(BT-T)*0.30; let guard=0;
      while(s.length<15 && guard++<5000){
        const x = L+R+2 + Math.random()*(RT-L-2*R-4), y = y0 + Math.random()*(y1-y0);
        if(s.every(p => Math.hypot(p.x-x, p.y-y) >= 2*R+1.5)) s.push({ x, y });
      }
      return s;
    }
    return put([1,2,3,4,5]);                                      // ▲ 삼각형(기본) 15
  }
  // ── 초기 배치: 8번은 무게중심(가운데), 나머지는 색공7·줄공7을 무작위로 ──
  function rack(){
    const slots = makeSlots(FORMATION);
    const mx = slots.reduce((a,p)=>a+p.x,0)/slots.length, my = slots.reduce((a,p)=>a+p.y,0)/slots.length;
    let ei=0, ed=Infinity;
    slots.forEach((p,i)=>{ const dd=Math.hypot(p.x-mx, p.y-my); if(dd<ed){ ed=dd; ei=i; } });   // 중심에 가장 가까운 슬롯 = 8번
    const rest = shuffle(SOLIDS.map(s=>({...s,type:'solid'})).concat(STRIPES.map(s=>({...s,type:'stripe'}))));
    const balls = [{ x:CUE_SPOT.x, y:CUE_SPOT.y, vx:0, vy:0, n:0, c:'#f8fafc', type:'cue', in:false }];
    let ri = 0;
    slots.forEach((p,i)=>{
      const spec = (i===ei) ? { n:8, c:'#18181b', type:'eight' } : rest[ri++];
      balls.push({ x: p.x + (Math.random()-0.5)*0.5, y: p.y + (Math.random()-0.5)*0.5,
                   vx:0, vy:0, n:spec.n, c:spec.c, type:spec.type, in:false });
    });
    G.balls = balls;
  }
  function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
  const cue = () => G.balls[0];
  const objLeft = () => G.balls.filter(b => !b.in && (b.type==='solid'||b.type==='stripe')).length;   // 8번 제외(규칙용)
  const ballsLeft = () => G.balls.filter(b => !b.in && b.type!=='cue').length;                        // 8번 포함(표시용)
  const alive = () => !!(cv && document.body.contains(cv));

  // ── 물리 ──────────────────────────────────────────
  function pocketBall(b){
    b.in = true; b.vx = b.vy = 0;
    if(b.type==='cue') G.evt.cueIn = true;
    else if(b.type==='eight') G.evt.eightIn = true;
    else G.evt.potted.push(b);
  }
  function tryPocket(b){
    const sp = Math.hypot(b.vx, b.vy); if(sp <= 0) return false;
    for(const p of POCKETS){
      const dx = p.x-b.x, dy = p.y-b.y, d = Math.hypot(dx,dy);
      if(d > p.reach || d <= 0) continue;
      if((b.vx*dx + b.vy*dy)/(sp*d) < AIM_CONE) continue;
      pocketBall(b); return true;
    }
    return false;
  }
  function step(){
    for(let s=0;s<SUB;s++){
      for(const b of G.balls){
        if(b.in || (!b.vx && !b.vy)) continue;
        b.x += b.vx/SUB; b.y += b.vy/SUB;
        const sp = Math.hypot(b.vx, b.vy);                    // 등감속: 방향은 유지하고 속력만 일정하게 깎는다
        if(sp > 0){ const ns = Math.max(0, sp - DECEL/SUB); b.vx = b.vx/sp*ns; b.vy = b.vy/sp*ns; }
        let sunk = false;
        for(const p of POCKETS){ if(Math.hypot(b.x-p.x, b.y-p.y) < p.grab){ pocketBall(b); sunk = true; break; } }
        if(sunk) continue;
        // 쿠션: 닿는 순간 포켓 자키 안이고 포켓 쪽으로 굴러가는 중이면 들어가고, 아니면 튕긴다
        if(b.x-R < L || b.x+R > RT){
          if(tryPocket(b)) continue;
          if(b.x-R < L){ b.x = L+R; b.vx = -b.vx*CUSH_E; b.vy *= 0.985; }
          else { b.x = RT-R; b.vx = -b.vx*CUSH_E; b.vy *= 0.985; }
        }
        if(b.y-R < T || b.y+R > BT){
          if(tryPocket(b)) continue;
          if(b.y-R < T){ b.y = T+R; b.vy = -b.vy*CUSH_E; b.vx *= 0.985; }
          else { b.y = BT-R; b.vy = -b.vy*CUSH_E; b.vx *= 0.985; }
        }
        // 틈으로 빠져나가더라도 캔버스 밖으로는 못 나가게(안전망)
        if(b.x < R*0.6){ b.x = R*0.6; b.vx = Math.abs(b.vx)*0.4; }
        else if(b.x > W-R*0.6){ b.x = W-R*0.6; b.vx = -Math.abs(b.vx)*0.4; }
        if(b.y < R*0.6){ b.y = R*0.6; b.vy = Math.abs(b.vy)*0.4; }
        else if(b.y > H-R*0.6){ b.y = H-R*0.6; b.vy = -Math.abs(b.vy)*0.4; }
      }
      // 공끼리 충돌(등질량 탄성) — 법선 방향 운동량 교환 + 겹침 보정
      for(let i=0;i<G.balls.length;i++){
        const a = G.balls[i]; if(a.in) continue;
        for(let j=i+1;j<G.balls.length;j++){
          const b = G.balls[j]; if(b.in) continue;
          const dx = b.x-a.x, dy = b.y-a.y, d = Math.hypot(dx,dy);
          if(d <= 0 || d >= 2*R) continue;
          const nx = dx/d, ny = dy/d;
          const ov = (2*R - d)/2;
          a.x -= nx*ov; a.y -= ny*ov; b.x += nx*ov; b.y += ny*ov;
          const rel = (b.vx-a.vx)*nx + (b.vy-a.vy)*ny;
          if(rel >= 0) continue;
          const imp = -(1+BALL_E)*rel/2;
          a.vx -= imp*nx; a.vy -= imp*ny; b.vx += imp*nx; b.vy += imp*ny;
          if(!G.evt.firstHit && (a.type==='cue' || b.type==='cue')) G.evt.firstHit = a.type==='cue' ? b : a;
        }
      }
      for(const b of G.balls){ if(!b.in && Math.hypot(b.vx,b.vy) < STOP){ b.vx = 0; b.vy = 0; } }
    }
  }
  const moving = () => G.balls.some(b => !b.in && (b.vx || b.vy));

  // ── 조준 예측(점선이 닿는 지점 + 목적구 진행 방향) ──
  function predict(){
    const c = cue(), dx = Math.cos(G.angle), dy = Math.sin(G.angle);
    let bestT = Infinity, target = null;
    for(const b of G.balls){
      if(b.in || b === c) continue;
      const ex = b.x-c.x, ey = b.y-c.y, t = ex*dx + ey*dy;
      if(t <= 0) continue;
      const perp2 = ex*ex + ey*ey - t*t, rr = (2*R)*(2*R);
      if(perp2 > rr) continue;
      const th = t - Math.sqrt(rr - perp2);
      if(th > 0 && th < bestT){ bestT = th; target = b; }
    }
    let wallT = Infinity;
    if(dx > 0) wallT = Math.min(wallT, (RT-R-c.x)/dx); else if(dx < 0) wallT = Math.min(wallT, (L+R-c.x)/dx);
    if(dy > 0) wallT = Math.min(wallT, (BT-R-c.y)/dy); else if(dy < 0) wallT = Math.min(wallT, (T+R-c.y)/dy);
    if(!target || wallT < bestT) return { x: c.x+dx*Math.max(0,wallT), y: c.y+dy*Math.max(0,wallT), target:null };
    return { x: c.x+dx*bestT, y: c.y+dy*bestT, target };
  }

  // ── 그리기 ────────────────────────────────────────
  function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  function drawTable(){
    ctx.fillStyle = '#3f2513'; roundRect(0,0,W,H,16); ctx.fill();                    // 나무 프레임
    ctx.fillStyle = '#14532d'; roundRect(4,4,W-8,H-8,12); ctx.fill();                // 레일
    const fg = ctx.createLinearGradient(0,T,0,BT);
    fg.addColorStop(0,'#15803d'); fg.addColorStop(0.5,'#177f45'); fg.addColorStop(1,'#136136');
    ctx.fillStyle = fg; ctx.fillRect(L,T,RT-L,BT-T);                                  // 천(felt)
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.strokeRect(L,T,RT-L,BT-T);
    ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.lineWidth = 1;                     // 헤드 스트링
    ctx.beginPath(); ctx.moveTo(L, CUE_SPOT.y); ctx.lineTo(RT, CUE_SPOT.y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.45)';                                          // 레일 다이아몬드
    for(let i=1;i<=3;i++){ const y = T + (BT-T)*i/4;
      if(i!==2){ ctx.beginPath(); ctx.arc(CU/2,y,1.6,0,7); ctx.fill(); ctx.beginPath(); ctx.arc(W-CU/2,y,1.6,0,7); ctx.fill(); } }
    for(let i=1;i<=3;i++){ const x = L + (RT-L)*i/4;
      ctx.beginPath(); ctx.arc(x,CU/2,1.6,0,7); ctx.fill(); ctx.beginPath(); ctx.arc(x,H-CU/2,1.6,0,7); ctx.fill(); }
    for(const p of POCKETS){                                                          // 포켓
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,7); ctx.fillStyle = '#0a0a0a'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(212,175,55,.55)'; ctx.stroke();
    }
  }
  function drawBall(b){
    ctx.beginPath(); ctx.ellipse(b.x+1.6, b.y+2.4, R*0.95, R*0.8, 0, 0, 7);           // 그림자
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(b.x,b.y,R,0,7); ctx.clip();
    ctx.fillStyle = (b.type==='solid') ? b.c : (b.type==='eight' ? '#18181b' : '#f8fafc');
    ctx.fillRect(b.x-R, b.y-R, 2*R, 2*R);
    if(b.type==='stripe'){ ctx.fillStyle = b.c; ctx.fillRect(b.x-R, b.y-R*0.56, 2*R, R*1.12); }
    if(b.type!=='cue'){
      ctx.beginPath(); ctx.arc(b.x,b.y,R*0.47,0,7); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.fillStyle = '#111827'; ctx.font = `bold ${Math.round(R*0.76)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(b.n), b.x, b.y+0.4);
    }
    const g = ctx.createRadialGradient(b.x-R*0.4, b.y-R*0.45, R*0.05, b.x-R*0.1, b.y-R*0.1, R*1.3);
    g.addColorStop(0,'rgba(255,255,255,.55)'); g.addColorStop(0.38,'rgba(255,255,255,.05)'); g.addColorStop(1,'rgba(0,0,0,.42)');
    ctx.fillStyle = g; ctx.fillRect(b.x-R, b.y-R, 2*R, 2*R);
    ctx.restore();
    ctx.beginPath(); ctx.arc(b.x,b.y,R,0,7); ctx.lineWidth = 0.9; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.stroke();
  }
  function drawAim(){
    const c = cue(); if(c.in) return;
    const p = predict(), dx = Math.cos(G.angle), dy = Math.sin(G.angle);
    ctx.save();
    ctx.setLineDash([6,6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.moveTo(c.x+dx*R, c.y+dy*R); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7);                                      // 고스트 볼(충돌 시점 흰공 위치)
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.4; ctx.stroke();
    if(p.target){                                                                     // 목적구가 튀어나갈 방향
      const ox = p.target.x-p.x, oy = p.target.y-p.y, od = Math.hypot(ox,oy) || 1;
      ctx.beginPath(); ctx.moveTo(p.target.x, p.target.y);
      ctx.lineTo(p.target.x + ox/od*34, p.target.y + oy/od*34);
      ctx.strokeStyle = 'rgba(253,224,71,.9)'; ctx.lineWidth = 2; ctx.stroke();
    }
    const pull = 8 + (G.phase==='power' ? G.power*26 : 0);                            // 큐대(파워만큼 뒤로 당겨짐)
    const bx = c.x - dx*(R+pull), by = c.y - dy*(R+pull);
    const tx = c.x - dx*(R+pull+96), ty = c.y - dy*(R+pull+96);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(tx,ty); ctx.lineWidth = 4.4; ctx.strokeStyle = '#c8873f'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(bx-dx*10, by-dy*10); ctx.lineWidth = 4.4; ctx.strokeStyle = '#e0f2fe'; ctx.stroke();
    ctx.restore();
  }
  function draw(){
    drawTable();
    for(const b of G.balls) if(!b.in) drawBall(b);
    if((G.phase==='aim' || G.phase==='power') && !G.over) drawAim();
  }

  // ── 루프 ──────────────────────────────────────────
  function loop(){
    if(!alive()){ if(G.raf) cancelAnimationFrame(G.raf); G.raf = null; return; }
    if(G.phase==='power'){
      G.power += G.pdir*PSPD;
      if(G.power >= 1){ G.power = 1; G.pdir = -1; }
      else if(G.power <= 0){ G.power = 0; G.pdir = 1; }
      $fill.style.width = Math.round(G.power*100) + '%';
    } else if(G.phase==='roll'){
      step();
      if(!moving()) endShot();
    }
    draw();
    G.raf = requestAnimationFrame(loop);
  }

  // ── 샷 처리 ───────────────────────────────────────
  function shoot(){
    const c = cue(), sp = PMIN + (PMAX-PMIN)*G.power;
    c.vx = Math.cos(G.angle)*sp; c.vy = Math.sin(G.angle)*sp;
    G.shots++; if($shots) $shots.textContent = G.shots;
    G.evt = { cueIn:false, eightIn:false, potted:[], firstHit:null };
    setPhase('roll');
  }
  function respotCue(){
    const c = cue();
    c.in = false; c.vx = c.vy = 0; c.x = CUE_SPOT.x; c.y = CUE_SPOT.y;
    for(let k=0;k<60;k++){                                        // 겹치면 아래로 조금씩 밀어 빈자리 찾기
      const hit = G.balls.some(b => b!==c && !b.in && Math.hypot(b.x-c.x, b.y-c.y) < 2*R+1);
      if(!hit) break;
      c.y = Math.min(BT-R-1, c.y + 3);
      if(c.y >= BT-R-1){ c.x = Math.max(L+R+1, c.x - 7); c.y = CUE_SPOT.y; }
    }
  }
  function endShot(){
    if(two){ resolveTwo(G.evt); return; }
    const e = G.evt, left = objLeft();
    if(e.eightIn){
      if(left === 0 && !e.cueIn) finish(true);
      else finish(false, e.cueIn ? '8번과 흰공을 함께 넣었어요 — 실패!' : '색공·줄공이 남았는데 8번을 넣었어요 — 실패!');
      return;
    }
    let msg;
    if(e.cueIn){ respotCue(); G.shots++; $shots.textContent = G.shots; msg = '스크래치! 흰공 복귀 · 벌타 +1'; }
    else if(!e.firstHit) msg = '헛샷! 아무 공도 못 맞혔어요';
    else if(e.potted.length) msg = `${e.potted.length}개 포켓 성공! 👍`;
    else msg = '아쉽다 — 다음 샷!';
    if(left === 0) msg = (e.cueIn ? '스크래치(벌타 +1) — ' : '') + '이제 검은 8번을 넣으면 클리어! 🎱';
    $left.textContent = ballsLeft();
    setPhase('aim', msg);
  }
  // ── 2인 대결: 넣으면 계속·못 넣으면 차례 넘김. 스크래치는 흰공 복귀 + 차례 넘김. 넣은 공만큼 득점(공 15개=홀수 → 무승부 없음) ──
  function resolveTwo(e){
    const potted = e.potted.length + (e.eightIn ? 1 : 0);
    if(potted > 0) G.score[G.turn] += potted;
    let pass, msg;
    if(e.cueIn){ respotCue(); pass = true; msg = `스크래치! ${potted ? `+${potted}점 · ` : ''}흰공 복귀 — ${who(1-G.turn)} 차례`; }
    else if(potted > 0){ pass = false; msg = `${who(G.turn)} +${potted}점! 한 번 더 🎯`; }
    else { pass = true; msg = `${e.firstHit ? '아쉽다' : '헛샷'} — ${who(1-G.turn)} 차례`; }
    if(pass) G.turn = 1 - G.turn;
    updateHud();
    if(ballsLeft() === 0){ finishTwo(); return; }
    setPhase('aim', msg);
  }
  function finishTwo(){
    G.over = true;
    const a = G.score[0], b = G.score[1];
    const title = a === b ? '무승부!' : `🎉 ${who(a > b ? 0 : 1)} 승리!`;
    $msg.innerHTML = `${title}<br><b>${a} : ${b}</b><br><button class="btn primary" id="pkAgain">다시하기</button>`;
    $msg.classList.remove('hidden'); setPhase('over');
    const ag = el.querySelector('#pkAgain'); if(ag) ag.onclick = newGame;
  }
  function finish(win, why){
    G.over = true;
    if(win){
      recordStat('pocket', { result:'win', best:G.shots });
      $msg.innerHTML = `🎉 클리어!<br><b>${G.shots}타</b><br><button class="btn primary" id="pkAgain">다시하기</button>`;
    } else {
      recordStat('pocket', { result:'loss' });
      $msg.innerHTML = `게임 오버<br><span class="pk-why">${escapeHtml(why)}</span><br><button class="btn primary" id="pkAgain">다시하기</button>`;
    }
    $msg.classList.remove('hidden');
    setPhase('over');
    const a = el.querySelector('#pkAgain'); if(a) a.onclick = newGame;
  }

  // ── 화면/조작 상태 ────────────────────────────────
  function setPhase(p, msg){
    G.phase = p;
    if(p !== 'power'){ G.power = 0; G.pdir = 1; if($fill) $fill.style.width = '0%'; }
    $act.disabled = (p === 'roll' || p === 'over');
    $act.textContent = p==='power' ? '발사! 🎯' : (p==='roll' ? '구르는 중…' : '파워 ▶');
    $act.classList.toggle('shoot', p==='power');
    $cancel.classList.toggle('hidden', p!=='power');
    el.querySelectorAll('.pk-rot').forEach(b => b.disabled = (p !== 'aim'));
    if(msg !== undefined) $tip.textContent = msg;
    else if(p==='aim') $tip.textContent = '화면을 터치·드래그해 방향을 맞춘 뒤 파워를 누르세요';
    else if(p==='power') $tip.textContent = '게이지가 왔다 갔다 하는 동안 원하는 세기에서 발사!';
  }
  function newGame(){
    rack(); G.shots = 0; G.over = false; G.angle = -Math.PI/2;
    G.turn = 0; G.score = [0,0];
    G.evt = { cueIn:false, eightIn:false, potted:[], firstHit:null };
    updateHud();
    $msg.classList.add('hidden'); $msg.innerHTML = '';
    setPhase('aim', two ? '1P 브레이크 샷! 세게 쳐서 흩뜨려요' : '브레이크 샷! 세게 쳐서 랙을 흩뜨려 보세요');
  }

  const pbest = getStat('pocket')?.best;
  const hudHtml = two
    ? `<div class="pk-hud pk-hud-two t0" id="pkHud">
        <span class="pk-p pk-p0"><b>1P</b> <b id="pkS0">0</b></span>
        <span>남은 <b id="pkLeft">15</b></span>
        <span class="pk-p pk-p1"><b>2P</b> <b id="pkS1">0</b></span>
      </div>`
    : `<div class="pk-hud">
        <span>샷 <b id="pkShots">0</b></span>
        <span>남은 공 <b id="pkLeft">15</b></span>
        <span>최소 <b id="pkBest">${pbest != null ? pbest + '타' : '-'}</b></span>
      </div>`;
  el.innerHTML = `<div class="mg pocket">
    ${hudHtml}
    <div class="pk-stage">
      <canvas id="pkCv" width="${W}" height="${H}"></canvas>
      <div class="pk-msg hidden" id="pkMsg"></div>
    </div>
    <div class="pk-gaugewrap">
      <div class="pk-gauge"><i id="pkFill"></i></div>
      <button class="pk-cancel hidden" id="pkCancel">취소</button>
    </div>
    <div class="pk-ctrl">
      <button class="btn pk-rot" id="pkL">◀</button>
      <button class="btn primary pk-act" id="pkAct">파워 ▶</button>
      <button class="btn pk-rot" id="pkR">▶</button>
    </div>
    <p class="pk-tip" id="pkTip"></p>
  </div>`;

  cv = el.querySelector('#pkCv'); ctx = cv.getContext('2d');
  $shots = el.querySelector('#pkShots'); $left = el.querySelector('#pkLeft');
  $s0 = el.querySelector('#pkS0'); $s1 = el.querySelector('#pkS1'); $hud = el.querySelector('#pkHud');
  $msg = el.querySelector('#pkMsg'); $fill = el.querySelector('#pkFill');
  $act = el.querySelector('#pkAct'); $cancel = el.querySelector('#pkCancel'); $tip = el.querySelector('#pkTip');

  // 캔버스 터치/드래그 → 큐볼 기준 방향
  function aimAt(e){
    if(G.phase !== 'aim' || G.over) return;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / r.width), y = (e.clientY - r.top) * (H / r.height);
    const c = cue(), dx = x - c.x, dy = y - c.y;
    if(Math.hypot(dx,dy) < 4) return;
    G.angle = Math.atan2(dy, dx);
  }
  let dragging = false;
  cv.addEventListener('pointerdown', e => { e.preventDefault(); dragging = true; try{ cv.setPointerCapture(e.pointerId); }catch(_){} aimAt(e); });
  cv.addEventListener('pointermove', e => { if(dragging) aimAt(e); });
  cv.addEventListener('pointerup', () => { dragging = false; });
  cv.addEventListener('pointercancel', () => { dragging = false; });
  cv.oncontextmenu = e => { e.preventDefault(); return false; };

  // 미세 조준(꾹 누르면 연속 회전)
  function holdRot(btn, dir){
    let t = null;
    const stepA = () => { if(G.phase === 'aim' && !G.over) G.angle += dir*0.009; };
    const stop = () => { if(t){ clearInterval(t); t = null; } };
    btn.onpointerdown = e => { e.preventDefault(); stepA(); stop(); t = setInterval(stepA, 40); };
    btn.onpointerup = stop; btn.onpointercancel = stop; btn.onpointerleave = stop;
    btn.oncontextmenu = e => { e.preventDefault(); return false; };
  }
  holdRot(el.querySelector('#pkL'), -1);
  holdRot(el.querySelector('#pkR'), +1);
  $act.onclick = () => {
    if(G.over) return;
    if(G.phase === 'aim'){ G.power = 0; G.pdir = 1; setPhase('power'); }
    else if(G.phase === 'power') shoot();
  };
  $cancel.onclick = () => { if(G.phase === 'power') setPhase('aim'); };

  newGame();
  G.raf = requestAnimationFrame(loop);
}

// ══════════════════════════ 🔴 4구(사구) ══════════════════════════
// 포켓 없는 캐롬 테이블 · 공 4개 — 흰공 2개(각 플레이어의 수구)와 빨간공 2개(적구).
// 규칙: 내 수구로 빨간공 2개를 모두 맞히면 1점(계속 침). 하나만 맞히거나 못 맞히면 차례가 넘어간다.
//       내 수구가 상대 흰공을 맞히면 파울 — 빨간공 2개를 다 맞혔더라도 무득점이고 차례가 넘어간다.
// 모드: 연습(혼자 10샷 도전 — 득점 합계가 기록) / 대결(vs 컴퓨터 3단계 · 같은 기기 2인, 먼저 5점).
// 물리·조작은 포켓볼과 동일: 등질량 탄성충돌 + 구름마찰 + 쿠션 반발, 조준 → 파워 게이지 → 발사.
// 컴퓨터는 후보 샷을 실제 물리로 미리 굴려보고(롤아웃) 가장 좋은 것을 고른다 — 난이도 = 후보 수 + 조준 오차.
// 배치·물리가 결정론적이라 한 턴이 {수구, 각도, 파워}만으로 재현된다.
// TODO(다음 단계): 이 턴 데이터를 Worker로 주고받아 다른 휴대폰 사용자와 온라인 대결(방 만들기/참가).
const FOUR_TARGET = 5;    // 대결: 먼저 이 점수에 닿으면 승리
const FOUR_SHOTS  = 10;   // 연습: 한 판에 칠 수 있는 샷 수
const FOUR_AIS = [   // samples=넓게 훑는 후보 수 · refine=주변을 다듬는 횟수 · noise=조준 흔들림(라디안)
  { key: 'easy', label: '초급', desc: '실수가 잦아요',       samples: 12,  refine: 0, noise: 0.07 },
  { key: 'mid',  label: '중급', desc: '제법 잘 쳐요',        samples: 45,  refine: 2, noise: 0.025 },
  { key: 'hard', label: '고급', desc: '좀처럼 놓치지 않아요', samples: 110, refine: 4, noise: 0 },
];

function startFourball(el){
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => showView('hub');
  el.innerHTML = `<div class="mg jg-pick">
    <div class="mg-msg">모드를 골라요 🔴</div>
    <label class="fb-opt"><input type="checkbox" id="fbSpinOpt"> <b>당점(회전) 사용</b>
      <small>정면 큐볼에서 칠 위치를 골라 팔로·드로·사이드 스핀 — 충돌·쿠션 반사가 달라져요</small></label>
    <label class="fb-opt"><input type="checkbox" id="fbCourseOpt"> <b>코스 자세히</b>
      <small>예상 괘적을 쿠션 반사까지 최대 3개 표시</small></label>
    <div class="omok-levels">
      <button data-m="solo">연습<small>혼자 ${FOUR_SHOTS}샷 도전 · 기록 저장</small></button>
      ${FOUR_AIS.map(a => `<button data-m="cpu" data-k="${a.key}">대결 · vs 컴퓨터 ${a.label}<small>${a.desc} · 먼저 ${FOUR_TARGET}점</small></button>`).join('')}
      <button data-m="two">대결 · 2인<small>한 기기에서 번갈아 치기</small></button>
    </div>
  </div>`;
  el.querySelectorAll('.omok-levels button').forEach(b => b.onclick = () => {
    const m = b.dataset.m;
    const spin = !!el.querySelector('#fbSpinOpt')?.checked;
    const course = !!el.querySelector('#fbCourseOpt')?.checked;
    runFour(el, { mode: m, ai: m === 'cpu' ? FOUR_AIS.find(a => a.key === b.dataset.k) : null, spin, course });
  });
}

function runFour(el, cfg){
  const W = 320, H = 568;                 // 캔버스 크기(세로형 테이블)
  const CU = 15;                          // 쿠션(레일) 두께
  const L = CU, T = CU, RT = W - CU, BT = H - CU;   // 플레이 영역 경계
  const R = 8.6;                          // 공 반지름
  const SUB = 8;                          // 프레임당 물리 서브스텝(빠른 공이 서로 통과하지 않게)
  const DECEL = 0.062;                    // 구름 마찰(프레임당 등감속)
  const STOP = 0.05;                      // 정지 임계 속도
  const CUSH_E = 0.78, BALL_E = 0.96;     // 쿠션/공 반발계수 — 캐롬은 쿠션을 많이 쓰므로 포켓볼보다 잘 튄다
  const PMIN = 3.0, PMAX = 20;            // 발사 속도(px/프레임)
  const PSPD = 0.022;                     // 파워 게이지 왕복 속도(프레임당)
  const CUE = 0, OPP = 1;                 // 공 인덱스: 0=민무늬 흰공(1P) 1=점박이 흰공(2P) 2,3=빨간공
  const solo = cfg.mode === 'solo';
  const useSpin = !!cfg.spin;             // 당점(회전) 사용
  const detailCourse = !!cfg.course;      // 코스 자세히(예상 괘적 최대 3개)
  let courseReflect = false;              // '코스반영' — 당점(스핀)까지 반영한 예측선(게임 중 체크박스)
  const FOLLOW_K = 0.55, THROW_K = 0.28, CUSH_ENG = 0.34;   // 팔로·드로 / 사이드 스로 / 쿠션 잉글리시 세기
  const who = i => cfg.mode === 'cpu' ? (i === 0 ? '나' : '컴퓨터') : `${i + 1}P`;

  const G = { balls: [], turn: 0, score: [0, 0], phase: 'aim', angle: -Math.PI/2, power: 0, pdir: 1,
              shotsLeft: FOUR_SHOTS, run: 0, bestRun: 0, hits: [], over: false, recorded: false, raf: null,
              spin: { f: 0, s: 0 }, hist: [] };
  // ── 되돌리기(무제한): 매 샷 직전 상태를 스택에 저장 ──
  function snapshot(){ return { balls: G.balls.map(b => ({ x:b.x, y:b.y, k:b.k })), turn:G.turn,
    score:[...G.score], shotsLeft:G.shotsLeft, run:G.run, bestRun:G.bestRun, angle:G.angle }; }
  function pushHistory(){ G.hist.push(snapshot()); }
  function restoreState(s){
    G.balls = s.balls.map(b => ({ x:b.x, y:b.y, k:b.k, vx:0, vy:0 }));
    G.turn = s.turn; G.score = [...s.score]; G.shotsLeft = s.shotsLeft; G.run = s.run; G.bestRun = s.bestRun; G.angle = s.angle; G.over = false;
  }
  function undo(){
    if(!G.hist.length) return;
    let s = G.hist.pop();
    if(cfg.mode === 'cpu'){ while(s.turn === 1 && G.hist.length) s = G.hist.pop(); }   // vs컴퓨터: 내 차례로 돌아올 때까지
    restoreState(s);
    $msg.classList.add('hidden'); $msg.innerHTML = '';
    resetSpin(); updateHud(); setPhase('aim', '이전 상태로 되돌렸어요 ↩︎');
  }
  // 당점(스핀) — 접촉 시 수구에 팔로/드로 + 사이드 스로 적용(대부분 소모). 수구만 spF/spS 를 가진다.
  function applySpin(b){
    if(!b.spF && !b.spS) return;
    const d = b.dir || { x: 0, y: 0 }, v0 = b.v0 || 0;
    b.vx += d.x * b.spF * v0 * FOLLOW_K; b.vy += d.y * b.spF * v0 * FOLLOW_K;   // 팔로(+)/드로(-)
    const tx = -d.y, ty = d.x;                                                  // 진행 접선(사이드)
    b.vx += tx * b.spS * v0 * THROW_K; b.vy += ty * b.spS * v0 * THROW_K;
    b.spF *= 0.12; b.spS *= 0.45;
  }
  function resetSpin(){ G.spin = { f: 0, s: 0 }; if(G._drawSpin) G._drawSpin(); }
  let cv, ctx, $hud, $msg, $fill, $act, $cancel, $tip;

  // ── 초기 배치: 빨간공 2개는 중앙선 스팟, 흰공 2개는 하단에 좌우 대칭(양쪽 조건 동일) ──
  function rack(){
    const cx = W/2, h = BT - T;
    G.balls = [
      { k:'w',   x: cx + 34, y: T + h*0.80, vx:0, vy:0 },
      { k:'wm',  x: cx - 34, y: T + h*0.80, vx:0, vy:0 },
      { k:'red', x: cx,      y: T + h*0.25, vx:0, vy:0 },
      { k:'red', x: cx,      y: T + h*0.50, vx:0, vy:0 },
    ];
  }
  const cue = () => G.balls[G.turn];
  const alive = () => !!(cv && document.body.contains(cv));

  // ── 물리 한 프레임 ─────────────────────────────────
  // bs=공 배열 · ci=수구 인덱스 · hits=수구가 접촉한 공 인덱스(중복 없이 누적) — 실제 진행과 CPU 시뮬레이션이 같은 코드를 쓴다
  function physFrame(bs, sub, hits, ci){
    for(let s=0;s<sub;s++){
      for(const b of bs){
        if(!b.vx && !b.vy) continue;
        b.x += b.vx/sub; b.y += b.vy/sub;
        const sp = Math.hypot(b.vx, b.vy);                  // 등감속: 방향은 유지하고 속력만 일정하게 깎는다
        if(sp > 0){ const ns = Math.max(0, sp - DECEL/sub); b.vx = b.vx/sp*ns; b.vy = b.vy/sp*ns; }
        let vwall = false, hwall = false;
        if(b.x-R < L){ b.x = L+R; b.vx = -b.vx*CUSH_E; b.vy *= 0.99; vwall = true; }        // 쿠션(포켓이 없으니 항상 튕긴다)
        else if(b.x+R > RT){ b.x = RT-R; b.vx = -b.vx*CUSH_E; b.vy *= 0.99; vwall = true; }
        if(b.y-R < T){ b.y = T+R; b.vy = -b.vy*CUSH_E; b.vx *= 0.99; hwall = true; }
        else if(b.y+R > BT){ b.y = BT-R; b.vy = -b.vy*CUSH_E; b.vx *= 0.99; hwall = true; }
        if(b.spS){                                                            // 사이드 스핀 → 쿠션 반사각이 달라진다(잉글리시)
          if(vwall){ b.vy += b.spS * Math.abs(b.vx) * CUSH_ENG; b.spS *= 0.7; }
          if(hwall){ b.vx += b.spS * Math.abs(b.vy) * CUSH_ENG; b.spS *= 0.7; }
        }
        if(b.spF) b.spF *= 0.994; if(b.spS) b.spS *= 0.994;                    // 미사용 스핀은 서서히 사라짐
      }
      for(let i=0;i<bs.length;i++){                          // 공끼리 충돌(등질량 탄성) — 법선 방향 운동량 교환 + 겹침 보정
        for(let j=i+1;j<bs.length;j++){
          const a = bs[i], b = bs[j];
          const dx = b.x-a.x, dy = b.y-a.y, d = Math.hypot(dx,dy);
          if(d <= 0 || d >= 2*R) continue;
          const nx = dx/d, ny = dy/d, ov = (2*R - d)/2;
          a.x -= nx*ov; a.y -= ny*ov; b.x += nx*ov; b.y += ny*ov;
          const rel = (b.vx-a.vx)*nx + (b.vy-a.vy)*ny;
          if(rel >= 0) continue;
          const imp = -(1+BALL_E)*rel/2;
          a.vx -= imp*nx; a.vy -= imp*ny; b.vx += imp*nx; b.vy += imp*ny;
          applySpin(a); applySpin(b);                            // 당점(팔로/드로/사이드) — 충돌 후 수구 진행이 달라진다
          if(hits && (i === ci || j === ci)){ const o = (i === ci) ? j : i; if(!hits.includes(o)) hits.push(o); }
        }
      }
      for(const b of bs) if(Math.hypot(b.vx,b.vy) < STOP){ b.vx = 0; b.vy = 0; }
    }
  }
  const moving = bs => bs.some(b => b.vx || b.vy);

  // ── 샷 판정: 빨간공 2개 모두 = 득점 · 상대 흰공 접촉 = 파울 ──
  function judge(hits){
    const reds = hits.filter(i => G.balls[i].k === 'red').length;
    const foul = hits.some(i => G.balls[i].k !== 'red');
    return { reds, foul, scored: !foul && reds >= 2 };
  }

  // ── 조준 예측(점선이 닿는 지점 + 목적구 진행 방향) ──
  function predict(){
    const c = cue(), dx = Math.cos(G.angle), dy = Math.sin(G.angle);
    let bestT = Infinity, target = null;
    for(const b of G.balls){
      if(b === c) continue;
      const ex = b.x-c.x, ey = b.y-c.y, t = ex*dx + ey*dy;
      if(t <= 0) continue;
      const perp2 = ex*ex + ey*ey - t*t, rr = (2*R)*(2*R);
      if(perp2 > rr) continue;
      const th = t - Math.sqrt(rr - perp2);
      if(th > 0 && th < bestT){ bestT = th; target = b; }
    }
    let wallT = Infinity;
    if(dx > 0) wallT = Math.min(wallT, (RT-R-c.x)/dx); else if(dx < 0) wallT = Math.min(wallT, (L+R-c.x)/dx);
    if(dy > 0) wallT = Math.min(wallT, (BT-R-c.y)/dy); else if(dy < 0) wallT = Math.min(wallT, (T+R-c.y)/dy);
    if(!target || wallT < bestT) return { x: c.x+dx*Math.max(0,wallT), y: c.y+dy*Math.max(0,wallT), target:null };
    return { x: c.x+dx*bestT, y: c.y+dy*bestT, target };
  }

  // ── 예상 괘적(수구 중심 기준, 쿠션 반사 포함 최대 maxSeg 구간) ──
  function predictPath(ox, oy, dx, dy, maxSeg){
    const c = cue(), pts = [{ x: ox, y: oy }];
    let target = null;
    for(let seg = 0; seg < maxSeg; seg++){
      let tBall = Infinity, tgt = null;                       // 가장 가까운 공까지
      for(const b of G.balls){
        if(b === c) continue;
        const ex = b.x-ox, ey = b.y-oy, t = ex*dx + ey*dy;
        if(t <= 0) continue;
        const perp2 = ex*ex + ey*ey - t*t, rr = (2*R)*(2*R);
        if(perp2 > rr) continue;
        const th = t - Math.sqrt(rr - perp2);
        if(th > 0.02 && th < tBall){ tBall = th; tgt = b; }
      }
      let tW = Infinity, wx = false, wy = false;              // 가장 가까운 쿠션까지(수구 중심 경계)
      if(dx > 0){ const t = (RT-R-ox)/dx; if(t < tW){ tW = t; wx = true; wy = false; } }
      else if(dx < 0){ const t = (L+R-ox)/dx; if(t < tW){ tW = t; wx = true; wy = false; } }
      if(dy > 0){ const t = (BT-R-oy)/dy; if(t < tW){ tW = t; wx = false; wy = true; } }
      else if(dy < 0){ const t = (T+R-oy)/dy; if(t < tW){ tW = t; wx = false; wy = true; } }
      if(tgt && tBall <= tW){                                 // 공에 먼저 → 거기서 종료
        ox += dx*tBall; oy += dy*tBall; pts.push({ x: ox, y: oy }); target = tgt; break;
      }
      const t = Math.max(0, tW);                              // 쿠션에 먼저 → 반사 후 계속
      ox += dx*t; oy += dy*t; pts.push({ x: ox, y: oy, bounce: true });
      if(wx) dx = -dx; if(wy) dy = -dy;
      ox += dx*0.02; oy += dy*0.02;                           // 같은 벽 재충돌 방지 살짝 밀기
    }
    return { points: pts, target };
  }

  // ── 당점(스핀) 반영 예측: 실제 물리로 수구 궤적을 굴려 본다 ──
  function simCuePath(angle, pw){
    const ci = G.turn;
    const bs = G.balls.map(b => ({ x:b.x, y:b.y, vx:0, vy:0, k:b.k }));
    const sp = PMIN + (PMAX-PMIN)*pw, c = bs[ci];
    c.vx = Math.cos(angle)*sp; c.vy = Math.sin(angle)*sp;
    c.dir = { x: Math.cos(angle), y: Math.sin(angle) }; c.v0 = sp;
    c.spF = G.spin.f; c.spS = G.spin.s;
    const pts = [{ x:c.x, y:c.y }], hits = [];
    let firstContactIdx = -1;
    for(let f=0; f<300; f++){
      const before = hits.length;
      physFrame(bs, 4, hits, ci);
      if(firstContactIdx < 0 && hits.length > before) firstContactIdx = pts.length;
      pts.push({ x:bs[ci].x, y:bs[ci].y });
      if(Math.hypot(bs[ci].vx, bs[ci].vy) < 1.2) break;
    }
    return { pts, firstContactIdx };
  }

  // ── 컴퓨터: 후보 샷을 물리로 미리 굴려보고 가장 좋은 것 고르기 ──
  function simulate(ang, pw, ci){
    const bs = G.balls.map(b => ({ ...b })), hits = [];
    bs.forEach(b => { b.spF = 0; b.spS = 0; });   // 컴퓨터는 당점 없이(중앙) 계산
    const sp = PMIN + (PMAX-PMIN)*pw;
    bs[ci].vx = Math.cos(ang)*sp; bs[ci].vy = Math.sin(ang)*sp;
    for(let f=0; f<700 && moving(bs); f++) physFrame(bs, 4, hits, ci);   // 미리보기는 서브스텝을 줄여 가볍게
    return { hits, bs };
  }
  function shotValue(hits, bs, ci){
    const j = judge(hits);
    if(j.foul) return -100 + j.reds;                       // 파울은 무조건 피한다
    let v = j.reds * 100;
    const c = bs[ci];                                       // 다음 샷 편의 — 수구와 적구가 가까울수록 소폭 가점
    for(const b of bs) if(b.k === 'red') v += 30/(1 + Math.hypot(b.x-c.x, b.y-c.y)/60);
    return v;
  }
  function cpuPick(){
    const ci = G.turn, c = G.balls[ci], reds = G.balls.filter(b => b.k === 'red');
    const tryShot = (ang, pw) => { const r = simulate(ang, pw, ci); return { v: shotValue(r.hits, r.bs, ci), ang, pw }; };
    let best = null;
    for(let i=0;i<cfg.ai.samples;i++){                      // 1) 넓게 훑기
      let ang;
      if(Math.random() < 0.75){                             // 적구 쪽을 겨냥한 후보(±약간)를 주로 보고
        const t = reds[Math.floor(Math.random()*reds.length)];
        ang = Math.atan2(t.y-c.y, t.x-c.x) + (Math.random()-0.5)*0.5;
      } else ang = Math.random()*Math.PI*2;                 // 가끔은 쿠션을 노리는 무작위 후보도 섞는다
      const r = tryShot(ang, 0.25 + Math.random()*0.7);
      if(!best || r.v > best.v) best = r;
    }
    if(!best) return { ang: G.angle, pw: 0.6 };
    for(let pass=0; pass<cfg.ai.refine; pass++){            // 2) 찾은 샷 주변을 점점 좁혀가며 다듬기(정밀도 = 난이도)
      const sp = 0.06 / (pass + 1);
      for(let i=0;i<8;i++){
        const r = tryShot(best.ang + (Math.random()-0.5)*sp*2, Math.min(0.98, Math.max(0.15, best.pw + (Math.random()-0.5)*0.2)));
        if(r.v > best.v) best = r;
      }
    }
    return { ang: best.ang + (Math.random()-0.5)*cfg.ai.noise, pw: best.pw };   // 난이도만큼 손이 흔들린다
  }

  // ── 그리기 ────────────────────────────────────────
  function roundRect(x,y,w,h,r){ ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); }
  function drawTable(){
    ctx.fillStyle = '#3f2513'; roundRect(0,0,W,H,16); ctx.fill();                  // 나무 프레임
    ctx.fillStyle = '#14532d'; roundRect(4,4,W-8,H-8,12); ctx.fill();              // 레일
    const fg = ctx.createLinearGradient(0,T,0,BT);
    fg.addColorStop(0,'#15803d'); fg.addColorStop(0.5,'#177f45'); fg.addColorStop(1,'#136136');
    ctx.fillStyle = fg; ctx.fillRect(L,T,RT-L,BT-T);                                // 천(felt)
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.strokeRect(L,T,RT-L,BT-T);
    ctx.fillStyle = 'rgba(255,255,255,.30)';                                        // 스팟(초구 자리)
    for(const f of [0.25, 0.5, 0.75]){ ctx.beginPath(); ctx.arc(W/2, T+(BT-T)*f, 2, 0, 7); ctx.fill(); }
    ctx.fillStyle = 'rgba(255,255,255,.45)';                                        // 레일 다이아몬드
    for(let i=1;i<=3;i++){ const y = T + (BT-T)*i/4;
      ctx.beginPath(); ctx.arc(CU/2,y,1.6,0,7); ctx.fill(); ctx.beginPath(); ctx.arc(W-CU/2,y,1.6,0,7); ctx.fill(); }
    for(let i=1;i<=3;i++){ const x = L + (RT-L)*i/4;
      ctx.beginPath(); ctx.arc(x,CU/2,1.6,0,7); ctx.fill(); ctx.beginPath(); ctx.arc(x,H-CU/2,1.6,0,7); ctx.fill(); }
  }
  function drawBall(b, isCue){
    ctx.beginPath(); ctx.ellipse(b.x+1.6, b.y+2.4, R*0.95, R*0.8, 0, 0, 7);          // 그림자
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(b.x,b.y,R,0,7); ctx.clip();
    ctx.fillStyle = b.k === 'red' ? '#dc2626' : '#f8fafc';
    ctx.fillRect(b.x-R, b.y-R, 2*R, 2*R);
    if(b.k === 'wm'){ ctx.beginPath(); ctx.arc(b.x,b.y,R*0.34,0,7); ctx.fillStyle = '#dc2626'; ctx.fill(); }   // 점박이 흰공(2P 수구)
    const g = ctx.createRadialGradient(b.x-R*0.4, b.y-R*0.45, R*0.05, b.x-R*0.1, b.y-R*0.1, R*1.3);
    g.addColorStop(0,'rgba(255,255,255,.55)'); g.addColorStop(0.38,'rgba(255,255,255,.05)'); g.addColorStop(1,'rgba(0,0,0,.42)');
    ctx.fillStyle = g; ctx.fillRect(b.x-R, b.y-R, 2*R, 2*R);
    ctx.restore();
    ctx.beginPath(); ctx.arc(b.x,b.y,R,0,7); ctx.lineWidth = 0.9; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.stroke();
    if(isCue){                                                                       // 지금 칠 수구 표시
      ctx.save(); ctx.setLineDash([3,3]); ctx.beginPath(); ctx.arc(b.x,b.y,R+3.4,0,7);
      ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(253,224,71,.95)'; ctx.stroke(); ctx.restore();
    }
  }
  function drawAim(){
    const c = cue(), dx = Math.cos(G.angle), dy = Math.sin(G.angle);
    ctx.save(); ctx.lineCap = 'round';
    if(useSpin && courseReflect){                                                    // '코스반영' — 당점(스핀)까지 물리로 반영한 예측선(하늘색)
      const pw = (G.phase === 'power') ? G.power : 0.7;
      const sim = simCuePath(G.angle, pw);
      ctx.setLineDash([6,6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(56,189,248,.95)';
      ctx.beginPath(); ctx.moveTo(c.x+dx*R, c.y+dy*R);
      for(let i=1;i<sim.pts.length;i++) ctx.lineTo(sim.pts[i].x, sim.pts[i].y);
      ctx.stroke(); ctx.setLineDash([]);
      if(sim.firstContactIdx > 0){ const p = sim.pts[sim.firstContactIdx];
        ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.4; ctx.stroke(); }
    } else {
      const path = predictPath(c.x, c.y, dx, dy, detailCourse ? 3 : 1);
      const pts = path.points, last = pts[pts.length-1];
      ctx.setLineDash([6,6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.beginPath(); ctx.moveTo(c.x+dx*R, c.y+dy*R);                               // 큐볼 가장자리에서 시작
      for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      for(let i=1;i<pts.length-1;i++){ if(pts[i].bounce){                            // 쿠션 반사점
        ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 2.6, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fill(); } }
      if(path.target){                                                               // 공에 닿는 지점: 고스트 + 목적구 진행방향
        ctx.beginPath(); ctx.arc(last.x, last.y, R, 0, 7); ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.4; ctx.stroke();
        const ox = path.target.x-last.x, oy = path.target.y-last.y, od = Math.hypot(ox,oy) || 1;
        ctx.beginPath(); ctx.moveTo(path.target.x, path.target.y);
        ctx.lineTo(path.target.x + ox/od*34, path.target.y + oy/od*34);
        ctx.strokeStyle = 'rgba(253,224,71,.9)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    const pull = 8 + (G.phase==='power' ? G.power*26 : 0);                           // 큐대(파워만큼 뒤로 당겨짐)
    const bx = c.x - dx*(R+pull), by = c.y - dy*(R+pull);
    const tx = c.x - dx*(R+pull+96), ty = c.y - dy*(R+pull+96);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(tx,ty); ctx.lineWidth = 4.4; ctx.strokeStyle = '#c8873f'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(bx-dx*10, by-dy*10); ctx.lineWidth = 4.4; ctx.strokeStyle = '#e0f2fe'; ctx.stroke();
    ctx.restore();
  }
  function draw(){
    drawTable();
    G.balls.forEach((b,i) => drawBall(b, i === G.turn && !G.over));
    if((G.phase==='aim' || G.phase==='power' || G.phase==='cpu') && !G.over) drawAim();
  }

  // ── 루프 ──────────────────────────────────────────
  function loop(){
    if(!alive()){ if(G.raf) cancelAnimationFrame(G.raf); G.raf = null; return; }
    if(G.phase==='power'){
      G.power += G.pdir*PSPD;
      if(G.power >= 1){ G.power = 1; G.pdir = -1; }
      else if(G.power <= 0){ G.power = 0; G.pdir = 1; }
      $fill.style.width = Math.round(G.power*100) + '%';
    } else if(G.phase==='roll'){
      physFrame(G.balls, SUB, G.hits, G.turn);
      if(!moving(G.balls)) endShot();
    }
    draw();
    G.raf = requestAnimationFrame(loop);
  }

  // ── 샷 처리 ───────────────────────────────────────
  function shoot(){
    pushHistory();                                                      // 샷 직전 상태 저장(되돌리기용)
    const c = cue(), sp = PMIN + (PMAX-PMIN)*G.power;
    c.vx = Math.cos(G.angle)*sp; c.vy = Math.sin(G.angle)*sp;
    c.dir = { x: Math.cos(G.angle), y: Math.sin(G.angle) }; c.v0 = sp;   // 당점 계산용
    c.spF = useSpin ? G.spin.f : 0; c.spS = useSpin ? G.spin.s : 0;
    G.hits = [];
    setPhase('roll');
  }
  function endShot(){
    const j = judge(G.hits);
    const why = j.foul ? '상대 흰공을 맞혔어요 — 파울!'
              : j.reds >= 2 ? '득점! 🔴🔴'
              : j.reds === 1 ? '빨간공 하나만… 아쉽다'
              : '헛샷! 빨간공을 못 맞혔어요';
    if(solo){
      G.shotsLeft--;
      if(j.scored){ G.score[0]++; G.run++; G.bestRun = Math.max(G.bestRun, G.run); } else G.run = 0;
      updateHud();
      if(G.shotsLeft <= 0) finishSolo();
      else { resetSpin(); setPhase('aim', j.scored ? `${why} (연속 ${G.run}점)` : why); }
      return;
    }
    if(j.scored){
      G.score[G.turn]++; updateHud();
      if(G.score[G.turn] >= FOUR_TARGET){ finishVs(G.turn); return; }
      proceed(`${who(G.turn)} 득점! 이어서 칩니다`, false);
    } else {
      proceed(`${who(G.turn)} — ${why}`, true);
    }
  }
  // 다음 차례로(pass=true면 상대에게 넘김). 컴퓨터 차례면 스스로 조준·발사한다.
  function proceed(msg, pass){
    if(pass) G.turn = 1 - G.turn;
    updateHud();
    aimDefault(); resetSpin();
    if(cfg.mode === 'cpu' && G.turn === 1) cpuTurn(msg);
    else setPhase('aim', msg);
  }
  function aimDefault(){                                    // 차례가 바뀌면 가까운 빨간공 쪽으로 초기 조준
    const c = cue();
    let best = null;
    G.balls.forEach(b => { if(b.k !== 'red') return; const d = Math.hypot(b.x-c.x, b.y-c.y); if(!best || d < best.d) best = { b, d }; });
    if(best) G.angle = Math.atan2(best.b.y-c.y, best.b.x-c.x);
  }
  function cpuTurn(msg){
    setPhase('cpu', (msg ? msg + ' · ' : '') + '컴퓨터가 조준 중…');
    setTimeout(() => {
      if(!alive() || G.over || G.phase !== 'cpu') return;
      const pick = cpuPick();
      G.angle = pick.ang;
      setTimeout(() => {
        if(!alive() || G.over || G.phase !== 'cpu') return;
        G.power = pick.pw; $fill.style.width = Math.round(G.power*100) + '%';
        shoot();
      }, 620);
    }, 380);
  }
  function endButtons(){
    return `<button class="btn primary" id="fbAgain">다시하기</button>
            <button class="btn ghost small" id="fbToMode">모드 변경</button>`;
  }
  function bindEnd(){
    const a = el.querySelector('#fbAgain'); if(a) a.onclick = newGame;
    const m = el.querySelector('#fbToMode'); if(m) m.onclick = () => startFourball(el);
  }
  function finishSolo(){
    G.over = true; setPhase('over', `${FOUR_SHOTS}샷 도전 끝 — 다시하기로 한 판 더!`);
    if(!G.recorded){ G.recorded = true; recordStat('four_solo', { best: G.score[0], result: G.score[0] > 0 ? 'win' : undefined }); }
    $msg.innerHTML = `🎯 연습 끝!<br><b>${G.score[0]}점</b>
      <span class="pk-why">${FOUR_SHOTS}샷 · 최고 연속 ${G.bestRun}점</span><br>${endButtons()}`;
    $msg.classList.remove('hidden'); bindEnd();
  }
  function finishVs(w){
    G.over = true; setPhase('over', '한 판 더 치려면 다시하기를 누르세요');
    if(cfg.mode === 'cpu' && !G.recorded){ G.recorded = true; recordStat('four_vs', { result: w === 0 ? 'win' : 'loss' }); }
    const head = cfg.mode === 'cpu' ? (w === 0 ? '🎉 이겼다!' : '아쉽다 — 컴퓨터 승리') : `🎉 ${who(w)} 승리!`;
    $msg.innerHTML = `${head}<br><b>${G.score[0]} : ${G.score[1]}</b>
      <span class="pk-why">${cfg.mode === 'cpu' ? '컴퓨터 ' + cfg.ai.label : '2인 대결'} · ${FOUR_TARGET}점 내기</span><br>${endButtons()}`;
    $msg.classList.remove('hidden'); bindEnd();
  }

  // ── 화면/조작 상태 ────────────────────────────────
  function updateHud(){
    if(solo){
      const best = getStat('four_solo')?.best;
      $hud.innerHTML = `<span>남은 샷 <b>${G.shotsLeft}</b></span>
        <span>득점 <b>${G.score[0]}</b></span>
        <span>최고 <b>${best != null ? best + '점' : '-'}</b></span>`;
    } else {
      const chip = i => `<span class="fb-p ${G.turn === i && !G.over ? 'on' : ''}">
        <i class="fb-dot ${i === 1 ? 'mark' : ''}"></i>${escapeHtml(who(i))} <b>${G.score[i]}</b></span>`;
      $hud.innerHTML = `${chip(0)}<span>${FOUR_TARGET}점 내기</span>${chip(1)}`;
    }
  }
  function setPhase(p, msg){
    G.phase = p;
    if(p !== 'power'){ G.power = 0; G.pdir = 1; if($fill) $fill.style.width = '0%'; }
    $act.disabled = (p !== 'aim' && p !== 'power');
    $act.textContent = p==='power' ? '발사! 🎯' : p==='roll' ? '구르는 중…' : p==='cpu' ? '컴퓨터 차례…' : '파워 ▶';
    $act.classList.toggle('shoot', p==='power');
    $cancel.classList.toggle('hidden', p!=='power');
    el.querySelectorAll('.pk-rot').forEach(b => b.disabled = (p !== 'aim'));
    const ub = el.querySelector('#fbUndo'); if(ub) ub.disabled = !(G.hist.length && (p === 'aim' || p === 'over'));
    if(msg !== undefined) $tip.textContent = msg;
    else if(p==='aim') $tip.textContent = '화면을 터치·드래그해 방향을 맞춘 뒤 파워를 누르세요';
    else if(p==='power') $tip.textContent = '게이지가 왔다 갔다 하는 동안 원하는 세기에서 발사!';
  }
  function newGame(){
    rack(); G.turn = 0; G.score = [0,0]; G.shotsLeft = FOUR_SHOTS; G.run = 0; G.bestRun = 0;
    G.hits = []; G.over = false; G.recorded = false; G.hist = [];
    $msg.classList.add('hidden'); $msg.innerHTML = '';
    updateHud(); aimDefault(); resetSpin();
    setPhase('aim', solo ? `빨간공 2개를 모두 맞히면 1점! ${FOUR_SHOTS}샷 도전`
                         : `${who(0)}부터 시작 — 먼저 ${FOUR_TARGET}점!`);
  }

  const sub = solo ? '연습' : cfg.mode === 'cpu' ? `vs 컴퓨터 ${cfg.ai.label}` : '2인 대결';
  el.innerHTML = `<div class="mg fourball">
    <div class="pk-hud" id="fbHud"></div>
    <div class="pk-stage">
      <canvas id="fbCv" width="${W}" height="${H}"></canvas>
      <div class="pk-msg hidden" id="fbMsg"></div>
    </div>
    <div class="pk-gaugewrap">
      <button class="btn ghost small fb-undo" id="fbUndo" title="이전 상태로 되돌리기" disabled>↩︎</button>
      <div class="pk-gauge"><i id="fbFill"></i></div>
      <button class="pk-cancel hidden" id="fbCancel">취소</button>
    </div>
    <div class="pk-ctrl">
      ${useSpin ? `<div class="fb-spinbox">
        <canvas class="fb-spin" id="fbSpin" width="120" height="120" title="당점 — 드래그로 회전 지정 (↑팔로 ↓드로 ←→사이드)"></canvas>
        <label class="fb-course"><input type="checkbox" id="fbCourseChk"> 코스반영</label>
      </div>` : ''}
      <button class="btn pk-rot" id="fbL">◀</button>
      <button class="btn primary pk-act" id="fbAct">파워 ▶</button>
      <button class="btn pk-rot" id="fbR">▶</button>
    </div>
    <p class="pk-tip" id="fbTip"></p>
  </div>`;
  document.getElementById('gameTitle').textContent = `🔴 4구 · ${sub}`;
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => startFourball(el);   // 뒤로 = 모드 선택

  cv = el.querySelector('#fbCv'); ctx = cv.getContext('2d');
  $hud = el.querySelector('#fbHud'); $msg = el.querySelector('#fbMsg'); $fill = el.querySelector('#fbFill');
  $act = el.querySelector('#fbAct'); $cancel = el.querySelector('#fbCancel'); $tip = el.querySelector('#fbTip');

  // 캔버스 터치/드래그 → 수구 기준 방향
  function aimAt(e){
    if(G.phase !== 'aim' || G.over) return;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * (W / r.width), y = (e.clientY - r.top) * (H / r.height);
    const c = cue(), dx = x - c.x, dy = y - c.y;
    if(Math.hypot(dx,dy) < 4) return;
    G.angle = Math.atan2(dy, dx);
  }
  let dragging = false;
  cv.addEventListener('pointerdown', e => { e.preventDefault(); dragging = true; try{ cv.setPointerCapture(e.pointerId); }catch(_){} aimAt(e); });
  cv.addEventListener('pointermove', e => { if(dragging) aimAt(e); });
  cv.addEventListener('pointerup', () => { dragging = false; });
  cv.addEventListener('pointercancel', () => { dragging = false; });
  cv.oncontextmenu = e => { e.preventDefault(); return false; };

  // 미세 조준(꾹 누르면 연속 회전)
  function holdRot(btn, dir){
    let t = null;
    const stepA = () => { if(G.phase === 'aim' && !G.over) G.angle += dir*0.009; };
    const stop = () => { if(t){ clearInterval(t); t = null; } };
    btn.onpointerdown = e => { e.preventDefault(); stepA(); stop(); t = setInterval(stepA, 40); };
    btn.onpointerup = stop; btn.onpointercancel = stop; btn.onpointerleave = stop;
    btn.oncontextmenu = e => { e.preventDefault(); return false; };
  }
  holdRot(el.querySelector('#fbL'), -1);
  holdRot(el.querySelector('#fbR'), +1);
  $act.onclick = () => {
    if(G.over) return;
    if(G.phase === 'aim'){ G.power = 0; G.pdir = 1; setPhase('power'); }
    else if(G.phase === 'power') shoot();
  };
  $cancel.onclick = () => { if(G.phase === 'power') setPhase('aim'); };
  el.querySelector('#fbUndo').onclick = () => { if(G.phase === 'aim' || G.phase === 'over') undo(); };

  // ── 당점(정면 큐볼) 선택기 ──
  if(useSpin){
    const sc = el.querySelector('#fbSpin'), sctx = sc.getContext('2d');
    const SR = 50, CX = 60, CY = 60, LIM = SR*0.82;   // 볼 반지름 · 중심 · 당점 이동 한계
    function drawSpin(){
      sctx.clearRect(0,0,120,120);
      const g = sctx.createRadialGradient(CX-16,CY-18,4, CX,CY,SR+12);
      g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#cbd5e1');
      sctx.beginPath(); sctx.arc(CX,CY,SR,0,7); sctx.fillStyle = g; sctx.fill();
      sctx.lineWidth = 2; sctx.strokeStyle = '#94a3b8'; sctx.stroke();
      sctx.strokeStyle = 'rgba(0,0,0,.12)'; sctx.lineWidth = 1;
      sctx.beginPath(); sctx.moveTo(CX-SR,CY); sctx.lineTo(CX+SR,CY); sctx.moveTo(CX,CY-SR); sctx.lineTo(CX,CY+SR); sctx.stroke();
      const px = CX + G.spin.s*LIM, py = CY - G.spin.f*LIM;
      sctx.beginPath(); sctx.arc(px,py,9,0,7); sctx.fillStyle = '#dc2626'; sctx.fill();
      sctx.lineWidth = 2; sctx.strokeStyle = '#fff'; sctx.stroke();
    }
    function setSpin(e){
      if(G.phase!=='aim' && G.phase!=='power') return;
      const r = sc.getBoundingClientRect();
      const x = (e.clientX-r.left)*(120/r.width), y = (e.clientY-r.top)*(120/r.height);
      let s = (x-CX)/LIM, f = -(y-CY)/LIM;
      const m = Math.hypot(s,f); if(m > 1){ s /= m; f /= m; }   // 원 안으로 제한
      G.spin.s = s; G.spin.f = f; drawSpin();
    }
    let spDrag = false;
    sc.addEventListener('pointerdown', e => { e.preventDefault(); spDrag = true; try{ sc.setPointerCapture(e.pointerId); }catch(_){} setSpin(e); });
    sc.addEventListener('pointermove', e => { if(spDrag) setSpin(e); });
    sc.addEventListener('pointerup', () => { spDrag = false; });
    sc.addEventListener('pointercancel', () => { spDrag = false; });
    sc.oncontextmenu = e => { e.preventDefault(); return false; };
    G._drawSpin = drawSpin;
    drawSpin();
    const chk = el.querySelector('#fbCourseChk');
    if(chk) chk.onchange = () => { courseReflect = chk.checked; };
  }

  newGame();
  G.raf = requestAnimationFrame(loop);
}

document.addEventListener('DOMContentLoaded', bootstrap);
