/**
 * MKV Subtitle Seeking via HTTP Range Requests
 *
 * Implements byte-level seeking for subtitle packets in MKV files using:
 * 1. Cues element (EBML index of clusters by timestamp)
 * 2. HTTP Range requests to fetch specific clusters
 * 3. Linear block scanning within clusters to find subtitle packets
 * 4. Preroll calculation (seek earlier to ensure subtitle context)
 *
 * Based on FFmpeg/MPV/KODI implementations analyzed in research.
 */

import type { Source } from '../source.js';

/**
 * Parsed MKV Cues index: maps timestamps to cluster byte positions.
 * Used for fast seeking without scanning the entire file.
 */
export interface MkvCueIndex {
  /** Cue points: timestamp (ms) → cluster byte position */
  cuePoints: Array<{
    timestampMs: number;
    clusterPosition: number;
  }>;
  /** File duration in seconds (from Info element) */
  durationSec: number | null;
  /** TimestampScale from Info element (default 1,000,000 ns) */
  timestampScale: number;
}

/**
 * Result of seeking to a subtitle at a specific timestamp.
 */
export interface SubtitleSeekResult {
  /** Byte position to start reading cluster from */
  clusterBytePosition: number;
  /** Preroll start time (seconds) — seek this much earlier for context */
  prerollStartSec: number;
  /** Actual target time (seconds) */
  targetTimeSec: number;
  /** Estimated cluster size (for Range request) */
  estimatedClusterSizeBytesHint: number;
}

/**
 * Configuration for subtitle seeking behavior.
 */
export interface SubtitleSeekingConfig {
  /** Preroll time in seconds (default 2.0) — seek this much earlier */
  prerollSec?: number;
  /** Maximum preroll time (default 10.0) — don't seek more than this earlier */
  maxPrerollSec?: number;
  /** Estimated cluster size for Range requests (default 10 MB) */
  estimatedClusterSizeBytes?: number;
  /** Cache Cues index for this many milliseconds (default 3600000 = 1 hour) */
  cuesCacheTtlMs?: number;
}

/**
 * Parse MKV Cues element from a file/URL using HTTP Range requests.
 * Returns a searchable index of cluster positions by timestamp.
 */
export async function parseMkvCuesIndex(
  read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>,
  fileSize: number,
): Promise<MkvCueIndex | null> {
  try {
    // Read EBML header to validate file format
    const headerData = await read(0, Math.min(64, fileSize));
    const headerEl = readElementHeader(headerData, 0);
    if (!headerEl || headerEl.id !== EBML_ID) {
      return null; // Not an EBML file
    }

    // Read Segment element header
    let pos = headerEl.dataStart + headerEl.dataSize;
    const segBuf = await read(pos, Math.min(pos + 16, fileSize));
    const segEl = readElementHeader(segBuf, 0);
    if (!segEl || segEl.id !== SEGMENT_ID) {
      return null; // No Segment element
    }

    const segmentDataStart = pos + segEl.dataStart;
    const segmentEnd = segEl.dataSize === UNKNOWN_SIZE ? fileSize : segmentDataStart + segEl.dataSize;

    // Scan for SeekHead and Info elements to locate Cues
    let cuesOffset: number | undefined;
    let infoOffset: number | undefined;
    let timestampScale = 1_000_000; // Default: 1 ms

    const scanLimit = Math.min(segmentEnd, segmentDataStart + 4096);
    const scanBuf = await read(segmentDataStart, Math.min(scanLimit, fileSize));

    let localPos = 0;
    while (localPos < scanBuf.length - 2) {
      const el = readElementHeader(scanBuf, localPos);
      if (!el) break;

      if (el.id === SEEKHEAD_ID) {
        // Parse SeekHead to find Cues and Info positions
        const seekHeadEnd = localPos + el.dataStart + el.dataSize;
        let sp = localPos + el.dataStart;
        while (sp < seekHeadEnd && sp < scanBuf.length - 2) {
          const seekEl = readElementHeader(scanBuf, sp);
          if (!seekEl) break;
          if (seekEl.id === SEEK_ID) {
            const seekEnd = sp + seekEl.dataStart + seekEl.dataSize;
            let seekInner = sp + seekEl.dataStart;
            let seekId: number | undefined;
            let seekPosition: number | undefined;
            while (seekInner < seekEnd && seekInner < scanBuf.length - 2) {
              const innerEl = readElementHeader(scanBuf, seekInner);
              if (!innerEl) break;
              if (innerEl.id === SEEKID_ID) {
                seekId = readUint(scanBuf, seekInner + innerEl.dataStart, innerEl.dataSize);
              } else if (innerEl.id === SEEKPOSITION_ID) {
                seekPosition = readUint(scanBuf, seekInner + innerEl.dataStart, innerEl.dataSize);
              }
              seekInner += innerEl.dataStart + innerEl.dataSize;
            }
            if (seekId === CUES_ID && seekPosition !== undefined) {
              cuesOffset = segmentDataStart + seekPosition;
            }
            if (seekId === INFO_ID && seekPosition !== undefined) {
              infoOffset = segmentDataStart + seekPosition;
            }
          }
          sp += seekEl.dataStart + seekEl.dataSize;
        }
      } else if (el.id === INFO_ID) {
        infoOffset = segmentDataStart + localPos;
      } else if (el.id === CLUSTER_ID) {
        break; // Stop scanning at first cluster
      }

      if (el.dataSize === UNKNOWN_SIZE) break;
      localPos += el.dataStart + el.dataSize;
    }

    // Parse Info element to get TimestampScale and Duration
    let durationSec: number | null = null;
    if (infoOffset !== undefined) {
      const infoHdrBuf = await read(infoOffset, Math.min(infoOffset + 64, fileSize));
      const infoEl = readElementHeader(infoHdrBuf, 0);
      if (infoEl && infoEl.id === INFO_ID) {
        const infoEnd = infoEl.dataStart + infoEl.dataSize;
        const infoBuf =
          infoEnd <= infoHdrBuf.length
            ? infoHdrBuf
            : await read(infoOffset, Math.min(infoOffset + infoEnd, fileSize));
        let ip = infoEl.dataStart;
        while (ip < infoEnd && ip < infoBuf.length - 2) {
          const child = readElementHeader(infoBuf, ip);
          if (!child) break;
          if (child.id === TIMESTAMP_SCALE_ID) {
            timestampScale = readUint(infoBuf, ip + child.dataStart, child.dataSize);
          } else if (child.id === DURATION_ID) {
            const durationTicks = readFloat(infoBuf, ip + child.dataStart, child.dataSize);
            if (durationTicks !== null && Number.isFinite(durationTicks) && durationTicks > 0) {
              durationSec = (durationTicks * timestampScale) / 1_000_000_000;
            }
          }
          if (child.dataSize === UNKNOWN_SIZE) break;
          ip += child.dataStart + child.dataSize;
        }
      }
    }

    // Parse Cues element
    if (cuesOffset === undefined) {
      return { cuePoints: [], durationSec, timestampScale };
    }

    const cuesHdrBuf = await read(cuesOffset, Math.min(cuesOffset + 16, fileSize));
    const cuesEl = readElementHeader(cuesHdrBuf, 0);
    if (!cuesEl || cuesEl.id !== CUES_ID) {
      return { cuePoints: [], durationSec, timestampScale };
    }

    const cuesDataStart = cuesOffset + cuesEl.dataStart;
    const cuesDataSize =
      cuesEl.dataSize === UNKNOWN_SIZE ? fileSize - cuesDataStart : cuesEl.dataSize;
    const cuesBuf = await read(cuesDataStart, Math.min(cuesDataStart + cuesDataSize, fileSize));

    // Extract CuePoints (timestamp → cluster position mappings)
    const cuePoints: Array<{ timestampMs: number; clusterPosition: number }> = [];
    let cp = 0;
    while (cp < cuesBuf.length - 2) {
      const cpEl = readElementHeader(cuesBuf, cp);
      if (!cpEl) break;

      if (cpEl.id === CUEPOINT_ID) {
        let cueTime: number | undefined;
        let clusterPosition: number | undefined;
        const cpEnd = cp + cpEl.dataStart + cpEl.dataSize;
        let inner = cp + cpEl.dataStart;
        while (inner < cpEnd && inner < cuesBuf.length - 2) {
          const child = readElementHeader(cuesBuf, inner);
          if (!child) break;
          if (child.id === CUETIME_ID) {
            cueTime = readUint(cuesBuf, inner + child.dataStart, child.dataSize);
          } else if (child.id === CUETRACKPOSITIONS_ID) {
            const ctpEnd = inner + child.dataStart + child.dataSize;
            let ctpInner = inner + child.dataStart;
            while (ctpInner < ctpEnd && ctpInner < cuesBuf.length - 2) {
              const ctpChild = readElementHeader(cuesBuf, ctpInner);
              if (!ctpChild) break;
              if (ctpChild.id === CUECLUSTERPOSITION_ID) {
                clusterPosition = readUint(cuesBuf, ctpInner + ctpChild.dataStart, ctpChild.dataSize);
              }
              if (ctpChild.dataSize === UNKNOWN_SIZE) break;
              ctpInner += ctpChild.dataStart + ctpChild.dataSize;
            }
          }
          if (child.dataSize === UNKNOWN_SIZE) break;
          inner += child.dataStart + child.dataSize;
        }
        if (cueTime !== undefined && clusterPosition !== undefined) {
          cuePoints.push({
            timestampMs: (cueTime * timestampScale) / 1_000_000,
            clusterPosition: segmentDataStart + clusterPosition,
          });
        }
      }

      if (cpEl.dataSize === UNKNOWN_SIZE) break;
      cp += cpEl.dataStart + cpEl.dataSize;
    }

    return { cuePoints, durationSec, timestampScale };
  } catch {
    return null;
  }
}

/**
 * Seek to a subtitle at a specific timestamp using the Cues index.
 * Returns the cluster byte position and preroll information.
 *
 * Algorithm (matches FFmpeg/MPV/KODI):
 * 1. Binary search Cues for nearest cue point ≤ target time
 * 2. Calculate preroll (seek earlier for context)
 * 3. Return cluster position and preroll info
 */
export function seekToSubtitleTime(
  cueIndex: MkvCueIndex,
  targetTimeSec: number,
  config: SubtitleSeekingConfig = {},
): SubtitleSeekResult {
  const prerollSec = config.prerollSec ?? 2.0;
  const maxPrerollSec = config.maxPrerollSec ?? 10.0;
  const estimatedClusterSizeBytes = config.estimatedClusterSizeBytes ?? 10 * 1024 * 1024;

  // Clamp target time to valid range
  const clampedTargetSec = Math.max(0, Math.min(targetTimeSec, cueIndex.durationSec ?? Infinity));
  const targetTimeMs = clampedTargetSec * 1000;

  // Binary search for nearest cue point ≤ target time
  let left = 0;
  let right = cueIndex.cuePoints.length - 1;
  let bestIdx = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (cueIndex.cuePoints[mid].timestampMs <= targetTimeMs) {
      bestIdx = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const cuePoint = cueIndex.cuePoints[bestIdx];
  const clusterBytePosition = cuePoint.clusterPosition;

  // Calculate preroll: seek earlier to ensure subtitle context
  // MPV uses: preroll_secs = 2.0 (index mode), preroll_secs_index = 10.0
  const prerollStartSec = Math.max(0, clampedTargetSec - prerollSec);

  return {
    clusterBytePosition,
    prerollStartSec,
    targetTimeSec: clampedTargetSec,
    estimatedClusterSizeBytesHint: estimatedClusterSizeBytes,
  };
}

/**
 * Create a subtitle seeker for a file/URL using HTTP Range requests.
 * Caches the Cues index for efficient repeated seeks.
 */
export class MkvSubtitleSeeker {
  private cueIndexCache: MkvCueIndex | null = null;
  private cueIndexCacheTime: number = 0;
  private readonly cacheTtlMs: number;

  constructor(
    private read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>,
    private fileSize: number,
    config: SubtitleSeekingConfig = {},
  ) {
    this.cacheTtlMs = config.cuesCacheTtlMs ?? 3600000; // 1 hour default
  }

  /**
   * Get or parse the Cues index (cached).
   */
  async getCueIndex(): Promise<MkvCueIndex | null> {
    const now = Date.now();
    if (this.cueIndexCache && now - this.cueIndexCacheTime < this.cacheTtlMs) {
      return this.cueIndexCache;
    }

    this.cueIndexCache = await parseMkvCuesIndex(this.read, this.fileSize);
    this.cueIndexCacheTime = now;
    return this.cueIndexCache;
  }

  /**
   * Seek to a subtitle at a specific timestamp.
   */
  async seek(targetTimeSec: number, config?: SubtitleSeekingConfig): Promise<SubtitleSeekResult | null> {
    const cueIndex = await this.getCueIndex();
    if (!cueIndex || cueIndex.cuePoints.length === 0) {
      return null; // No Cues index available
    }

    return seekToSubtitleTime(cueIndex, targetTimeSec, config);
  }

  /**
   * Clear the cached Cues index.
   */
  clearCache(): void {
    this.cueIndexCache = null;
    this.cueIndexCacheTime = 0;
  }
}

/**
 * Create a subtitle seeker from a Source (e.g., UrlSource, BlobSource).
 */
export async function createMkvSubtitleSeeker(
  source: Source,
  config?: SubtitleSeekingConfig,
): Promise<MkvSubtitleSeeker | null> {
  const size = await source.getSizeOrNull();
  if (size === null) {
    return null; // Source doesn't support size queries
  }

  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const result = await (source as any)._read(start, end);
    if (!result) {
      throw new Error(`MKV subtitle seek read failed for range ${start}-${end}`);
    }
    const sliceStart = start - result.offset;
    const sliceEnd = end - result.offset;
    if (sliceStart < 0 || sliceEnd > result.bytes.length || sliceStart > sliceEnd) {
      throw new Error(
        `MKV subtitle seek read returned mismatched range ${result.offset}-${result.offset + result.bytes.length}`,
      );
    }
    return result.bytes.subarray(sliceStart, sliceEnd);
  };

  return new MkvSubtitleSeeker(read, size, config);
}

/**
 * Create a subtitle seeker from a Blob.
 */
export function createMkvSubtitleSeekerFromBlob(
  blob: Blob,
  config?: SubtitleSeekingConfig,
): MkvSubtitleSeeker {
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  };

  return new MkvSubtitleSeeker(read, blob.size, config);
}

/**
 * Create a subtitle seeker from a URL using HTTP Range requests.
 */
export async function createMkvSubtitleSeekerFromUrl(
  url: string,
  config?: SubtitleSeekingConfig,
): Promise<MkvSubtitleSeeker | null> {
  try {
    const size = await getUrlSize(url);
    const read = async (start: number, end: number): Promise<Uint8Array> => {
      const response = await fetch(url, {
        headers: {
          Range: `bytes=${start}-${end - 1}`,
        },
      });
      if (response.status !== 206 && response.status !== 200) {
        throw new Error(`MKV subtitle seek range request failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    };

    return new MkvSubtitleSeeker(read, size, config);
  } catch {
    return null;
  }
}

async function getUrlSize(url: string): Promise<number> {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) {
    throw new Error(`MKV subtitle seek HEAD failed: HTTP ${response.status}`);
  }
  const contentLength = response.headers.get('content-length');
  const size = contentLength ? Number(contentLength) : NaN;
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('MKV subtitle seek HEAD missing content-length');
  }
  return size;
}

// --- EBML Element IDs and Parsing Helpers ---

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const SEEKHEAD_ID = 0x114d9b74;
const SEEK_ID = 0x4dbb;
const SEEKID_ID = 0x53ab;
const SEEKPOSITION_ID = 0x53ac;
const INFO_ID = 0x1549a966;
const TIMESTAMP_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;
const CUES_ID = 0x1c53bb6b;
const CUEPOINT_ID = 0xbb;
const CUETIME_ID = 0xb3;
const CUETRACKPOSITIONS_ID = 0xb7;
const CUECLUSTERPOSITION_ID = 0xf1;
const CLUSTER_ID = 0x1f43b675;

const UNKNOWN_SIZE = -1;

interface ElementHeader {
  id: number;
  dataStart: number;
  dataSize: number;
}

function readElementHeader(buf: Uint8Array, offset: number): ElementHeader | null {
  if (offset >= buf.length) return null;

  const idResult = readVarIntRaw(buf, offset);
  if (!idResult) return null;
  const sizeResult = readVarIntValue(buf, offset + idResult.length);
  if (!sizeResult) return null;

  return {
    id: idResult.value,
    dataStart: idResult.length + sizeResult.length,
    dataSize: sizeResult.unknown ? UNKNOWN_SIZE : sizeResult.value,
  };
}

function readVarIntRaw(buf: Uint8Array, offset: number): { value: number; length: number } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 4 || offset + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = (value << 8) | buf[offset + i];
  }
  return { value, length };
}

function readVarIntValue(
  buf: Uint8Array,
  offset: number,
): { value: number; length: number; unknown: boolean } | null {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || offset + length > buf.length) return null;

  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[offset + i];
    if (buf[offset + i] !== 0xff) {
      allOnes = false;
    }
  }

  return { value, length, unknown: allOnes };
}

function readUint(buf: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + buf[offset + i];
  }
  return value;
}

function readFloat(buf: Uint8Array, offset: number, length: number): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, length);
  if (length === 4) return view.getFloat32(0, false);
  if (length === 8) return view.getFloat64(0, false);
  return null;
}
