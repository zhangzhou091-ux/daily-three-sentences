
const CACHE_NAME = 'd3s-cache-v3.2';
const STATIC_ASSETS = [
  '/',
  '/index.html'
];

const EXTERNAL_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap'
];

const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

const shouldBypassCache = (url) => {
  const bypassPatterns = [
    'generativelanguage.googleapis.com',
    'supabase.co',
    'supabase.com',
    'supabase.in',
    '/rest/v1/',
    '/auth/v1/',
    '/storage/v1/',
    '/realtime/v1/',
    'chrome-extension://',
    'moz-extension://'
  ];
  return bypassPatterns.some(pattern => url.includes(pattern));
};

const isStaticAsset = (url) => {
  return STATIC_ASSETS.some(asset => url.endsWith(asset) || url === self.location.origin + asset);
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(STATIC_ASSETS);
      
      for (const asset of EXTERNAL_ASSETS) {
        try {
          const response = await fetch(asset, { mode: 'cors' });
          if (response.ok) {
            await cache.put(asset, response);
          }
        } catch (err) {
          console.warn('Failed to cache external asset:', asset, err);
        }
      }
      
      return self.skipWaiting();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  if (shouldBypassCache(url)) {
    return;
  }

  if (request.method !== 'GET') {
    return;
  }

  if (request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(request).then(response => {
            return response || caches.match('/');
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        const cachedDate = cachedResponse.headers.get('sw-cached-date');
        if (cachedDate) {
          const age = Date.now() - new Date(cachedDate).getTime();
          if (age > CACHE_EXPIRY_MS) {
            caches.open(CACHE_NAME).then(cache => cache.delete(request));
            return fetch(request).then(response => {
              const responseToCache = new Response(response.clone().body, {
                status: response.status,
                statusText: response.statusText,
                headers: {
                  ...Object.fromEntries(response.headers.entries()),
                  'sw-cached-date': new Date().toISOString()
                }
              });
              caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
              return response;
            }).catch(() => cachedResponse);
          }
        }
        return cachedResponse;
      }

      return fetch(request).then(response => {
        if (response.status === 200) {
          const responseToCache = new Response(response.clone().body, {
            status: response.status,
            statusText: response.statusText,
            headers: {
              ...Object.fromEntries(response.headers.entries()),
              'sw-cached-date': new Date().toISOString()
            }
          });
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseToCache));
        }
        return response;
      });
    }).catch(() => {
      return caches.match('/');
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});
