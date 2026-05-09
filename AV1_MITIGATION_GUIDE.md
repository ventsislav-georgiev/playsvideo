# AV1 Safari/iOS Mitigation Strategy

## Problem Summary

Safari/iPhone users encounter AV1 decode failures with error chain:
```
[av1 @ ...] Your platform doesn't support hardware accelerated AV1 decoding.
[av1 @ ...] Failed to get pixel format.
[av1 @ ...] Missing Sequence Header.
```

**Root causes:**
1. **Hardware limitation**: Safari/iOS AV1 support is hardware-dependent (newer Apple chips only)
2. **Malformed metadata**: Source WebM/AV1 may be missing AV1 Sequence Header OBU
3. **ffmpeg.wasm limitations**: Default build lacks software AV1 decoder (`libdav1d`/`libaom`)

## Solution: Client-Only Mitigation

### Components

#### 1. **av1-capability.ts** — AV1 Detection & Validation
- `detectAv1Support()`: WebCodecs API-based hardware capability check
- `validateAv1Metadata()`: Checks for AV1 Sequence Header OBU in WebM files
- `getAv1Fallback()`: Returns H.264 as fallback codec
- `detectDeviceType()`: Identifies iOS/old devices for better messaging
- Caching to avoid repeated WebCodecs checks

#### 2. **codec-probe-av1.ts** — AV1-Aware Codec Prober
- Wraps standard `CodecProber` with AV1-specific logic
- `shouldUseAv1()`: Async check before AV1 playback
- `diagnoseAv1Support()`: Detailed diagnostic output for debugging

#### 3. **Integration Points**

**In playback-selection.ts:**
```typescript
// Before evaluating HLS playback with AV1:
const av1Support = await prober.getAv1Support();
if (media.sourceVideoCodec === 'av1' && av1Support !== 'supported') {
  // Route to H.264 fallback or show warning
}
```

**In engine.ts (playback decision):**
```typescript
// After demux, before HLS setup:
const av1Diagnosis = await diagnoseAv1Support();
if (av1Diagnosis.recommendation === 'use-fallback') {
  // Trigger fallback asset selection or transcode
}
```

**In Player.tsx (UI):**
```typescript
// Show warning when AV1 is unavailable:
if (av1Support === 'unsupported') {
  showWarning(getAv1UnsupportedMessage(deviceInfo));
}
```

### Deployment Checklist

- [ ] Add `av1-capability.ts` to `src/`
- [ ] Add `codec-probe-av1.ts` to `src/pipeline/`
- [ ] Update `playback-selection.ts` to check AV1 support before HLS evaluation
- [ ] Update `engine.ts` to call `diagnoseAv1Support()` during playback decision
- [ ] Add AV1 warning UI to `Player.tsx`
- [ ] Test on:
  - [ ] iPhone 12 (no AV1 support)
  - [ ] iPhone 14+ (AV1 support)
  - [ ] iPad Air 2 (no AV1 support)
  - [ ] Safari on macOS 12 (no AV1 support)
  - [ ] Safari on macOS 13+ (AV1 support)
- [ ] Verify fallback to H.264 works smoothly
- [ ] Verify metadata validation catches malformed files

### User Experience Flow

1. **Startup**: App detects AV1 support once (cached)
2. **Media Selection**: 
   - If AV1 unsupported → show warning, route to H.264
   - If AV1 supported → proceed with AV1
3. **Playback**:
   - If AV1 decode fails → fallback to H.264 (if available)
   - If metadata invalid → show "corrupted file" warning
4. **Logging**: Diagnostic info sent to console for debugging

### Error Messages

**Device doesn't support AV1:**
```
"This video uses AV1 codec which is not supported on your device. 
Playing H.264 version instead."
```

**File appears malformed:**
```
"This video file appears to be corrupted or incomplete. 
Attempting to play with fallback codec."
```

### Testing AV1 Metadata Validation

```typescript
import { validateAv1Metadata } from './av1-capability';

// Test with valid AV1 file
const valid = await validateAv1Metadata(file);
console.log('Valid AV1:', valid); // true

// Test with malformed file
const malformed = await validateAv1Metadata(corruptedFile);
console.log('Malformed:', malformed); // false
```

### Performance Considerations

- **WebCodecs detection**: ~5-10ms (cached after first call)
- **Metadata validation**: ~1-2ms per file (reads first 64KB only)
- **No impact on H.264/VP9 playback**: Checks only run for AV1 sources

### Future Enhancements

1. **Server-side fallback**: If client-side H.264 unavailable, request server transcode
2. **Adaptive bitrate**: Prefer H.264 on older devices even if AV1 available
3. **Telemetry**: Track AV1 support distribution across user base
4. **ffmpeg.wasm upgrade**: Enable software AV1 decoder in custom build

## References

- [WebCodecs API](https://www.w3.org/TR/webcodecs/)
- [AV1 Bitstream Specification](https://aomediacodec.org/av1-specification/)
- [Safari AV1 Support](https://caniuse.com/av1)
- [ffmpeg.wasm Issue #814](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/814)
