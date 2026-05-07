import {
  ALL_FORMATS,
  BlobSource,
  type EncodedPacket,
  EncodedPacketSink,
  FilePathSource,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  Source as MBSource,
  UrlSource,
} from 'mediabunny';
import { Source } from '../source.js';
import { type AbortableSource, checkAbort } from './source-signal.js';
import { getSubtitleTrackInfos } from './subtitle.js';
import type { KeyframeEntry, KeyframeIndex, PlannedSegment, SubtitleTrackInfo } from './types.js';

const KEYFRAME_LOOKUP_EARLY_SEC = 0.5;
const KEYFRAME_LOOKUP_LATE_SEC = 0.2;
const BOUNDARY_ALIGN_EPSILON_SEC = 1 / 1000;
const URL_READ_RETRIES = 2;
const URL_READ_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
const OFFLINE_URL_READ_WINDOW_BYTES = 512 * 1024;

export interface DemuxResult {
  input: Input;
  duration: number;
  videoTrack: InputVideoTrack;
  audioTrack: InputAudioTrack | null;
  videoCodec: string;
  audioCodec: string | null;
  audioInternalCodecId: string | null;
  videoDecoderConfig: VideoDecoderConfig;
  audioDecoderConfig: AudioDecoderConfig | null;
  videoSink: EncodedPacketSink;
  audioSink: EncodedPacketSink | null;
  subtitleTracks: SubtitleTrackInfo[];
  dispose: () => void;
}

export async function demuxFile(filePath: string): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new FilePathSource(filePath) }));
}

export async function demuxBlob(blob: Blob): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) }));
}

export async function demuxUrl(url: string): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new UrlSource(url) }));
}

export class AbortableUrlSource extends Source implements AbortableSource {
  private _currentSignal: AbortSignal | null = null;
  private readonly _readCache: Array<{ start: number; end: number; bytes: Uint8Array }> = [];
  private _readCacheBytes = 0;
  private _size: number | null = null;

  constructor(private readonly _url: string) {
    super();
  }

  setCurrentSignal(signal: AbortSignal | null): void {
    this._currentSignal = signal;
  }

  /**
   * Determine file size using a single GET request with Range header.
   * This approach:
   * - Combines size detection with initial data fetch (single RTT)
   * - Probes range support via 206 response
   * - Caches initial chunk for reuse
   * - Aligns with Mediabunny's UrlSource strategy
   *
   * See: https://github.com/ventsislav-georgiev/mediabunny/blob/main/src/source.ts#L436-L494
   */
  async _retrieveSize(): Promise<number | null> {
    const response = await fetch(this._url, {
      headers: {
        Range: 'bytes=0-',  // Request all bytes as range
      },
      signal: this._currentSignal ?? undefined,
    });

    if (response.status === 206) {
      // Server supports ranges: extract size from Content-Range header
      const contentRange = response.headers.get('content-range');
      const match = contentRange?.match(/^bytes 0-\d+\/(\d+)$/);
      if (match) {
        const size = Number(match[1]);
        this._size = Number.isFinite(size) && size > 0 ? size : null;
        // Cache initial chunk for reuse in subsequent reads
        const bytes = new Uint8Array(await response.arrayBuffer());
        this._cacheRead(0, bytes.byteLength, bytes);
        return this._size;
      }
    } else if (response.status === 200) {
      // Server doesn't support ranges: use Content-Length header
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const size = Number(contentLength);
        this._size = Number.isFinite(size) && size > 0 ? size : null;
        // Cache entire response for offline mode
        const bytes = new Uint8Array(await response.arrayBuffer());
        this._cacheRead(0, bytes.byteLength, bytes);
        return this._size;
      } else {
        throw new Error('HTTP response must surface Content-Length header.');
      }
    }

    throw new Error(`URL source size detection failed: HTTP ${response.status}`);
  }

  async _read(start: number, end: number) {
    const signal = this._currentSignal ?? undefined;
    checkAbort(signal);

    const cached = this._readCache.find((entry) => entry.start <= start && entry.end >= end);
    if (cached) {
      const bytes = cached.bytes.subarray(start - cached.start, end - cached.start);
      return this._makeReadResult(bytes, start);
    }

    const requestRange = this._makeRequestRange(start, end);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= URL_READ_RETRIES; attempt += 1) {
      try {
        checkAbort(signal);
        const response = await fetch(this._url, {
          headers: { Range: `bytes=${requestRange.start}-${requestRange.end - 1}` },
          signal,
        });
        if (response.status !== 206 && response.status !== 200) {
          throw new Error(`URL source range request failed: HTTP ${response.status}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const responseStart =
          this._getResponseStart(response) ?? (response.status === 200 ? 0 : requestRange.start);
        this._cacheRead(responseStart, responseStart + bytes.byteLength, bytes);
        const offset = start - responseStart;
        const length = end - start;
        if (offset < 0 || offset + length > bytes.byteLength) {
          throw new Error('URL source range response did not cover requested bytes');
        }
        return this._makeReadResult(bytes.subarray(offset, offset + length), start);
      } catch (err) {
        lastError = err;
        checkAbort(signal);
        if (attempt === URL_READ_RETRIES) break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private _makeRequestRange(start: number, end: number): { start: number; end: number } {
    if (!this._isOfflineUrl()) {
      return { start, end };
    }

    const requestStart =
      Math.floor(start / OFFLINE_URL_READ_WINDOW_BYTES) * OFFLINE_URL_READ_WINDOW_BYTES;
    const requestedWindowEnd = requestStart + OFFLINE_URL_READ_WINDOW_BYTES;
    const requestEnd = Math.max(end, requestedWindowEnd);
    return { start: requestStart, end: this._size ? Math.min(requestEnd, this._size) : requestEnd };
  }

  private _isOfflineUrl(): boolean {
    return this._url.includes('/offline-video/');
  }

  private _getResponseStart(response: Response): number | null {
    const contentRange = response.headers.get('content-range');
    const match = contentRange?.match(/^bytes (\d+)-\d+\/\d+$/);
    if (!match) return null;
    const start = Number(match[1]);
    return Number.isFinite(start) ? start : null;
  }

  private _cacheRead(start: number, end: number, bytes: Uint8Array): void {
    if (bytes.byteLength > URL_READ_CACHE_LIMIT_BYTES) return;

    this._readCache.push({ start, end, bytes });
    this._readCacheBytes += bytes.byteLength;
    while (this._readCacheBytes > URL_READ_CACHE_LIMIT_BYTES) {
      const evicted = this._readCache.shift();
      if (!evicted) break;
      this._readCacheBytes -= evicted.bytes.byteLength;
    }
  }

  private _makeReadResult(bytes: Uint8Array, offset: number) {
    return {
      bytes,
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset,
    };
  }

  _dispose(): void {
    this._currentSignal = null;
    this._readCache.length = 0;
    this._readCacheBytes = 0;
    this._size = null;
  }
}

class SourceAdapter extends MBSource {
  constructor(private _inner: Source) {
    super();
  }
  _retrieveSize() {
    return this._inner._retrieveSize();
  }
  _read(start: number, end: number) {
    return this._inner._read(start, end);
  }
  _dispose() {
    this._inner._dispose();
  }
}

export async function demuxSource(source: Source): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new SourceAdapter(source) }));
}

/**
 * Create a lightweight Input handle for subtitle-only access.
 * Uses its own I/O path so subtitle extraction never contends with
 * segment processing on the main demux handle.
 * The returned Input is probed (format detected, subtitle tracks initialised).
 */
export async function createSubtitleInput(blob: Blob | null, url: string | null): Promise<Input> {
  let input: Input;
  if (blob) input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  else if (url) input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
  else throw new Error('No source provided for subtitle input');
  // Trigger format probing so subtitle track methods (getCuesFrom, etc.) are available.
  await input.getSubtitleTracks();
  return input;
}

async function demuxInput(input: Input): Promise<DemuxResult> {
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error('No video track found');
  }

  let audioTrack: InputAudioTrack | null = null;
  try {
    audioTrack = await input.getPrimaryAudioTrack();
  } catch {
    // No audio track — that's fine
  }

  const videoCodec = videoTrack.codec;
  if (!videoCodec) {
    throw new Error('Could not determine video codec');
  }

  const videoSink = new EncodedPacketSink(videoTrack);
  const audioSink = audioTrack ? new EncodedPacketSink(audioTrack) : null;

  const duration = Number(await videoTrack.computeDuration());

  const videoDecoderConfig = await videoTrack.getDecoderConfig();
  if (!videoDecoderConfig) {
    throw new Error('Could not get video decoder config');
  }

  let audioDecoderConfig: AudioDecoderConfig | null = null;
  let audioInternalCodecId: string | null = null;
  if (audioTrack) {
    audioDecoderConfig = await audioTrack.getDecoderConfig();
    const internalCodecId = audioTrack.internalCodecId;
    audioInternalCodecId = typeof internalCodecId === 'string' ? internalCodecId : null;
  }

  const subtitleTracks = await getSubtitleTrackInfos(input);

  return {
    input,
    duration,
    videoTrack,
    audioTrack,
    videoCodec,
    audioCodec: audioTrack?.codec ?? mapAudioInternalCodecId(audioInternalCodecId),
    audioInternalCodecId,
    videoDecoderConfig,
    audioDecoderConfig,
    videoSink,
    audioSink,
    subtitleTracks,
    dispose: () => input.dispose(),
  };
}

function mapAudioInternalCodecId(internalCodecId: string | null): string | null {
  if (!internalCodecId) return null;

  if (internalCodecId === 'A_TRUEHD') return 'truehd';
  if (internalCodecId === 'A_MLP') return 'mlp';
  if (internalCodecId === 'A_AC3') return 'ac3';
  if (internalCodecId === 'A_EAC3') return 'eac3';
  if (internalCodecId.startsWith('A_DTS')) return 'dts';
  if (internalCodecId === 'A_FLAC') return 'flac';
  if (internalCodecId === 'A_OPUS') return 'opus';
  if (internalCodecId === 'A_MPEG/L3') return 'mp3';
  if (internalCodecId.startsWith('A_AAC')) return 'aac';

  return null;
}

export async function getKeyframeIndex(
  videoSink: EncodedPacketSink,
  duration: number,
): Promise<KeyframeIndex> {
  const keyframes: KeyframeEntry[] = [];
  // getKeyPacket(0) returns null if the first keyframe has PTS > 0 (non-zero
  // initial offset). Fall back to getFirstPacket() which always works.
  let packet = await videoSink.getKeyPacket(0, { metadataOnly: true });
  if (!packet) {
    const first = await videoSink.getFirstPacket();
    if (first?.type === 'key') packet = first;
  }

  while (packet) {
    const ts = packet.timestamp;
    if (Number.isFinite(ts) && ts >= 0) {
      keyframes.push({ timestamp: ts, sequenceNumber: packet.sequenceNumber });
    }
    const next = await videoSink.getNextKeyPacket(packet, {
      metadataOnly: true,
    });
    if (!next || next.sequenceNumber === packet.sequenceNumber) break;
    packet = next;
  }

  return { duration, keyframes };
}

async function resolveActualVideoBoundary(
  videoSink: EncodedPacketSink,
  boundarySec: number,
  nextBoundarySec: number,
): Promise<number> {
  if (boundarySec <= BOUNDARY_ALIGN_EPSILON_SEC) return 0;

  let packet = await videoSink.getKeyPacket(boundarySec, { metadataOnly: true });
  if (!packet) return boundarySec;

  if (boundarySec - packet.timestamp > KEYFRAME_LOOKUP_EARLY_SEC) {
    let next = await videoSink.getNextKeyPacket(packet, { metadataOnly: true });
    while (next && next.timestamp <= boundarySec + KEYFRAME_LOOKUP_LATE_SEC) {
      packet = next;
      next = await videoSink.getNextKeyPacket(next, { metadataOnly: true });
    }
    if (
      next &&
      boundarySec - packet.timestamp > KEYFRAME_LOOKUP_EARLY_SEC &&
      next.timestamp < nextBoundarySec
    ) {
      packet = next;
    }
  }

  const timestamp = Number(packet.timestamp);
  if (Number.isFinite(timestamp) && boundarySec - timestamp > KEYFRAME_LOOKUP_EARLY_SEC)
    return boundarySec;
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : boundarySec;
}

export type SegmentBoundaryResolver = (boundaryIndex: number) => Promise<number>;

export function createVideoBoundaryResolver(
  videoSink: EncodedPacketSink,
  plan: PlannedSegment[],
  log?: (msg: string) => void,
): SegmentBoundaryResolver {
  const cache = new Map<number, Promise<number>>();

  const last = plan[plan.length - 1];
  const durationSec = last ? last.startSec + last.durationSec : 0;

  return async (boundaryIndex: number) => {
    if (boundaryIndex <= 0) return 0;
    if (boundaryIndex >= plan.length) return durationSec;

    const cached = cache.get(boundaryIndex);
    if (cached) return cached;

    const pending = (async () => {
      const segment = plan[boundaryIndex];
      const next = plan[boundaryIndex + 1];
      const plannedBoundarySec = segment.startSec;
      const nextBoundarySec = next ? next.startSec : durationSec;
      const actualBoundarySec = await resolveActualVideoBoundary(
        videoSink,
        plannedBoundarySec,
        nextBoundarySec,
      );

      const delta = actualBoundarySec - plannedBoundarySec;
      if (Math.abs(delta) > BOUNDARY_ALIGN_EPSILON_SEC) {
        log?.(
          `segment-boundary-align seq=${segment.sequence} ${plannedBoundarySec.toFixed(6)}->${actualBoundarySec.toFixed(6)} delta=${delta.toFixed(6)}`,
        );
      }

      return actualBoundarySec;
    })();

    cache.set(boundaryIndex, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(boundaryIndex);
      throw error;
    }
  };
}

export async function collectPacketsInRange(
  sink: EncodedPacketSink,
  startSec: number,
  endSec: number,
  opts?: { startFromKeyframe?: boolean; includePacketBeforeStart?: boolean },
): Promise<EncodedPacket[]> {
  const packets: EncodedPacket[] = [];

  let packet: EncodedPacket | null = null;
  if (opts?.startFromKeyframe) {
    packet = await sink.getKeyPacket(startSec);
    // getKeyPacket uses "floor" semantics (last keyframe with PTS <= startSec).
    // For HEVC B-frame content in MKV, the returned keyframe can be a full GOP
    // earlier than startSec when the actual keyframe at startSec sits on a
    // cluster boundary that the per-cluster PTS lookup misses.  Stepping forward
    // via getNextKeyPacket finds the real keyframe and keeps video/audio start
    // times aligned in the muxed fMP4 — critical for Chrome MSE which can't
    // handle large A/V start-time mismatches.
    if (packet && startSec - packet.timestamp > 0.5) {
      let next = await sink.getNextKeyPacket(packet);
      while (next && next.timestamp <= startSec + 0.2) {
        packet = next;
        next = await sink.getNextKeyPacket(next);
      }
      // If still a full GOP back, prefer the next keyframe when it falls
      // within this segment — avoids collecting double the intended duration.
      if (next && startSec - packet.timestamp > 0.5 && next.timestamp < endSec) {
        packet = next;
      }
    }
  } else {
    packet = await sink.getPacket(startSec);
  }
  if (!packet) {
    packet = await sink.getFirstPacket();
  }
  if (!packet) return packets;

  // For non-keyframe collection (audio), skip any initial packet whose
  // timestamp falls before startSec — the previous segment already owns it.
  // Without this, getPacket() "floor" semantics cause one AAC frame (~21 ms)
  // to appear in two consecutive fMP4 fragments, producing overlap that
  // manifests as stutter (Safari) or progressive A/V desync (Chrome).
  if (!opts?.startFromKeyframe && !opts?.includePacketBeforeStart) {
    while (packet && packet.timestamp < startSec) {
      const next = await sink.getNextPacket(packet);
      if (!next || next.sequenceNumber === packet.sequenceNumber) {
        packet = null;
        break;
      }
      packet = next;
    }
    if (!packet) return packets;
  }

  // Collect packets until we reach endSec
  while (packet) {
    if (packet.timestamp >= endSec) break;
    if (!packet.isMetadataOnly && packet.timestamp >= 0) {
      packets.push(packet);
    }
    const next = await sink.getNextPacket(packet);
    if (!next || next.sequenceNumber === packet.sequenceNumber) break;
    packet = next;
  }

  return packets;
}
