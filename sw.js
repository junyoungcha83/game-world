// 앱 셸 오프라인 캐시. 캐시 이름 바꾸면 옛 캐시 자동 폐기.
const CACHE = 'game-world-v38';
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
const ASSETS = ['./', './index.html', './assets/app.css', './assets/app.js', './manifest.webmanifest', './assets/icon.svg'];
// 지도 맞히기용 국가 실루엣 — 완전 오프라인 위해 프리캐시
const MAP_CODES = ['kr','jp','cn','us','gb','fr','de','it','es','pt','ca','br','ar','mx','au','in','ru','th','vn','id','ph','tr','eg','za','nl','se','no','ch','gr'];
const MAP_ASSETS = MAP_CODES.map(c => `./assets/maps/${c}.svg`);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(ASSETS).catch(() => {});
    // 지도는 개별 캐시(일부 실패해도 설치는 진행)
    await Promise.all(MAP_ASSETS.map(u => c.add(u).catch(() => {})));
  }));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// 같은 출처 GET 만 네트워크 우선, 실패 시 캐시
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
