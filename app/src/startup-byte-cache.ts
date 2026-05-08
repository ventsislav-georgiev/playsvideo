/**
 * Startup Byte Cache Module
 * 
 * Provides HTTP Range (206) support for service worker via IndexedDB.
 * Handles binary storage, range request parsing, and Safari private mode fallback.
 * 
 * Key features:
 * - Parses Range headers and returns 206 Partial Content
 * - Stores assets as Uint8Array in IndexedDB
 * - Detects Safari private mode (IDB unavailable)
 * - Fire-and-forget caching on network fetch
 * - Comprehensive telemetry for diagnostics
 */

// ============================================================================
// Constants
// ============================================================================

const STARTUP_CACHE_DB = 'bookplay-startup-cache';
const STARTUP_CACHE_STORE = 'startup-bytes';
const STARTUP_CACHE_VERSION = 1;

// Patterns to cache (customize in sw.ts)
const STARTUP_BYTE_PATTERNS: RegExp[] = [];

// ============================================================================
// Types
// ============================================================================

interface StartupByteRecord {
  url: string;
  data: Uint8Array;
  size: number;
  etag?: string;
  timestamp: number;
  contentType: string;
}

interface RangeRequest {
  start: number;
  end: number;
  total: number;
}

interface StartupByteCacheTelemetry {
  // IDB health
  idb_open_success: number;
  idb_open_error: number;
  idb_quota_exceeded: number;
  safari_idb_available: boolean;
  safari_private_mode_detected: boolean;

  // Range requests
  range_request_count: number;
  range_request_error: number;
  range_response_206: number;
  range_response_fallback: number;

  // Transaction health
  transaction_inactive_error: number;

  // Performance
  sw_activation_time_ms: number;
}

// ============================================================================
// Global State
// ============================================================================

let idbInstance: IDBDatabase | null = null;
let idbAvailable = true;
let privateModeDected = false;
const telemetry: StartupByteCacheTelemetry = {
  idb_open_success: 0,
  idb_open_error: 0,
  idb_quota_exceeded: 0,
  safari_idb_available: true,
  safari_private_mode_detected: false,
  range_request_count: 0,
  range_request_error: 0,
  range_response_206: 0,
  range_response_fallback: 0,
  transaction_inactive_error: 0,
  sw_activation_time_ms: 0,
};

// ============================================================================
// IDB Initialization
// ============================================================================

async function initStartupByteCache(): Promise<void> {
  const startTime = performance.now();

  try {
    idbInstance = await new Promise((resolve, reject) => {
      const req = indexedDB.open(STARTUP_CACHE_DB, STARTUP_CACHE_VERSION);

      req.onerror = () => {
        const error = req.error;
        if (error?.name === 'NotAllowedError') {
          // Safari private mode
          privateModeDected = true;
          idbAvailable = false;
          telemetry.safari_private_mode_detected = true;
          telemetry.idb_open_error++;
          resolve(null as any);
        } else {
          telemetry.idb_open_error++;
          reject(error);
        }
      };

      req.onsuccess = () => {
        telemetry.idb_open_success++;
        resolve(req.result);
      };

      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STARTUP_CACHE_STORE)) {
          db.createObjectStore(STARTUP_CACHE_STORE, { keyPath: 'url' });
        }
      };
    });
  } catch (error) {
    telemetry.idb_open_error++;
    idbAvailable = false;
  }

  telemetry.sw_activation_time_ms = performance.now() - startTime;
}

// ============================================================================
// IDB Operations
// ============================================================================

async function putStartupBytesInIDB(
  url: string,
  data: Uint8Array,
  etag?: string,
  contentType?: string
): Promise<void> {
  if (!idbInstance || !idbAvailable) return;

  try {
    const record: StartupByteRecord = {
      url,
      data,
      size: data.byteLength,
      etag,
      timestamp: Date.now(),
      contentType: contentType || 'application/octet-stream',
    };

    await new Promise<void>((resolve, reject) => {
      const tx = idbInstance!.transaction([STARTUP_CACHE_STORE], 'readwrite');
      const store = tx.objectStore(STARTUP_CACHE_STORE);
      const req = store.put(record);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();

      tx.onerror = () => {
        if (tx.error?.name === 'QuotaExceededError') {
          telemetry.idb_quota_exceeded++;
        }
        reject(tx.error);
      };
    });
  } catch (error) {
    // Silently fail (fire-and-forget caching)
  }
}

async function getStartupBytesFromIDB(url: string): Promise<StartupByteRecord | null> {
  if (!idbInstance || !idbAvailable) return null;

  try {
    return await new Promise((resolve, reject) => {
      const tx = idbInstance!.transaction([STARTUP_CACHE_STORE], 'readonly');
      const store = tx.objectStore(STARTUP_CACHE_STORE);
      const req = store.get(url);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result || null);

      tx.onerror = () => {
        if (tx.error?.name === 'InvalidStateError') {
          telemetry.transaction_inactive_error++;
        }
        reject(tx.error);
      };
    });
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Range Request Parsing
// ============================================================================

function parseRangeHeader(rangeHeader: string, total: number): RangeRequest | null {
  const match = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : total - 1;

  // Validate bounds
  if (start < 0 || start >= total || end < start || end >= total) {
    return null;
  }

  return { start, end, total };
}

// ============================================================================
// Range Response Handling
// ============================================================================

function createRangeResponse(data: Uint8Array, range: RangeRequest, contentType: string): Response {
  const sliced = data.slice(range.start, range.end + 1);
  // Convert Uint8Array to ArrayBuffer for Response body
  const buffer = sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength) as ArrayBuffer;

  return new Response(buffer, {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(sliced.byteLength),
      'Content-Range': `bytes ${range.start}-${range.end}/${range.total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// ============================================================================
// Main Fetch Handler
// ============================================================================

async function handleStartupByteFetch(event: any): Promise<Response | null> {
  const request = event.request as Request;
  const url = request.url;

  // Only handle GET requests
  if (request.method !== 'GET') return null;

  // Check if URL matches patterns
  if (!STARTUP_BYTE_PATTERNS.some((pattern) => pattern.test(url))) {
    return null;
  }

  const rangeHeader = request.headers.get('Range');

  // ========================================================================
  // Case 1: Range Request
  // ========================================================================
  if (rangeHeader) {
    telemetry.range_request_count++;

    try {
      // Try to get from IDB
      const record = await getStartupBytesFromIDB(url);

      if (record) {
        const range = parseRangeHeader(rangeHeader, record.size);
        if (range) {
          telemetry.range_response_206++;
          return createRangeResponse(record.data, range, record.contentType);
        } else {
          telemetry.range_request_error++;
          return new Response('Invalid Range', { status: 416 });
        }
      }

      // IDB miss: fall back to network
      telemetry.range_response_fallback++;
      return null;
    } catch (error) {
      telemetry.range_request_error++;
      return null;
    }
  }

  // ========================================================================
  // Case 2: Normal Request (cache on network fetch)
  // ========================================================================
  try {
    const response = await fetch(request);

    if (response.ok) {
      const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
      const etag = response.headers.get('ETag') || undefined;

      // Clone response for reading
      const cloned = response.clone();
      const buffer = await cloned.arrayBuffer();
      const uint8 = new Uint8Array(buffer);

      // Fire-and-forget: cache in IDB
      void putStartupBytesInIDB(url, uint8, etag, contentType);
    }

    return response;
  } catch (error) {
    // Network error: try IDB fallback
    const record = await getStartupBytesFromIDB(url);
    if (record) {
      const buffer = record.data.buffer.slice(
        record.data.byteOffset,
        record.data.byteOffset + record.data.byteLength
      ) as ArrayBuffer;
      return new Response(buffer, {
        status: 200,
        headers: {
          'Content-Type': record.contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // No IDB data: return error
    return new Response('Not Found', { status: 404 });
  }
}

// ============================================================================
// Telemetry
// ============================================================================

function isStartupByteCacheAvailable(): boolean {
  return idbAvailable && !privateModeDected;
}

function getTelemetry(): StartupByteCacheTelemetry {
  return { ...telemetry };
}

// ============================================================================
// Exports
// ============================================================================

export {
  initStartupByteCache,
  handleStartupByteFetch,
  isStartupByteCacheAvailable,
  getTelemetry,
  STARTUP_CACHE_DB,
  STARTUP_CACHE_STORE,
  STARTUP_CACHE_VERSION,
  STARTUP_BYTE_PATTERNS,
  type StartupByteRecord,
  type RangeRequest,
  type StartupByteCacheTelemetry,
};
