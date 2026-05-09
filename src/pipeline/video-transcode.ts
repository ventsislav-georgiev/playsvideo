import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { checkAbort } from './source-signal.js';
import type { FfmpegRunner } from './types.js';

const DEFAULT_OUTPUT_SAMPLE_RATE = 48000;
const DEFAULT_OUTPUT_CHANNELS = 2;
const DEFAULT_OUTPUT_AUDIO_BITRATE = '128k';
const DEFAULT_OUTPUT_VIDEO_CRF = '30';
const DEFAULT_OUTPUT_VIDEO_MAXRATE = '2800k';
const DEFAULT_OUTPUT_VIDEO_BUFSIZE = '5600k';
const DEFAULT_OUTPUT_VIDEO_FILTER = 'scale=w=trunc(min(1280\\,iw)/2)*2:h=-2';
const VIDEO_TRANSCODE_INPUT_AUDIO_CODECS = new Set<string>(['aac', 'opus']);

export const VIDEO_TRANSCODE_OUTPUT_CODEC = 'avc';
export const VIDEO_TRANSCODE_OUTPUT_CODEC_FULL = 'avc1.42E01E';
export const VIDEO_TRANSCODE_OUTPUT_AUDIO_CODEC = 'aac';
export const VIDEO_TRANSCODE_OUTPUT_AUDIO_CODEC_FULL = 'mp4a.40.2';

const runnerLocks = new WeakMap<FfmpegRunner, { tail: Promise<void> }>();
let videoTranscodeJobCounter = 0;

export interface VideoTranscodeOptions {
  videoPackets: EncodedPacket[];
  audioPackets: EncodedPacket[];
  sourceVideoCodec: string;
  sourceAudioCodec: string | null;
  videoDecoderConfig: VideoDecoderConfig;
  audioDecoderConfig: AudioDecoderConfig | null;
  segmentStartSec: number;
  segmentDurationSec: number;
  fragmentSequenceNumber: number;
  log?: (message: string) => void;
}

interface LocalVideoTranscodeOptions extends VideoTranscodeOptions {
  ffmpeg: FfmpegRunner;
}

export interface VideoTranscodeMetrics {
  packageMs: number;
  writeMs: number;
  ffmpegMs: number;
  readMs: number;
  splitMs: number;
  cleanupMs: number;
  totalMs: number;
  inputBytes: number;
  outputBytes: number;
  ffmpegSpeed: number | null;
  ffmpegTimeMs: number | null;
}

export interface VideoTranscodeResult {
  initSegment: Uint8Array;
  mediaData: Uint8Array;
  audioDecoderConfig: AudioDecoderConfig | null;
  metrics: VideoTranscodeMetrics;
}

export type VideoTranscodeExecutor = (
  opts: VideoTranscodeOptions,
  signal?: AbortSignal,
) => Promise<VideoTranscodeResult>;

export function isVideoTranscodeInputSupported(codec: string | null | undefined): boolean {
  return codec === 'av1';
}

export function createLocalVideoTranscoder(ffmpeg: FfmpegRunner): VideoTranscodeExecutor {
  return (opts, signal) => transcodeVideoSegment({ ...opts, ffmpeg }, signal);
}

export function makeVideoTranscodeAudioDecoderConfig(
  sourceConfig: AudioDecoderConfig | null,
): AudioDecoderConfig {
  return {
    codec: VIDEO_TRANSCODE_OUTPUT_AUDIO_CODEC_FULL,
    numberOfChannels: DEFAULT_OUTPUT_CHANNELS,
    sampleRate: sourceConfig?.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE,
  };
}

async function transcodeVideoSegment(
  opts: LocalVideoTranscodeOptions,
  signal?: AbortSignal,
): Promise<VideoTranscodeResult> {
  if (!isVideoTranscodeInputSupported(opts.sourceVideoCodec)) {
    throw new Error(`Unsupported video transcode source codec: ${opts.sourceVideoCodec}`);
  }
  if (
    opts.audioPackets.length > 0
    && (!opts.sourceAudioCodec || !VIDEO_TRANSCODE_INPUT_AUDIO_CODECS.has(opts.sourceAudioCodec))
  ) {
    throw new Error(
      `Unsupported audio codec for video transcode input: ${opts.sourceAudioCodec ?? 'unknown'}`,
    );
  }

  checkAbort(signal);
  const tTotal = now();
  const tPackage = now();
  const inputData = await packageSegmentAsMp4(opts);
  const packageMs = now() - tPackage;
  checkAbort(signal);

  const raw = await runFfmpegVideoTranscode({
    ffmpeg: opts.ffmpeg,
    inputData,
    hasAudio: opts.audioPackets.length > 0,
    sourceAudioCodec: opts.sourceAudioCodec,
    sourceCodec: opts.sourceVideoCodec,
    signal,
  });
  checkAbort(signal);

  const tSplit = now();
  const split = splitFragmentedMp4(raw.mp4Data);
  const splitMs = now() - tSplit;
  const audioDecoderConfig = opts.audioPackets.length > 0
    ? makeVideoTranscodeAudioDecoderConfig(opts.audioDecoderConfig)
    : null;

  return {
    initSegment: split.initSegment,
    mediaData: split.mediaData,
    audioDecoderConfig,
    metrics: {
      packageMs,
      writeMs: raw.metrics.writeMs,
      ffmpegMs: raw.metrics.ffmpegMs,
      readMs: raw.metrics.readMs,
      splitMs,
      cleanupMs: raw.metrics.cleanupMs,
      totalMs: now() - tTotal,
      inputBytes: inputData.byteLength,
      outputBytes: raw.mp4Data.byteLength,
      ffmpegSpeed: raw.metrics.ffmpegSpeed,
      ffmpegTimeMs: raw.metrics.ffmpegTimeMs,
    },
  };
}

async function packageSegmentAsMp4(opts: VideoTranscodeOptions): Promise<Uint8Array> {
  if (opts.videoPackets.length === 0) {
    throw new Error('Video transcode requires at least one video packet');
  }

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: Number.MAX_SAFE_INTEGER }),
    target,
  });
  const videoSource = new EncodedVideoPacketSource(opts.sourceVideoCodec as VideoCodec);
  const audioSource = opts.audioPackets.length > 0
    ? new EncodedAudioPacketSource(opts.sourceAudioCodec as AudioCodec)
    : null;
  if (audioSource && !opts.audioDecoderConfig) {
    throw new Error('Video transcode requires audio decoder config when audio packets are present');
  }

  output.addVideoTrack(videoSource);
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();
  const baseTimestamp = opts.videoPackets[0].timestamp;
  const videoMeta: EncodedVideoChunkMetadata = { decoderConfig: opts.videoDecoderConfig };
  for (const packet of opts.videoPackets) {
    await videoSource.add(normalizePacketTimestamp(packet, baseTimestamp), videoMeta);
  }
  videoSource.close();

  if (audioSource && opts.audioDecoderConfig) {
    const audioMeta: EncodedAudioChunkMetadata = {
      decoderConfig: audioDecoderConfigWithDescription(opts.sourceAudioCodec, opts.audioDecoderConfig),
    };
    for (const packet of opts.audioPackets) {
      await audioSource.add(normalizePacketTimestamp(packet, baseTimestamp), audioMeta);
    }
    audioSource.close();
  }

  await output.finalize();
  if (!target.buffer) {
    throw new Error('MP4 wrapper did not produce output');
  }
  return new Uint8Array(target.buffer);
}

function normalizePacketTimestamp(packet: EncodedPacket, baseTimestamp: number): EncodedPacket {
  return new EncodedPacket(
    packet.data,
    packet.type,
    packet.timestamp - baseTimestamp,
    packet.duration,
    packet.sequenceNumber,
    packet.byteLength,
    packet.sideData,
  );
}

function audioDecoderConfigWithDescription(
  codec: string | null,
  config: AudioDecoderConfig,
): AudioDecoderConfig {
  if (codec === 'opus') return opusDecoderConfigWithDescription(config);
  return config;
}

function opusDecoderConfigWithDescription(config: AudioDecoderConfig): AudioDecoderConfig {
  if (config.description && config.description.byteLength > 0) return config;
  return { ...config, description: buildOpusIdentificationHeader(config) };
}

function buildOpusIdentificationHeader(config: AudioDecoderConfig): Uint8Array {
  const channels = Math.max(1, Math.min(255, config.numberOfChannels || DEFAULT_OUTPUT_CHANNELS));
  const sampleRate = config.sampleRate || DEFAULT_OUTPUT_SAMPLE_RATE;
  const header = new Uint8Array(19);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x4f707573, false);
  view.setUint32(4, 0x48656164, false);
  view.setUint8(8, 1);
  view.setUint8(9, channels);
  view.setUint16(10, 0, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true);
  view.setUint8(18, 0);
  return header;
}

async function runFfmpegVideoTranscode(opts: {
  ffmpeg: FfmpegRunner;
  inputData: Uint8Array;
  hasAudio: boolean;
  sourceAudioCodec: string | null;
  sourceCodec: string;
  signal?: AbortSignal;
}): Promise<{
  mp4Data: Uint8Array;
  metrics: {
    writeMs: number;
    ffmpegMs: number;
    readMs: number;
    cleanupMs: number;
    ffmpegSpeed: number | null;
    ffmpegTimeMs: number | null;
  };
}> {
  const jobId = nextVideoTranscodeJobId();
  const inputName = `video-transcode-input-${jobId}.mp4`;
  const outputName = `video-transcode-output-${jobId}.mp4`;
  let writeMs = 0;
  let ffmpegMs = 0;
  let readMs = 0;
  let cleanupMs = 0;
  let ffmpegSpeed: number | null = null;
  let ffmpegTimeMs: number | null = null;
  let mp4Data = new Uint8Array(0);

  await withRunnerLock(opts.ffmpeg, async () => {
    try {
      checkAbort(opts.signal);
      await opts.ffmpeg.loadForCodec?.(opts.sourceCodec);

      const tWrite = now();
      await opts.ffmpeg.writeInput(inputName, opts.inputData);
      writeMs = now() - tWrite;
      checkAbort(opts.signal);

      const audioArgs = videoTranscodeFfmpegAudioArgs(opts.hasAudio, opts.sourceAudioCodec);
      const tFfmpeg = now();
      const result = await opts.ffmpeg.run([
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        inputName,
        '-map',
        '0:v:0',
        ...audioArgs,
        '-vf',
        DEFAULT_OUTPUT_VIDEO_FILTER,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-profile:v',
        'baseline',
        '-crf',
        DEFAULT_OUTPUT_VIDEO_CRF,
        '-maxrate',
        DEFAULT_OUTPUT_VIDEO_MAXRATE,
        '-bufsize',
        DEFAULT_OUTPUT_VIDEO_BUFSIZE,
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        'empty_moov+default_base_moof+frag_keyframe',
        '-f',
        'mp4',
        '-y',
        outputName,
      ]);
      ffmpegMs = now() - tFfmpeg;
      if (result.exitCode !== 0) {
        throw new Error(formatVideoTranscodeFailure(opts.sourceCodec, result.stderr));
      }
      ({ speed: ffmpegSpeed, timeMs: ffmpegTimeMs } = parseFfmpegStats(result.stderr));

      const tRead = now();
      mp4Data = copyBytes(await opts.ffmpeg.readOutput(outputName));
      readMs = now() - tRead;
    } finally {
      const tCleanup = now();
      await opts.ffmpeg.deleteFile?.(inputName);
      await opts.ffmpeg.deleteFile?.(outputName);
      cleanupMs = now() - tCleanup;
    }
  });

  return { mp4Data, metrics: { writeMs, ffmpegMs, readMs, cleanupMs, ffmpegSpeed, ffmpegTimeMs } };
}

export function videoTranscodeFfmpegAudioArgs(
  hasAudio: boolean,
  sourceAudioCodec: string | null,
): string[] {
  if (!hasAudio) return ['-an'];
  if (sourceAudioCodec === 'aac') return ['-map', '0:a:0?', '-c:a', 'copy'];
  return [
    '-map',
    '0:a:0?',
    '-c:a',
    'aac',
    '-ac',
    String(DEFAULT_OUTPUT_CHANNELS),
    '-ar',
    String(DEFAULT_OUTPUT_SAMPLE_RATE),
    '-b:a',
    DEFAULT_OUTPUT_AUDIO_BITRATE,
  ];
}

function formatVideoTranscodeFailure(sourceCodec: string, stderr: string): string {
  if (sourceCodec === 'av1' && looksLikeMissingAv1SoftwareDecoder(stderr)) {
    return [
      'Video transcode failed: the active ffmpeg.wasm core cannot decode AV1 in this browser.',
      'AV1 client transcode requires a custom client-side ffmpeg core built with a software AV1 decoder such as libdav1d (or libaom) plus libx264.',
      'This is still a browser/client path; no server transcode is required, but the stock @ffmpeg/core bundle is not sufficient.',
      stderr,
    ].join('\n');
  }
  return `Video transcode failed: ${stderr}`;
}

function looksLikeMissingAv1SoftwareDecoder(stderr: string): boolean {
  return /hardware accelerated AV1 decoding/i.test(stderr)
    || /Function not implemented/i.test(stderr)
    || /Missing Sequence Header/i.test(stderr)
    || /Failed to get pixel format/i.test(stderr);
}

export function splitFragmentedMp4(data: Uint8Array): { initSegment: Uint8Array; mediaData: Uint8Array } {
  const initParts: Uint8Array[] = [];
  const mediaParts: Uint8Array[] = [];
  let sawMoov = false;
  let sawMedia = false;

  for (const box of topLevelBoxes(data)) {
    const bytes = data.slice(box.start, box.end);
    if (box.type === 'ftyp' || box.type === 'moov') {
      initParts.push(bytes);
      if (box.type === 'moov') sawMoov = true;
    } else if (sawMoov) {
      mediaParts.push(bytes);
      if (box.type === 'moof' || box.type === 'mdat') sawMedia = true;
    }
  }

  if (!sawMoov || !sawMedia || initParts.length === 0 || mediaParts.length === 0) {
    throw new Error('Video transcode did not produce fragmented MP4 init/media boxes');
  }
  return { initSegment: concatBytes(initParts), mediaData: concatBytes(mediaParts) };
}

function topLevelBoxes(data: Uint8Array): Array<{ type: string; start: number; end: number }> {
  const boxes: Array<{ type: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset + 8 <= data.byteLength) {
    const view = new DataView(data.buffer, data.byteOffset + offset, data.byteLength - offset);
    let size = view.getUint32(0);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > data.byteLength) break;
      size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      headerSize = 16;
    } else if (size === 0) {
      size = data.byteLength - offset;
    }
    if (size < headerSize || offset + size > data.byteLength) break;
    boxes.push({ type, start: offset, end: offset + size });
    offset += size;
  }
  return boxes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function copyBytes(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function parseFfmpegStats(stderr: string): { speed: number | null; timeMs: number | null } {
  const speedMatch = stderr.match(/speed=\s*([\d.]+)x/);
  const timeMatch = stderr.match(/time=(\d+):(\d+):([\d.]+)/);
  return {
    speed: speedMatch ? Number.parseFloat(speedMatch[1]) : null,
    timeMs: timeMatch
      ? (Number.parseInt(timeMatch[1], 10) * 3600 +
          Number.parseInt(timeMatch[2], 10) * 60 +
          Number.parseFloat(timeMatch[3])) * 1000
      : null,
  };
}

async function withRunnerLock<T>(runner: FfmpegRunner, fn: () => Promise<T>): Promise<T> {
  const state = getRunnerLockState(runner);
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function getRunnerLockState(runner: FfmpegRunner): { tail: Promise<void> } {
  let state = runnerLocks.get(runner);
  if (!state) {
    state = { tail: Promise.resolve() };
    runnerLocks.set(runner, state);
  }
  return state;
}

function nextVideoTranscodeJobId(): number {
  videoTranscodeJobCounter += 1;
  return videoTranscodeJobCounter;
}

function now(): number {
  return performance.now();
}
