import {
  BufferTarget,
  EncodedPacket,
  EncodedAudioPacketSource,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
  type AudioCodec,
} from 'mediabunny';
import { create as createDav1d, type Dav1dDecoder } from 'dav1d.js';
import type { Dav1dFrame } from 'dav1d.js';
import { createDav1dBridge } from '../vendor/dav1d-bridge/dav1d-bridge.js';
import { checkAbort } from './source-signal.js';
import {
  splitFragmentedMp4,
  VIDEO_TRANSCODE_OUTPUT_CODEC,
  type VideoTranscodeExecutor,
  type VideoTranscodeResult,
} from './video-transcode.js';
import { H264_WEB_CODECS_CODEC } from './webcodecs-transcode-probe.js';
import {
  getObuType,
  hasObuSizeField,
  hasObuExtension,
  decodeLeb128,
  extractObus,
} from './av1-packet-builder.js';

const DAV1D_WASM_URL = new URL('../vendor/dav1d-bridge/dav1d-bridge.wasm', import.meta.url).href;
const DEFAULT_VIDEO_BITRATE = 8_000_000;

function now(): number {
  return performance.now();
}

export interface Dav1dDecodedSample {
  sample: VideoSample;
  packet: EncodedPacket;
  frame: Dav1dFrame;
}

const AV1_OBU_SEQUENCE_HEADER = 1;
const AV1_OBU_FRAME_HEADER = 3;
const AV1_OBU_TILE_GROUP = 4;
const AV1_OBU_FRAME = 6;
const AV1_CONFIG_RECORD_HEADER_BYTES = 4;
const MICROSECONDS_PER_SECOND = 1_000_000;

export async function createDav1dDecoder(wasmData: ArrayBuffer | Uint8Array): Promise<Dav1dDecoder> {
  try {
    return await createDav1dBridge({ wasmData }) as unknown as Dav1dDecoder;
  } catch {
    return createDav1d({ wasmData });
  }
}

export interface Dav1dWebCodecsVideoTranscoderOptions {
  wasmURL?: string;
  wasmData?: ArrayBuffer | Uint8Array;
  videoBitrate?: number;
  h264Codec?: string;
}

export function createDav1dWebCodecsVideoTranscoder(
  options: Dav1dWebCodecsVideoTranscoderOptions = {},
): VideoTranscodeExecutor {
  let wasmDataPromise: Promise<ArrayBuffer | Uint8Array> | null = options.wasmData
    ? Promise.resolve(options.wasmData)
    : null;

  const getWasmData = async (): Promise<ArrayBuffer | Uint8Array> => {
    if (!wasmDataPromise) {
      const wasmURL = options.wasmURL ?? DAV1D_WASM_URL;
      wasmDataPromise = fetch(wasmURL, { credentials: 'same-origin' }).then(async (res) => {
        if (!res.ok) {
          throw new Error(`Failed to load dav1d wasm from ${wasmURL}: ${res.status} ${res.statusText}`);
        }
        return res.arrayBuffer();
      });
    }
    return wasmDataPromise;
  };

  return async (opts, signal) => {
    const decoder = await createDav1dDecoder(await getWasmData());
    try {
      return await transcodeDav1dWebCodecsSegment(
        decoder,
        opts,
        options.videoBitrate ?? DEFAULT_VIDEO_BITRATE,
        options.h264Codec ?? H264_WEB_CODECS_CODEC,
        signal,
      );
    } finally {
      decoder.unsafeCleanup();
    }
  };
}

async function transcodeDav1dWebCodecsSegment(
  decoder: Dav1dDecoder,
  opts: Parameters<VideoTranscodeExecutor>[0],
  videoBitrate: number,
  h264Codec: string,
  signal?: AbortSignal,
): Promise<VideoTranscodeResult> {
  if (opts.sourceVideoCodec !== 'av1') {
    throw new Error(`Unsupported dav1d video transcode source codec: ${opts.sourceVideoCodec}`);
  }
  if (opts.videoPackets.length === 0) {
    throw new Error('dav1d video transcode requires at least one video packet');
  }
  if (opts.audioPackets.length > 0 && opts.sourceAudioCodec !== 'aac') {
    throw new Error(
      `dav1d video transcode requires pre-transcoded AAC audio, got ${opts.sourceAudioCodec ?? 'unknown'}`,
    );
  }

  checkAbort(signal);
  const tTotal = now();
  const inputBytes = opts.videoPackets.reduce((sum, packet) => sum + packet.data.byteLength, 0)
    + opts.audioPackets.reduce((sum, packet) => sum + packet.data.byteLength, 0);

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: Number.MAX_SAFE_INTEGER }),
    target,
  });
  const videoSource = new VideoSampleSource({
    codec: VIDEO_TRANSCODE_OUTPUT_CODEC,
    fullCodecString: h264Codec,
    bitrate: videoBitrate,
    bitrateMode: 'variable',
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
    keyFrameInterval: opts.segmentDurationSec,
  });
  const audioSource = opts.audioPackets.length > 0 ? new EncodedAudioPacketSource('aac' as AudioCodec) : null;
  if (audioSource && !opts.audioDecoderConfig) {
    throw new Error('dav1d video transcode requires audio decoder config when AAC packets are present');
  }

  output.addVideoTrack(videoSource);
  if (audioSource) output.addAudioTrack(audioSource);

  const sourceColorSpace = videoColorSpaceForTranscode(opts.videoDecoderConfig);
  const outputColorSpace = outputColorSpaceForWebCodecs(sourceColorSpace);
  const tEncode = now();
  await output.start();

  const decodedFrames = decodeDav1dFrames(decoder, opts, outputColorSpace, signal);
  opts.log?.(formatDav1dFrameDiagnostics(opts, decodedFrames));
  opts.log?.(formatDav1dColorDiagnostics(sourceColorSpace, outputColorSpace));
  let decodedSamples = 0;
  for (let i = 0; i < decodedFrames.length; i++) {
    checkAbort(signal);
    const sample = sampleFromDecodedFrame(
      decodedFrames[i],
      decodedFrameDurationSec(decodedFrames, i, opts),
      outputColorSpace,
      shouldExpandLimitedRangeForWebCodecs(sourceColorSpace),
    );
    try {
      await videoSource.add(sample, { keyFrame: decodedSamples === 0 });
    } finally {
      sample.close();
    }
    decodedSamples += 1;
  }
  if (decodedSamples === 0) {
    throw new Error('dav1d video transcode did not find any decodable AV1 video packets');
  }
  videoSource.close();

  if (audioSource && opts.audioDecoderConfig) {
    const meta: EncodedAudioChunkMetadata = { decoderConfig: opts.audioDecoderConfig };
    for (let i = 0; i < opts.audioPackets.length; i++) {
      checkAbort(signal);
      await audioSource.add(opts.audioPackets[i], i === 0 ? meta : undefined);
    }
    audioSource.close();
  }

  await output.finalize();
  const encodeMs = now() - tEncode;
  if (!target.buffer) {
    throw new Error('dav1d/WebCodecs MP4 mux did not produce output');
  }

  const tSplit = now();
  const mp4Data = new Uint8Array(target.buffer);
  const split = splitFragmentedMp4(mp4Data);
  const splitMs = now() - tSplit;

  return {
    initSegment: split.initSegment,
    mediaData: split.mediaData,
    audioDecoderConfig: opts.audioPackets.length > 0 ? opts.audioDecoderConfig : null,
    metrics: {
      packageMs: 0,
      writeMs: 0,
      ffmpegMs: encodeMs,
      readMs: 0,
      splitMs,
      cleanupMs: 0,
      totalMs: now() - tTotal,
      inputBytes,
      outputBytes: mp4Data.byteLength,
      ffmpegSpeed: null,
      ffmpegTimeMs: null,
    },
  };
}

interface Dav1dDecodedFrameRecord {
  frame: Dav1dFrame;
  packet: EncodedPacket | null;
  timestampSec: number;
}

type BridgeDav1dDecoder = Dav1dDecoder & {
  sendPacket: (obu: Uint8Array, timestamp?: number) => void;
  receiveFrame: () => Dav1dFrame;
};

function decodeDav1dFrames(
  decoder: Dav1dDecoder,
  opts: Parameters<VideoTranscodeExecutor>[0],
  colorSpace: VideoColorSpaceInit,
  signal?: AbortSignal,
): Dav1dDecodedFrameRecord[] {
  if (!isBridgeDav1dDecoder(decoder)) {
    return decodeDav1dFramesLegacy(decoder, opts, colorSpace, signal);
  }

  const records: Dav1dDecodedFrameRecord[] = [];
  const packetByTimestampUs = new Map<number, EncodedPacket>();
  let sentPackets = 0;
  for (const packet of opts.videoPackets) {
    checkAbort(signal);
    if (!hasDecodableAv1Frame(packet.data)) continue;

    const timestampUs = secondsToMicroseconds(packet.timestamp);
    packetByTimestampUs.set(timestampUs, packet);
    const packetData = prepareDav1dAv1Packet(packet.data, opts.videoDecoderConfig, sentPackets === 0);
    decoder.sendPacket(packetData, timestampUs);
    sentPackets += 1;
    drainBridgeFrames(decoder, packetByTimestampUs, records);
  }
  drainBridgeFrames(decoder, packetByTimestampUs, records);
  records.sort((a, b) => a.timestampSec - b.timestampSec);
  return records;
}

function decodeDav1dFramesLegacy(
  decoder: Dav1dDecoder,
  opts: Parameters<VideoTranscodeExecutor>[0],
  colorSpace: VideoColorSpaceInit,
  signal?: AbortSignal,
): Dav1dDecodedFrameRecord[] {
  const records: Dav1dDecodedFrameRecord[] = [];
  for (const packet of opts.videoPackets) {
    checkAbort(signal);
    if (!hasDecodableAv1Frame(packet.data)) continue;

    const decoded = decodeAv1PacketToSample(
      decoder,
      packet,
      opts.videoDecoderConfig,
      records.length === 0,
      colorSpace,
    );
    decoded.sample.close();
    records.push({ frame: decoded.frame, packet, timestampSec: packet.timestamp });
  }
  return records;
}

function isBridgeDav1dDecoder(decoder: Dav1dDecoder): decoder is BridgeDav1dDecoder {
  return typeof decoder.sendPacket === 'function' && typeof decoder.receiveFrame === 'function';
}

function drainBridgeFrames(
  decoder: BridgeDav1dDecoder,
  packetByTimestampUs: Map<number, EncodedPacket>,
  records: Dav1dDecodedFrameRecord[],
): void {
  while (true) {
    try {
      const frame = decoder.receiveFrame();
      const timestampUs = Number.isFinite(frame.timestamp) ? Math.trunc(frame.timestamp ?? Number.NaN) : Number.NaN;
      const packet = Number.isFinite(timestampUs) ? packetByTimestampUs.get(timestampUs) ?? null : null;
      const timestampSec = packet?.timestamp ?? (Number.isFinite(timestampUs) ? timestampUs / MICROSECONDS_PER_SECOND : 0);
      records.push({ frame, packet, timestampSec });
    } catch (err) {
      if (isDav1dNeedsMoreData(err)) return;
      throw err;
    }
  }
}

function isDav1dNeedsMoreData(err: unknown): boolean {
  return String(err).includes('dav1d bridge needs more data');
}

function sampleFromDecodedFrame(
  record: Dav1dDecodedFrameRecord,
  duration: number,
  colorSpace: VideoColorSpaceInit,
  expandLimitedRange: boolean,
): VideoSample {
  const frame = record.frame;
  const expectedI420Size = frame.width * frame.height + 2 * Math.ceil(frame.width / 2) * Math.ceil(frame.height / 2);
  if (frame.data.byteLength < expectedI420Size) {
    throw new Error(
      `dav1d returned ${frame.data.byteLength} bytes for ${frame.width}x${frame.height} I420 frame; expected at least ${expectedI420Size}`,
    );
  }

  const data = frame.data.byteLength === expectedI420Size
    ? frame.data
    : frame.data.slice(0, expectedI420Size);
  const outputData = expandLimitedRange
    ? expandLimitedI420ToFullRange(data, frame.width, frame.height)
    : data;

  return new VideoSample(outputData, {
    format: 'I420',
    codedWidth: frame.width,
    codedHeight: frame.height,
    timestamp: record.timestampSec,
    duration,
    colorSpace,
  });
}

function decodedFrameDurationSec(
  records: Dav1dDecodedFrameRecord[],
  index: number,
  opts: Parameters<VideoTranscodeExecutor>[0],
): number {
  const current = records[index];
  const next = records[index + 1];
  if (next && next.timestampSec > current.timestampSec) {
    return next.timestampSec - current.timestampSec;
  }

  if (current.packet && current.packet.duration > 0) return current.packet.duration;

  const previous = records[index - 1];
  if (previous && current.timestampSec > previous.timestampSec) {
    return current.timestampSec - previous.timestampSec;
  }

  return Math.max(1 / 24, opts.segmentStartSec + opts.segmentDurationSec - current.timestampSec);
}

function formatDav1dFrameDiagnostics(
  opts: Parameters<VideoTranscodeExecutor>[0],
  records: Dav1dDecodedFrameRecord[],
): string {
  const decodablePackets = opts.videoPackets.filter((packet) => hasDecodableAv1Frame(packet.data)).length;
  if (records.length === 0) {
    return `dav1d frames decoded=0 decodablePackets=${decodablePackets} seg=[${opts.segmentStartSec.toFixed(3)},${(opts.segmentStartSec + opts.segmentDurationSec).toFixed(3)}]`;
  }

  const first = records[0].timestampSec;
  const last = records[records.length - 1].timestampSec;
  const deltas = records.slice(1, Math.min(records.length, 8)).map((record, index) => record.timestampSec - records[index].timestampSec);
  const deltaText = deltas.map((delta) => delta.toFixed(4)).join(',');
  return `dav1d frames decoded=${records.length} decodablePackets=${decodablePackets} ts=[${first.toFixed(4)},${last.toFixed(4)}] firstDeltas=[${deltaText}] seg=[${opts.segmentStartSec.toFixed(3)},${(opts.segmentStartSec + opts.segmentDurationSec).toFixed(3)}]`;
}

function secondsToMicroseconds(seconds: number): number {
  return Math.trunc(seconds * MICROSECONDS_PER_SECOND);
}

export function decodeAv1PacketToSample(
  decoder: Dav1dDecoder,
  packet: EncodedPacket,
  decoderConfig?: VideoDecoderConfig | null,
  includeDecoderConfig = false,
  colorSpace?: VideoColorSpaceInit,
): Dav1dDecodedSample {
  const packetData = prepareDav1dAv1Packet(packet.data, decoderConfig, includeDecoderConfig);
  
  // Collect diagnostics for decode error context
  const diagnostics = {
    packetByteLength: packetData.byteLength,
    hasSequenceHeader: containsAv1ObuType(packetData, AV1_OBU_SEQUENCE_HEADER),
    hasDecoderConfig: !!decoderConfig,
    decoderConfigByteLength: decoderConfig?.description ? toUint8Array(decoderConfig.description).byteLength : 0,
    includeDecoderConfig,
  };
  
  let frame;
  try {
    frame = decoder.decodeFrameAsYUV(packetData);
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes('error in djs_decode')) {
      const enrichedMsg = `dav1d decode failed: ${errMsg} | diagnostics: ${JSON.stringify(diagnostics)}`;
      throw new Error(enrichedMsg, { cause: err });
    }
    throw err;
  }
  
  const sourceColorSpace = colorSpace ?? videoColorSpaceForTranscode(decoderConfig);
  const outputColorSpace = outputColorSpaceForWebCodecs(sourceColorSpace);
  const sample = sampleFromDecodedFrame(
    { frame, packet, timestampSec: packet.timestamp },
    packet.duration,
    outputColorSpace,
    shouldExpandLimitedRangeForWebCodecs(sourceColorSpace),
  );

  return { sample, packet, frame };
}

function videoColorSpaceForTranscode(decoderConfig?: VideoDecoderConfig | null): VideoColorSpaceInit {
  const colorSpace = decoderConfig?.colorSpace;
  if (colorSpace?.primaries || colorSpace?.transfer || colorSpace?.matrix || colorSpace?.fullRange !== undefined) {
    return {
      primaries: colorSpace.primaries ?? 'bt709',
      transfer: colorSpace.transfer ?? 'bt709',
      matrix: colorSpace.matrix ?? 'bt709',
      fullRange: colorSpace.fullRange ?? false,
    };
  }

  return {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    fullRange: false,
  };
}

function outputColorSpaceForWebCodecs(sourceColorSpace: VideoColorSpaceInit): VideoColorSpaceInit {
  if (shouldExpandLimitedRangeForWebCodecs(sourceColorSpace)) {
    return { ...sourceColorSpace, fullRange: true };
  }
  return sourceColorSpace;
}

function shouldExpandLimitedRangeForWebCodecs(colorSpace: VideoColorSpaceInit): boolean {
  return colorSpace.fullRange === false;
}

function expandLimitedI420ToFullRange(data: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(data.byteLength);
  const ySize = width * height;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const chromaSize = chromaWidth * chromaHeight;

  for (let i = 0; i < ySize; i++) {
    output[i] = expandLimitedLumaToFull(data[i]);
  }
  for (let i = ySize; i < ySize + chromaSize * 2; i++) {
    output[i] = expandLimitedChromaToFull(data[i]);
  }
  return output;
}

function expandLimitedLumaToFull(value: number): number {
  return clampByte(Math.round((value - 16) * 255 / 219));
}

function expandLimitedChromaToFull(value: number): number {
  return clampByte(Math.round((value - 128) * 255 / 224 + 128));
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function formatDav1dColorDiagnostics(sourceColorSpace: VideoColorSpaceInit, outputColorSpace: VideoColorSpaceInit): string {
  const source = formatColorSpace(sourceColorSpace);
  const output = formatColorSpace(outputColorSpace);
  const rangeConversion = shouldExpandLimitedRangeForWebCodecs(sourceColorSpace) ? 'limited-to-full' : 'none';
  return `dav1d color source=${source} output=${output} rangeConversion=${rangeConversion}`;
}

function formatColorSpace(colorSpace: VideoColorSpaceInit): string {
  return `${colorSpace.primaries ?? 'unknown'}/${colorSpace.transfer ?? 'unknown'}/${colorSpace.matrix ?? 'unknown'}/${colorSpace.fullRange ? 'full' : 'limited'}`;
}

export function prepareDav1dAv1Packet(
  packetData: Uint8Array,
  decoderConfig?: VideoDecoderConfig | null,
  includeDecoderConfig = false,
): Uint8Array {
  if (!includeDecoderConfig || packetData.byteLength === 0 || containsAv1ObuType(packetData, AV1_OBU_SEQUENCE_HEADER)) {
    return packetData;
  }

  const configObus = extractAv1ConfigObus(decoderConfig?.description);
  if (!configObus || configObus.byteLength === 0) return packetData;

  const combined = new Uint8Array(configObus.byteLength + packetData.byteLength);
  combined.set(configObus, 0);
  combined.set(packetData, configObus.byteLength);
  return combined;
}

function extractAv1ConfigObus(description?: AllowSharedBufferSource | null): Uint8Array | null {
  if (!description) return null;

  const bytes = toUint8Array(description);
  if (bytes.byteLength <= AV1_CONFIG_RECORD_HEADER_BYTES) return null;

  const marker = (bytes[0] >> 7) & 0x01;
  const version = bytes[0] & 0x7f;
  if (marker !== 1 || version !== 1) return null;

  return bytes.subarray(AV1_CONFIG_RECORD_HEADER_BYTES);
}

function toUint8Array(buffer: AllowSharedBufferSource): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new Uint8Array(buffer);
}

function containsAv1ObuType(packetData: Uint8Array, wantedType: number): boolean {
  try {
    const obus = extractObus(packetData);
    return obus.some(obu => obu.type === wantedType);
  } catch {
    // Fallback: manual parsing for packets without size fields
    let offset = 0;
    while (offset < packetData.byteLength) {
      const header = packetData[offset++];
      const obuType = getObuType(header);
      const hasExtension = hasObuExtension(header);
      const hasSizeField = hasObuSizeField(header);

      if (obuType === wantedType) return true;
      if (hasExtension) {
        if (offset >= packetData.byteLength) return false;
        offset += 1;
      }

      let payloadSize: number;
      if (hasSizeField) {
        const parsedSize = decodeLeb128(packetData, offset);
        payloadSize = parsedSize.value;
        offset += parsedSize.bytesRead;
      } else {
        payloadSize = packetData.byteLength - offset;
      }

      offset += payloadSize;
    }

    return false;
  }
}

export function hasDecodableAv1Frame(packetData: Uint8Array): boolean {
  try {
    const obus = extractObus(packetData);
    return obus.some((obu) =>
      obu.type === AV1_OBU_FRAME_HEADER ||
      obu.type === AV1_OBU_FRAME ||
      obu.type === AV1_OBU_TILE_GROUP,
    );
  } catch {
    return containsAv1ObuType(packetData, AV1_OBU_FRAME_HEADER) ||
      containsAv1ObuType(packetData, AV1_OBU_FRAME) ||
      containsAv1ObuType(packetData, AV1_OBU_TILE_GROUP);
  }
}
