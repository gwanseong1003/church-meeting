// v3.5: 「바탕화면에 바로가기」(홈 화면 설치)를 위한 최소 서비스 워커.
// 아무것도 저장(캐시)하지 않고 항상 네트워크로 — 새 버전이 바로 반영되게.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
