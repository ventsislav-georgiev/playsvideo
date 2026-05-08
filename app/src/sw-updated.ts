/**
 * Updated Service Worker with Startup Byte Cache Integration
 * 
 * Drop-in replacement for app/src/sw.ts
 * Adds HTTP Range (206) support via IndexedDB while preserving existing WASM caching.
 */

import {
  initStartupByteCache,
  handleStartupByteFetch,
  getTelemetry,
  STARTUP_BYTE_PATTERNS,
} from './startup-byte-cache';

// ============================================================================
// Configuration
// ============================================================================

// Update these patterns to match your actual asset URLs
const STARTUP_BYTE_PATTERNS_CONFIG = [
  /\/playsvideo\/assets\/.*\.(js|wasm|css)$/,
  /\/playsvideo\/index\.html$/,
];

// ============================================================================
// Service Worker Lifecycle
// ============================================================================

const sw = self as any;

sw.addEventListener('install', (event: any) => {
  event.waitUntil(sw.skipWaiting());
});

sw.addEventListener('activate', (event: any) => {
  event.waitUntil(
    (async () => {
      // Initialize startup byte cache
      await initStartupByteCache();

      // Update patterns
      STARTUP_BYTE_PATTERNS.push(...STARTUP_BYTE_PATTERNS_CONFIG);

      // Claim all clients
      await sw.clients.claim();
    })()
  );
});

// ============================================================================
// Fetch Handler
// ============================================================================

sw.addEventListener('fetch', (event: any) => {
  const { request } = event;

  // Try startup byte cache first (handles Range requests)
  const startupByteResponse = handleStartupByteFetch(event);
  if (startupByteResponse) {
    event.respondWith(startupByteResponse);
    return;
  }

  // Fall back to existing handlers (WASM cache, etc.)
  event.respondWith(handleFetch(request));
});

// ============================================================================
// Existing Fetch Handler (WASM Cache, etc.)
// ============================================================================

async function handleFetch(request: Request): Promise<Response> {
  // Your existing fetch logic here
  // This is a placeholder - integrate with your current sw.ts logic

  try {
    return await fetch(request);
  } catch (error) {
    return new Response('Service Unavailable', { status: 503 });
  }
}

// ============================================================================
// Message Handler (Telemetry)
// ============================================================================

sw.addEventListener('message', (event: any) => {
  if (event.data.type === 'GET_TELEMETRY') {
    const telemetry = getTelemetry();
    event.ports[0].postMessage(telemetry);
  }
});
