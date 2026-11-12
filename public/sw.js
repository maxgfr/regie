// Offline shell: the page and its assets are cached; streams always come from the network.
const CACHE = 'regie-v3'
// Bundled files carry a content hash in their name, and font files never change: those can come from the cache.
const IMMUTABLE = /\/chunk-[a-z0-9]+\.(js|css)$|\.woff2$/

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

const store = (request, response) => {
  if (response.ok) {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy))
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((r) => store(request, r))))
    return
  }
  // Everything else (the page, manifest, icons, font list): network first, so a new version shows up at
  // once; the cache only covers offline use.
  event.respondWith(
    fetch(request)
      .then((response) => store(request, response))
      .catch(() =>
        caches
          .match(request)
          .then((cached) => cached || (request.mode === 'navigate' ? caches.match('./') : Response.error())),
      ),
  )
})
