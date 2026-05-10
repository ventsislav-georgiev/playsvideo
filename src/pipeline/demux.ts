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
import type { AudioTrackInfo, KeyframeEntry, KeyframeIndex, PlannedSegment, SubtitleTrackInfo } from './types.js';

const KEYFRAME_LOOKUP_EARLY_SEC = 0.5;
const KEYFRAME_LOOKUP_LATE_SEC = 0.2;
const BOUNDARY_ALIGN_EPSILON_SEC = 1 / 1000;
const URL_READ_RETRIES = 2;
const URL_READ_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
const URL_SIZE_PROBE_BYTES = 64 * 1024;
const OFFLINE_URL_READ_WINDOW_BYTES = 512 * 1024;
const ONLINE_URL_READ_WINDOW_BYTES = 8 * 1024 * 1024;

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

function demuxLog(message: string): void {
  console.log(`[demux] ${message}`);
}

export interface DemuxResult {
  input: Input;
  duration: number;
  videoTrack: InputVideoTrack;
  audioTrack: InputAudioTrack | null;
  audioTrackIndex: number | null;
  audioTracks: AudioTrackInfo[];
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

export async function demuxFile(filePath: string, selectedAudioTrackIndex?: number): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new FilePathSource(filePath) }), selectedAudioTrackIndex);
}

export async function demuxBlob(blob: Blob, selectedAudioTrackIndex?: number): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) }), selectedAudioTrackIndex);
}
export async function demuxUrl(url: string, selectedAudioTrackIndex?: number): Promise<DemuxResult> {
  const source = new UrlSource(url, {
    maxCacheSize: 64 * 2 ** 20, // 64 MiB (default)
    parallelism: 2, // 2 concurrent requests (default)
    getRetryDelay: (attempts: number, _error: unknown, _url: string | URL | Request) => {
      // Exponential backoff: 100ms, 200ms, 400ms, then give up
      if (attempts >= 3) return null;
      return 100 * 2 ** attempts;
    },
  });
  return demuxInput(new Input({ formats: ALL_FORMATS, source }), selectedAudioTrackIndex);
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
   * Determine file size using a bounded GET request with Range header.
   * This approach:
   * - Combines size detection with a small initial data fetch (single RTT)
   * - Probes range support via 206 response
   * - Caches initial chunk for reuse
   * - Aligns with Mediabunny's UrlSource strategy
   *
   * See: https://github.com/ventsislav-georgiev/mediabunny/blob/main/src/source.ts#L436-L494
   */
  async _retrieveSize(): Promise<number | null> {
    if (this._isOfflineUrl()) {
      return this._retrieveOfflineSize();
    }

    const t0 = performance.now();
    const response = await fetch(this._url, {
      headers: {
        Range: `bytes=0-${URL_SIZE_PROBE_BYTES - 1}`,
      },
      signal: this._currentSignal ?? undefined,
    });

    if (response.status === 206) {
      let size = this._getTotalLengthFromContentRange(response);
      if (!size) {
        size = await this._retrieveRemoteHeadSize();
      }
      this._size = size;
      // Cache initial chunk for reuse in subsequent reads
      const tBody = performance.now();
      const bytes = new Uint8Array(await response.arrayBuffer());
      this._cacheRead(0, bytes.byteLength, bytes);
      demuxLog(
        `url-size range status=206 total=${this._size ?? 'unknown'} bodyBytes=${bytes.byteLength} fetch=${elapsed(t0)} body=${elapsed(tBody)}`,
      );
      return this._size;
    } else if (response.status === 200) {
      // Server ignored the range. Use Content-Length for size, but do not read the
      // body here because it may be a multi-GB video.
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const size = Number(contentLength);
        this._size = Number.isFinite(size) && size > 0 ? size : null;
        demuxLog(
          `url-size full status=200 total=${this._size ?? 'unknown'} bodyBytes=skipped fetch=${elapsed(t0)}`,
        );
        return this._size;
      } else {
        throw new Error('HTTP response must surface Content-Length header.');
      }
    }

    throw new Error(`URL source size detection failed: HTTP ${response.status}`);
  }

  private async _retrieveOfflineSize(): Promise<number | null> {
    const t0 = performance.now();
    const response = await fetch(this._url, {
      method: 'HEAD',
      signal: this._currentSignal ?? undefined,
    });

    if (response.status !== 200) {
      throw new Error(`URL source size detection failed: HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
      throw new Error('HTTP response must surface Content-Length header.');
    }

    const size = Number(contentLength);
    this._size = Number.isFinite(size) && size > 0 ? size : null;
    demuxLog(
      `offline-size HEAD status=${response.status} total=${this._size ?? 'unknown'} elapsed=${elapsed(t0)}`,
    );
    return this._size;
  }

  private async _retrieveRemoteHeadSize(): Promise<number | null> {
    const t0 = performance.now();
    const response = await fetch(this._url, {
      method: 'HEAD',
      signal: this._currentSignal ?? undefined,
    });
    if (response.status !== 200) {
      throw new Error(`URL source HEAD size detection failed: HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (!contentLength) {
      throw new Error('HTTP HEAD response must surface Content-Length header.');
    }
    const size = Number(contentLength);
    if (!Number.isFinite(size) || size <= 0) return null;
    demuxLog(`url-size HEAD status=${response.status} total=${size} elapsed=${elapsed(t0)}`);
    return size;
  }

  async _read(start: number, end: number) {
    const signal = this._currentSignal ?? undefined;
    checkAbort(signal);

    const cached = this._readFromCache(start, end);
    if (cached) {
      return this._makeReadResult(cached, start);
    }

    const readStart = this._firstMissingOffset(start, end) ?? start;
    const requestRange = this._makeRequestRange(readStart, end);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= URL_READ_RETRIES; attempt += 1) {
      try {
        checkAbort(signal);
        const tFetch = performance.now();
        const response = await fetch(this._url, {
          headers: { Range: `bytes=${requestRange.start}-${requestRange.end - 1}` },
          signal,
        });
        if (response.status !== 206 && response.status !== 200) {
          throw new Error(`URL source range request failed: HTTP ${response.status}`);
        }
        const tBody = performance.now();
        const bytes = new Uint8Array(await response.arrayBuffer());
        const responseStart =
          this._getResponseStart(response) ?? (response.status === 200 ? 0 : requestRange.start);
        this._cacheRead(responseStart, responseStart + bytes.byteLength, bytes);
        const combined = this._readFromCache(start, end);
        if (combined) {
          this._logReadFetch(readStart, start, end, requestRange, responseStart, response.status, bytes.byteLength, tFetch, tBody);
          return this._makeReadResult(combined, start);
        }
        const offset = start - responseStart;
        const length = end - start;
        if (offset < 0 || offset + length > bytes.byteLength) {
          throw new Error('URL source range response did not cover requested bytes');
        }
        this._logReadFetch(readStart, start, end, requestRange, responseStart, response.status, bytes.byteLength, tFetch, tBody);
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
    const windowBytes = this._isOfflineUrl() ? OFFLINE_URL_READ_WINDOW_BYTES : ONLINE_URL_READ_WINDOW_BYTES;
    const requestStart =
      Math.floor(start / windowBytes) * windowBytes;
    const requestedWindowEnd = requestStart + windowBytes;
    const requestEnd = Math.max(end, requestedWindowEnd);
    return { start: requestStart, end: this._size ? Math.min(requestEnd, this._size) : requestEnd };
  }

  private _logReadFetch(
    readStart: number,
    start: number,
    end: number,
    requestRange: { start: number; end: number },
    responseStart: number,
    status: number,
    byteLength: number,
    fetchStartedAt: number,
    bodyStartedAt: number,
  ): void {
    const mode = this._isOfflineUrl() ? 'offline-read' : 'url-read';
    demuxLog(
      `${mode} fetch requested=${readStart}-${end - 1} target=${start}-${end - 1} fetched=${requestRange.start}-${requestRange.end - 1} responseStart=${responseStart} status=${status} bytes=${byteLength} fetch=${elapsed(fetchStartedAt)} body=${elapsed(bodyStartedAt)}`,
    );
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

  private _getTotalLengthFromContentRange(response: Response): number | null {
    const contentRange = response.headers.get('content-range');
    const rangeMatch = contentRange?.match(/\/(\d+)$/);
    if (rangeMatch) {
      const size = Number(rangeMatch[1]);
      if (Number.isFinite(size) && size > 0) return size;
    }

    return null;
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

  private _readFromCache(start: number, end: number): Uint8Array | null {
    let offset = start;
    const parts: Uint8Array[] = [];

    while (offset < end) {
      const entry = this._bestCachedEntryForOffset(offset);
      if (!entry) return null;

      const sliceEnd = Math.min(end, entry.end);
      parts.push(entry.bytes.subarray(offset - entry.start, sliceEnd - entry.start));
      offset = sliceEnd;
    }

    if (parts.length === 0) return new Uint8Array(0);
    if (parts.length === 1) return parts[0];

    const bytes = new Uint8Array(end - start);
    let writeOffset = 0;
    for (const part of parts) {
      bytes.set(part, writeOffset);
      writeOffset += part.byteLength;
    }
    return bytes;
  }

  private _firstMissingOffset(start: number, end: number): number | null {
    let offset = start;
    while (offset < end) {
      const entry = this._bestCachedEntryForOffset(offset);
      if (!entry) return offset;
      offset = Math.min(end, entry.end);
    }
    return null;
  }

  private _bestCachedEntryForOffset(offset: number): { start: number; end: number; bytes: Uint8Array } | null {
    let best: { start: number; end: number; bytes: Uint8Array } | null = null;
    for (const entry of this._readCache) {
      if (entry.start > offset || entry.end <= offset) continue;
      if (!best || entry.end > best.end) best = entry;
    }
    return best;
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

export async function demuxSource(source: Source, selectedAudioTrackIndex?: number): Promise<DemuxResult> {
  return demuxInput(new Input({ formats: ALL_FORMATS, source: new SourceAdapter(source) }), selectedAudioTrackIndex);
}

export async function getAudioTrackInfos(input: Input): Promise<AudioTrackInfo[]> {
  const tracks = await input.getAudioTracks();
  return tracks.map((track, i) => {
    const disposition = track.disposition;
    return {
      index: i,
      codec: track.codec ?? null,
      language: track.languageCode,
      name: track.name,
      channels: Number.isFinite(track.numberOfChannels) ? track.numberOfChannels : null,
      sampleRate: Number.isFinite(track.sampleRate) ? track.sampleRate : null,
      disposition: {
        default: disposition.default,
        forced: disposition.forced,
        hearingImpaired: disposition.hearingImpaired,
      },
    };
  });
}

/**
 * Create a lightweight Input handle for subtitle-only access.
 * Uses its own I/O path so subtitle extraction never contends with
 * segment processing on the main demux handle.
 */
export async function createSubtitleInput(blob: Blob | null, url: string | null): Promise<Input> {
  let input: Input;
  if (blob) {
    input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  } else if (url) {
    const source = new UrlSource(url, {
      maxCacheSize: 64 * 2 ** 20, // 64 MiB (default)
      parallelism: 2, // 2 concurrent requests (default)
      getRetryDelay: (attempts: number, _error: unknown, _url: string | URL | Request) => {
        // Exponential backoff: 100ms, 200ms, 400ms, then give up
        if (attempts >= 3) return null;
        return 100 * 2 ** attempts;
      },
    });
    input = new Input({ formats: ALL_FORMATS, source });
  } else {
    throw new Error('No source provided for subtitle input');
  }
  // Trigger format probing so subtitle track methods (getCuesFrom, etc.) are available.
  await input.getSubtitleTracks();
  return input;
}

async function demuxInput(input: Input, selectedAudioTrackIndex?: number): Promise<DemuxResult> {
  const tTotal = performance.now();
  demuxLog('phase start');

  const videoTrack = await timedDemuxPhase('getPrimaryVideoTrack', () =>
    input.getPrimaryVideoTrack(),
  );
  if (!videoTrack) {
    throw new Error('No video track found');
  }

  let audioTrack: InputAudioTrack | null = null;
  let audioTrackIndex: number | null = null;
  let audioTracks: InputAudioTrack[] = [];
  try {
    audioTracks = await timedDemuxPhase('getAudioTracks', () => input.getAudioTracks());
    if (audioTracks.length > 0) {
      const requestedIndex = Number.isInteger(selectedAudioTrackIndex) ? selectedAudioTrackIndex! : null;
      audioTrackIndex = requestedIndex !== null && requestedIndex >= 0 && requestedIndex < audioTracks.length
        ? requestedIndex
        : Math.max(0, audioTracks.findIndex((track) => track.disposition.default));
      audioTrack = audioTracks[audioTrackIndex] ?? null;
    }
  } catch {
    // No audio track — that's fine
    demuxLog('phase getAudioTracks failed/no-audio');
  }

  const videoCodec = videoTrack.codec;
  if (!videoCodec) {
    throw new Error('Could not determine video codec');
  }

  const videoSink = new EncodedPacketSink(videoTrack);
  const audioSink = audioTrack ? new EncodedPacketSink(audioTrack) : null;

  const duration = await timedDemuxPhase('computeTrackDuration', () =>
    computeTrackDuration(videoTrack),
  );

  const videoDecoderConfig = await timedDemuxPhase('video.getDecoderConfig', () =>
    videoTrack.getDecoderConfig(),
  );
  if (!videoDecoderConfig) {
    throw new Error('Could not get video decoder config');
  }

  let audioDecoderConfig: AudioDecoderConfig | null = null;
  let audioInternalCodecId: string | null = null;
  if (audioTrack) {
    audioDecoderConfig = await timedDemuxPhase('audio.getDecoderConfig', () =>
      audioTrack.getDecoderConfig(),
    );
    const internalCodecId = audioTrack.internalCodecId;
    audioInternalCodecId = typeof internalCodecId === 'string' ? internalCodecId : null;
  }

  const subtitleTracks = await timedDemuxPhase('getSubtitleTrackInfos', () =>
    getSubtitleTrackInfos(input),
  );
  const audioTrackInfos = await timedDemuxPhase('getAudioTrackInfos', () => getAudioTrackInfos(input));
  demuxLog(`phase complete total=${elapsed(tTotal)}`);

  return {
    input,
    duration,
    videoTrack,
    audioTrack,
    audioTrackIndex,
    audioTracks: audioTrackInfos,
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

async function timedDemuxPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    demuxLog(`phase ${name} done ${elapsed(t0)}`);
    return result;
  } catch (err) {
    demuxLog(
      `phase ${name} failed ${elapsed(t0)} error=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

async function computeTrackDuration(videoTrack: InputVideoTrack): Promise<number> {
  const containerDuration = getContainerDuration(videoTrack);
  if (containerDuration !== null) {
    demuxLog(`duration source=container value=${containerDuration.toFixed(3)}s`);
    return containerDuration;
  }

  demuxLog('duration source=computeDuration fallback');
  return Number(await videoTrack.computeDuration());
}

function getContainerDuration(videoTrack: InputVideoTrack): number | null {
  const trackRecord = toRecord(videoTrack);
  const backing = toRecord(trackRecord?._backing);
  const internalTrack = toRecord(backing?.internalTrack);
  const demuxer = toRecord(internalTrack?.demuxer);

  return (
    durationFromTimescale(internalTrack?.durationInMovieTimescale, demuxer?.movieTimescale) ??
    durationFromTimescale(internalTrack?.durationInMediaTimescale, internalTrack?.timescale) ??
    durationFromTimescale(demuxer?.movieDurationInTimescale, demuxer?.movieTimescale)
  );
}

function durationFromTimescale(durationValue: unknown, timescaleValue: unknown): number | null {
  if (typeof durationValue !== 'number' || typeof timescaleValue !== 'number') return null;
  if (
    !Number.isFinite(durationValue) ||
    !Number.isFinite(timescaleValue) ||
    durationValue <= 0 ||
    timescaleValue <= 0
  ) {
    return null;
  }

  const duration = durationValue / timescaleValue;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
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
