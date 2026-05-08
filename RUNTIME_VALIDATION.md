# Runtime Validation Guide — Startup Byte Cache

**Status**: Ready for browser execution  
**Date**: May 7, 2026  
**Target**: http://localhost:4200/ (dev server)

---

## 🧪 Browser Console Tests

Open browser DevTools (F12) and run these tests in the console:

### Test 1: Service Worker Registration
```javascript
// Check if SW is registered and active
navigator.serviceWorker.getRegistrations().then(regs => {
  console.log('✅ SW Registrations:', regs.length);
  regs.forEach(reg => {
    console.log('  - Scope:', reg.scope);
    console.log('  - Active:', reg.active ? 'Yes' : 'No');
    console.log('  - Installing:', reg.installing ? 'Yes' : 'No');
    console.log('  - Waiting:', reg.waiting ? 'Yes' : 'No');
  });
});
```

**Expected Output**:
- At least 1 registration
- Active SW present
- Scope includes current origin

---

### Test 2: Get Telemetry
```javascript
// Request telemetry from SW
async function getTelemetry() {
  const regs = await navigator.serviceWorker.getRegistrations();
  if (!regs.length || !regs[0].active) {
    console.error('❌ No active SW');
    return;
  }
  
  const channel = new MessageChannel();
  regs[0].active.controller.postMessage(
    { type: 'GET_TELEMETRY' },
    [channel.port2]
  );
  
  channel.port1.onmessage = (e) => {
    console.log('✅ Telemetry received:');
    console.table(e.data);
  };
  
  channel.port1.start();
  
  // Timeout after 2 seconds
  setTimeout(() => {
    console.warn('⚠️ Telemetry timeout (SW may not be responding)');
  }, 2000);
}

getTelemetry();
```

**Expected Output**:
- Telemetry object with 11 keys
- `idb_open_success` > 0 (or `safari_idb_available: false` on Safari private mode)
- `sw_activation_time_ms` > 0

---

### Test 3: Check IndexedDB
```javascript
// Verify IndexedDB database exists
async function checkIndexedDB() {
  const dbs = await indexedDB.databases();
  console.log('✅ Available databases:', dbs.map(d => d.name));
  
  const hasStartupCache = dbs.some(d => d.name === 'bookplay-startup-cache');
  console.log(hasStartupCache ? '✅ Startup cache DB found' : '❌ Startup cache DB NOT found');
  
  // Try to open it
  try {
    const req = indexedDB.open('bookplay-startup-cache', 1);
    req.onsuccess = () => {
      const db = req.result;
      console.log('✅ DB opened successfully');
      console.log('  - Object stores:', Array.from(db.objectStoreNames));
      db.close();
    };
    req.onerror = () => {
      console.error('❌ Failed to open DB:', req.error);
    };
  } catch (e) {
    console.error('❌ IndexedDB error:', e.message);
  }
}

checkIndexedDB();
```

**Expected Output**:
- `bookplay-startup-cache` in database list
- Object store: `startup-bytes`
- DB opens successfully

---

### Test 4: Check Safari Private Mode
```javascript
// Detect Safari private mode
async function checkSafariPrivateMode() {
  try {
    const test = indexedDB.open('test');
    test.onerror = () => {
      console.log('⚠️ Safari private mode detected (IDB disabled)');
    };
    test.onsuccess = () => {
      console.log('✅ IDB available (not in private mode)');
      test.result.close();
    };
  } catch (e) {
    console.log('⚠️ Private mode or IDB unavailable:', e.message);
  }
}

checkSafariPrivateMode();
```

**Expected Output**:
- Either "IDB available" or "private mode detected"

---

### Test 5: Inspect SW Source
```javascript
// Check if SW has startup-byte-cache symbols
async function inspectSW() {
  const regs = await navigator.serviceWorker.getRegistrations();
  if (!regs.length) {
    console.error('❌ No SW registered');
    return;
  }
  
  const sw = regs[0].active;
  console.log('✅ SW Controller:', sw.scriptURL);
  
  // Fetch SW source and check for symbols
  try {
    const response = await fetch(sw.scriptURL);
    const source = await response.text();
    
    const symbols = [
      'STARTUP_CACHE_DB',
      'STARTUP_CACHE_STORE',
      'initStartupByteCache',
      'handleStartupByteFetch',
      'isStartupByteCacheAvailable'
    ];
    
    console.log('✅ Checking for startup-byte-cache symbols:');
    symbols.forEach(sym => {
      const found = source.includes(sym);
      console.log(`  ${found ? '✅' : '❌'} ${sym}`);
    });
  } catch (e) {
    console.error('❌ Failed to fetch SW source:', e.message);
  }
}

inspectSW();
```

**Expected Output**:
- All 5 symbols found in SW source

---

### Test 6: Simulate Range Request
```javascript
// Simulate a Range request (requires a real resource)
async function testRangeRequest() {
  try {
    // Use a real resource from the site
    const response = await fetch('/', {
      headers: {
        'Range': 'bytes=0-1023'
      }
    });
    
    console.log('✅ Range request response:');
    console.log('  - Status:', response.status);
    console.log('  - Content-Range:', response.headers.get('Content-Range'));
    console.log('  - Content-Length:', response.headers.get('Content-Length'));
    
    if (response.status === 206) {
      console.log('✅ 206 Partial Content response received');
    } else if (response.status === 200) {
      console.log('⚠️ Full content returned (206 not supported)');
    }
  } catch (e) {
    console.error('❌ Range request failed:', e.message);
  }
}

testRangeRequest();
```

**Expected Output**:
- Status: 206 (or 200 if server doesn't support Range)
- Content-Range header present (if 206)

---

## 📊 Network Tab Inspection

1. Open DevTools → Network tab
2. Reload page
3. Look for:
   - **SW registration**: `sw.js` request (should be cached after first load)
   - **206 responses**: Any requests with status 206 (Partial Content)
   - **Range headers**: Requests with `Range: bytes=...` header

---

## 🔍 Application Tab Inspection

1. Open DevTools → Application tab
2. Check:
   - **Service Workers**: Should show active SW for current scope
   - **IndexedDB**: Should show `bookplay-startup-cache` database
   - **Storage**: Check quota usage

---

## ✅ Validation Checklist

- [ ] SW registered and active
- [ ] Telemetry received via message port
- [ ] IndexedDB `bookplay-startup-cache` exists
- [ ] Object store `startup-bytes` present
- [ ] All 5 startup-byte-cache symbols found in SW
- [ ] Range requests return 206 (or 200 fallback)
- [ ] No console errors
- [ ] Safari private mode detection works (if on Safari)

---

## 🐛 Troubleshooting

### "No active SW"
- Reload page
- Check if SW registration failed (check console for errors)
- Verify SW script URL is correct

### "Telemetry timeout"
- SW may not be responding to messages
- Check SW console for errors
- Verify message port is being used correctly

### "IndexedDB not found"
- Check if browser supports IndexedDB
- On Safari private mode, IDB is disabled (expected)
- Check browser console for quota errors

### "206 not returned"
- Server may not support Range requests
- Check server configuration
- Fallback to 200 is acceptable

---

## 📝 Notes

- Tests can be run individually or as a suite
- Copy-paste each test into browser console
- Results will appear in console immediately
- Some tests may take 1-2 seconds to complete
- Private mode detection is browser-specific

---

**Ready to validate**: Run tests in browser console at http://localhost:4200/

