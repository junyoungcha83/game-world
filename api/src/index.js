// game-world 데이터 동기화 API
// - GET  /api/data : 공용 읽기
// - PUT  /api/data : X-Edit-Token 이 EDIT_TOKEN 과 일치할 때만 KV 저장
// - 테트리스 배틀 방(room): 토큰 없이 read/write (양쪽 폰이 서로 상태 교환).
//     PUT /api/room/:code/meta  방 메타(mode·seed·host) 생성
//     GET /api/room/:code/meta  방 메타 읽기(없으면 404)
//     PUT /api/room/:code/:slot 내 슬롯(a|b) 상태 저장 — 각자 자기 키만 써서 충돌 없음
//     GET /api/room/:code       {meta, a, b} 통째로 읽기
//   남용 방지: 코드 형식 제한 + 슬롯당 크기 제한 + KV TTL 로 자동 만료.
// KV binding: GAMEWORLD (단일 키 "game-world-data") · Secret: EDIT_TOKEN

const KEY = 'game-world-data';
const MAX_BYTES = 4 * 1024 * 1024;   // 4MB (사진 base64 소수 사용자)
const ROOM_TTL = 7200;               // 방은 2시간 뒤 자동 만료
const ROOM_MAX = 16 * 1024;          // 슬롯당 16KB (미니보드 문자열 정도)
const okCode = c => /^[A-Za-z0-9]{3,8}$/.test(c);

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8000', 'http://localhost:8080', 'http://127.0.0.1:8000',
];
function cors(req) {
  const o = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400', 'Vary': 'Origin',
  };
}
function json(body, status, extra) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function valid(p) { return p && typeof p === 'object' && Array.isArray(p.users); }

export default {
  async fetch(req, env) {
    const url = new URL(req.url), h = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });

    // ── 테트리스 배틀 방 (토큰 불필요) ──
    const rm = url.pathname.match(/^\/api\/room\/([^/]+)(?:\/([a-z]+))?$/);
    if (rm) {
      const code = rm[1], part = rm[2] || '';
      if (!okCode(code)) return json({ error: 'bad_code' }, 400, h);
      const base = `rm:${code}`;
      const nostore = { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (req.method === 'GET') {
        if (part === 'meta') {
          const m = await env.GAMEWORLD.get(base + ':meta');
          return m ? new Response(m, { headers: nostore }) : json({ error: 'no_room' }, 404, h);
        }
        const [m, a, b] = await Promise.all([
          env.GAMEWORLD.get(base + ':meta'), env.GAMEWORLD.get(base + ':a'), env.GAMEWORLD.get(base + ':b'),
        ]);
        return new Response(JSON.stringify({
          meta: m ? JSON.parse(m) : null, a: a ? JSON.parse(a) : null, b: b ? JSON.parse(b) : null,
        }), { headers: nostore });
      }
      if (req.method === 'PUT') {
        if (!['meta', 'a', 'b'].includes(part)) return json({ error: 'bad_part' }, 400, h);
        const body = await req.text();
        if (body.length > ROOM_MAX) return json({ error: 'too_large', limit: ROOM_MAX }, 413, h);
        try { JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400, h); }
        await env.GAMEWORLD.put(`${base}:${part}`, body, { expirationTtl: ROOM_TTL });
        return json({ ok: true }, 200, h);
      }
      return json({ error: 'method_not_allowed' }, 405, h);
    }

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.GAMEWORLD.get(KEY);
        return new Response(raw || JSON.stringify({ version: 1, users: [], scores: {} }), {
          headers: { ...h, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      if (req.method === 'PUT') {
        const token = req.headers.get('X-Edit-Token') || '';
        if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) return json({ error: 'unauthorized' }, 401, h);
        const body = await req.text();
        if (body.length > MAX_BYTES) return json({ error: 'too_large', limit: MAX_BYTES, size: body.length }, 413, h);
        let parsed; try { parsed = JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400, h); }
        if (!valid(parsed)) return json({ error: 'invalid_shape' }, 400, h);
        await env.GAMEWORLD.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, h);
      }
      return json({ error: 'method_not_allowed' }, 405, h);
    }
    if (url.pathname === '/' || url.pathname === '/api/health') return json({ ok: true, service: 'game-world-api' }, 200, h);
    return new Response('Not Found', { status: 404, headers: h });
  },
};
