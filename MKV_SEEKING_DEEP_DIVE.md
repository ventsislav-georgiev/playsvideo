# MKV Subtitle Seeking: Byte-Level Technical Deep Dive

**Status**: Research & Documentation  
**Date**: May 3, 2026  
**Focus**: Technical implementation details, not user-facing features

---

## Table of Contents

1. [MKV File Structure Overview](#mkv-file-structure-overview)
2. [Cues Element: The Seeking Index](#cues-element-the-seeking-index)
3. [Cluster Layout & Subtitle Interleaving](#cluster-layout--subtitle-interleaving)
4. [Seeking Strategies: MPV vs KODI vs ffmpeg](#seeking-strategies-mpv-vs-kodi-vs-ffmpeg)
5. [Range Request Strategy for HTTP Seeking](#range-request-strategy-for-http-seeking)
6. [Phase 1 Engine Implementation Mapping](#phase-1-engine-implementation-mapping)
7. [Performance Optimization Techniques](#performance-optimization-techniques)

---

## MKV File Structure Overview

### EBML Container Hierarchy

```
EBML File
├── EBML Header (metadata about the file format)
├── Segment
│   ├── SeekHead (optional, points to major elements)
│   ├── Info (duration, title, muxing app)
│   ├── Tracks (track definitions: video, audio, subtitles)
│   ├── Cues (seeking index - CRITICAL for seeking)
│   ├── Cluster 1 (frames/packets with timestamps)
│   ├── Cluster 2
│   ├── Cluster 3
│   └── ...
│   └── Tags (optional, metadata)
```

### Key Insight: Cues Element Location

The **Cues element typically appears AFTER all Clusters** in MKV files (though spec allows it anywhere). This means:

- ✅ **Advantage**: Can be written after encoding (streaming-friendly)
- ❌ **Disadvantage**: Must seek to end of file to find it (or use SeekHead pointer)
- ⚠️ **Impact**: HTTP Range requests need to fetch Cues first to know where to seek

---

## Cues Element: The Seeking Index

### EBML Structure (Byte-Level)

```
Cues Element (ID: 0x1C 0x53 0xBB 0x6B)
├── Size: Variable-length encoded
└── CuePoint (repeats for each indexed position)
    ├── CueTime (timestamp in milliseconds)
    ├── CueTrackPositions (one per track)
    │   ├── CueTrack (track number)
    │   ├── CueClusterPosition (byte offset to cluster)
    │   ├── CueRelativePosition (byte offset within cluster)
    │   ├── CueDuration (optional, duration of this cue)
    │   └── CueBlockNumber (optional, which block in cluster)
    └── [next CuePoint]
```

### Example: Cues Binary Layout

```
1C 53 BB 6B          # Cues element ID
82 00 00 00          # Size: 128 bytes (variable-length encoded)

# CuePoint 1 (timestamp 0ms)
BB 00                # CuePoint element ID
81 00                # Size: 1 byte
B3 00                # CueTime: 0ms

B7 00                # CueTrackPositions element ID
81 00                # Size: 1 byte
D7 00                # CueTrack: 0 (video track)
F1 00 00 00 00 00    # CueClusterPosition: 0x1000 (4096 bytes)
F0 00                # CueRelativePosition: 0 (start of cluster)

# CuePoint 2 (timestamp 1000ms)
BB 00                # CuePoint element ID
81 00                # Size: 1 byte
B3 03 E8             # CueTime: 1000ms (variable-length encoded)

B7 00                # CueTrackPositions element ID
81 00                # Size: 1 byte
D7 01                # CueTrack: 1 (audio track)
F1 00 00 00 00 10    # CueClusterPosition: 0x10000 (65536 bytes)
F0 00                # CueRelativePosition: 0
```

### Cues Index Density

**Key Question**: How many CuePoints are in a typical MKV?

- **Video-focused**: 1 keyframe per 2-5 seconds → ~200-500 cues per hour
- **Audio-focused**: 1 cue per 100ms → ~36,000 cues per hour
- **Subtitle-focused**: 1 cue per subtitle block → varies (10-1000 per hour)

**Impact on seeking**:
- Sparse cues (video): Must scan clusters after seeking to cue
- Dense cues (audio): Can seek directly to exact timestamp

---

## Cluster Layout & Subtitle Interleaving

### Cluster Structure (Byte-Level)

```
Cluster (ID: 0x1F 0x43 0xB6 0x75)
├── Size: Variable-length encoded
├── Timestamp (cluster's base timestamp in ms)
└── SimpleBlock / BlockGroup (repeats)
    ├── Track number (1-127)
    ├── Timestamp offset (relative to cluster timestamp)
    ├── Flags (keyframe, invisible, lacing, etc.)
    └── Frame data (variable length)
```

### Example: Cluster with Interleaved Tracks

```
Cluster at byte offset 0x1000, timestamp 0ms

SimpleBlock (Video, track 1)
├── Timestamp: 0ms (absolute: 0ms)
├── Keyframe: yes
├── Data: 50KB video frame

SimpleBlock (Audio, track 2)
├── Timestamp: 0ms (absolute: 0ms)
├── Data: 4KB audio frame

SimpleBlock (Subtitle, track 3)
├── Timestamp: 500ms (absolute: 500ms)
├── Data: 100 bytes subtitle block

SimpleBlock (Video, track 1)
├── Timestamp: 33ms (absolute: 33ms)
├── Keyframe: no
├── Data: 20KB video frame

SimpleBlock (Subtitle, track 3)
├── Timestamp: 2000ms (absolute: 2000ms)
├── Data: 150 bytes subtitle block
```

### Critical Insight: Subtitle Blocks Are Interleaved

**Key Finding**: Subtitle blocks are **NOT** in separate clusters. They're interleaved with video/audio blocks in the same clusters.

**Implications**:
1. ✅ **Efficient**: One cluster read gets all tracks
2. ❌ **Scanning Required**: Must parse all blocks to find subtitles
3. ⚠️ **Timestamp Ordering**: Blocks are NOT necessarily in timestamp order within a cluster

---

## Seeking Strategies: MPV vs KODI vs ffmpeg

### Strategy 1: MPV (libavformat-based)

**How MPV seeks subtitles in MKV**:

```
1. User requests seek to timestamp T
2. libavformat reads Cues element
3. Find CuePoint with timestamp ≤ T
4. Seek to CueClusterPosition (byte offset)
5. Read cluster and parse all blocks
6. Filter blocks for subtitle track
7. Find first subtitle block with timestamp ≥ T
8. Return that block's data
```

**Code Path** (conceptual):
```c
// libavformat/matroskadec.c
int matroska_seek(AVFormatContext *s, int stream_index, int64_t timestamp) {
    // 1. Find cue point
    MatroskaSeekPoint *cue = matroska_find_cue(s, timestamp);
    
    // 2. Seek to cluster
    avio_seek(s->pb, cue->cluster_pos, SEEK_SET);
    
    // 3. Parse cluster
    MatroskaCluster *cluster = matroska_parse_cluster(s);
    
    // 4. Find subtitle block
    for (block in cluster->blocks) {
        if (block->track == subtitle_track && block->timestamp >= timestamp) {
            return block;
        }
    }
}
```

**Performance**: ~50-200ms (depends on cluster size and subtitle density)

### Strategy 2: KODI (custom demuxer)

**How KODI seeks subtitles in MKV**:

```
1. Pre-load Cues element on file open
2. Build in-memory Cues index (hash map by timestamp)
3. User requests seek to timestamp T
4. Look up nearest cue in hash map
5. Seek to cluster byte offset
6. Stream-parse cluster blocks
7. Cache subtitle blocks in memory
8. Return cached block for timestamp T
```

**Optimization**: KODI caches subtitle blocks in memory to avoid re-parsing.

**Performance**: ~20-50ms (faster due to in-memory cues index)

### Strategy 3: ffmpeg (libavformat)

**How ffmpeg seeks subtitles in MKV**:

```
1. Same as MPV (both use libavformat)
2. Additional optimization: Cues index is cached in AVFormatContext
3. Subsequent seeks use cached index (no re-read)
```

**Performance**: ~50-200ms (first seek), ~10-20ms (cached seeks)

### Comparison Table

| Strategy | First Seek | Cached Seek | Memory | Complexity |
|----------|-----------|------------|--------|-----------|
| MPV | 50-200ms | 50-200ms | Low | Medium |
| KODI | 20-50ms | 5-10ms | High | High |
| ffmpeg | 50-200ms | 10-20ms | Medium | Medium |

---

## Range Request Strategy for HTTP Seeking

### Challenge: Cues Element Location

In HTTP streaming, we can't seek to end of file to find Cues. Solution:

**Strategy 1: SeekHead Pointer (Recommended)**

```
1. Fetch first 1MB of MKV file (contains EBML header + SeekHead)
2. Parse SeekHead element (ID: 0x11 0x4D 0x9B 0x74)
3. SeekHead contains byte offsets to:
   - Info element
   - Tracks element
   - Cues element ← THIS IS KEY
   - Tags element
4. Use Range request to fetch Cues element directly
5. Parse Cues to find cluster offsets
6. Use Range requests to fetch specific clusters
```

**SeekHead Binary Structure**:

```
SeekHead (ID: 0x11 0x4D 0x9B 0x74)
├── Seek (repeats)
│   ├── SeekID (element ID to seek to)
│   └── SeekPosition (byte offset from segment start)
│   └── [next Seek]
```

**Example**:

```
11 4D 9B 74          # SeekHead element ID
82 00 00 00          # Size: 128 bytes

4D BB 00             # Seek element ID
81 00                # Size: 1 byte
53 00                # SeekID: Info (0x15 0x49 0xA9 0x66)
F7 00 00 00 00 00    # SeekPosition: 0x1000 (4096 bytes from segment start)

4D BB 00             # Seek element ID
81 00                # Size: 1 byte
53 01                # SeekID: Tracks (0x16 0x54 0xAE 0x6B)
F7 00 00 00 00 20    # SeekPosition: 0x2000 (8192 bytes from segment start)

4D BB 00             # Seek element ID
81 00                # Size: 1 byte
53 02                # SeekID: Cues (0x1C 0x53 0xBB 0x6B)
F7 00 00 00 10 00    # SeekPosition: 0x100000 (1MB from segment start)
```

### HTTP Range Request Sequence

```
Step 1: Fetch SeekHead
GET /video.mkv HTTP/1.1
Range: bytes=0-1048576

Response: 1MB of file
Parse SeekHead → find Cues at byte offset 0x100000

Step 2: Fetch Cues Element
GET /video.mkv HTTP/1.1
Range: bytes=1048576-1049600

Response: Cues element (1024 bytes)
Parse Cues → find cluster at byte offset 0x200000 for timestamp 5000ms

Step 3: Fetch Cluster
GET /video.mkv HTTP/1.1
Range: bytes=2097152-2150000

Response: Cluster data
Parse cluster → extract subtitle blocks
```

**Performance**: 3 HTTP requests = ~150-300ms (network latency dependent)

### Strategy 2: Pre-computed Manifest (Alternative)

For streaming services, pre-compute and serve a manifest:

```json
{
  "file": "video.mkv",
  "duration_ms": 3600000,
  "cues": {
    "offset": 1048576,
    "size": 1024
  },
  "clusters": [
    {
      "timestamp_ms": 0,
      "offset": 2097152,
      "size": 102400,
      "tracks": [1, 2, 3]
    },
    {
      "timestamp_ms": 5000,
      "offset": 2199552,
      "size": 98304,
      "tracks": [1, 2, 3]
    }
  ]
}
```

**Advantage**: Single HTTP request for manifest + cluster seeks  
**Disadvantage**: Requires pre-processing

---

## Phase 1 Engine Implementation Mapping

### How Our `subtitle-seeking.ts` Maps to MKV Seeking

**Current Implementation** (from Phase 1):

```typescript
// src/pipeline/subtitle-seeking.ts
export async function seekSubtitles(
  demuxer: Demuxer,
  trackIndex: number,
  targetTimeSec: number
): Promise<SubtitleSeekResult> {
  // 1. Get track info
  const track = demuxer.getTrack(trackIndex);
  
  // 2. Find cues near target time
  const cues = demuxer.getCuesIndex();
  const nearestCue = cues.findNearest(targetTimeSec);
  
  // 3. Seek demuxer to cluster
  await demuxer.seek(nearestCue.clusterByteOffset);
  
  // 4. Parse cluster and find subtitle blocks
  const blocks = await demuxer.readCluster();
  const subtitleBlocks = blocks.filter(b => b.trackIndex === trackIndex);
  
  // 5. Find first block at/after target time
  const targetBlock = subtitleBlocks.find(b => b.timestamp >= targetTimeSec);
  
  return {
    foundCues: subtitleBlocks.length,
    targetCue: targetBlock,
    seekTimeMs: performance.now() - startTime
  };
}
```

**Mapping to MKV Seeking Strategies**:

| Phase 1 Step | MKV Equivalent | Implementation |
|--------------|----------------|-----------------|
| `getCuesIndex()` | Parse Cues element | Read EBML structure |
| `findNearest()` | Binary search in CuePoints | O(log n) lookup |
| `seek(offset)` | HTTP Range request or file seek | Demuxer abstraction |
| `readCluster()` | Parse Cluster element | EBML parser |
| `filter(trackIndex)` | Scan SimpleBlocks for track | Linear scan |
| `find(timestamp)` | Find first block ≥ timestamp | Linear scan |

### Optimization Opportunities

**Current Bottleneck**: Linear scan of all blocks in cluster

```typescript
// SLOW: O(n) scan
const subtitleBlocks = blocks.filter(b => b.trackIndex === trackIndex);
const targetBlock = subtitleBlocks.find(b => b.timestamp >= targetTimeSec);
```

**Optimization 1: Pre-filter by track during cluster parse**

```typescript
// FASTER: O(1) track lookup + O(m) scan where m << n
const trackBlocks = demuxer.getBlocksByTrack(trackIndex);
const targetBlock = trackBlocks.find(b => b.timestamp >= targetTimeSec);
```

**Optimization 2: Cache subtitle blocks in memory**

```typescript
// FASTEST: O(1) lookup in cached blocks
const cachedBlocks = demuxer.getCachedBlocks(trackIndex);
const targetBlock = cachedBlocks.find(b => b.timestamp >= targetTimeSec);
```

**Optimization 3: Use Cues density for subtitle tracks**

```typescript
// If subtitle track has dense cues (1 per block):
// Seek directly to cue instead of scanning cluster
const cue = cues.findExact(targetTimeSec, trackIndex);
if (cue) {
  return demuxer.getBlockAtCue(cue);
}
```

---

## Performance Optimization Techniques

### Technique 1: Cues Index Caching

**Problem**: Re-parsing Cues element on every seek is slow

**Solution**: Cache Cues in memory on first access

```typescript
class MKVDemuxer {
  private cuesCache: CuePoint[] | null = null;
  
  getCuesIndex(): CuePoint[] {
    if (!this.cuesCache) {
      // First access: parse and cache
      this.cuesCache = this.parseCuesElement();
    }
    return this.cuesCache;
  }
}
```

**Impact**: 50-200ms → 10-20ms for subsequent seeks

### Technique 2: Cluster Block Pre-filtering

**Problem**: Scanning all blocks in cluster is slow for large clusters

**Solution**: Pre-filter blocks by track during cluster parse

```typescript
class Cluster {
  private blocksByTrack: Map<number, Block[]> = new Map();
  
  getBlocksByTrack(trackIndex: number): Block[] {
    return this.blocksByTrack.get(trackIndex) || [];
  }
}
```

**Impact**: 50-100ms → 10-30ms for large clusters

### Technique 3: Subtitle Block Caching

**Problem**: Re-reading same cluster for multiple seeks is slow

**Solution**: Cache subtitle blocks in memory

```typescript
class SubtitleCache {
  private cache: Map<number, SubtitleBlock[]> = new Map();
  
  getBlocks(trackIndex: number): SubtitleBlock[] {
    if (!this.cache.has(trackIndex)) {
      this.cache.set(trackIndex, this.loadBlocks(trackIndex));
    }
    return this.cache.get(trackIndex)!;
  }
}
```

**Impact**: 50-200ms → 5-10ms for cached seeks

### Technique 4: Binary Search in Cues

**Problem**: Linear search in Cues is O(n)

**Solution**: Binary search (Cues are timestamp-ordered)

```typescript
function findNearestCue(cues: CuePoint[], targetTime: number): CuePoint {
  let left = 0, right = cues.length - 1;
  
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (cues[mid].timestamp < targetTime) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  
  return cues[left];
}
```

**Impact**: O(n) → O(log n), negligible for small cues but important for dense cues

### Technique 5: HTTP Range Request Optimization

**Problem**: Multiple HTTP requests for SeekHead → Cues → Cluster

**Solution**: Combine requests or use manifest

```typescript
// Single manifest request instead of 3 HTTP requests
const manifest = await fetch('/video.mkv.manifest.json');
const cues = manifest.cues;
const cluster = manifest.clusters.find(c => c.timestamp >= targetTime);
```

**Impact**: 150-300ms → 50-100ms (network dependent)

---

## Summary: Byte-Level Seeking Strategy

### The Complete Picture

```
User Request: "Seek to 5:30 in subtitles"
↓
Convert to timestamp: 330,000 ms
↓
Phase 1 Engine:
  1. Get Cues index (cached or parsed)
  2. Binary search for nearest cue at ≤ 330,000ms
  3. Get cluster byte offset from cue
  4. Seek to cluster (HTTP Range or file seek)
  5. Parse cluster EBML structure
  6. Filter blocks by subtitle track
  7. Find first block with timestamp ≥ 330,000ms
  8. Return block data
↓
Phase 2 UI:
  1. Show "Seeking..." status
  2. Display result: "Found 3 cues (45ms)"
  3. Auto-close modal
↓
Player:
  1. Render subtitle blocks
  2. Update video position (if needed)
```

### Performance Targets

| Scenario | Target | Technique |
|----------|--------|-----------|
| First seek | 50-100ms | Cues caching |
| Cached seek | 10-20ms | In-memory blocks |
| Large cluster | 20-50ms | Block pre-filtering |
| HTTP streaming | 100-200ms | Range requests + manifest |

---

## References

- **Matroska Specification**: https://www.matroska.org/technical/specs/index.html
- **EBML Specification**: https://github.com/ietf-wg-cellar/ebml-specification
- **libavformat Source**: https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/matroskadec.c
- **KODI MKV Handler**: https://github.com/xbmc/xbmc/blob/master/xbmc/cores/VideoPlayer/DVDInputStreams/DVDInputStreamMatroska.cpp

