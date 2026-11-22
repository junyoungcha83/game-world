// ── 똥벼락(똥 피하기) — 레트로 ─────────────────────────────
// 하늘의 '심술 구름'이 똥을 떨어뜨린다. 아래 아이가 좌우로 피한다.
//  · 조작: 화면 왼쪽을 누르고 있으면 ←, 오른쪽을 누르고 있으면 →, 가운데를 톡 누르면 아이템 사용.
//          (키보드: ← → 이동, 스페이스/↑ 아이템)
//  · 땅에 떨어진 똥 1개 = 1점. 시간이 갈수록 똥이 많아지고 빨라진다(15초마다 단계 +1).
//  · 💢 분노 타임: 20초부터 25초마다 5초 동안, 구름이 빨개지며 한 칸만 비운 '똥 줄'을 연달아 쏟는다. 다 버티면 +10.
//  · 똥 종류: 보통 / 꼬마똥(작고 빠름) / 왕똥(크고 느림) / 갈래똥(중간에 세 갈래로 터짐, 4단계부터).
//  · 아이템(가끔 떨어짐, 몸으로 받으면 가운데 칸에 보관 — 1개만, 새로 받으면 바뀜):
//      🧻 휴지 방패: 8초 동안 똥 한 번을 막아 준다
//      ⏳ 모래시계: 5초 동안 모든 똥이 느려진다
//      🚽 변기 물: 화면의 똥을 싹 내려보낸다(내려간 똥도 점수)
//  · 방식: 💩 한 방(한 번 맞으면 끝) / ❤️ 목숨 3개(맞으면 잠깐 무적).
// 기록 키: ddong_1(한 방), ddong_3(목숨 3) — best = 점수.
// 이 파일은 app.js 보다 먼저 읽힌다 — app.js 의 함수(recordStat·getStat·sfxCtx 등)는 실행 시점에만 쓴다.

const DD_MODES = [
  { k: '1', label: '💩 한 방',  desc: '한 번 맞으면 끝', lives: 1 },
  { k: '3', label: '❤️ 목숨 3', desc: '세 번까지 버텨요', lives: 3 },
];
const ddKey = k => 'ddong_' + k;
const ddFmt = s => s ? `${s.plays}판 · 최고 ${s.best || 0}점` : '아직 기록 없음';
function ddBoardEntries() {
  return DD_MODES.map(m => ({ id: ddKey(m.k), emoji: '💩', name: `똥벼락 ${m.label.replace(/^\S+\s/, '')}`, best: 'high', fmtStat: ddFmt }));
}
function ddAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const parts = DD_MODES.map(m => { const s = getStat(ddKey(m.k), u); return s && s.plays ? `${m.label.replace(/^\S+\s/, '')} ${s.best || 0}점` : null; }).filter(Boolean);
  return parts.length ? parts.join(' · ') : '아직 기록 없음';
}

let ddStop = null;
function ddLeave() { if (ddStop) { const f = ddStop; ddStop = null; f(); } }

// ── 효과음 ──
function ddSnd(kind) {
  if (typeof sfxCtx !== 'function') return;
  const c = sfxCtx(); if (!c || !sfx.master) return;
  const t = c.currentTime;
  const noise = (filter, freq, vol, dur) => {
    const src = c.createBufferSource(); src.buffer = bgm.noise;
    const f = c.createBiquadFilter(); f.type = filter; f.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(sfx.master); src.start(t); src.stop(t + dur + 0.02);
  };
  const tone = (type, hz, vol, dur, to, at) => {
    const o = c.createOscillator(), g = c.createGain(); const t0 = t + (at || 0);
    o.type = type; o.frequency.setValueAtTime(hz, t0); if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(sfx.master); o.start(t0); o.stop(t0 + dur + 0.02);
  };
  switch (kind) {
    case 'splat': noise('lowpass', 380, 0.07, 0.09); break;
    case 'hit':   noise('lowpass', 600, 0.35, 0.25); tone('square', 220, 0.12, 0.35, 70); break;
    case 'item':  tone('square', 660, 0.07, 0.08); tone('square', 990, 0.07, 0.1, null, 0.07); break;
    case 'use':   tone('triangle', 520, 0.16, 0.25, 1040); break;
    case 'flush': noise('bandpass', 900, 0.3, 0.7); tone('sine', 300, 0.12, 0.6, 90); break;
    case 'block': tone('triangle', 1200, 0.15, 0.18, 600); break;
    case 'fury':  tone('sawtooth', 110, 0.12, 0.5, 80); tone('sawtooth', 165, 0.08, 0.5, 120); break;
    case 'bonus': [523, 659, 784, 1047].forEach((h, i) => tone('square', h, 0.06, 0.1, null, i * 0.08)); break;
    case 'over':  [392, 330, 262, 196].forEach((h, i) => tone('square', h, 0.08, 0.18, null, i * 0.17)); break;
    case 'go':    tone('square', 880, 0.08, 0.18); break;
  }
}

// ── 설정 화면 ──
function ddLoadMode() { const v = localStorage.getItem('dd-mode'); return DD_MODES.some(m => m.k === v) ? v : '1'; }
function startDdong(el) {
  ddLeave();
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => showView('hub');
  let mode = ddLoadMode();
  const me = getCurrentUser();
  const render = () => {
    const M = DD_MODES.find(m => m.k === mode);
    const best = getStat(ddKey(mode));
    el.innerHTML = `<div class="mg ft-setup dd-setup">
      <div class="dd-logo">💩 똥벼락</div>
      <div class="mg-msg">심술 구름이 퍼붓는 똥을 피해요!</div>
      <div class="ft-row"><span class="ft-lab">방식</span><div class="ft-seg">${DD_MODES.map(m =>
        `<button data-v="${m.k}" class="${m.k === mode ? 'on' : ''}">${m.label}<small>${m.desc}</small></button>`).join('')}</div></div>
      <label class="fb-opt"><input type="checkbox" id="ddSfx"${sfxEnabled() ? ' checked' : ''}> <b>효과음</b>
        <small>철퍼덕·아이템 소리</small></label>
      <div class="ft-best">${me ? escapeHtml(me.name) + ' · ' : ''}${M.label} 최고 <b>${best && best.plays ? (best.best || 0) + '점' : '-'}</b></div>
      <button class="btn primary ft-go">시작!</button>
      <div class="sd-help">화면 <b>왼쪽·오른쪽</b>을 누르고 있으면 그쪽으로 움직여요.<br>
        <b>가운데</b>를 톡 누르면 모아 둔 아이템을 써요.<br>
        🧻 방패 · ⏳ 느리게 · 🚽 싹 내리기<br>
        💢 <b>분노 타임</b>엔 똥 줄의 빈칸으로 쏙!</div>
    </div>`;
    el.querySelectorAll('.ft-seg button').forEach(b => b.onclick = () => {
      mode = b.dataset.v; try { localStorage.setItem('dd-mode', mode); } catch {} render();
    });
    const cb = el.querySelector('#ddSfx'); if (cb) cb.onchange = () => { sfxSet(cb.checked); if (cb.checked) ddSnd('item'); };
    el.querySelector('.ft-go').onclick = () => runDdong(el, mode);
  };
  render();
}

// ── 게임 ──
const DD = { LW: 360, LH: 620, GROUND: 560, PW: 34, PH: 46 };
const DD_ITEMS = {
  shield: { emoji: '🧻', name: '휴지 방패' },
  slow:   { emoji: '⏳', name: '모래시계' },
  flush:  { emoji: '🚽', name: '변기 물' },
};

function runDdong(el, modeK) {
  ddLeave();
  const M = DD_MODES.find(m => m.k === modeK) || DD_MODES[0];
  const key = ddKey(M.k);
  const prevBest = (getStat(key) || {}).best || 0;
  const { LW, LH, GROUND, PW, PH } = DD;

  el.innerHTML = `<div class="ft-wrap">
    <div class="ft-top"><span class="dd-hud-l"></span><span class="ft-tag">${M.label} · 최고 ${prevBest}점</span></div>
    <div class="ft-stage"><canvas class="ft-cv dd-cv"></canvas><div class="ft-ov hidden"></div></div>
  </div>`;
  const cv = el.querySelector('canvas'); const g = cv.getContext('2d');
  const $ov = el.querySelector('.ft-ov'), $stage = el.querySelector('.ft-stage'), $hud = el.querySelector('.dd-hud-l');

  let dpr = 1;
  function fit() {
    const tab = document.querySelector('.tab-bar');
    const bottom = tab ? tab.getBoundingClientRect().top : innerHeight;
    const avail = Math.max(320, bottom - $stage.getBoundingClientRect().top - 6);
    let w = Math.min($stage.clientWidth || 360, 480), h = w * LH / LW;
    if (h > avail) { h = avail; w = h * LW / LH; }
    dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    $stage.style.height = h + 'px';
  }
  fit();
  window.addEventListener('resize', fit);

  const G = {
    phase: 'ready', readyT: 1.6, t: 0, score: 0, lives: M.lives,
    px: LW / 2, vx: 0, face: 1, walk: 0, inv: 0,
    poops: [], items: [], splats: [], pops: [], parts: [],
    spawnT: 0.6, itemT: 8 + Math.random() * 4,
    held: null, shield: 0, slow: 0,
    fury: 0, furyNext: 20, furyRowT: 0, furyGap: LW / 2, furyHit: false,
    cloudX: LW / 2, cloudShake: 0, flash: 0, shake: 0,
    raf: 0, last: 0, paused: false,
  };
  const stage = () => 1 + Math.floor(G.t / 15);

  // ── 입력 ──
  const ptrs = new Map();   // pointerId → 'L' | 'R'
  let keyL = false, keyR = false;
  const toX = e => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) / r.width * LW; };
  const zone = x => x < LW * 0.36 ? 'L' : x > LW * 0.64 ? 'R' : 'C';
  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const z = zone(toX(e));
    if (z === 'C') { useItem(); return; }
    ptrs.set(e.pointerId, z);
  });
  cv.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId)) return;
    const z = zone(toX(e));
    if (z !== 'C') { ptrs.delete(e.pointerId); ptrs.set(e.pointerId, z); }   // 맨 뒤로 → 마지막 방향 우선
  });
  const up = e => ptrs.delete(e.pointerId);
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  const onKey = e => {
    const d = e.type === 'keydown';
    if (e.key === 'ArrowLeft') { keyL = d; e.preventDefault(); }
    else if (e.key === 'ArrowRight') { keyR = d; e.preventDefault(); }
    else if (d && (e.key === ' ' || e.key === 'ArrowUp')) { useItem(); e.preventDefault(); }
  };
  addEventListener('keydown', onKey); addEventListener('keyup', onKey);
  const moveDir = () => {
    let dir = 0;
    if (ptrs.size) { const last = [...ptrs.values()].pop(); dir = last === 'L' ? -1 : 1; }
    if (keyL && !keyR) dir = -1; else if (keyR && !keyL) dir = 1;
    return dir;
  };

  function useItem() {
    if (G.phase !== 'play' || !G.held) return;
    const it = G.held; G.held = null;
    if (it === 'shield') { G.shield = 8; ddSnd('use'); pop('🧻 방패!', G.px, GROUND - 80); }
    else if (it === 'slow') { G.slow = 5; ddSnd('use'); pop('⏳ 느리게~', G.px, GROUND - 80); }
    else if (it === 'flush') {
      ddSnd('flush');
      const n = G.poops.length;
      for (const p of G.poops) burst(p.x, p.y, 4, '#60a5fa');
      G.poops = []; G.score += n; G.flash = 0.35;
      pop(`🚽 쏴아~ +${n}`, LW / 2, LH * 0.4, true);
    }
  }

  // ── 생성 ──
  const POOP_TYPES = {
    norm:  { r: 14, v: 1.0 },
    mini:  { r: 9,  v: 1.45 },
    big:   { r: 22, v: 0.72 },
    split: { r: 15, v: 0.9 },
  };
  function baseSpeed() { return Math.min(520, 150 + G.t * 2.6); }
  function addPoop(type, x, opt) {
    const T = POOP_TYPES[type];
    const p = { type, x, y: opt && opt.y != null ? opt.y : 70, r: T.r,
      vy: (opt && opt.vy) || baseSpeed() * T.v * (0.85 + Math.random() * 0.3),
      vx: (opt && opt.vx) || 0, rot: (Math.random() - 0.5) * 0.4, spin: (Math.random() - 0.5) * 1.5,
      splitY: type === 'split' ? 200 + Math.random() * 160 : 0, fury: !!(opt && opt.fury) };
    G.poops.push(p);
    return p;
  }
  function spawnNormal() {
    const s = stage();
    const r = Math.random();
    let type = 'norm';
    if (s >= 2 && r < 0.18) type = 'mini';
    else if (s >= 3 && r < 0.30) type = 'big';
    else if (s >= 4 && r < 0.40) type = 'split';
    // 가끔은 아이 머리 위를 노린다(가만히 서 있기 방지)
    const aim = Math.random() < Math.min(0.22, G.t * 0.008);   // 처음엔 안 노리다가 점점
    const x = aim ? Math.max(16, Math.min(LW - 16, G.px + (Math.random() - 0.5) * 40)) : 16 + Math.random() * (LW - 32);
    addPoop(type, x);
  }
  function spawnFuryRow() {
    // 한 칸(아이 3명 폭)만 비운 똥 줄. 빈칸은 앞 줄에서 조금씩만 옮겨 간다(따라갈 수 있게)
    const gapW = Math.max(PW * 2.6, 112 - stage() * 3);
    G.furyGap = Math.max(gapW / 2 + 6, Math.min(LW - gapW / 2 - 6, G.furyGap + (Math.random() - 0.5) * 150));
    const v = Math.min(330, 200 + G.t * 0.8);
    for (let x = 14; x < LW; x += 26) {
      if (Math.abs(x - G.furyGap) < gapW / 2) continue;
      addPoop('norm', x, { vy: v, fury: true });
    }
  }
  function spawnItem() {
    const ks = Object.keys(DD_ITEMS);
    G.items.push({ k: ks[Math.floor(Math.random() * ks.length)], x: 24 + Math.random() * (LW - 48), y: 70, vy: 130, t: 0 });
  }
  function pop(text, x, y, big) { G.pops.push({ text, x, y, t: 0, big }); }
  function burst(x, y, n, col) {
    for (let i = 0; i < n; i++) G.parts.push({ x, y, vx: (Math.random() - 0.5) * 220, vy: -60 - Math.random() * 180, t: 0, col, r: 2 + Math.random() * 3 });
  }

  // ── 진행 ──
  function hitPlayer(p) {
    if (G.inv > 0) return false;
    if (G.shield > 0) {
      G.shield = 0; ddSnd('block'); burst(p.x, p.y, 8, '#f8fafc'); pop('막았다!', G.px, GROUND - 70);
      G.inv = 0.6; return true;
    }
    G.lives--; G.shake = 0.4; G.flash = 0.25; ddSnd('hit');
    burst(G.px, GROUND - PH / 2, 14, '#92400e');
    if (G.fury > 0) G.furyHit = true;
    if (G.lives <= 0) { gameOver(); return true; }
    G.inv = 1.6;
    // 바로 위에 있던 똥은 치워 준다(연달아 맞지 않게)
    G.poops = G.poops.filter(q => !(Math.abs(q.x - G.px) < 60 && q.y > GROUND - 200));
    pop(`앗! ❤️ ${G.lives}`, G.px, GROUND - 80);
    return true;
  }

  function update(dt) {
    G.cloudShake = Math.max(0, G.cloudShake - dt);
    G.flash = Math.max(0, G.flash - dt); G.shake = Math.max(0, G.shake - dt);
    for (const p of G.pops) p.t += dt;
    G.pops = G.pops.filter(p => p.t < 1.1);
    for (const p of G.parts) { p.t += dt; p.vy += 600 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    G.parts = G.parts.filter(p => p.t < 0.8);
    for (const s of G.splats) s.t += dt;
    G.splats = G.splats.filter(s => s.t < 1.2);

    if (G.phase === 'ready') {
      G.readyT -= dt;
      if (G.readyT <= 0) { G.phase = 'play'; ddSnd('go'); }
      return;
    }
    if (G.phase !== 'play') return;

    G.t += dt;
    G.inv = Math.max(0, G.inv - dt); G.shield = Math.max(0, G.shield - dt); G.slow = Math.max(0, G.slow - dt);

    // 아이 이동 — 살짝 가속해서 톡톡 눌러 미세 조정도 된다
    const dir = moveDir();
    const vmax = 250 + Math.min(70, G.t * 0.6);
    if (dir) { G.vx += dir * 2200 * dt; G.vx = Math.max(-vmax, Math.min(vmax, G.vx)); G.face = dir; G.walk += dt * 12; }
    else { G.vx *= Math.pow(0.0005, dt); if (Math.abs(G.vx) < 5) G.vx = 0; }
    G.px += G.vx * dt;
    if (G.px < PW / 2) { G.px = PW / 2; G.vx = 0; }
    if (G.px > LW - PW / 2) { G.px = LW - PW / 2; G.vx = 0; }

    // 구름은 천천히 좌우로
    G.cloudX = LW / 2 + Math.sin(G.t * 0.7) * 50;

    // 분노 타임
    if (G.fury > 0) {
      G.fury -= dt; G.furyRowT -= dt;
      if (G.furyRowT <= 0 && G.fury > 0.8) { spawnFuryRow(); G.furyRowT = Math.max(0.62, 0.95 - stage() * 0.03); }
      if (G.fury <= 0) {
        G.furyNext = G.t + 25;
        if (!G.furyHit) { G.score += 10; ddSnd('bonus'); pop('분노 버티기 +10', LW / 2, LH * 0.35, true); }
      }
    } else if (G.t >= G.furyNext) {
      G.fury = 5; G.furyRowT = 0.6; G.furyHit = false; G.furyGap = G.px; G.cloudShake = 5;
      ddSnd('fury'); pop('💢 분노 타임!', LW / 2, LH * 0.3, true);
    } else {
      // 보통 똥
      G.spawnT -= dt;
      if (G.spawnT <= 0) {
        spawnNormal();
        if (stage() >= 5 && Math.random() < 0.25) spawnNormal();
        G.spawnT = Math.max(0.13, 0.55 - G.t * 0.0045) * (0.7 + Math.random() * 0.6);
      }
    }

    // 아이템
    G.itemT -= dt;
    if (G.itemT <= 0) { spawnItem(); G.itemT = 9 + Math.random() * 6; }

    const sk = G.slow > 0 ? 0.45 : 1;
    const top = GROUND - PH, hx = PW / 2 - 5;   // 판정은 몸보다 살짝 좁게(억울하지 않게)

    // 똥
    const born = [];
    for (const p of G.poops) {
      p.y += p.vy * sk * dt; p.x += p.vx * sk * dt; p.rot += p.spin * dt;
      if (p.type === 'split' && p.y >= p.splitY) {
        p.dead = true; burst(p.x, p.y, 5, '#a16207'); ddSnd('splat');
        for (const vx of [-90, 0, 90]) born.push(['mini', p.x, { y: p.y, vy: p.vy * 1.05, vx }]);
        continue;
      }
      if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx); }
      if (p.x > LW - p.r) { p.x = LW - p.r; p.vx = -Math.abs(p.vx); }
      // 아이와 부딪힘(원 ↔ 사각형)
      const cx = Math.max(G.px - hx, Math.min(G.px + hx, p.x)), cy = Math.max(top + 6, Math.min(GROUND, p.y));
      const dx = p.x - cx, dy = p.y - cy;
      if (dx * dx + dy * dy < (p.r * 0.82) ** 2 && hitPlayer(p)) { p.dead = true; if (G.phase !== 'play') return; continue; }
      if (p.y + p.r * 0.6 >= GROUND) {
        p.dead = true; G.score++;
        G.splats.push({ x: p.x, r: p.r, t: 0 });
        if (Math.random() < 0.35) ddSnd('splat');
      }
    }
    G.poops = G.poops.filter(p => !p.dead);
    for (const b of born) addPoop(b[0], b[1], b[2]);

    // 아이템 줍기
    for (const it of G.items) {
      it.t += dt; it.y += it.vy * dt;
      if (Math.abs(it.x - G.px) < PW / 2 + 12 && it.y > top - 12 && it.y < GROUND + 4) {
        it.dead = true; G.held = it.k; ddSnd('item');
        pop(`${DD_ITEMS[it.k].emoji} ${DD_ITEMS[it.k].name}`, G.px, GROUND - 80);
      } else if (it.y > GROUND + 10) it.dead = true;
    }
    G.items = G.items.filter(i => !i.dead);
  }

  function gameOver() {
    G.phase = 'over'; ptrs.clear();
    ddSnd('over');
    recordStat(key, { best: G.score });
    const gb = document.getElementById('gameBest'); if (gb) gb.textContent = ddAggFmt();
    const rec = G.score > prevBest && G.score > 0;
    setTimeout(() => {
      if (!el.contains(cv)) return;
      $ov.innerHTML = `<div class="ft-ov-card">
        <div class="ft-ov-t">${rec ? '🎉 새 기록!' : '💩 철퍼덕!'}</div>
        <div class="ft-ov-t"><b>${G.score}</b>점</div>
        <div class="ft-ov-s">${stage()}단계 · ${G.t.toFixed(1)}초 버팀 · 최고 ${Math.max(prevBest, G.score)}점</div>
        <div class="ft-ov-btns"><button class="btn primary" id="ddAgain">다시 하기</button><button class="btn ghost" id="ddMenu">처음으로</button></div>
      </div>`;
      $ov.classList.remove('hidden');
      $ov.querySelector('#ddAgain').onclick = () => runDdong(el, M.k);
      $ov.querySelector('#ddMenu').onclick = () => { stop(); startDdong(el); };
    }, 700);
  }

  // ── 그리기 ──
  function drawPoop(x, y, r, rot, angry) {
    g.save(); g.translate(x, y); g.rotate(rot);
    const k = r / 14;
    g.scale(k, k);
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.beginPath(); g.ellipse(1, 12, 15, 4, 0, 0, Math.PI * 2); g.fill();
    const body = angry ? '#7c2d12' : '#8b5a2b', hi = angry ? '#b45309' : '#b07a43';
    const blob = (cy, rx, ry) => {
      g.fillStyle = body; g.beginPath(); g.ellipse(0, cy, rx, ry, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = hi; g.beginPath(); g.ellipse(-rx * 0.35, cy - ry * 0.35, rx * 0.35, ry * 0.3, 0, 0, Math.PI * 2); g.fill();
    };
    blob(6, 15, 7); blob(-2, 11, 6); blob(-9, 7, 5);
    g.fillStyle = body; g.beginPath(); g.moveTo(-3, -12); g.quadraticCurveTo(2, -20, 5, -17); g.quadraticCurveTo(2, -14, 3, -11); g.fill();
    // 얼굴
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(-5, 3, 3.2, 0, Math.PI * 2); g.arc(5, 3, 3.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#111';
    g.beginPath(); g.arc(-4.4, 3.6, 1.6, 0, Math.PI * 2); g.arc(5.6, 3.6, 1.6, 0, Math.PI * 2); g.fill();
    if (angry) {
      g.strokeStyle = '#111'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(-8, -1.5); g.lineTo(-2.5, 0.5); g.moveTo(8, -1.5); g.lineTo(2.5, 0.5); g.stroke();
    }
    g.strokeStyle = '#111'; g.lineWidth = 1.3;
    g.beginPath();
    if (angry) g.arc(0, 11, 3, Math.PI * 1.15, Math.PI * 1.85); else g.arc(0, 7, 3, 0.15 * Math.PI, 0.85 * Math.PI);
    g.stroke();
    g.restore();
  }

  function drawCloud() {
    const fury = G.fury > 0;
    const sx = G.cloudShake > 0 && fury ? (Math.random() - 0.5) * 6 : 0;
    const x = G.cloudX + sx, y = 38;
    // 구름 띠(화면 전체) + 가운데 큰 얼굴 구름
    g.fillStyle = fury ? '#7f1d1d' : '#64748b';
    for (let i = -1; i < 9; i++) { g.beginPath(); g.arc(i * 46 + ((G.t * 8) % 46), 18, 30, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = fury ? '#b91c1c' : '#94a3b8';
    for (const [dx, dy, r] of [[-52, 6, 26], [-24, -6, 32], [12, -10, 36], [48, 0, 28], [0, 12, 30], [-36, 16, 22], [36, 16, 22]]) {
      g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI * 2); g.fill();
    }
    // 얼굴: 찌푸린 눈썹과 입
    g.fillStyle = '#fff';
    g.beginPath(); g.ellipse(x - 16, y + 4, 8, 7, 0, 0, Math.PI * 2); g.ellipse(x + 16, y + 4, 8, 7, 0, 0, Math.PI * 2); g.fill();
    const look = Math.max(-3, Math.min(3, (G.px - x) / 40));
    g.fillStyle = '#111';
    g.beginPath(); g.arc(x - 16 + look, y + 6, 3.5, 0, Math.PI * 2); g.arc(x + 16 + look, y + 6, 3.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = fury ? 4 : 3; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x - 27, y - 8 - (fury ? 3 : 0)); g.lineTo(x - 8, y - 2); g.moveTo(x + 27, y - 8 - (fury ? 3 : 0)); g.lineTo(x + 8, y - 2); g.stroke();
    g.beginPath();
    if (fury) { g.ellipse(x, y + 22, 9, 6, 0, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill(); }
    else { g.arc(x, y + 28, 8, Math.PI * 1.2, Math.PI * 1.8); g.stroke(); }
    if (fury) { g.font = '20px system-ui'; g.textAlign = 'center'; g.fillText('💢', x + 44, y - 18); }
  }

  function drawKid() {
    const x = G.px, base = GROUND;
    if (G.inv > 0 && Math.floor(G.inv * 12) % 2 === 0 && G.phase === 'play') return;
    const step = G.vx ? Math.sin(G.walk) : 0;
    g.save(); g.translate(x, base);
    g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(0, 2, 18, 4, 0, 0, Math.PI * 2); g.fill();
    // 다리
    g.strokeStyle = '#1e3a8a'; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-5, -16); g.lineTo(-5 - step * 4, -2); g.moveTo(5, -16); g.lineTo(5 + step * 4, -2); g.stroke();
    // 몸
    g.fillStyle = '#facc15'; g.beginPath(); g.roundRect ? g.roundRect(-11, -32, 22, 18, 6) : g.rect(-11, -32, 22, 18); g.fill();
    // 팔(머리를 감싸는 자세)
    g.strokeStyle = '#fcd34d'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(-10, -28); g.lineTo(-15, -40); g.lineTo(-8, -48); g.moveTo(10, -28); g.lineTo(15, -40); g.lineTo(8, -48); g.stroke();
    // 머리
    g.fillStyle = '#fde3c4'; g.beginPath(); g.arc(0, -42, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3f2a1d'; g.beginPath(); g.arc(0, -45, 10, Math.PI, 0); g.fill();
    g.fillStyle = '#111';
    g.beginPath(); g.arc(-3.5 + G.face * 1.5, -41, 1.4, 0, Math.PI * 2); g.arc(3.5 + G.face * 1.5, -41, 1.4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = 1.2; g.beginPath(); g.arc(G.face * 1.5, -36, 2.2, 0, Math.PI * 2); g.stroke();   // '헉' 입
    g.restore();
    if (G.shield > 0) {
      g.strokeStyle = `rgba(248,250,252,${0.5 + 0.3 * Math.sin(performance.now() / 120)})`; g.lineWidth = 3;
      g.beginPath(); g.arc(x, base - 26, 34, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.font = '16px system-ui'; g.textAlign = 'center'; g.fillText('🧻', x, base - 64);
    }
  }

  function draw() {
    g.setTransform(cv.width / LW, 0, 0, cv.height / LH, 0, 0);
    g.save();
    if (G.shake > 0) g.translate((Math.random() - 0.5) * 10 * G.shake / 0.4, (Math.random() - 0.5) * 8 * G.shake / 0.4);
    // 하늘
    const sky = g.createLinearGradient(0, 0, 0, GROUND);
    if (G.fury > 0) { sky.addColorStop(0, '#450a0a'); sky.addColorStop(1, '#9a3412'); }
    else { sky.addColorStop(0, '#1e3a5f'); sky.addColorStop(1, G.slow > 0 ? '#5b8bb8' : '#7dd3fc'); }
    g.fillStyle = sky; g.fillRect(-10, -10, LW + 20, GROUND + 10);
    // 먼 산·집
    g.fillStyle = G.fury > 0 ? '#7c2d12' : '#4d7c0f';
    g.beginPath(); g.moveTo(-10, GROUND); g.lineTo(60, GROUND - 70); g.lineTo(130, GROUND); g.lineTo(200, GROUND - 50); g.lineTo(280, GROUND - 90); g.lineTo(370, GROUND); g.fill();
    // 땅
    g.fillStyle = '#65a30d'; g.fillRect(-10, GROUND, LW + 20, LH - GROUND + 10);
    g.fillStyle = '#4d7c0f'; for (let x = 0; x < LW; x += 18) g.fillRect(x, GROUND, 9, 4);
    // 철퍼덕 자국
    for (const s of G.splats) {
      g.globalAlpha = Math.max(0, 1 - s.t / 1.2);
      g.fillStyle = '#78350f';
      g.beginPath(); g.ellipse(s.x, GROUND + 2, s.r * 1.3, s.r * 0.35, 0, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
    drawCloud();
    // 아이템
    for (const it of G.items) {
      g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(it.x, it.y, 15 + Math.sin(it.t * 8) * 1.5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fde047'; g.lineWidth = 2.5; g.stroke();
      g.font = '18px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(DD_ITEMS[it.k].emoji, it.x, it.y + 1);
    }
    for (const p of G.poops) drawPoop(p.x, p.y, p.r, p.rot, p.fury || p.type === 'split');
    drawKid();
    for (const p of G.parts) {
      g.globalAlpha = Math.max(0, 1 - p.t / 0.8); g.fillStyle = p.col;
      g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    }
    g.restore();

    // 조작 칸(아래): ◀ | 아이템 | ▶
    const cy = GROUND + 30;
    g.fillStyle = 'rgba(0,0,0,.22)';
    g.fillRect(0, GROUND + 8, LW * 0.36 - 2, LH - GROUND - 8); g.fillRect(LW * 0.64 + 2, GROUND + 8, LW * 0.36 - 2, LH - GROUND - 8);
    g.fillStyle = 'rgba(255,255,255,.75)'; g.font = '900 24px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('◀', LW * 0.18, cy); g.fillText('▶', LW * 0.82, cy);
    g.fillStyle = G.held ? 'rgba(253,224,71,.95)' : 'rgba(255,255,255,.25)';
    g.beginPath(); g.arc(LW / 2, cy, 22, 0, Math.PI * 2); g.fill();
    g.font = '22px system-ui'; g.fillStyle = '#111';
    g.fillText(G.held ? DD_ITEMS[G.held].emoji : '·', LW / 2, cy + 1);
    if (G.held) { g.font = '800 10px system-ui'; g.fillStyle = '#fff'; g.fillText('눌러서 쓰기', LW / 2, cy + 30 > LH - 4 ? LH - 6 : cy + 30); }

    // 점수·상태
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '900 22px system-ui'; g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.6)';
    g.strokeText(String(G.score), 10, 80); g.fillStyle = '#fde047'; g.fillText(String(G.score), 10, 80);
    g.font = '800 12px system-ui'; g.fillStyle = '#fff';
    g.fillText(`${stage()}단계 · ${G.t.toFixed(1)}초`, 10, 106);
    g.textAlign = 'right';
    if (M.lives > 1) { g.font = '16px system-ui'; g.fillText('❤️'.repeat(Math.max(0, G.lives)) + '🤍'.repeat(M.lives - Math.max(0, G.lives)), LW - 8, 80); }
    let sy = M.lives > 1 ? 102 : 80;
    g.font = '800 12px system-ui';
    if (G.shield > 0) { g.fillText(`🧻 ${G.shield.toFixed(1)}초`, LW - 8, sy); sy += 16; }
    if (G.slow > 0) { g.fillText(`⏳ ${G.slow.toFixed(1)}초`, LW - 8, sy); sy += 16; }
    if (G.fury > 0) { g.fillStyle = '#fca5a5'; g.fillText(`💢 ${Math.max(0, G.fury).toFixed(1)}초`, LW - 8, sy); }

    if (G.flash > 0) { g.fillStyle = `rgba(255,255,255,${G.flash})`; g.fillRect(0, 0, LW, LH); }
    // 팝업
    for (const p of G.pops) {
      g.globalAlpha = Math.max(0, 1 - p.t / 1.1); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 ${p.big ? 26 : 16}px system-ui`;
      g.lineWidth = 4; g.strokeStyle = '#451a03'; g.strokeText(p.text, p.x, p.y - p.t * 36);
      g.fillStyle = '#fde047'; g.fillText(p.text, p.x, p.y - p.t * 36); g.globalAlpha = 1;
    }
    if (G.phase === 'ready') {
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, LW, LH);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = '900 40px system-ui'; g.fillText(G.readyT > 0.6 ? '준비…' : '피해!', LW / 2, LH * 0.42);
      g.font = '700 13px system-ui'; g.fillText('◀ 왼쪽 · 가운데 아이템 · 오른쪽 ▶', LW / 2, LH * 0.42 + 42);
    }
    if (G.paused && G.phase === 'play') {
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, LW, LH);
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '900 28px system-ui'; g.fillText('잠깐 멈춤', LW / 2, LH * 0.45);
    }
    $hud.textContent = `💩 ${G.score}점`;
  }

  function frame(ts) {
    G.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, G.last ? (ts - G.last) / 1000 : 0); G.last = ts;
    if (document.hidden) { G.paused = true; return; }
    if (G.paused) { G.paused = false; return; }   // 돌아온 첫 프레임은 건너뛰어 순간이동 방지
    update(dt);
    draw();
  }

  function stop() {
    cancelAnimationFrame(G.raf);
    window.removeEventListener('resize', fit);
    removeEventListener('keydown', onKey); removeEventListener('keyup', onKey);
    if (ddStop === stop) ddStop = null;
  }
  ddStop = stop;
  cv._dd = { G, update, useItem };   // 시험용
  const back = document.getElementById('gameBack');
  if (back) back.onclick = () => { stop(); startDdong(el); };
  G.raf = requestAnimationFrame(frame);
}
