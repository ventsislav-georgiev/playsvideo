# Audio Track Selection Integration Guide

## Overview

This guide covers integrating audio track selection into PlaysVideoEngine and BookPlay.

**Key Components:**
- `src/audio-track-manager.ts` — Core audio track management (hls.js + Safari native HLS)
- `app/src/components/AudioTrackSelector.tsx` — React UI component for track selection
- Integration points in `src/engine.ts` and BookPlay's player UI

---

## Architecture

### Audio Track Manager (`AudioTrackManager`)

Manages audio track selection for **hls.js playback** (MSE mode).

**Features:**
- Discovers available audio tracks from hls.js manifest
- Provides track metadata (language, label, role, codec, bitrate, channels)
- Handles user selection and persistence via localStorage
- Event-driven API for UI updates
- Capability detection

**Usage:**

```typescript
import { AudioTrackManager } from 'playsvideo';
import Hls from 'hls.js';

const video = document.querySelector('video')!;
const hls = new Hls();

// Initialize manager
const audioManager = new AudioTrackManager({
  storageKeyPrefix: 'bookplay_audio_track',
  debug: true,
});

audioManager.initialize(hls, video, contentId);

// Listen for track changes
audioManager.on((event) => {
  if (event.type === 'tracks-available') {
    console.log('Available tracks:', event.tracks);
  } else if (event.type === 'track-switched') {
    console.log('Track switched to:', event.selectedIndex);
  }
});

// Select a track
audioManager.selectTrack(1);

// Or by language
audioManager.selectTrackByLanguage('es');

// Get current state
const tracks = audioManager.getTracks();
const selected = audioManager.getSelectedTrack();
const isAvailable = audioManager.isAvailable();
```

### Safari Native Audio Track Manager (`SafariNativeAudioTrackManager`)

Manages audio track selection for **Safari native HLS playback** (via `<video src="...m3u8">`).

**Limitations:**
- Uses `HTMLMediaElement.audioTracks` API (limited browser support)
- Safari native HLS has constraints on track switching
- Fallback to MSE (hls.js) recommended for full control

**Usage:**

```typescript
import { SafariNativeAudioTrackManager } from 'playsvideo';

const video = document.querySelector('video')!;

const audioManager = new SafariNativeAudioTrackManager({
  debug: true,
});

audioManager.initialize(video, contentId);

// Same API as AudioTrackManager
audioManager.selectTrack(0);
audioManager.getTracks();
```

### React Component (`AudioTrackSelector`)

Provides a dropdown UI for track selection.

**Features:**
- Auto-hides when only one track available
- Shows language, role, and default status
- Persists user selection
- Responsive to track changes

**Usage:**

```tsx
import { AudioTrackSelector } from 'playsvideo';
import { AudioTrackManager } from 'playsvideo';

function PlayerUI({ audioManager }: { audioManager: AudioTrackManager | null }) {
  return (
    <div className="player-controls">
      <AudioTrackSelector
        manager={audioManager}
        className="player-control"
        showLabel={true}
      />
    </div>
  );
}
```

---

## Integration Steps

### 1. Update `src/engine.ts`

Add audio track manager initialization:

```typescript
import { AudioTrackManager } from './audio-track-manager.js';

export class PlaysVideoEngine {
  private audioTrackManager: AudioTrackManager | null = null;

  // In the hls.js initialization section (around line 2130):
  private initializeHls(): void {
    // ... existing code ...

    // Initialize audio track manager
    this.audioTrackManager = new AudioTrackManager({
      storageKeyPrefix: 'bookplay_audio_track',
      debug: false,
    });

    this.audioTrackManager.initialize(
      this.hls,
      this.video,
      this.currentContentId // Pass content ID for persistence
    );
  }

  // Expose audio track manager to consumers
  getAudioTrackManager(): AudioTrackManager | null {
    return this.audioTrackManager;
  }

  // Clean up in destroy()
  destroy(): void {
    // ... existing cleanup ...
    this.audioTrackManager?.destroy();
  }
}
```

### 2. Update BookPlay Player UI

In BookPlay's player component:

```swift
// In BookPlayServer/Sources/BookPlayServer/Public/index.html
// or your player wrapper component

<div id="player-controls">
  <div id="audio-track-selector"></div>
  <!-- other controls -->
</div>

<script>
  // After engine is initialized
  const engine = new PlaysVideoEngine(video);
  const audioManager = engine.getAudioTrackManager();

  // Mount React component
  const root = ReactDOM.createRoot(
    document.getElementById('audio-track-selector')
  );
  root.render(
    <AudioTrackSelector manager={audioManager} />
  );
</script>
```

### 3. Add CSS Styling

```css
.audio-track-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.audio-track-selector label {
  font-size: 14px;
  font-weight: 500;
  color: #666;
}

.audio-track-select {
  padding: 6px 12px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 14px;
  background-color: white;
  cursor: pointer;
  min-width: 200px;
}

.audio-track-select:hover {
  border-color: #999;
}

.audio-track-select:focus {
  outline: none;
  border-color: #0066cc;
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .audio-track-selector label {
    color: #aaa;
  }

  .audio-track-select {
    background-color: #222;
    color: #fff;
    border-color: #444;
  }

  .audio-track-select:hover {
    border-color: #666;
  }
}
```

---

## Runtime Behavior

### Track Discovery Flow

1. **Manifest Parsed** → hls.js emits `hlsManifestParsed`
2. **AudioTrackManager** discovers tracks from `hls.audioTracks`
3. **Metadata Extracted** → language, label, role, codec, bitrate, channels
4. **User Selection Restored** → from localStorage if available
5. **Event Emitted** → `tracks-available` event with full track list
6. **UI Updated** → React component renders dropdown

### Track Selection Flow

1. **User Selects Track** → dropdown change event
2. **Manager Updates** → `hls.audioTrack = index`
3. **hls.js Switches** → emits `hlsAudioTrackSwitching` → `hlsAudioTrackSwitched`
4. **Selection Persisted** → saved to localStorage
5. **Event Emitted** → `track-switched` event
6. **UI Updated** → dropdown reflects new selection

### Persistence

- **Key Format:** `bookplay_audio_track_{contentId}`
- **Value:** Track index (0-based)
- **Scope:** Per-content (different videos can have different selections)
- **Fallback:** If no stored selection, uses default track or first track

---

## Safari Native HLS Limitations

### Current Constraints

| Feature | hls.js (MSE) | Safari Native HLS |
|---------|--------------|-------------------|
| Track Discovery | ✅ Full | ⚠️ Limited |
| Track Switching | ✅ Reliable | ⚠️ Unreliable |
| Metadata Access | ✅ Complete | ⚠️ Basic |
| Persistence | ✅ Works | ✅ Works |
| Event Notifications | ✅ Detailed | ⚠️ Basic |

### Workarounds

1. **Prefer MSE Playback** — Use hls.js for all playback (recommended)
2. **Capability Detection** — Check `AudioTrackManager.canPlayNativeHls()` and `AudioTrackManager.supportsHtmlAudioTracks()`
3. **Graceful Degradation** — Show UI only when tracks are reliably available
4. **Manifest Quality** — Ensure HLS manifest has proper `EXT-X-MEDIA` metadata

---

## Testing

### Unit Tests

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { AudioTrackManager } from '../src/audio-track-manager';

describe('AudioTrackManager', () => {
  let manager: AudioTrackManager;

  beforeEach(() => {
    manager = new AudioTrackManager({ debug: true });
  });

  it('should discover audio tracks', () => {
    // Mock hls.js instance
    const mockHls = {
      audioTracks: [
        { lang: 'en', default: true, attrs: { ROLE: 'main' } },
        { lang: 'es', default: false, attrs: { ROLE: 'dub' } },
      ],
      audioTrack: 0,
      on: () => {},
    };

    manager.initialize(mockHls as any, document.createElement('video'));
    const tracks = manager.getTracks();

    expect(tracks).toHaveLength(2);
    expect(tracks[0].language).toBe('en');
    expect(tracks[1].language).toBe('es');
  });

  it('should select track by index', () => {
    // ... test implementation
  });

  it('should persist selection to localStorage', () => {
    // ... test implementation
  });
});
```

### Integration Tests

1. **Multi-track MKV** — Test with MKV containing 2+ audio tracks
2. **Language Switching** — Verify track switches correctly
3. **Persistence** — Reload page and verify selection restored
4. **Safari Native** — Test on Safari with native HLS playback
5. **Single Track** — Verify UI hides when only one track

### Manual Testing Matrix

| Browser | Playback Mode | Tracks | Selection | Persistence |
|---------|---------------|--------|-----------|-------------|
| Chrome | MSE (hls.js) | ✅ | ✅ | ✅ |
| Firefox | MSE (hls.js) | ✅ | ✅ | ✅ |
| Safari | MSE (hls.js) | ✅ | ✅ | ✅ |
| Safari | Native HLS | ⚠️ | ⚠️ | ✅ |
| Edge | MSE (hls.js) | ✅ | ✅ | ✅ |

---

## API Reference

### `AudioTrackManager`

#### Constructor

```typescript
new AudioTrackManager(config?: AudioTrackManagerConfig)
```

#### Methods

- `initialize(hls: Hls, video: HTMLVideoElement, contentId?: string): void`
- `selectTrack(index: number): void`
- `selectTrackByLanguage(languageCode: string): boolean`
- `getTracks(): AudioTrackInfo[]`
- `getSelectedTrack(): AudioTrackInfo | null`
- `getSelectedTrackIndex(): number`
- `isAvailable(): boolean`
- `on(listener: AudioTrackEventListener): () => void`
- `destroy(): void`

#### Static Methods

- `canPlayNativeHls(): boolean`
- `supportsHtmlAudioTracks(): boolean`

### `AudioTrackInfo`

```typescript
interface AudioTrackInfo {
  index: number;
  language: string;
  label: string;
  role?: string;
  isDefault: boolean;
  isSelected: boolean;
  codec?: string;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
}
```

### Events

```typescript
type AudioTrackSelectionEvent =
  | { type: 'tracks-available'; tracks: AudioTrackInfo[]; selectedIndex: number }
  | { type: 'track-switched'; selectedIndex: number; tracks: AudioTrackInfo[] }
  | { type: 'track-error'; error: string };
```

---

## Troubleshooting

### No Tracks Discovered

- **Cause:** Manifest doesn't include audio tracks or hls.js not initialized
- **Fix:** Verify HLS manifest has `EXT-X-MEDIA` entries; check hls.js initialization

### Track Selection Not Persisting

- **Cause:** localStorage disabled or contentId not provided
- **Fix:** Enable localStorage; pass contentId to `initialize()`

### Safari Native HLS Not Working

- **Cause:** `HTMLMediaElement.audioTracks` not supported or manifest missing metadata
- **Fix:** Use MSE playback (hls.js) instead; ensure manifest has proper `EXT-X-MEDIA` tags

### UI Not Showing

- **Cause:** Only one track available or manager not initialized
- **Fix:** Check `isAvailable()` returns true; verify manager initialization

---

## Future Enhancements

- [ ] Shaka Player integration
- [ ] WebCodecs audio decoder support
- [ ] Subtitle track synchronization
- [ ] Audio description track support
- [ ] Accessibility improvements (ARIA labels)
- [ ] Advanced filtering (by language, role, codec)
- [ ] Track statistics (bitrate, sample rate display)

