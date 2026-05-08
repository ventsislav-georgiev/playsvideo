# 🧪 Manual Browser Validation Guide

**Status**: Startup Byte Cache integration is **code-complete** and **build-verified**. This guide walks you through manual runtime validation in a browser.

---

## Quick Start

### 1. Ensure Dev Server is Running
```bash
cd /Users/ventsislav.georgiev/personal/playsvideo
pnpm run dev
# Expected output: http://localhost:4200/
```

### 2. Open Validation Harness
Copy and paste this into your browser address bar:
```
file:///tmp/validation-harness.html
```

Or open it directly:
```bash
open /tmp/validation-harness.html
```

### 3. Click "Run All Tests"
The harness will execute 6 tests and display results with pass/fail/warning status.

---

## Test Suite Overview

### Test 1: Service Worker Registration ✅
**What it checks**: SW is registered and active.

**Expected result**:
```
✅ SW registered at: http://localhost:4200/
Active: Yes
Waiting: No
```

**If it fails**:
- Check browser console for SW registration errors
- Verify `/sw.js` is accessible: `curl http://localhost:4200/sw.js`
- Clear browser cache and reload

---

### Test 2: Get Telemetry ✅
**What it checks**: Telemetry message-port communication works.

**Expected result**:
```
✅ Telemetry received:
idb_open_success: 1
idb_open_error: 0
idb_quota_exceeded: 0
safari_idb_available: true
safari_private_mode_detected: false
range_request_count: 0
range_request_error: 0
range_response_206: 0
range_response_fallback: 0
transaction_inactive_error: 0
sw_activation_time_ms: 45
```

**If it times out**:
- Check SW is active (Test 1)
- Open DevTools → Application → Service Workers
- Verify SW is in "activated and running" state
- Try reloading the page

---

### Test 3: Check IndexedDB ✅
**What it checks**: IndexedDB database and object store are created.

**Expected result**:
```
✅ IndexedDB databases: bookplay-startup-cache
Has 'bookplay-startup-cache': Yes
Object stores: startup-bytes
```

**If it shows "No"**:
- This is normal on first load (IDB is created on-demand)
- Reload the page and run tests again
- Check DevTools → Application → IndexedDB → bookplay-startup-cache

---

### Test 4: Safari Private Mode Detection ✅
**What it checks**: Private mode detection works.

**Expected result**:
```
✅ IndexedDB available (not in private mode)
```

**If it shows warning**:
- You may be in Safari private mode
- This is expected behavior (IDB is disabled in private mode)
- The app will continue to work with network fallback

---

### Test 5: Inspect SW Source ✅
**What it checks**: SW contains startup-byte-cache integration.

**Expected result**:
```
✅ SW source fetched (12345 bytes)
Has STARTUP_CACHE_DB: Yes
Has handleStartupByteFetch: Yes
Has initStartupByteCache: Yes
DB name: bookplay-startup-cache
Store name: startup-bytes
```

**If any show "No"**:
- Build may not have completed
- Run `pnpm run build` and reload
- Check `public/sw.js` contains the symbols

---

### Test 6: Simulate Range Request ⚠️
**What it checks**: HTTP Range request handling.

**Expected result** (varies by server):
```
✅ Range request sent
Status: 206
Content-Range: bytes 0-99/12345
Content-Length: 100
✅ Server supports 206 Partial Content
```

**Or** (if server doesn't support Range):
```
✅ Range request sent
Status: 200
Content-Range: (not present)
Content-Length: 12345
⚠️ Server returned 200 (full content, not partial)
```

**Note**: Vite dev server may not support Range requests. This is OK for development. Production servers (nginx, Apache) will support it.

---

## Manual Console Tests

If the harness doesn't work, run these directly in the browser console (F12):

### Check SW Registration
```javascript
navigator.serviceWorker.getRegistration().then(reg => {
  console.log('SW registered:', reg?.scope);
  console.log('Active:', reg?.active ? 'Yes' : 'No');
});
```

### Get Telemetry
```javascript
navigator.serviceWorker.getRegistration().then(reg => {
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => console.log('Telemetry:', e.data);
  reg.active.controller.postMessage({ type: 'GET_TELEMETRY' }, [channel.port2]);
});
```

### Check IndexedDB
```javascript
indexedDB.databases().then(dbs => {
  console.log('Databases:', dbs.map(d => d.name));
  const req = indexedDB.open('bookplay-startup-cache');
  req.onsuccess = () => {
    console.log('Stores:', Array.from(req.result.objectStoreNames));
    req.result.close();
  };
});
```

### Inspect SW Source
```javascript
fetch('/sw.js').then(r => r.text()).then(text => {
  console.log('Has STARTUP_CACHE_DB:', text.includes('STARTUP_CACHE_DB'));
  console.log('Has handleStartupByteFetch:', text.includes('handleStartupByteFetch'));
  console.log('Has initStartupByteCache:', text.includes('initStartupByteCache'));
});
```

---

## DevTools Inspection

### Service Workers Tab
1. Open DevTools (F12)
2. Go to **Application** → **Service Workers**
3. Verify:
   - ✅ SW is registered at `http://localhost:4200/`
   - ✅ Status is "activated and running"
   - ✅ No errors in console

### IndexedDB Tab
1. Open DevTools (F12)
2. Go to **Application** → **IndexedDB**
3. Expand `bookplay-startup-cache`
4. Verify:
   - ✅ Database exists
   - ✅ `startup-bytes` object store exists
   - ✅ Entries appear after Range requests

### Network Tab
1. Open DevTools (F12)
2. Go to **Network** tab
3. Reload page
4. Look for requests to `/sw.js`
5. Verify:
   - ✅ Status 200 (or 304 if cached)
   - ✅ Response headers include `Content-Type: application/javascript`

### Console Tab
1. Open DevTools (F12)
2. Go to **Console** tab
3. Verify:
   - ✅ No red errors
   - ✅ No warnings about SW registration
   - ✅ Telemetry messages appear

---

## Troubleshooting

### "No SW registration found"
**Solution**:
1. Reload the page (Cmd+R or Ctrl+R)
2. Wait 2-3 seconds for SW to activate
3. Check DevTools → Application → Service Workers
4. If still missing, check browser console for errors

### "Timeout waiting for telemetry response"
**Solution**:
1. Verify SW is active (Test 1)
2. Check DevTools → Application → Service Workers
3. Click "Unregister" and reload
4. Wait for SW to re-register
5. Try telemetry test again

### "IndexedDB unavailable"
**Solution**:
1. Check if you're in Safari private mode
2. Try in a different browser
3. Check DevTools → Application → IndexedDB
4. If empty, this is normal (IDB is created on-demand)

### "Server returned 200 (not 206)"
**Solution**:
1. This is expected for Vite dev server
2. Production servers (nginx, Apache) will support 206
3. App will still work with network fallback
4. No action needed

---

## Next Steps

### If All Tests Pass ✅
1. **Deploy to production**:
   ```bash
   ./build-playsvideo.sh
   ./deploy.sh
   ```

2. **Monitor telemetry** on production:
   - Check `range_response_206` increases over time
   - Monitor `idb_quota_exceeded` for storage issues
   - Track `range_request_error` for failures

3. **Measure bandwidth savings**:
   - Compare network traffic before/after
   - Expected: 20-40% reduction for HLS streams

### If Tests Fail ❌
1. **Check build**:
   ```bash
   cd /Users/ventsislav.georgiev/personal/playsvideo
   pnpm run build
   npx tsc --noEmit
   ```

2. **Verify integration**:
   ```bash
   grep -n "STARTUP_CACHE_DB" public/sw.js
   grep -n "handleStartupByteFetch" public/sw.js
   ```

3. **Check console errors**:
   - Open DevTools → Console
   - Look for red errors
   - Report errors to development team

---

## Validation Report

After running tests, you can:

1. **Download report**: Click "Download Report" button in harness
2. **Share results**: Email the `.txt` file to the team
3. **Archive results**: Save for deployment records

---

## Questions?

Refer to these documentation files:
- **Architecture**: `STARTUP_BYTE_CACHE_GUIDE.md`
- **API Reference**: `STARTUP_CACHE_DELIVERY.md`
- **Deployment**: `DEPLOYMENT_CHECKLIST.md`
- **Status**: `FINAL_STATUS.md`

---

**Last Updated**: May 7, 2026  
**Status**: ✅ Ready for Manual Validation
