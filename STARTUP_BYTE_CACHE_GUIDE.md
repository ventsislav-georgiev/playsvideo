# BookPlay Startup Byte Cache Implementation Guide

## Overview

The startup byte cache module provides HTTP Range (206) support for service worker-cached assets via IndexedDB, with special handling for Safari/iOS private mode and transaction lifetime safety.

**Problem solved**: Cache API rejects 206 responses; this module serves partial content from IDB instead.

## Files

- `app/src/startup-byte-cache.ts` — Core SW module (Range parsing, IDB storage, 206 responses)
- `app/src/startup-byte-cache-client.ts` — Client-side telemetry utilities
- `app/src/sw-updated.ts` — Updated service worker with cache integration

## Integration Steps

### 1. Replace `app/src/sw.ts`

```bash
cp app/src/sw-updated.ts app/src/sw.ts
```

Or manually merge the changes:
- Import `handleStartupByteFetch`, `initStartupByteCache`, `isStartupByteCacheAvailable`, `getTelemetry`
- Add `initStartupByteCache()` to the `activate` event
- Add startup byte fetch handler in the `fetch` event (before WASM handler)
- Add telemetry message handler

### 2. Configure Asset Patterns

In `app/src/sw.ts`, update `STARTUP_BYTE_PATTERNS` to match your asset paths:

```typescript
const STARTUP_BYTE_PATTERNS = [
  /\/playsvideo\/assets\/.*\.(js|wasm|css)$/,
  /\/playsvideo\/index\.html$/,
  // Add more patterns as needed
];
```

### 3. Add Client-Side Telemetry (Optional)

In your main app initialization:

```typescript
import { logStartupByteCacheTelemetry, isStartupByteCacheHealthy } from './startup-byte-cache-client.js';

// Log telemetry on app startup
await logStartupByteCacheTelemetry();

// Check health
const healthy = await isStartupByteCacheHealthy();
if (!healthy) {
  console.warn('Startup byte cache is not healthy');
}
```

## How It Works

### Range Request Flow

1. **Client sends Range header**: `Range: bytes=0-499`
2. **Service worker intercepts**: Checks for Range header
3. **IDB lookup**: Retrieves full file from IndexedDB
4. **Slice and respond**: Returns 206 with `Content-Range` header
5. **Fallback**: If IDB miss, fetches from network

### Storage Flow

1. **Network fetch**: Full file downloaded
2. **IDB store**: Converted to `Uint8Array` and stored (fire-and-forget)
3. **Subsequent Range requests**: Served from IDB with 206 status

### Private Mode Handling

- **Detection**: IDB open fails with `NotAllowedError` or `QuotaExceededError`
- **Fallback**: All requests go to network (no caching)
- **Telemetry**: `safari_private_mode_detected` flag set

## Telemetry Metrics

### IDB Health
- `idb_open_success` — Successful IDB opens
- `idb_open_error` — Failed IDB opens
- `idb_quota_exceeded` — Storage quota exceeded
- `safari_idb_available` — IDB available at SW activation
- `safari_private_mode_detected` — Private mode detected

### Range Requests
- `range_request_count` — Total Range requests received
- `range_request_error` — Invalid Range headers or slicing errors
- `range_response_206` — Successful 206 responses from IDB
- `range_response_fallback` — Fallback to network (IDB miss)

### Transaction Health
- `transaction_inactive_error` — IDB transaction became inactive (bug indicator)

### Performance
- `sw_activation_time_ms` — Time to initialize cache on SW activation

## Accessing Telemetry

### From Console

```javascript
// In browser console
const telemetry = await navigator.serviceWorker.controller.postMessage({ type: 'GET_TELEMETRY' });
```

### From Client Code

```typescript
import { logStartupByteCacheTelemetry } from './startup-byte-cache-client.js';

await logStartupByteCacheTelemetry();
```

## Debugging

### Check IDB Contents

```javascript
// In browser console
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open('bookplay-startup-cache', 1);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const tx = db.transaction(['startup-bytes'], 'readonly');
const store = tx.objectStore('startup-bytes');
const allRecords = await new Promise((resolve, reject) => {
  const req = store.getAll();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

console.table(allRecords.map(r => ({
  url: r.url,
  size: r.size,
  timestamp: new Date(r.timestamp).toISOString(),
  etag: r.etag
})));
```

### Monitor Range Requests

```javascript
// In browser console
const telemetry = await navigator.serviceWorker.controller.postMessage({ type: 'GET_TELEMETRY' });
console.log(`Range requests: ${telemetry.range_request_count}`);
console.log(`206 responses: ${telemetry.range_response_206}`);
console.log(`Fallbacks: ${telemetry.range_response_fallback}`);
```

## Performance Considerations

### Storage Limits

- **Desktop**: ~50MB (Chrome), ~10MB (Safari)
- **iOS**: ~5MB (Safari PWA)
- **Private mode**: 0MB (in-memory only, cleared on close)

### Startup Impact

- IDB initialization: ~5-50ms (depends on stored data size)
- Range request parsing: <1ms
- Slice operation: <1ms (for typical HLS segments)

### Recommendations

1. **Cache only essential startup assets** (index.html, core JS bundles)
2. **Monitor quota**: Log `idb_quota_exceeded` events
3. **Set expiry**: Consider adding TTL-based cleanup (not implemented yet)
4. **Test on iOS**: Private mode behavior differs significantly

## Known Limitations

1. **No automatic cleanup**: Stored data persists indefinitely (add TTL logic if needed)
2. **No compression**: Raw binary storage (consider gzip if quota is tight)
3. **No versioning**: Cache invalidation requires manual IDB clear
4. **Private mode**: No persistence on iOS Safari private browsing

## Testing

### Unit Tests

```typescript
// Test Range parsing
import { parseRangeHeader } from './startup-byte-cache.js';

expect(parseRangeHeader('bytes=0-499')).toEqual({ start: 0, end: 499 });
expect(parseRangeHeader('bytes=500-')).toEqual({ start: 500, end: undefined });
expect(parseRangeHeader('invalid')).toBeNull();
```

### Integration Tests

1. Load app in normal mode → verify IDB caching
2. Load app in private mode → verify network fallback
3. Send Range request → verify 206 response with correct `Content-Range`
4. Clear IDB → verify network fallback
5. Check telemetry → verify metrics are accurate

## References

- [MDN Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- [MDN Range Header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range)
- [MDN HTTP 206 Partial Content](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/206)
- [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
