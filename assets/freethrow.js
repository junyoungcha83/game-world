// ── 자유투(오락실 농구기계) — 스포츠 ─────────────────────────────
// 화면 아래 공을 손가락으로 '아래 → 위'로 휙 튕기면 던진다.
//  · 튕기는 빠르기(손가락 속도) → 던지는 힘. 너무 느리면 짧고, 너무 빠르면 백보드를 세게 맞는다.
//  · 튕기는 방향(위쪽에서 기운 각도) → 좌우 방향. 똑바로 위로 튕겨야 정면으로 날아간다.
//  · 레벨(초급·중급·고급): 힘·방향 오차를 얼마나 줄여 주는지가 다르다(고급은 거의 그대로 반영).
// 방식: ⏱1분(60초 동안 몇 골) / 🏀10구(10번 던져 몇 골). 2인은 한 기기에서 1P가 다 던진 뒤 2P가 던진다.
// 그림은 오락실 농구기계(노란 백보드·빨간 LED 점수판·파란 프레임·철망 케이지·경사 레일)를 본떴다.
// 세계 좌표(미터): x 오른쪽, y 위, z 앞(백보드 쪽). 공 출발점 (0,0,0).
// 이 파일은 app.js 보다 먼저 읽힌다 — app.js 의 함수(recordStat·getStat·sfxCtx 등)는 실행 시점에만 쓴다.

const FT_LEVELS = [
  // pk: 힘 오차 반영 비율, dk: 방향 오차 반영 비율, dz: 이 각도(도)까지 기울어도 정면으로 친다
  { k: 'e', label: '초급', desc: '힘·방향이 조금 틀려도 들어가요', pk: 0.30, dk: 0.28, dz: 8 },
  { k: 'm', label: '중급', desc: '꽤 정확하게 튕겨야 해요',       pk: 0.55, dk: 0.50, dz: 3 },
  { k: 'h', label: '고급', desc: '아주 정확해야 들어가요',         pk: 1.00, dk: 0.80, dz: 0 },
];
const FT_MODES = [
  { k: 't60', label: '1분', desc: '60초 동안 몇 골?' },
  { k: 'b10', label: '10구', desc: '10번 던져 몇 골?' },
];
const ftKey = (lv, md) => `ft_${lv}_${md}`;
const ftFmt = s => s ? `${s.plays}판 · 최고 ${s.best || 0}골` : '아직 기록 없음';
function ftBoardEntries() {
  const out = [];
  for (const m of FT_MODES) for (const l of FT_LEVELS)
    out.push({ id: ftKey(l.k, m.k), emoji: '🏀', name: `자유투 ${m.label} ${l.label}`, best: 'high', fmtStat: ftFmt });
  return out;
}
function ftAggFmt() {
  const u = getCurrentUser(); if (!u) return '아직 기록 없음';
  const parts = [];
  for (const m of FT_MODES) for (const l of FT_LEVELS) {
    const s = getStat(ftKey(l.k, m.k), u);
    if (s && s.plays) parts.push(`${m.label}${l.label} ${s.best || 0}골`);
  }
  return parts.length ? parts.slice(0, 3).join(' · ') : '아직 기록 없음';
}

// ── 물리 상수 ──
const FT = {
  g: 9.8, rb: 0.12, Rr: 0.23, tube: 0.014,          // 공 반지름, 림 반지름, 림 쇠 굵기
  hx: 0, hy: 1.55, hz: 2.7,                          // 림 중심
  alpha: 66 * Math.PI / 180,                         // 던지는 앙각(고정) — 힘은 속력만 바꾼다
  wallX: 0.95, ceil: 2.75, slope: 0.1, floor0: -0.12, // 케이지 벽, 천장, 경사 레일(앞이 낮다)
  S0: 3.0,                                           // '딱 좋은' 튕기기 빠르기(캔버스 높이/초)
  LW: 360, LH: 620,                                  // 논리 캔버스 크기
  camY: 0.45, camZ: -1.1,
};
FT.zb = FT.hz + FT.Rr + 0.11;                        // 백보드 앞면
FT.ceilPhys = 4.5;                                   // 공이 실제로 부딪히는 천장(화면 위 철망보다 높다 — 세게 던진 공이 천장에 튕겨 쏙 들어가지 않게)
FT.vIdeal = (() => {                                 // 림 한가운데로 떨어지는 속력
  const d = FT.hz, dh = FT.hy, c = Math.cos(FT.alpha);
  return Math.sqrt(FT.g * d * d / (2 * c * c * (d * Math.tan(FT.alpha) - dh)));
})();
FT.f = 0.864 * FT.LH; FT.hzn = 0.487 * FT.LH;        // 초점거리·지평선(논리 px)
const ftFloorY = z => FT.floor0 + FT.slope * z;
// 레벨별 '깨끗이 들어가는' 허용 폭 — 화면의 힘·방향 게이지 초록 칸에 쓴다
const ftPowTol = L => 0.03 / (L.pk * 0.55);         // 튕기기 빠르기 비율(1±tol)
const ftDirTol = L => L.dz + 3.0 / L.dk;             // 튕기는 각도(도)

let ftStop = null;
function ftLeave() { if (ftStop) { const f = ftStop; ftStop = null; f(); } }

// ── 효과음 ──
function ftSnd(kind, s) {
  if (typeof sfxCtx !== 'function') return;
  const c = sfxCtx(); if (!c || !sfx.master) return;
  const t = c.currentTime;
  s = Math.max(0.05, Math.min(1, s == null ? 0.6 : s));
  const noise = (filter, freq, vol, dur, q) => {
    const src = c.createBufferSource(); src.buffer = bgm.noise;
    const f = c.createBiquadFilter(); f.type = filter; f.frequency.value = freq; if (q) f.Q.value = q;
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
    case 'throw': noise('bandpass', 700 + 900 * s, 0.10 + 0.12 * s, 0.16, 0.8); break;
    case 'rim': noise('highpass', 2500, 0.12 + 0.25 * s, 0.03);
      tone('triangle', 1650, 0.10 + 0.22 * s, 0.22, 1500); tone('triangle', 2730, 0.05 + 0.12 * s, 0.14, 2500); break;
    case 'board': noise('lowpass', 500, 0.18 + 0.3 * s, 0.08); tone('sine', 150, 0.2 + 0.25 * s, 0.12, 90); break;
    case 'floor': noise('lowpass', 400, 0.08 + 0.2 * s, 0.06); tone('sine', 110, 0.12 + 0.2 * s, 0.08, 70); break;
    case 'swish': noise('highpass', 3200, 0.22, 0.28); break;
    case 'goal': tone('square', 880, 0.06, 0.09); tone('square', 1320, 0.06, 0.12, null, 0.08); break;
    case 'beep': tone('sine', 660, 0.25, 0.15); break;
    case 'go': tone('sine', 990, 0.3, 0.3); break;
    case 'buzz': tone('sawtooth', 160, 0.16, 0.7); tone('square', 120, 0.08, 0.7); break;
  }
}

// ── 설정 화면 ──
function ftLoadCfg() {
  let c = {}; try { c = JSON.parse(localStorage.getItem('ft-setup') || '{}') || {}; } catch {}
  return { np: c.np === 2 ? 2 : 1, md: FT_MODES.some(m => m.k === c.md) ? c.md : 't60',
           lv: FT_LEVELS.some(l => l.k === c.lv) ? c.lv : 'e', p2: typeof c.p2 === 'string' ? c.p2 : '' };
}
function ftSaveCfg(c) { try { localStorage.setItem('ft-setup', JSON.stringify(c)); } catch {} }

function startFreethrow(el) {
  ftLeave();
  const back = document.getElementById('gameBack'); if (back) back.onclick = () => showView('hub');
  const cfg = ftLoadCfg();
  const me = getCurrentUser();
  const others = (state.users || []).filter(u => !me || u.id !== me.id);
  if (cfg.p2 && !others.some(u => u.id === cfg.p2)) cfg.p2 = '';
  const render = () => {
    const best = getStat(ftKey(cfg.lv, cfg.md));
    const L = FT_LEVELS.find(l => l.k === cfg.lv);
    const seg = (g, items) => `<div class="ft-seg" data-g="${g}">${items.map(it =>
      `<button data-v="${escapeHtml(String(it.v))}" class="${String(cfg[g]) === String(it.v) ? 'on' : ''}">${it.html}</button>`).join('')}</div>`;
    el.innerHTML = `<div class="mg ft-setup">
      <div class="mg-msg">🏀 자유투 — 공을 손가락으로 <b>아래에서 위로 휙</b> 튕겨 던져요</div>
      <div class="ft-row"><span class="ft-lab">인원</span>${seg('np', [{ v: 1, html: '1인' }, { v: 2, html: '2인' }])}</div>
      ${cfg.np === 2 ? `<div class="ft-row"><span class="ft-lab">2P</span>${seg('p2', others.map(u => ({ v: u.id, html: escapeHtml(u.name) })).concat([{ v: '', html: '손님' }]))}</div>` : ''}
      <div class="ft-row"><span class="ft-lab">방식</span>${seg('md', FT_MODES.map(m => ({ v: m.k, html: `${m.label}<small>${m.desc}</small>` })))}</div>
      <div class="ft-row"><span class="ft-lab">레벨</span>${seg('lv', FT_LEVELS.map(l => ({ v: l.k, html: l.label })))}</div>
      <div class="ft-desc">${escapeHtml(L.desc)}</div>
      <label class="fb-opt"><input type="checkbox" id="ftSfx"${sfxEnabled() ? ' checked' : ''}> <b>효과음</b>
        <small>림·백보드에 맞는 소리, 골인 소리</small></label>
      <div class="ft-best">${me ? escapeHtml(me.name) + ' · ' : ''}${FT_MODES.find(m => m.k === cfg.md).label} ${L.label} 최고 <b>${best && best.plays ? (best.best || 0) + '골' : '-'}</b></div>
      <button class="btn primary ft-go">시작!</button>
      <div class="sd-help">공을 누른 채 <b>위로 빠르게 쓸어 올리고 손을 떼면</b> 던져요.<br>
        세게 튕길수록 멀리 날아가요. 비스듬히 튕기면 옆으로 빗나가요.<br>
        던진 뒤 아래쪽 <b>힘·방향 게이지</b>를 보고 초록 칸에 맞춰 보세요.${cfg.np === 2 ? '<br>2인: 1P가 다 던지면 2P가 이어서 던져요.' : ''}</div>
    </div>`;
    el.querySelectorAll('.ft-seg').forEach(sg => sg.querySelectorAll('button').forEach(b => b.onclick = () => {
      const g = sg.dataset.g; let v = b.dataset.v;
      cfg[g] = g === 'np' ? +v : v;
      ftSaveCfg(cfg); render();
    }));
    const cb = el.querySelector('#ftSfx'); if (cb) cb.onchange = () => { sfxSet(cb.checked); if (cb.checked) ftSnd('swish'); };
    el.querySelector('.ft-go').onclick = () => runFreethrow(el, { ...cfg });
  };
  render();
}

// ── 경기 ──
function runFreethrow(el, cfg) {
  ftLeave();
  const L = FT_LEVELS.find(l => l.k === cfg.lv) || FT_LEVELS[0];
  const M = FT_MODES.find(m => m.k === cfg.md) || FT_MODES[0];
  const key = ftKey(L.k, M.k);
  const timed = M.k === 't60';
  const me = getCurrentUser();
  const p2u = cfg.np === 2 ? (state.users || []).find(u => u.id === cfg.p2) : null;
  const players = [{ name: me ? me.name : '1P', score: 0, thrown: 0 }];
  if (cfg.np === 2) players.push({ name: p2u ? p2u.name : '손님', score: 0, thrown: 0 });
  const prevBest = (getStat(key) || {}).best || 0;

  el.innerHTML = `<div class="ft-wrap">
    <div class="ft-top"><span class="ft-who"></span><span class="ft-tag">${M.label} · ${L.label}</span></div>
    <div class="ft-stage"><canvas class="ft-cv"></canvas><div class="ft-ov hidden"></div></div>
  </div>`;
  const cv = el.querySelector('.ft-cv'); let g = cv.getContext('2d');
  const $ov = el.querySelector('.ft-ov'), $who = el.querySelector('.ft-who'), $stage = el.querySelector('.ft-stage');
  const { LW, LH, f: F, hzn: HZ } = FT;

  let cssW = 0, cssH = 0, dpr = 1;
  function fit() {
    const tab = document.querySelector('.tab-bar');
    const bottom = tab ? tab.getBoundingClientRect().top : innerHeight;
    const avail = Math.max(320, bottom - $stage.getBoundingClientRect().top - 6);
    cssW = Math.min($stage.clientWidth || 360, 480); cssH = cssW * LH / LW;
    if (cssH > avail) { cssH = avail; cssW = cssH * LW / LH; }
    dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    $stage.style.height = cssH + 'px';
  }
  fit();
  window.addEventListener('resize', fit);

  // 투영: 세계(미터) → 논리 캔버스 px
  const P = (x, y, z) => { const d = z - FT.camZ; return [LW / 2 + F * x / d, HZ - F * (y - FT.camY) / d, F / d]; };

  const G = { nextT: 0, pi: 0, phase: 'count', cd: 3.2, timeLeft: 60, balls: [], hasBall: true, popT: 0,
              pops: [], netW: 0, fb: null, trail: [], settleT: 0, raf: 0, lastTs: 0, hint: 1, beepN: 4, flash: 0 };
  const cur = () => players[G.pi];
  const setWho = () => { $who.textContent = (cfg.np === 2 ? `${G.pi + 1}P ` : '') + cur().name; };
  setWho();

  // ── 입력: 튕기기 ──
  let drag = null;
  const canThrow = () => G.phase === 'play' && G.hasBall && G.popT > 0.15;
  const toLogical = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * LW, (e.clientY - r.top) / r.height * LH]; };
  cv.addEventListener('pointerdown', e => {
    if (!canThrow()) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    drag = { id: e.pointerId, s: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
    G.trail = [toLogical(e)];
  });
  cv.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    drag.s.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    if (drag.s.length > 60) drag.s.shift();
    G.trail.push(toLogical(e)); if (G.trail.length > 24) G.trail.shift();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const s = drag.s; drag = null;
    s.push({ t: performance.now(), x: e.clientX, y: e.clientY });
    const last = s[s.length - 1];
    let first = s[0];
    for (let i = s.length - 1; i >= 0; i--) { if (last.t - s[i].t > 90) break; first = s[i]; }   // 손 떼기 직전 90ms 의 움직임
    if (first === last && s.length > 1) first = s[s.length - 2];
    const dx = last.x - first.x, dy = last.y - first.y, dt = Math.max(8, last.t - first.t);
    const totalUp = s[0].y - last.y;
    if (totalUp < 25 || dy >= -4 || !canThrow()) return;   // 위로 튕긴 게 아니면 무시
    const sN = Math.hypot(dx, dy) / dt * 1000 / cssH;      // 캔버스 높이/초
    const theta = Math.atan2(dx, -dy) * 180 / Math.PI;      // 0 = 똑바로 위, + = 오른쪽
    shoot(sN, theta);
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) drag = null; });
  const stopTouch = e => { if (e.target === cv) e.preventDefault(); };
  cv.addEventListener('touchmove', stopTouch, { passive: false });

  function shoot(sN, theta) {
    const pr = sN / FT.S0;
    const vT = FT.vIdeal * 1.008;                        // 림 가운데보다 아주 살짝 깊게 — 시험해 보니 이 속력 앞뒤로 깨끗이 들어간다
    const raw = vT * (0.45 + 0.55 * pr);
    let v = vT + (raw - vT) * L.pk;                      // 레벨별로 오차를 줄여 반영
    v = Math.max(FT.vIdeal * 0.5, Math.min(FT.vIdeal * 1.45, v));
    const a = Math.abs(theta);
    let phi = Math.sign(theta) * Math.max(0, a - L.dz) * L.dk;
    phi = Math.max(-25, Math.min(25, phi)) * Math.PI / 180;
    const vh = v * Math.cos(FT.alpha);
    G.balls.push({ x: 0, y: 0, z: 0, vx: vh * Math.sin(phi), vy: v * Math.sin(FT.alpha), vz: vh * Math.cos(phi),
                   rot: 0, age: 0, prevY: 0, scored: false, lastSnd: 0, bounces: 0 });
    cur().thrown++;
    G.hint = 0;
    G.fb = { pr, theta, t: 0 };
    G.hasBall = false; G.popT = 0;
    ftSnd('throw', Math.min(1, pr * 0.6));
    if (!timed && cur().thrown >= 10) { G.phase = 'settle'; G.settleT = 0; }
    else G.nextT = 0.38;
  }

  // ── 물리 ──
  function step(b, dt) {
    b.age += dt;
    b.vy -= FT.g * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    b.rot += (b.vz * 0.9 + Math.abs(b.vx)) * dt * 6;
    const dx = b.x - FT.hx, dz = b.z - FT.hz, rad = Math.hypot(dx, dz);
    // 그물 — 지나가는 공을 살짝 붙잡고 가운데로 모은다
    if (b.y < FT.hy && b.y > FT.hy - 0.45 && rad < FT.Rr) {
      const k = 1 - 3.5 * dt; b.vx *= k; b.vz *= k; b.vy *= (1 - 1.0 * dt);
      b.vx -= dx * 8 * dt; b.vz -= dz * 8 * dt;
    }
    // 골 판정 — 림 높이를 위→아래로 림 안쪽에서 지나가면
    if (!b.scored && b.prevY >= FT.hy && b.y < FT.hy && rad < FT.Rr - 0.015) goal(b);
    b.prevY = b.y;
    // 림(도넛 모양 쇠고리)
    if (rad > 1e-6) {
      const kx = FT.hx + dx / rad * FT.Rr, kz = FT.hz + dz / rad * FT.Rr;
      const ex = b.x - kx, ey = b.y - FT.hy, ez = b.z - kz, d = Math.hypot(ex, ey, ez), min = FT.rb + FT.tube;
      if (d < min && d > 1e-6) {
        const nx = ex / d, ny = ey / d, nz = ez / d;
        b.x = kx + nx * min; b.y = FT.hy + ny * min; b.z = kz + nz * min;
        const vn = b.vx * nx + b.vy * ny + b.vz * nz;
        if (vn < 0) {
          b.vx -= 1.55 * vn * nx; b.vy -= 1.55 * vn * ny; b.vz -= 1.55 * vn * nz;
          b.vx *= 0.92; b.vy *= 0.92; b.vz *= 0.92;
          if (-vn > 0.4 && b.age - b.lastSnd > 0.06) { b.lastSnd = b.age; ftSnd('rim', -vn / 4); G.rimShake = Math.min(1, -vn / 3); }
        }
      }
    }
    // 백보드(뒤판 전체)
    if (b.z + FT.rb > FT.zb) {
      b.z = FT.zb - FT.rb;
      if (b.vz > 0) { if (b.vz > 0.5) ftSnd('board', b.vz / 7); b.vz = -b.vz * 0.7; b.vx *= 0.9; b.vy *= 0.9; }
    }
    // 케이지 옆 철망·천장
    if (b.x - FT.rb < -FT.wallX) { b.x = -FT.wallX + FT.rb; if (b.vx < 0) b.vx = -b.vx * 0.45; }
    if (b.x + FT.rb > FT.wallX) { b.x = FT.wallX - FT.rb; if (b.vx > 0) b.vx = -b.vx * 0.45; }
    if (b.y + FT.rb > FT.ceilPhys) { b.y = FT.ceilPhys - FT.rb; if (b.vy > 0) b.vy = -b.vy * 0.4; }
    // 경사 레일 바닥 — 앞(던지는 사람 쪽)으로 굴러 내려온다
    const Ln = Math.hypot(1, FT.slope), nyy = 1 / Ln, nzz = -FT.slope / Ln;
    const dist = (b.y - ftFloorY(b.z)) * nyy;
    if (dist < FT.rb) {
      const push = FT.rb - dist; b.y += nyy * push; b.z += nzz * push;
      const vn = b.vy * nyy + b.vz * nzz;
      if (vn < 0) {
        const e = vn < -0.8 ? 0.45 : 0;
        b.vy -= (1 + e) * vn * nyy; b.vz -= (1 + e) * vn * nzz;
        if (vn < -0.8) { b.bounces++; ftSnd('floor', -vn / 6); }
      }
      b.vx *= (1 - 1.2 * dt); b.vz *= (1 - 0.25 * dt);
    }
  }
  function goal(b) {
    b.scored = true;
    cur().score++;
    G.netW = 1; G.flash = 1;
    const [sx, sy] = P(FT.hx, FT.hy, FT.hz);
    G.pops.push({ text: '골!', x: sx, y: sy - 30, t: 0 });
    ftSnd('swish'); setTimeout(() => ftSnd('goal'), 90);
    try { navigator.vibrate && navigator.vibrate(18); } catch {}
  }

  // ── 흐름 ──
  function endPlayer() {
    G.phase = 'between';
    const p = cur();
    if (cfg.np === 2 && G.pi === 0) {
      showOv(`<div class="ft-ov-card">
        <div class="ft-ov-t">1P ${escapeHtml(p.name)} <b>${p.score}골</b></div>
        <div class="ft-ov-s">${timed ? '1분 동안' : '10구 중'} ${p.score}골${timed ? ` · ${p.thrown}번 던짐` : ''}</div>
        <div class="ft-ov-n">이제 <b>2P ${escapeHtml(players[1].name)}</b> 차례!</div>
        <button class="btn primary" data-a="next">2P 시작</button></div>`);
      return;
    }
    finish();
  }
  function finish() {
    G.phase = 'over';
    let html;
    if (cfg.np === 1) {
      const p = players[0];
      const nb = p.score > prevBest;
      if (me) recordStat(key, { best: p.score });
      const gb = document.getElementById('gameBest'); if (gb) gb.textContent = ftAggFmt();
      html = `<div class="ft-ov-t">끝! <b>${p.score}골</b></div>
        <div class="ft-ov-s">${timed ? `1분 동안 ${p.thrown}번 던져 ${p.score}골` : `10구 중 ${p.score}골 (성공률 ${p.score * 10}%)`}</div>
        ${nb && p.score > 0 ? '<div class="ft-ov-n">🎉 최고 기록!</div>' : `<div class="ft-ov-s">최고 기록 ${Math.max(prevBest, p.score)}골</div>`}`;
    } else {
      const [a, b] = players;
      const w = a.score === b.score ? '무승부!' : `🏆 ${escapeHtml((a.score > b.score ? a : b).name)} 승리!`;
      html = `<div class="ft-ov-t">${w}</div>
        <div class="ft-ov-vs"><div><small>1P</small>${escapeHtml(a.name)}<b>${a.score}</b></div><span>:</span><div><small>2P</small>${escapeHtml(b.name)}<b>${b.score}</b></div></div>`;
    }
    showOv(`<div class="ft-ov-card">${html}
      <div class="ft-ov-btns"><button class="btn primary" data-a="again">다시 하기</button><button class="btn ghost" data-a="menu">설정으로</button></div></div>`);
  }
  function showOv(html) {
    $ov.innerHTML = html; $ov.classList.remove('hidden');
    $ov.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'next') { $ov.classList.add('hidden'); G.pi = 1; resetRound(); setWho(); }
      else if (a === 'again') runFreethrow(el, cfg);
      else if (a === 'menu') { stop(); startFreethrow(el); }
    });
  }
  function resetRound() {
    G.balls = []; G.pops = []; G.fb = null; G.trail = []; G.hint = 1;
    G.phase = 'count'; G.cd = 3.2; G.beepN = 4; G.timeLeft = 60; G.hasBall = true; G.popT = 0; G.settleT = 0; G.nextT = 0;
  }

  // ── 메인 루프 ──
  function frame(ts) {
    if (!document.body.contains(cv)) { stop(); return; }
    const dt = G.lastTs ? Math.min(0.05, (ts - G.lastTs) / 1000) : 0.016; G.lastTs = ts;
    update(dt); draw();
    G.raf = requestAnimationFrame(frame);
  }
  function update(dt) {
    if (G.phase === 'count') {
      G.cd -= dt;
      const n = Math.ceil(G.cd - 0.2);
      if (n < G.beepN && n >= 1) { G.beepN = n; ftSnd('beep'); }
      if (G.cd <= 0.2) { G.phase = 'play'; ftSnd('go'); G.pops.push({ text: '시작!', x: LW / 2, y: LH * 0.55, t: 0, big: 1 }); }
    } else if (G.phase === 'play') {
      if (timed) {
        G.timeLeft -= dt;
        if (G.timeLeft <= 0) { G.timeLeft = 0; G.phase = 'settle'; G.settleT = 0; G.hasBall = false; drag = null; ftSnd('buzz'); }
      }
    } else if (G.phase === 'settle') {
      G.settleT += dt;
      const flying = G.balls.some(b => !b.scored && b.age < 3 && b.z > 0.5);
      if (G.settleT > 3.5 || (!flying && G.settleT > 0.6)) endPlayer();
    }
    if (G.phase === 'play' && !G.hasBall && G.nextT > 0 && (G.nextT -= dt) <= 0) G.hasBall = true;
    if (G.hasBall && G.popT < 1) G.popT = Math.min(1, G.popT + dt / 0.25);
    const SUB = 8, h = dt / SUB;
    for (const b of G.balls) for (let i = 0; i < SUB; i++) step(b, h);
    G.balls = G.balls.filter(b => b.z > -0.3 && b.age < 7);
    G.netW = Math.max(0, G.netW - dt * 1.6);
    G.flash = Math.max(0, G.flash - dt * 2.5);
    G.rimShake = Math.max(0, (G.rimShake || 0) - dt * 4);
    for (const p of G.pops) p.t += dt;
    G.pops = G.pops.filter(p => p.t < 1.1);
    if (G.fb) G.fb.t += dt;
    if (!drag && G.trail.length) G.trail.shift();
  }

  // ── 그리기 ──
  function poly(pts, fill, stroke, lw) {
    g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); }
  }
  const line3 = (a, b) => { const p = P(...a), q = P(...b); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); };
  const zNear = -0.55;

  function drawRoom() {
    // 뒤 배경(오락실 벽) — 밝은 회백색
    const bg = g.createLinearGradient(0, 0, 0, LH);
    bg.addColorStop(0, '#d7dade'); bg.addColorStop(0.5, '#b9bec6'); bg.addColorStop(1, '#5b616b');
    g.fillStyle = bg; g.fillRect(0, 0, LW, LH);
    const W = FT.wallX, C = FT.ceil, zb = FT.zb + 0.02;
    // 천장 철망
    poly([P(-W, C, zNear), P(W, C, zNear), P(W, C, zb), P(-W, C, zb)], 'rgba(60,66,78,.25)');
    g.beginPath(); g.strokeStyle = 'rgba(40,44,52,.55)'; g.lineWidth = 1;
    for (let x = -W; x <= W + 1e-6; x += 0.12) line3([x, C, zNear], [x, C, zb]);
    for (let z = zNear; z <= zb; z += 0.16) line3([-W, C, z], [W, C, z]);
    g.stroke();
    // 옆 철망(양쪽)
    for (const sx of [-1, 1]) {
      const X = sx * W;
      poly([P(X, ftFloorY(zNear) - 0.4, zNear), P(X, C, zNear), P(X, C, zb), P(X, ftFloorY(zb), zb)], 'rgba(70,76,88,.18)');
      g.beginPath(); g.strokeStyle = 'rgba(40,44,52,.5)'; g.lineWidth = 1;
      for (let z = zNear; z <= zb; z += 0.14) line3([X, ftFloorY(z) - 0.4, z], [X, C, z]);
      for (let y = -0.4; y <= C; y += 0.14) line3([X, y, zNear], [X, y, zb]);
      g.stroke();
      // 파란 프레임 기둥(뒤쪽)·윗변
      g.lineCap = 'round';
      g.beginPath(); g.strokeStyle = '#1e40af'; g.lineWidth = 9; line3([X, C, zNear], [X, C, zb]); g.stroke();
      g.beginPath(); g.strokeStyle = '#2563eb'; g.lineWidth = 4; line3([X, C, zNear], [X, C, zb]); g.stroke();
    }
    // 뒤판 둘레 파란 프레임
    const fx = 0.84, fyb = ftFloorY(FT.zb), fyt = C;
    poly([P(-W, fyb, zb), P(-fx, fyb, zb), P(-fx, fyt, zb), P(-W, fyt, zb)], '#f1f2f4');
    poly([P(fx, fyb, zb), P(W, fyb, zb), P(W, fyt, zb), P(fx, fyt, zb)], '#f1f2f4');
    poly([P(-fx, fyb, zb), P(fx, fyb, zb), P(fx, fyt, zb), P(-fx, fyt, zb)], '#1d3fa8');
    g.beginPath(); g.strokeStyle = '#3b6ae0'; g.lineWidth = 2;
    line3([-fx + 0.03, fyb, zb], [-fx + 0.03, fyt - 0.03, zb]); line3([fx - 0.03, fyb, zb], [fx - 0.03, fyt - 0.03, zb]);
    line3([-fx + 0.03, fyt - 0.03, zb], [fx - 0.03, fyt - 0.03, zb]); g.stroke();
  }

  // 7세그먼트 숫자
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
  function seg7(ch, x, y, w, h) {
    const t = Math.max(1.4, w * 0.17), on = SEG[ch] || '';
    const R = { a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + h / 2 - t / 2, w - 2 * t, t],
                f: [x, y + t * 0.6, t, h / 2 - t * 0.9], b: [x + w - t, y + t * 0.6, t, h / 2 - t * 0.9],
                e: [x, y + h / 2 + t * 0.3, t, h / 2 - t * 0.9], c: [x + w - t, y + h / 2 + t * 0.3, t, h / 2 - t * 0.9] };
    for (const k of 'abcdefg') { g.fillStyle = on.includes(k) ? '#ff3b30' : 'rgba(255,60,48,.12)'; g.fillRect(...R[k]); }
  }
  function ledBox(x, y, w, h, val, label) {
    g.fillStyle = '#120606'; g.fillRect(x, y, w, h);
    g.strokeStyle = '#4b5563'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    const s = String(val).padStart(3, ' ').slice(-3), dw = (w - 8) / 3;
    g.save(); g.shadowColor = 'rgba(255,40,30,.8)'; g.shadowBlur = 4;
    for (let i = 0; i < 3; i++) seg7(s[i], x + 4 + i * dw + dw * 0.12, y + h * 0.16, dw * 0.76, h * 0.68);
    g.restore();
    g.fillStyle = '#fff'; g.font = `800 ${Math.max(6, h * 0.36)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText(label, x + w / 2, y + h + 2);
  }

  function drawBoard() {
    const zb = FT.zb, bx = 0.75, by0 = ftFloorY(FT.zb) + 0.06, by1 = FT.ceil - 0.08;   // 노란 판이 바닥까지 내려온다(사진처럼)
    const [x0, y0, s] = P(-bx, by1, zb), [x1, y1] = P(bx, by0, zb);
    // 노란 판
    const yg = g.createLinearGradient(0, y0, 0, y1);
    yg.addColorStop(0, '#f4d81c'); yg.addColorStop(1, '#efc90f');
    g.fillStyle = yg; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    // 육각 무늬
    g.save(); g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 1;
    const hs = 0.07 * s;
    for (let r = 0, yy = y0; yy < y1 + hs; r++, yy += hs * 0.87) {
      for (let xx = x0 + (r % 2) * hs / 2; xx < x1 + hs; xx += hs) { g.beginPath(); g.arc(xx, yy, hs * 0.38, 0, Math.PI * 2); g.stroke(); }
    }
    // 림 뒤 밝은 조명
    const [rx, ry] = P(FT.hx, FT.hy - 0.2, zb);
    const lg = g.createRadialGradient(rx, ry, 4, rx, ry, 0.75 * s);
    lg.addColorStop(0, 'rgba(255,255,255,.85)'); lg.addColorStop(0.5, 'rgba(255,255,255,.35)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    // 큰 글자(아래쪽) — 그물 뒤로 비친다
    g.fillStyle = '#1d4ed8'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = `italic 900 ${0.16 * s}px system-ui,sans-serif`;
    g.fillText('GAME WORLD', (x0 + x1) / 2, P(0, FT.hy - 0.62, zb)[1]);
    g.font = `800 ${0.06 * s}px system-ui,sans-serif`; g.fillStyle = '#1e3a8a';
    g.fillText('ARCADE BASKETBALL', (x0 + x1) / 2, P(0, FT.hy - 0.74, zb)[1]);
    g.restore();
    g.strokeStyle = '#1e3a8a'; g.lineWidth = 2; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // 림 위 흰 사각형(슈팅 박스)
    const [qx0, qy0] = P(-0.24, FT.hy + 0.36, zb), [qx1, qy1] = P(0.24, FT.hy + 0.02, zb);
    g.strokeStyle = '#fff'; g.lineWidth = 3; g.strokeRect(qx0, qy0, qx1 - qx0, qy1 - qy0);
    // 양옆 장식 배지(일반 무늬)
    badge(-0.55, FT.hy + 0.15, '#1d4ed8', '★', s); badge(0.55, FT.hy + 0.2, '#dc2626', 'GO', s);
    badge(-0.56, FT.hy - 0.25, '#7c3aed', '3', s); badge(0.56, FT.hy - 0.22, '#0891b2', '♥', s);
    badge(-0.5, FT.hy - 0.95, '#ea580c', '2', s); badge(0.5, FT.hy - 0.95, '#16a34a', '✓', s);
    // 림 받침대
    const [bx0, byy] = P(-0.08, FT.hy - 0.02, zb), [bx1, byb] = P(0.08, FT.hy - 0.2, zb);
    g.fillStyle = '#9ca3af'; g.fillRect(bx0, byy, bx1 - bx0, byb - byy);
    g.beginPath(); g.strokeStyle = '#d1d5db'; g.lineWidth = 3;
    line3([0, FT.hy - 0.03, zb], [0, FT.hy - 0.01, FT.hz + FT.Rr]); g.stroke();
  }
  // 점수판·램프 — 매 프레임 바뀌는 부분
  function drawLed() {
    const zb = FT.zb, by1 = FT.ceil - 0.08, s = P(0, 0, zb)[2];
    // LED 점수판
    const ly0 = by1 - 0.13, lh = 0.17;
    const [lx0, lyy] = P(-0.68, ly0, zb), [lx1, lyb] = P(0.68, ly0 - lh - 0.1, zb);
    g.fillStyle = '#111827'; g.fillRect(lx0, lyy, lx1 - lx0, lyb - lyy);
    const bw = (lx1 - lx0 - 16) / 3, bh = (lh * s) * 0.82;
    const p = cur();
    let hiLab = 'HIGH SCORE', hiVal = Math.max(prevBest, cfg.np === 1 ? p.score : 0);
    if (cfg.np === 2) { if (G.pi === 1) { hiLab = '1P SCORE'; hiVal = players[0].score; } else hiVal = prevBest; }
    const mid = timed ? Math.ceil(G.phase === 'count' ? 60 : G.timeLeft) : Math.max(0, 10 - p.thrown);
    ledBox(lx0 + 4, lyy + 3, bw, bh, hiVal, hiLab);
    ledBox(lx0 + 8 + bw, lyy + 3, bw, bh, mid, timed ? 'TIME' : 'BALL');
    ledBox(lx0 + 12 + 2 * bw, lyy + 3, bw, bh, p.score, 'SCORE');
    // 초록 램프 4개 + 가운데 이름판
    const [gx, gy] = P(0, by1 - 0.06, zb);
    const lampOn = G.flash > 0 ? (Math.floor(G.flash * 10) % 2 === 0) : true;
    for (const k of [-0.5, -0.36, 0.36, 0.5]) {
      const [lx] = P(k, 0, zb);
      g.fillStyle = lampOn ? '#a3e635' : '#3f6212'; g.fillRect(lx - 0.045 * s, gy - 0.03 * s, 0.09 * s, 0.06 * s);
      g.strokeStyle = '#365314'; g.lineWidth = 1; g.strokeRect(lx - 0.045 * s, gy - 0.03 * s, 0.09 * s, 0.06 * s);
    }
    g.fillStyle = '#fff'; g.fillRect(gx - 0.2 * s, gy - 0.035 * s, 0.4 * s, 0.07 * s);
    g.fillStyle = '#dc2626'; g.font = `900 ${0.05 * s}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('FREE THROW', gx, gy + 0.002 * s);
  }
  function badge(x, y, col, txt, s) {
    const [cx, cy] = P(x, y, FT.zb), r = 0.09 * s;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.beginPath(); g.arc(cx, cy, r * 0.8, 0, Math.PI * 2); g.fillStyle = col; g.fill();
    g.fillStyle = '#fff'; g.font = `900 ${r * 0.95}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, cx, cy + 1);
  }

  function drawFloor() {
    const W = FT.wallX, zb = FT.zb;
    poly([P(-W, ftFloorY(zNear), zNear), P(W, ftFloorY(zNear), zNear), P(W, ftFloorY(zb), zb), P(-W, ftFloorY(zb), zb)], '#4b5058');
    poly([P(-W, ftFloorY(zb - 0.45), zb - 0.45), P(W, ftFloorY(zb - 0.45), zb - 0.45), P(W, ftFloorY(zb), zb), P(-W, ftFloorY(zb), zb)], '#e9c514');
    g.beginPath(); g.strokeStyle = 'rgba(200,205,214,.55)'; g.lineWidth = 1.2;
    for (let x = -W; x <= W + 1e-6; x += 0.1) line3([x, ftFloorY(zNear), zNear], [x, ftFloorY(zb - 0.45), zb - 0.45]);
    for (let z = zNear; z < zb - 0.45; z += 0.2) line3([-W, ftFloorY(z), z], [W, ftFloorY(z), z]);
    g.stroke();
  }
  function drawShadow(b) {
    const fy = ftFloorY(b.z), h = Math.max(0, b.y - fy);
    const [sx, sy, s] = P(b.x, fy, b.z);
    const a = Math.max(0, 0.35 - h * 0.12);
    if (a <= 0) return;
    g.fillStyle = `rgba(0,0,0,${a})`; g.beginPath(); g.ellipse(sx, sy, FT.rb * s * 1.1, FT.rb * s * 0.35, 0, 0, Math.PI * 2); g.fill();
  }
  function drawBall(x, y, z, rot) {
    const [sx, sy, s] = P(x, y, z), r = FT.rb * s;
    if (r < 0.5) return;
    const gr = g.createRadialGradient(sx - r * 0.35, sy - r * 0.4, r * 0.1, sx, sy, r);
    gr.addColorStop(0, '#fdba74'); gr.addColorStop(0.45, '#f97316'); gr.addColorStop(1, '#9a3412');
    g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fillStyle = gr; g.fill();
    g.save(); g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.clip();
    g.strokeStyle = '#1c1917'; g.lineWidth = Math.max(0.8, r * 0.07);
    const c = Math.cos(rot);
    g.beginPath(); g.ellipse(sx, sy, r, Math.abs(r * c), 0, 0, Math.PI * 2); g.stroke();       // 가로 솔기(돌아간다)
    g.beginPath(); g.moveTo(sx, sy - r); g.lineTo(sx, sy + r); g.stroke();                     // 세로 솔기
    g.beginPath(); g.ellipse(sx - r * 0.95, sy, r * 0.55, r * 1.05, 0, -Math.PI / 2, Math.PI / 2); g.stroke();
    g.beginPath(); g.ellipse(sx + r * 0.95, sy, r * 0.55, r * 1.05, 0, Math.PI / 2, Math.PI * 1.5); g.stroke();
    g.restore();
  }
  // 림 — 앞쪽/뒤쪽 반원 따로 (공이 그 사이로 지나가게)
  function drawRim(front) {
    const N = 40;
    const shake = (G.rimShake || 0) * 0.012 * Math.sin(performance.now() / 18);
    const half = [];
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2, z = Math.sin(a);
      if (front ? z <= 0.02 : z >= -0.02) half.push(P(FT.hx + Math.cos(a) * FT.Rr, FT.hy + shake, FT.hz + z * FT.Rr));
    }
    if (half.length < 2) return;
    const lw = 0.03 * P(0, FT.hy, FT.hz)[2];
    g.lineCap = 'round';
    g.beginPath(); half.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    g.strokeStyle = '#991b1b'; g.lineWidth = lw + 1.5; g.stroke();
    g.strokeStyle = front ? '#ef4423' : '#c2410c'; g.lineWidth = lw; g.stroke();
    if (front) { g.strokeStyle = 'rgba(255,220,200,.55)'; g.lineWidth = lw * 0.3; g.stroke(); }
  }
  // 그물 — 위에서부터 빨강·빨강·하양·파랑 마름모
  function drawNet(front) {
    const N = 14, LV = 4;
    const w = G.netW, wob = Math.sin((1 - w) * Math.PI * 3) * w;
    const lev = k => ({ y: FT.hy - k * 0.135 - (k ? wob * 0.05 * k : 0), r: FT.Rr - k * 0.026 + (k ? wob * 0.02 : 0) });
    const pt = (k, i) => { const l = lev(k), a = (i + k * 0.5) / N * Math.PI * 2; return [FT.hx + Math.cos(a) * l.r, l.y, FT.hz + Math.sin(a) * l.r]; };
    const cols = ['#ef4444', '#f87171', '#f8fafc', '#2563eb'];
    g.lineWidth = 1.3;
    for (let k = 0; k < LV - 1; k++) {
      g.beginPath(); g.strokeStyle = cols[k + (k >= 1 ? 1 : 0)] || cols[k];
      for (let i = 0; i < N; i++) {
        const a = pt(k, i), b1 = pt(k + 1, i), b2 = pt(k + 1, i - 1);
        const zf = (a[2] + b1[2]) / 2 <= FT.hz;
        if (zf !== front) continue;
        line3(a, b1); line3(a, b2);
      }
      g.stroke();
    }
    // 아래 끝 술
    g.beginPath(); g.strokeStyle = '#1d4ed8';
    for (let i = 0; i < N; i++) { const a = pt(LV - 1, i); if ((a[2] <= FT.hz) !== front) continue; line3(a, [a[0] * 0.92, a[1] - 0.06, FT.hz + (a[2] - FT.hz) * 0.92]); }
    g.stroke();
  }
  const RAIL_Y = LH - 50;
  function drawRailBar() {
    // 맨 앞 가로 손잡이 바(사진의 회색 레일)
    const y = RAIL_Y;
    const rg = g.createLinearGradient(0, y, 0, y + 16);
    rg.addColorStop(0, '#6b7280'); rg.addColorStop(0.4, '#374151'); rg.addColorStop(1, '#1f2937');
    g.fillStyle = rg; g.fillRect(0, y, LW, 16);
  }
  function drawRail() {
    const y = RAIL_Y + 16;
    g.fillStyle = '#2b3038'; g.fillRect(0, y, LW, LH - y);
    g.strokeStyle = 'rgba(160,166,176,.45)'; g.lineWidth = 1;
    g.beginPath(); for (let x = 6; x < LW; x += 14) { g.moveTo(x, y); g.lineTo(x - 4, LH); } g.stroke();
  }
  function drawGauges() {
    const fb = G.fb;
    // 힘 게이지(오른쪽 세로)
    const gx = LW - 22, gy0 = LH - 230, gy1 = LH - 70, gh = gy1 - gy0;
    const lo = 0.3, hi = 1.7, yOf = r => gy1 - (Math.max(lo, Math.min(hi, r)) - lo) / (hi - lo) * gh;
    const tol = ftPowTol(L);
    g.fillStyle = 'rgba(15,23,42,.6)'; g.fillRect(gx - 7, gy0 - 4, 14, gh + 8);
    g.fillStyle = 'rgba(74,222,128,.85)'; g.fillRect(gx - 5, yOf(1 + tol), 10, Math.max(2, yOf(1 - tol) - yOf(1 + tol)));
    g.fillStyle = '#e5e7eb'; g.font = '800 10px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText('힘', gx, gy0 - 6);
    // 방향 게이지(아래 가로)
    const dx0 = LW / 2 - 70, dx1 = LW / 2 + 70, dy = LH - 17, rng = 30;
    const xOf = t => LW / 2 + Math.max(-rng, Math.min(rng, t)) / rng * 70;
    const dt = ftDirTol(L);
    g.fillStyle = 'rgba(15,23,42,.6)'; g.fillRect(dx0 - 4, dy - 6, dx1 - dx0 + 8, 12);
    g.fillStyle = 'rgba(74,222,128,.85)'; g.fillRect(xOf(-dt), dy - 4, xOf(dt) - xOf(-dt), 8);
    g.fillStyle = '#e5e7eb'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText('방향', dx0 - 8, dy);
    if (!fb) return;
    // 마지막 던지기 표시
    const okP = Math.abs(fb.pr - 1) <= tol, okD = Math.abs(fb.theta) <= dt;
    g.fillStyle = okP ? '#fff' : '#fb923c';
    const my = yOf(fb.pr);
    g.beginPath(); g.moveTo(gx - 12, my); g.lineTo(gx - 6, my - 5); g.lineTo(gx - 6, my + 5); g.closePath(); g.fill();
    g.fillRect(gx - 6, my - 1.5, 12, 3);
    g.fillStyle = okD ? '#fff' : '#fb923c';
    const mx = xOf(fb.theta);
    g.beginPath(); g.moveTo(mx, dy - 11); g.lineTo(mx - 5, dy - 5); g.lineTo(mx + 5, dy - 5); g.closePath(); g.fill();
    g.fillRect(mx - 1.5, dy - 6, 3, 12);
    if (fb.t < 2.2) {
      const msg = [okP ? '힘 좋아요' : (fb.pr < 1 ? '더 세게!' : '더 살살!'), okD ? '방향 좋아요' : (fb.theta < 0 ? '왼쪽으로 기울었어요' : '오른쪽으로 기울었어요')].join(' · ');
      g.globalAlpha = Math.min(1, (2.2 - fb.t) * 2);
      g.fillStyle = '#f8fafc'; g.font = '800 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(msg, LW / 2, P(0, 0, 0)[1] - 80);
      g.fillText(msg, LW / 2, P(0, 0, 0)[1] - 80);
      g.globalAlpha = 1;
    }
  }

  // 움직이지 않는 배경(철망·백보드·레일 바닥)은 크기가 바뀔 때만 한 번 그려 두고 매 프레임 복사한다
  let bgLayer = null;
  function buildBg() {
    bgLayer = document.createElement('canvas'); bgLayer.width = cv.width; bgLayer.height = cv.height;
    const keep = g; g = bgLayer.getContext('2d');
    g.setTransform(cv.width / LW, 0, 0, cv.height / LH, 0, 0);
    drawRoom(); drawBoard(); drawFloor(); drawRail();
    g = keep;
  }
  function draw() {
    if (!bgLayer || bgLayer.width !== cv.width || bgLayer.height !== cv.height) buildBg();
    g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(bgLayer, 0, 0);
    g.setTransform(cv.width / LW, 0, 0, cv.height / LH, 0, 0);
    drawLed();
    for (const b of G.balls) drawShadow(b);
    const inRim = b => Math.hypot(b.x - FT.hx, b.z - FT.hz) < FT.Rr + FT.rb && b.y < FT.hy + 0.3 && b.y > FT.hy - 0.65;
    const A = [], B = [], C = [];
    for (const b of G.balls) (inRim(b) ? B : (b.z > FT.hz ? A : C)).push(b);
    A.sort((a, b) => b.z - a.z); C.sort((a, b) => b.z - a.z);
    for (const b of A) drawBall(b.x, b.y, b.z, b.rot);
    drawRim(false); drawNet(false);
    for (const b of B) drawBall(b.x, b.y, b.z, b.rot);
    drawNet(true); drawRim(true);
    for (const b of C) drawBall(b.x, b.y, b.z, b.rot);
    // 대기 중인 공(아래에서 쏙 올라온다)
    if (G.hasBall && (G.phase === 'play' || G.phase === 'count')) {
      const p = 1 - Math.pow(1 - G.popT, 3);
      drawBall(0, -0.35 * (1 - p), 0, 0.4);
    }
    drawRailBar();
    // 손가락 궤적
    if (G.trail.length > 1) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); G.trail.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
      g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 6; g.stroke();
    }
    drawGauges();
    // 처음 안내
    if (G.hint && G.phase === 'play' && G.hasBall) {
      const a = 0.55 + 0.45 * Math.sin(performance.now() / 220);
      g.globalAlpha = a; g.fillStyle = '#fff'; g.font = '900 15px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('⬆ 공을 위로 휙 튕기세요', LW / 2, P(0, 0, 0)[1] - 78);
      g.globalAlpha = 1;
    }
    // 카운트다운
    if (G.phase === 'count') {
      const n = Math.max(1, Math.ceil(G.cd - 0.2));
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, LW, LH);
      g.fillStyle = '#fff'; g.font = '900 96px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(n), LW / 2, LH * 0.5);
      g.font = '800 16px system-ui,sans-serif';
      g.fillText((cfg.np === 2 ? `${G.pi + 1}P ` : '') + cur().name + ' 준비!', LW / 2, LH * 0.5 - 76);
    }
    // 시간 임박 경고
    if (timed && G.phase === 'play' && G.timeLeft <= 5) {
      g.fillStyle = `rgba(239,68,68,${0.12 + 0.1 * Math.sin(performance.now() / 120)})`; g.fillRect(0, 0, LW, LH);
    }
    // 골! 팝업
    for (const p of G.pops) {
      const a = Math.max(0, 1 - p.t / 1.1);
      g.globalAlpha = a; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `900 ${p.big ? 44 : 30}px system-ui,sans-serif`;
      g.lineWidth = 5; g.strokeStyle = '#7c2d12'; g.strokeText(p.text, p.x, p.y - p.t * 40);
      g.fillStyle = '#fde047'; g.fillText(p.text, p.x, p.y - p.t * 40);
      g.globalAlpha = 1;
    }
  }

  function stop() {
    cancelAnimationFrame(G.raf);
    window.removeEventListener('resize', fit);
    if (ftStop === stop) ftStop = null;
  }
  ftStop = stop;
  cv._ft = { G, shoot, update };   // 시험용(자동 테스트에서 던지기 흉내)
  const back = document.getElementById('gameBack');
  if (back) back.onclick = () => { stop(); startFreethrow(el); };
  G.raf = requestAnimationFrame(frame);
}
