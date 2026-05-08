# BookPlay Startup Byte Cache — Quick Start

## 5-Minute Integration

### Step 1: Copy Files
```bash
# Already in place:
# - app/src/startup-byte-cache.ts
# - app/src/startup-byte-cache-client.ts
# - app/src/sw-updated.ts
```

### Step 2: Replace Service Worker
```bash
cp app/src/sw-updated.ts app/src/sw.ts
```

### Step 3: Update Asset Patterns (if needed)
Edit `app/src/sw.ts`, line ~20:
```typescript
const STARTUP_BYTE_PATTERNS = [
  /\/playsvideo\/assets\/.*\.(js|wasm|css)$/,
  /\/playsvideo\/index\.html$/,
  // Add your patterns here
];
```

### Step 4: Build & Test
```bash
pnpm run build
# Test in browser: DevTools → Application → Service Workers
```

### Step 5: Verify Telemetry (Optional)
In browser console:
```javascript
import { logStartupByteCacheTelemetry } from './startup-byte-cache-client.js';
await logStartupByteCacheTelemetry();
```

---

## What Gets Cached?

✅ **Cached** (if matching `STARTUP_BYTE_PATTERNS`):
- `index.html`
- `assets/app.js`
- `assets/vendor.js`
- `assets/styles.css`

❌ **Not cached**:
- `.wasm` files (handled by existing WASM_CACHE)
- Non-GET requests
- Cross-origin requests
- Private mode (iOS Safari)

---

## How to Verify It Works

### Desktop (Chrome/Safari)
1. Open DevTools → Application → IndexedDB
2. Look for `bookplay-startup-cache` database
3. Expand `startup-bytes` object store
4. Should see cached files with `Uint8Array` data

### iOS Safari PWA
1. Open app in standalone mode
2. Open DevTools (if available)
3. Check console for telemetry logs
4. Private mode: IDB should be unavailable

### Network Tab
1. Open DevTools → Network
2. Reload page
3. Look for Range requests: `Range: bytes=0-499`
4. Should see 206 responses from service worker

---

## Troubleshooting

### IDB Not Available
```javascript
// Check if private mode
const telemetry = await navigator.serviceWorker.controller.postMessage({ type: 'GET_TELEMETRY' });
console.log(telemetry.safari_private_mode_detected); // true = private mode
```

### Range Requests Not Working
```javascript
// Check telemetry
const telemetry = await navigator.serviceWorker.controller.postMessage({ type: 'GET_TELEMETRY' });
console.log({
  range_request_count: telemetry.range_request_count,
  range_response_206: telemetry.range_response_206,
  range_request_error: telemetry.range_request_error,
});
```

### Transaction Errors
```javascript
// Check for inactive transaction errors
const telemetry = await navigator.serviceWorker.controller.postMessage({ type: 'GET_TELEMETRY' });
console.log(telemetry.transaction_inactive_error); // Should be 0
```

---

## Performance Impact

- **Startup**: +5-50ms (IDB initialization)
- **Range requests**: <1ms (parsing + slicing)
- **Storage**: ~5-50MB (depends on assets)
- **Private mode**: No impact (network-only)

---

## Next Steps

1. ✅ Integrate (3 steps above)
2. ✅ Test (verify in DevTools)
3. ✅ Monitor (check telemetry)
4. 📖 Read `STARTUP_BYTE_CACHE_GUIDE.md` for advanced topics

---

## Files Reference

| File | Purpose |
|------|---------|
| `app/src/startup-byte-cache.ts` | Core SW module |
| `app/src/startup-byte-cache-client.ts` | Client telemetry |
| `app/src/sw.ts` | Updated service worker |
| `STARTUP_BYTE_CACHE_GUIDE.md` | Full documentation |
| `STARTUP_CACHE_DELIVERY.md` | Technical summary |

---

## Support

- 📖 See `STARTUP_BYTE_CACHE_GUIDE.md` for detailed docs
- 🐛 Check telemetry for diagnostics
- 🔍 Use browser DevTools to inspect IDB
- 📊 Monitor metrics in production

