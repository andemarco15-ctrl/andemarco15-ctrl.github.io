/*
 * Preflight: offline support for the installed app.
 *
 * The rule that keeps this safe: the cache name carries the build number, and
 * tools/stamp.py rewrites the two constants below on every publish. A new build
 * therefore lands in a brand-new cache and the old one is deleted on activate,
 * so nobody can be stranded on stale files — the failure this project has already
 * had once. Never edit VERSION or BUILD by hand.
 *
 * version.json is deliberately never cached: it is how the running app notices a
 * new build and offers a reload, and a cached copy would defeat it.
 */
const VERSION = '1.0';
const BUILD = '17';
const TAG = `${VERSION}-${BUILD}`;
const CACHE = `preflight-${TAG}`;
const FONTS = 'preflight-fonts';

/* The whole app. It is small enough to precache outright, which is what makes a
   cold start with no signal work. Query strings must match index.html exactly or
   the cached entry will never be hit. */
const SHELL = [
  'index.html',
  `assets/styles.css?v=${TAG}`,
  `assets/questions.js?v=${TAG}`,
  `assets/firebase-config.js?v=${TAG}`,
  `assets/app.js?v=${TAG}`,
  `assets/cloud.js?v=${TAG}`,
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/apple-touch-icon.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is all-or-nothing; one 404 would leave the app with no offline copy
    // at all, so each file is added on its own and a miss is survivable.
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (err) { /* offline at install time: the runtime handler will fill it in */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => (n === CACHE || n === FONTS ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

const isFont = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache: it is the update signal itself.
  if (url.origin === self.location.origin && url.pathname.endsWith('/version.json')) return;

  // Firebase loads over the network or not at all; accounts need a connection
  // anyway and the app is built to work without one.
  if (url.hostname === 'www.gstatic.com') return;

  // A page load: prefer the network so a new build is picked up, fall back to the
  // cached shell so the app still opens with no signal.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match('index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isFont(url)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then(async (res) => {
        if (res.ok) (await caches.open(FONTS)).put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Same-origin assets are immutable for a given build, so the cache wins.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      return (await caches.match('index.html')) || Response.error();
    }
  })());
});
