/// <reference lib="webworker" />

import {
  handleMetadataRequest,
  isMetadataRequestEnvelope,
  toMetadataErrorResponse,
} from './metadata/protocol-handler.js';
import { registerEnvCredentialProvider } from './metadata/env-credential-provider.js';
import {
  initStartupByteCache,
  handleStartupByteFetch,
  isStartupByteCacheAvailable,
} from './startup-byte-cache.js';

declare const self: ServiceWorkerGlobalScope;

const WASM_CACHE = 'playsvideo-wasm-v1';

registerEnvCredentialProvider();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Clean up old caches
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key !== WASM_CACHE).map((key) => caches.delete(key))),
      ),
      // Initialize startup byte cache
      initStartupByteCache(),
    ]),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Try startup byte cache first (for partial content requests)
  if (isStartupByteCacheAvailable()) {
    const startupByteResponse = handleStartupByteFetch(event.request);
    if (startupByteResponse) {
      event.respondWith(startupByteResponse);
      return;
    }
  }

  // WASM caching (existing logic)
  if (url.pathname.endsWith('.wasm')) {
    event.respondWith(
      caches.open(WASM_CACHE).then((cache) =>
        cache.match(event.request).then((cached) =>
          cached ||
          fetch(event.request).then((response) => {
            cache.put(event.request, response.clone());
            return response;
          }),
        ),
      ),
    );
  }
});

self.addEventListener('message', (event) => {
  // Handle metadata requests
  if (isMetadataRequestEnvelope(event.data)) {
    const port = event.ports[0];
    if (!port) {
      return;
    }

    void handleMetadataRequest(event.data)
      .then((response) => port.postMessage(response))
      .catch((error) => port.postMessage(toMetadataErrorResponse(event.data.id, error)));
    return;
  }

  // Handle telemetry requests
  if (event.data?.type === 'GET_TELEMETRY') {
    const port = event.ports[0];
    if (port) {
      // Telemetry is stored in IndexedDB by startup-byte-cache
      // Client will fetch it directly via getTelemetryFromSW()
      port.postMessage({ type: 'TELEMETRY_READY' });
    }
  }
});
