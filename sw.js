// 앱 셸 오프라인 캐시. 캐시 이름 바꾸면 옛 캐시 자동 폐기.
const CACHE = 'game-world-v105';
self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });
// app.css/app.js 는 버전 쿼리(?v=)로 참조 — 배포마다 URL 이 바뀌어 옛 캐시가 절대 재사용되지 않는다.
const ASSETS = ['./', './index.html', './assets/app.css?v=105', './assets/app.js?v=105', './manifest.webmanifest', './assets/icon.svg', './assets/kbo-bg.jpg'];
// 지도 맞히기용 국가 실루엣 — 완전 오프라인 위해 프리캐시
const MAP_CODES = ['kr','jp','cn','us','gb','fr','de','it','es','pt','ca','br','ar','mx','au','in','ru','th','vn','id','ph','tr','eg','za','nl','se','no','ch','gr',
  'cl','nz','ie','is','sa','ir','pk','my','mn','ua','pl','pe','co','ng','ma','fi','kz','ve','cu','ke','dk','at','ae','sg','lk','kh','np','il','be','cz','ro','hu'];
const MAP_ASSETS = MAP_CODES.map(c => `./assets/maps/${c}.svg`);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    // cache:'reload' — 프리캐시할 때 HTTP 캐시를 우회해 항상 최신 파일을 담는다(옛 버전 굳는 것 방지)
    await Promise.all(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    // 지도는 개별 캐시(일부 실패해도 설치는 진행)
    await Promise.all(MAP_ASSETS.map(u => c.add(u).catch(() => {})));
  }));
  // skipWaiting() 안 함 — 새 버전은 '대기'만 하고, 페이지 새로고침(메인화면 진입) 때만 적용.
  // 사용 중(게임 플레이 중)에 자동으로 버전이 바뀌지 않게 한다.
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
  // HTML(내비게이션)은 HTTP 캐시를 우회해 항상 최신 index.html 을 받는다 → 새 버전이 새로고침 때 바로 반영
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  const net = isHTML ? fetch(req, { cache: 'reload' }) : fetch(req);
  e.respondWith(
    net.then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
