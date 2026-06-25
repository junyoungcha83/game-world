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
async function loadInitial() {
  const remote = await fetchFromServer();
  if (remote) { state = migrate(remote); saveLocalRaw(); setSync('✓ 동기화됨'); return; }
  const local = loadLocal();
  if (local) { state = migrate(local); setSync(getToken() ? '오프라인(로컬)' : ''); return; }
  state = DEFAULT_STATE(); setSync('');
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
function getScore(gid) { const u = getCurrentUser(); if (!u) return null; return (state.scores[u.id] && state.scores[u.id][gid] != null) ? state.scores[u.id][gid] : null; }
function setScore(gid, val) { const u = getCurrentUser(); if (!u) return; state.scores[u.id] = state.scores[u.id] || {}; state.scores[u.id][gid] = val; save(); }
function recordScore(gid, val) {
  const g = GAMES.find(x => x.id === gid), cur = getScore(gid);
  const better = cur == null || (g.best === 'high' ? val > cur : val < cur);
  if (better) setScore(gid, val);
}
function bestText(gid) { const g = GAMES.find(x => x.id === gid), v = getScore(gid); return v == null ? '-' : g.bestLabel(v); }
function refreshBest(gid) { const el = document.getElementById('gameBest'); if (el) el.textContent = '최고 ' + bestText(gid); }

// ── 게임 레지스트리 (여기에 추가만 하면 방사형 메뉴 자동 반영) ──
const GAMES = [
  { id: 'rps',   name: '가위바위보', emoji: '✊', color: '#f472b6', best: 'high', bestLabel: n => `${n}연승`,     start: startRPS },
  { id: 'guess', name: '숫자 맞히기', emoji: '🔢', color: '#60a5fa', best: 'low',  bestLabel: n => `${n}번 만에`, start: startGuess },
  { id: 'ttt',   name: '틱택토',     emoji: '⭕', color: '#34d399', best: 'high', bestLabel: n => `${n}승`,       start: startTTT },
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
  document.getElementById('gameBest').textContent = '최고 ' + bestText(id);
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
    if (r === '승') { streak++; msg.textContent = '이겼다! 🎉'; recordScore('rps', streak); refreshBest('rps'); }
    else if (r === '패') { streak = 0; msg.textContent = '졌어요 😢'; }
    else { msg.textContent = '비겼네요 😐'; }
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
    if (v === target) { done = true; m.textContent = `정답! 🎉 ${tries}번 만에 맞혔어요`; recordScore('guess', tries); refreshBest('guess'); document.getElementById('gReset').hidden = false; }
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
    if (w === 'O') { setScore('ttt', (getScore('ttt') || 0) + 1); refreshBest('ttt'); }
    draw();
  };
  document.getElementById('tReset').onclick = () => startTTT(el);
  draw();
}

// ── 프로필 ────────────────────────────────────────────
function renderProfile() {
  const u = getCurrentUser(); if (!u) { showReg(); return; }
  document.getElementById('profName').value = u.name;
  setAvatar('profAvatarImg', 'profAvatarFallback', u);
  document.getElementById('syncHint').textContent = getToken() ? '동기화 켜짐' : '동기화하려면 비밀번호 설정';
}

// ── 사용자 등록/선택 오버레이 ─────────────────────────
let regPhotoData = '';
function showReg() {
  regPhotoData = '';
  const ov = document.getElementById('regOverlay');
  const ex = document.getElementById('regExisting');
  document.getElementById('regName').value = '';
  setAvatar('regAvatarImg', 'regAvatarFallback', null);
  if (state.users.length) {
    document.getElementById('regTitle').textContent = '누구로 할까요?';
    document.getElementById('regSub').textContent = '기존 사용자를 고르거나 새로 만드세요.';
    ex.classList.remove('hidden');
    ex.innerHTML = state.users.map(u => `<button class="reg-user" data-id="${u.id}">${avatarInner(u)}<span>${escapeHtml(u.name)}</span></button>`).join('');
    ex.querySelectorAll('.reg-user').forEach(b => b.onclick = () => { setCurrentUser(b.dataset.id); ov.classList.add('hidden'); showView('hub'); });
  } else {
    document.getElementById('regTitle').textContent = '사용자 등록';
    document.getElementById('regSub').textContent = '이름을 입력하면 그 이름으로 게임을 즐길 수 있어요.';
    ex.classList.add('hidden'); ex.innerHTML = '';
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
