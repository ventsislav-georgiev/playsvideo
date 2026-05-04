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
import type { Source } from '../source.js';
import { getSubtitleTrackInfos } from './subtitle.js';
import type { KeyframeEntry, KeyframeIndex, PlannedSegment, SubtitleTrackInfo } from './types.js';

const KEYFRAME_LOOKUP_EARLY_SEC = 0.5;
const KEYFRAME_LOOKUP_LATE_SEC = 0.2;
const BOUNDARY_ALIGN_EPSILON_SEC = 1 / 1000;

export interface DemuxResult {
  input: Input;
  duration: number;
  videoTrack: InputVideoTrack;
  audioTrack: InputAudioTrack | null;
  videoCodec: string;
  audioCodec: string | null;
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
  if (audioTrack) {
    audioDecoderConfig = await audioTrack.getDecoderConfig();
  }

  const subtitleTracks = await getSubtitleTrackInfos(input);

  return {
    input,
    duration,
    videoTrack,
    audioTrack,
    videoCodec,
    audioCodec: audioTrack?.codec ?? null,
    videoDecoderConfig,
    audioDecoderConfig,
    videoSink,
    audioSink,
    subtitleTracks,
    dispose: () => input.dispose(),
  };
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
    if (next && boundarySec - packet.timestamp > KEYFRAME_LOOKUP_EARLY_SEC && next.timestamp < nextBoundarySec) {
      packet = next;
    }
  }

  const timestamp = Number(packet.timestamp);
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
  opts?: { startFromKeyframe?: boolean },
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
  if (!opts?.startFromKeyframe) {
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
