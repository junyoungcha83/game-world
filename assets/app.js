// 게임 월드 — 방사형 게임 허브 + 사용자 프로필 + 미니게임. 데이터는 Worker+KV 동기화(읽기 공개·쓰기 토큰).

const API_BASE   = 'https://game-world-api.junyoung-cha83.workers.dev';  // 배포 후 확정
const STORAGE_KEY = 'game-world-state-v1';
const TOKEN_KEY   = 'game-world-edit-token';
const CURUSER_KEY = 'game-world-current-user';

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
function mergeStates(a, b) {
  if (!a) return b; if (!b) return a;
  const byId = {};
  for (const u of a.users) byId[u.id] = u;
  for (const u of b.users) if (!byId[u.id]) byId[u.id] = u;
  return { version: 1, users: Object.values(byId), scores: Object.assign({}, b.scores, a.scores) };
}
async function loadInitial() {
  const local = loadLocal();
  const remote = await fetchFromServer();
  if (local || remote) {
    state = migrate(mergeStates(local, remote));   // 로컬 우선 병합 → 빈 원격이 로컬 사용자를 지우지 않음
    saveLocalRaw();
    setSync(remote ? '✓ 동기화됨' : (getToken() ? '오프라인(로컬)' : ''));
  } else {
    state = DEFAULT_STATE(); setSync('');
  }
}

// ── 사용자 ────────────────────────────────────────────
function getCurrentUser() { const id = localStorage.getItem(CURUSER_KEY); return state.users.find(u => u.id === id) || null; }
function setCurrentUser(id) { localStorage.setItem(CURUSER_KEY, id); }
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
  if (opt.best != null) { const g = GAMES.find(x => x.id === gid); if (s.best == null || (g.best === 'high' ? opt.best > s.best : opt.best < s.best)) s.best = opt.best; }
  save(); refreshStat(gid);
}
function refreshStat(gid) { const el = document.getElementById('gameBest'); if (el) { const g = GAMES.find(x => x.id === gid); el.textContent = g.fmtStat(getStat(gid)); } }

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
];

// ── 허브(방사형) ──────────────────────────────────────
function renderHub() {
  const hub = document.getElementById('hub'); hub.innerHTML = '';
  const u = getCurrentUser();
  const av = document.createElement('button'); av.className = 'hub-avatar'; av.innerHTML = avatarInner(u);
  av.onclick = () => showView('profile'); hub.appendChild(av);

  const n = GAMES.length, Rp = 37;   // 반지름 = 허브폭의 37%
  GAMES.forEach((g, i) => {
    const theta = i * (2 * Math.PI / n);          // 0=3시, 시계방향(화면 y는 아래로)
    const btn = document.createElement('button'); btn.className = 'game-node'; btn.style.background = g.color;
    btn.style.left = (50 + Rp * Math.cos(theta)).toFixed(2) + '%';
    btn.style.top  = (50 + Rp * Math.sin(theta)).toFixed(2) + '%';
    btn.innerHTML = `<span class="gn-emoji">${g.emoji}</span><span class="gn-name">${escapeHtml(g.name)}</span>`;
    btn.onclick = () => openGame(g.id);
    hub.appendChild(btn);
  });
  document.getElementById('hubHint').textContent = u ? `${u.name} 님, 즐겜! · 가운데 사진을 누르면 프로필` : '';
}

// ── 뷰 전환 ───────────────────────────────────────────
function showView(name) {
  ['hub', 'game', 'profile'].forEach(v => document.getElementById(v + 'View').classList.toggle('hidden', v !== name));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'profile') renderProfile();
  if (name === 'hub') renderHub();
}
function openGame(id) {
  const g = GAMES.find(x => x.id === id); if (!g) return;
  document.getElementById('gameTitle').textContent = g.emoji + ' ' + g.name;
  document.getElementById('gameBest').textContent = g.fmtStat(getStat(id));
  showView('game');
  g.start(document.getElementById('gameScreen'));
}

// ── 미니게임: 가위바위보 ──────────────────────────────
function startRPS(el) {
  let streak = 0;
  const R = [['✊', '바위'], ['✌️', '가위'], ['🖐', '보']];   // 0바위 1가위 2보
  el.innerHTML = `<div class="mg rps">
    <div class="mg-msg" id="rpsMsg">셋 중 하나를 골라요!</div>
    <div class="mg-vs" id="rpsVs">　</div>
    <div class="rps-choices">${R.map((r, i) => `<button data-i="${i}">${r[0]}</button>`).join('')}</div>
    <div class="mg-score">연승 <b id="rpsStreak">0</b></div>
  </div>`;
  el.querySelectorAll('.rps-choices button').forEach(b => b.onclick = () => {
    const me = +b.dataset.i, cpu = Math.floor(Math.random() * 3);
    let r = (me === cpu) ? '무' : ((me + 1) % 3 === cpu ? '승' : '패');   // me가 (me+1)%3 을 이김
    document.getElementById('rpsVs').textContent = `나 ${R[me][0]}  vs  ${R[cpu][0]} 컴퓨터`;
    const msg = document.getElementById('rpsMsg');
    if (r === '승') { streak++; msg.textContent = '이겼다! 🎉'; recordStat('rps', { result: 'win', best: streak }); }
    else if (r === '패') { streak = 0; msg.textContent = '졌어요 😢'; recordStat('rps', { result: 'loss' }); }
    else { msg.textContent = '비겼네요 😐'; recordStat('rps', { result: 'draw' }); }
    document.getElementById('rpsStreak').textContent = streak;
  });
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
const COUNTRIES = [
  ['🇰🇷','대한민국'],['🇯🇵','일본'],['🇨🇳','중국'],['🇺🇸','미국'],['🇬🇧','영국'],
  ['🇫🇷','프랑스'],['🇩🇪','독일'],['🇮🇹','이탈리아'],['🇪🇸','스페인'],['🇵🇹','포르투갈'],
  ['🇨🇦','캐나다'],['🇧🇷','브라질'],['🇦🇷','아르헨티나'],['🇲🇽','멕시코'],['🇦🇺','호주'],
  ['🇮🇳','인도'],['🇷🇺','러시아'],['🇹🇭','태국'],['🇻🇳','베트남'],['🇮🇩','인도네시아'],
  ['🇵🇭','필리핀'],['🇸🇬','싱가포르'],['🇹🇷','튀르키예'],['🇪🇬','이집트'],['🇿🇦','남아공'],
  ['🇳🇱','네덜란드'],['🇸🇪','스웨덴'],['🇳🇴','노르웨이'],['🇨🇭','스위스'],['🇬🇷','그리스'],
];
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startFlags(el) {
  let streak = 0;
  const round = () => {
    const correct = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
    const opts = shuffle([correct, ...shuffle(COUNTRIES.filter(c => c !== correct)).slice(0, 3)]);
    el.innerHTML = `<div class="mg flags">
      <div class="mg-msg" id="fMsg">이 국기는 어느 나라일까요?</div>
      <div class="flag-big">${correct[0]}</div>
      <div class="flag-opts">${opts.map(o => `<button data-name="${escapeHtml(o[1])}">${escapeHtml(o[1])}</button>`).join('')}</div>
      <div class="mg-score">연속 정답 <b id="fStreak">${streak}</b></div>
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
    const u = { id: uid(), name, photo: regPhotoData || '', created_at: new Date().toISOString() };
    state.users.push(u); setCurrentUser(u.id); save();
    document.getElementById('regOverlay').classList.add('hidden');
    showView('hub');
  };

  setSync('불러오는 중…');
  await loadInitial();
  if (!getCurrentUser()) showReg();
  renderHub();
}
document.addEventListener('DOMContentLoaded', bootstrap);
