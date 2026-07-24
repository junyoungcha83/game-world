// game-world 데이터 동기화 API
// - GET  /api/data : 공용 읽기
// - PUT  /api/data : X-Edit-Token 이 EDIT_TOKEN 과 일치할 때만 KV 저장
// KV binding: GAMEWORLD (단일 키 "game-world-data") · Secret: EDIT_TOKEN

const KEY = 'game-world-data';
const MAX_BYTES = 4 * 1024 * 1024;   // 4MB (사진 base64 소수 사용자)

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
