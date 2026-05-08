/// <reference lib="webworker" />

// Startup byte cache imports
const STARTUP_CACHE_DB = 'bookplay-startup-cache';
const STARTUP_CACHE_STORE = 'startup-bytes';
const STARTUP_CACHE_VERSION = 1;

// Startup byte cache telemetry
const telemetry = {
  idb_open_success: 0,
  idb_open_error: 0,
  idb_quota_exceeded: 0,
  safari_idb_available: false,
  safari_private_mode_detected: false,
  range_request_count: 0,
  range_request_error: 0,
  range_response_206: 0,
  range_response_fallback: 0,
  transaction_inactive_error: 0,
  sw_activation_time_ms: 0,
};

let db = null;
let idbAvailable = true;
const activationStart = performance.now();

// Initialize IndexedDB
async function initStartupByteCache() {
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(STARTUP_CACHE_DB, STARTUP_CACHE_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STARTUP_CACHE_STORE)) {
          database.createObjectStore(STARTUP_CACHE_STORE);
        }
      };
    });
    telemetry.idb_open_success++;
  } catch (err) {
    telemetry.idb_open_error++;
    // Check for Safari private mode
    if (err?.name === 'QuotaExceededError') {
      telemetry.safari_private_mode_detected = true;
      idbAvailable = false;
    }
  }
  telemetry.sw_activation_time_ms = Math.round(performance.now() - activationStart);
}

function isStartupByteCacheAvailable() {
  return idbAvailable && db !== null;
}

// Handle Range requests
async function handleStartupByteFetch(request) {
  if (!isStartupByteCacheAvailable()) return null;

  const url = new URL(request.url);
  const rangeHeader = request.headers.get('range');
  
  if (!rangeHeader) return null;

  telemetry.range_request_count++;

  try {
    const response = await fetch(request);
    
    if (response.status === 206) {
      telemetry.range_response_206++;
      
      // Cache the range
      const buffer = await response.arrayBuffer();
      const contentRange = response.headers.get('content-range');
      
      if (contentRange) {
        try {
          const tx = db.transaction([STARTUP_CACHE_STORE], 'readwrite');
          const store = tx.objectStore(STARTUP_CACHE_STORE);
          store.put(buffer, `${url.pathname}:${contentRange}`);
        } catch (err) {
          if (err?.name === 'InvalidStateError') {
            telemetry.transaction_inactive_error++;
          } else if (err?.name === 'QuotaExceededError') {
            telemetry.idb_quota_exceeded++;
          }
        }
      }
      
      return response;
    } else {
      telemetry.range_response_fallback++;
      return response;
    }
  } catch (err) {
    telemetry.range_request_error++;
    return null;
  }
}

// Original SW code
const WASM_CACHE = 'playsvideo-wasm-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys.filter((k) => k !== WASM_CACHE && k !== 'playsvideo-shared').map((k) => caches.delete(k))
        )
      ),
      initStartupByteCache(),
    ])
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Try startup byte cache first
  if (isStartupByteCacheAvailable()) {
    const startupByteResponse = handleStartupByteFetch(event.request);
    if (startupByteResponse) {
      event.respondWith(startupByteResponse);
      return;
    }
  }

  // Handle share target POST (Android share sheet)
  if (url.pathname === '/player/share-target' && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Only handle GET requests for same-origin resources
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Cache-first only for .wasm files; everything else goes to network
  if (url.pathname.endsWith('.wasm')) {
    event.respondWith(
      caches.open(WASM_CACHE).then((cache) =>
        cache.match(event.request).then((cached) =>
          cached || fetch(event.request).then((resp) => {
            cache.put(event.request, resp.clone());
            return resp;
          })
        )
      )
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_TELEMETRY') {
    const port = event.ports[0];
    if (port) {
      port.postMessage({ type: 'TELEMETRY_READY', data: telemetry });
    }
  }
});

async function handleShareTarget(request) {
  const formData = await request.formData();
  const videoFile = formData.get('video');

  if (videoFile) {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({
        type: 'SHARE_TARGET',
        file: {
          name: videoFile.name,
          size: videoFile.size,
          type: videoFile.type,
        },
      });
    }
  }

  return new Response('OK');
}
