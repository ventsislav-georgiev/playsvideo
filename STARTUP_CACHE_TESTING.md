# Startup Byte Cache — Testing Guide

**Status**: ✅ **INTEGRATED INTO PRODUCTION SERVICE WORKER**  
**Date**: May 7, 2026  
**Files Updated**: `public/sw.js`, `app/src/sw.ts`

## Quick Verification

### 1. Verify Integration in Production SW
```bash
grep -n "initStartupByteCache\|handleStartupByteFetch" public/sw.js
```

Expected output:
```
28:async function initStartupByteCache() {
53:function isStartupByteCacheAvailable() {
58:async function handleStartupByteFetch(request) {
118:      initStartupByteCache(),
128:  if (isStartupByteCacheAvailable()) {
```

### 2. Verify TypeScript Compilation
```bash
cd /Users/ventsislav.georgiev/personal/playsvideo && npx tsc --noEmit 2>&1 | grep -E "(sw\.ts|startup-byte-cache)"
```

Expected: No output (no errors)

### 3. Verify Build Success
```bash
cd /Users/ventsislav.georgiev/personal/playsvideo && pnpm run build 2>&1 | tail -5
```

Expected: `EXIT_CODE=0`

---

## Browser Testing Checklist

### Setup
1. Open the app in a modern browser (Chrome, Firefox, Safari, Edge)
2. Open DevTools (F12)
3. Go to Application tab

### Test 1: Service Worker Registration
- [ ] Go to Application → Service Workers
- [ ] Verify SW is registered and active
- [ ] Check for any errors in console

### Test 2: IndexedDB Initialization
- [ ] Go to Application → IndexedDB
- [ ] Reload the page
- [ ] Look for database: `bookplay-startup-cache`
- [ ] Look for object store: `startup-bytes`
- [ ] Verify database was created successfully

### Test 3: Range Request Handling
- [ ] Go to Network tab
- [ ] Reload page
- [ ] Look for requests with `Range: bytes=0-1023` header
- [ ] Verify responses have `206 Partial Content` status
- [ ] Check `Content-Range` header in response (e.g., `Content-Range: bytes 0-1023/...`)

### Test 4: Cache Storage
- [ ] After reload, go to Application → IndexedDB → bookplay-startup-cache → startup-bytes
- [ ] Verify entries are stored with keys like `{url}:{content-range}`
- [ ] Check that byte ranges are being cached

### Test 5: Telemetry Collection
- [ ] Open browser console
- [ ] Run:
```javascript
navigator.serviceWorker.controller.postMessage({type: 'GET_TELEMETRY'}, [channel.port2]);
```
- [ ] Check IndexedDB for telemetry data
- [ ] Verify metrics are being recorded

### Test 6: Offline Mode
- [ ] Enable offline in DevTools (Network tab → Offline)
- [ ] Reload page
- [ ] Verify cached content loads from IDB
- [ ] Check console for any errors
- [ ] Go back online

### Test 7: Private Mode (Safari)
- [ ] Open in Safari private mode
- [ ] Reload page
- [ ] Check console for private mode detection
- [ ] Verify IDB gracefully falls back
- [ ] Check telemetry for `safari_private_mode_detected: true`

### Test 8: Network Throttling
- [ ] Enable slow 3G in DevTools (Network tab → Throttling)
- [ ] Reload page
- [ ] Monitor Network tab for Range requests
- [ ] Verify bandwidth reduction from partial requests
- [ ] Check telemetry for request counts

---

## Telemetry Metrics

After running tests, check IndexedDB for these metrics:

```javascript
{
  idb_open_success: number,              // IDB initialized successfully
  idb_open_error: number,                // IDB failed to open
  idb_quota_exceeded: number,            // Storage quota exceeded
  safari_idb_available: boolean,         // IDB available (Safari check)
  safari_private_mode_detected: boolean, // Private mode detected
  range_request_count: number,           // Total Range requests made
  range_request_error: number,           // Range requests that failed
  range_response_206: number,            // Successful 206 responses
  range_response_fallback: number,       // Fallback to full response
  transaction_inactive_error: number,    // IDB transaction errors
  sw_activation_time_ms: number          // Time to initialize cache
}
```

---

## Expected Behavior

### Normal Operation
1. **Activation**: SW initializes IDB on activate event
2. **Fetch**: For Range requests, SW attempts to cache partial bytes
3. **Offline**: Cached bytes are served from IDB
4. **Telemetry**: Metrics are collected and available via message port

### Error Handling
- **IDB Unavailable**: Falls back to network (no caching)
- **Private Mode**: Detects and disables IDB caching
- **Quota Exceeded**: Logs error, continues with network
- **Transaction Error**: Logs error, continues with network

### Performance Impact
- **Bandwidth**: Range requests reduce bandwidth for partial content
- **Latency**: IDB lookups add minimal overhead (~1-5ms)
- **Storage**: Configurable quota (default: unlimited)

---

## Debugging

### Check SW Console
```javascript
// In DevTools console
navigator.serviceWorker.controller.postMessage({type: 'GET_TELEMETRY'}, [channel.port2]);
```

### Monitor Network Requests
1. Open Network tab
2. Filter by "Range" in search
3. Look for requests with `Range: bytes=` header
4. Check response status (206 = success, 200 = fallback)

### Check IDB Storage
1. Application → IndexedDB → bookplay-startup-cache
2. Look at object store: startup-bytes
3. Keys show URL + content-range
4. Values show cached byte buffers

### Common Issues

| Issue | Solution |
|-------|----------|
| IDB not created | Check browser console for errors, verify private mode |
| No Range requests | Check if server supports Range requests (206 responses) |
| Telemetry not available | Verify message port is passed correctly |
| High memory usage | Check IDB quota settings, consider limiting cache size |

---

## Deployment Checklist

Before deploying to production:

- [ ] Run all browser tests above
- [ ] Verify telemetry is being collected
- [ ] Test offline mode works correctly
- [ ] Check Safari private mode detection
- [ ] Monitor bandwidth savings in Network tab
- [ ] Verify no console errors
- [ ] Test on multiple browsers (Chrome, Firefox, Safari, Edge)
- [ ] Test on mobile devices
- [ ] Check performance impact (should be minimal)

---

## Next Steps

1. **Run browser tests** from checklist above
2. **Monitor telemetry** in production
3. **Analyze bandwidth savings** from Range requests
4. **Optimize cache patterns** based on real usage
5. **Consider adding analytics** to track cache hit rates

---

**Ready for testing!**
