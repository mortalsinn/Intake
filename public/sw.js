// Service worker: cache the app shell so the kiosk loads even when the wifi
// is down. API calls are never cached here — the app has its own queue and
// form-config fallback in localStorage, which handle offline properly.
const CACHE = 'iw-intake-v5';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return;
    // Network first so style tweaks show up on reload; cache is the fallback.
    e.respondWith(
        fetch(e.request)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, copy));
                return res;
            })
            .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
});
