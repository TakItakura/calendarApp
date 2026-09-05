const CACHE_NAME = "holiday-plus-weeks-v7";

// ここに “アプリ本体” を入れる（外部CDNは固定バージョンなので入れてOK）
const APP_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.png",
  "https://cdn.jsdelivr.net/npm/fullcalendar@6.1.11/index.global.min.js"
];

// 祝日API（実体データ）
const HOLIDAY_API = "https://holidays-jp.github.io/api/v1/date.json";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// 基本戦略：
// - 画面HTML: network-first（更新を取得し、オフライン時はキャッシュ）
// - その他のアプリ本体: cache-first
// - 祝日API: network-first（成功したらキャッシュ更新、失敗したらキャッシュから返す）
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 祝日APIは network-first
  if (req.method === "GET" && url.href === HOLIDAY_API) {
    event.respondWith(networkFirst(req));
    return;
  }

  // iOSのホーム画面アプリでも更新した画面を取得しやすくする。
  if (req.method === "GET" && req.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(req));
    return;
  }

  // それ以外は cache-first
  if (req.method === "GET") {
    event.respondWith(cacheFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  const fresh = await fetch(req);
  // 取得できたらキャッシュに入れる（同一オリジンだけに限定する方が安全）
  if (new URL(req.url).origin === self.location.origin) {
    cache.put(req, fresh.clone());
  }
  return fresh;
}

async function navigationNetworkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    if (fresh.ok) await cache.put("./", fresh.clone());
    return fresh;
  } catch (e) {
    return await cache.match(req)
      || await cache.match("./")
      || await cache.match("./index.html")
      || Response.error();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}
