import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  OggOutputFormat,
  Output,
} from 'mediabunny';
import { parseAdtsFrames } from './adts-parse.js';
import type { FfmpegRunner } from './types.js';

const SAMPLES_PER_AAC_FRAME = 1024;
const DEFAULT_OUTPUT_SAMPLE_RATE = 48000;
const DEFAULT_OUTPUT_CHANNELS = 2;
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

const AAC_LC_SILENT_PAYLOADS: Record<number, number[]> = {
  1: [0x00, 0xc8, 0x00, 0x80, 0x23, 0x80],
  2: [0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80],
  3: [0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x8e],
  4: [
    0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x80, 0x2c, 0x80, 0x08,
    0x02, 0x38,
  ],
  5: [
    0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x82, 0x30, 0x04, 0x99,
    0x00, 0x21, 0x90, 0x02, 0x38,
  ],
  6: [
    0x00, 0xc8, 0x00, 0x80, 0x20, 0x84, 0x01, 0x26, 0x40, 0x08, 0x64, 0x00, 0x82, 0x30, 0x04, 0x99,
    0x00, 0x21, 0x90, 0x02, 0x00, 0xb2, 0x00, 0x20, 0x08, 0xe0,
  ],
};

const runnerLocks = new WeakMap<FfmpegRunner, { tail: Promise<void> }>();
let transcodeJobCounter = 0;

/** Map short codec names to ffmpeg input format (-f) flags. */
const INPUT_FORMAT: Record<string, string> = {
  ac3: 'ac3',
  eac3: 'eac3',
  dts: 'dts',
  truehd: 'truehd',
  mlp: 'mlp',
  mp3: 'mp3',
  flac: 'flac',
};

const INPUT_EXTENSION: Record<string, string> = {
  ac3: 'ac3',
  eac3: 'eac3',
  dts: 'dts',
  truehd: 'thd',
  mlp: 'mlp',
  mp3: 'mp3',
  flac: 'flac',
  opus: 'ogg',
};

export function isAudioTranscodeInputSupported(codec: string): boolean {
  return codec === 'opus' || codec in INPUT_FORMAT;
}

const OPUS_CHANNEL_MAPPING: Record<
  number,
  { streams: number; coupledStreams: number; mapping: number[] }
> = {
  3: { streams: 2, coupledStreams: 1, mapping: [0, 2, 1] },
  4: { streams: 2, coupledStreams: 2, mapping: [0, 1, 2, 3] },
  5: { streams: 3, coupledStreams: 2, mapping: [0, 4, 1, 2, 3] },
  6: { streams: 4, coupledStreams: 2, mapping: [0, 4, 1, 2, 3, 5] },
  7: { streams: 5, coupledStreams: 2, mapping: [0, 4, 1, 2, 3, 5, 6] },
  8: { streams: 5, coupledStreams: 3, mapping: [0, 6, 1, 2, 3, 4, 5, 7] },
};

export interface TranscodeOptions {
  packets: EncodedPacket[];
  sampleRate: number;
  /** Timestamp of the first original audio packet — used as base for transcoded timestamps */
  audioStartSec: number;
  /** Timestamp assigned to the first output AAC packet. Defaults to audioStartSec. */
  outputStartSec?: number;
  /** Encoded audio to discard from the beginning after transcoding, in seconds. */
  trimStartSec?: number;
  /** Silence to prepend before encoding, in seconds. */
  leadingSilenceSec?: number;
  /** Minimum output duration to produce, in seconds. */
  targetDurationSec?: number;
  /** Exact number of AAC frames to emit. Used for sample-continuous segment windows. */
  targetFrameCount?: number;
  /** Source audio codec (e.g. 'ac3', 'mp3'). Determines ffmpeg input format. */
  sourceCodec?: string;
  /** Source audio decoder config. Required to wrap packetized Opus into an Ogg input for ffmpeg. */
  audioDecoderConfig?: AudioDecoderConfig | null;
}

export type AudioTranscodeExecutor = (
  opts: TranscodeOptions,
  signal?: AbortSignal,
) => Promise<TranscodeResult>;

export interface FfmpegTranscodeMetrics {
  writeMs: number;
  ffmpegMs: number;
  readMs: number;
  cleanupMs: number;
  /** ffmpeg-reported realtime multiplier (e.g. 63 = 63x realtime), null if not parseable */
  ffmpegSpeed: number | null;
  /** ffmpeg-reported output duration in ms, null if not parseable */
  ffmpegTimeMs: number | null;
}

export interface RawAudioTranscodeResult {
  aacData: Uint8Array;
  metrics: FfmpegTranscodeMetrics;
}

export interface TranscodeMetrics {
  inputPackets: number;
  inputBytes: number;
  /** Duration of input audio (last packet end - first packet start) */
  audioDurationSec: number;
  /** Phase timings in milliseconds */
  concatMs: number;
  writeMs: number;
  ffmpegMs: number;
  readMs: number;
  cleanupMs: number;
  parseMs: number;
  totalMs: number;
  outputPackets: number;
  outputBytes: number;
  /** Duration computed from output frame count */
  outputDurationSec: number;
  /** Exact requested output AAC frame count, when one was provided */
  targetFrameCount?: number;
  /** ffmpeg-reported realtime multiplier (e.g. 63 = 63x realtime), null if not parseable */
  ffmpegSpeed: number | null;
  /** ffmpeg-reported output duration in ms, null if not parseable */
  ffmpegTimeMs: number | null;
  /** totalMs / (audioDurationSec * 1000) — values <1 mean faster than realtime */
  realtimeRatio: number;
}

export interface TranscodeResult {
  packets: EncodedPacket[];
  decoderConfig: AudioDecoderConfig;
  metrics: TranscodeMetrics;
}

export function makeAacDecoderConfig(sourceConfig: AudioDecoderConfig | null): AudioDecoderConfig {
  return {
    codec: 'mp4a.40.2',
    numberOfChannels: DEFAULT_OUTPUT_CHANNELS,
    sampleRate: sourceConfig?.sampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE,
  };
}

/** Parse ffmpeg's final stats line for speed and time values. */
function parseFfmpegStats(stderr: string): { speed: number | null; timeMs: number | null } {
  const speedMatch = stderr.match(/speed=\s*([\d.]+)x/);
  const timeMatch = stderr.match(/time=(\d+):(\d+):([\d.]+)/);
  return {
    speed: speedMatch ? Number.parseFloat(speedMatch[1]) : null,
    timeMs: timeMatch
      ? (Number.parseInt(timeMatch[1], 10) * 3600 +
          Number.parseInt(timeMatch[2], 10) * 60 +
          Number.parseFloat(timeMatch[3])) *
        1000
      : null,
  };
}

function now(): number {
  return performance.now();
}

function nextTranscodeJobId(): number {
  transcodeJobCounter += 1;
  return transcodeJobCounter;
}

function positiveFinite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function snapToSampleGrid(timestampSec: number, sampleRate: number): number {
  if (!Number.isFinite(timestampSec) || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return timestampSec;
  }
  return Math.round(timestampSec * sampleRate) / sampleRate;
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

export function createAacSilentAdtsFrame(sampleRate: number, channels: number): Uint8Array | null {
  const sampleRateIndex = ADTS_SAMPLE_RATES.indexOf(sampleRate);
  const payload = AAC_LC_SILENT_PAYLOADS[channels];
  if (sampleRateIndex < 0 || !payload) return null;

  const payloadBytes = new Uint8Array(payload);
  const frameLength = 7 + payloadBytes.byteLength;
  const header = new Uint8Array(7);
  const profile = 1; // AAC-LC: audio object type 2 minus one.
  const channelConfig = channels;

  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] = (profile << 6) | (sampleRateIndex << 2) | ((channelConfig >> 2) & 0x01);
  header[3] = ((channelConfig & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f;
  header[6] = 0xfc;

  return concatBytes([header, payloadBytes]);
}

function makeAacPacket(
  data: Uint8Array,
  timestamp: number,
  duration: number,
  sequenceNumber: number,
): EncodedPacket {
  return new EncodedPacket(data, 'key', timestamp, duration, sequenceNumber);
}

function padAacPacketsToSegment(input: {
  packets: EncodedPacket[];
  sampleRate: number;
  channels: number;
  startSec: number;
  leadingSilenceSec?: number;
  targetDurationSec?: number;
  targetFrameCount?: number;
}): EncodedPacket[] {
  const frameDuration = SAMPLES_PER_AAC_FRAME / input.sampleRate;
  const leadingFrameCount = Math.max(
    0,
    Math.round(positiveFinite(input.leadingSilenceSec) / frameDuration),
  );
  const targetFrameCount =
    input.targetFrameCount !== undefined && Number.isFinite(input.targetFrameCount)
      ? Math.max(0, Math.round(input.targetFrameCount))
      : null;
  const targetDurationSec = positiveFinite(input.targetDurationSec);
  const targetEndSec = targetDurationSec > 0 ? input.startSec + targetDurationSec : null;
  const silentFrame =
    createAacSilentAdtsFrame(input.sampleRate, input.channels) ?? input.packets[0]?.data;
  if (!silentFrame) {
    return targetFrameCount === null ? input.packets : input.packets.slice(0, targetFrameCount);
  }

  const packets: EncodedPacket[] = [];
  let timestamp = input.startSec;
  let sequenceNumber = 0;
  const canAppendFrame = (): boolean => {
    if (targetFrameCount !== null) return packets.length < targetFrameCount;
    return targetEndSec === null || timestamp < targetEndSec - frameDuration / 1000;
  };

  for (let i = 0; i < leadingFrameCount && canAppendFrame(); i++) {
    packets.push(makeAacPacket(silentFrame, timestamp, frameDuration, sequenceNumber));
    timestamp += frameDuration;
    sequenceNumber += 1;
  }

  for (const packet of input.packets) {
    if (!canAppendFrame()) break;
    packets.push(makeAacPacket(packet.data, timestamp, frameDuration, sequenceNumber));
    timestamp += frameDuration;
    sequenceNumber += 1;
  }

  while ((targetFrameCount !== null || targetEndSec !== null) && canAppendFrame()) {
    packets.push(makeAacPacket(silentFrame, timestamp, frameDuration, sequenceNumber));
    timestamp += frameDuration;
    sequenceNumber += 1;
  }

  return packets;
}

function getRunnerLockState(runner: FfmpegRunner): { tail: Promise<void> } {
  let state = runnerLocks.get(runner);
  if (!state) {
    state = { tail: Promise.resolve() };
    runnerLocks.set(runner, state);
  }
  return state;
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

export function createLocalAudioTranscoder(ffmpeg: FfmpegRunner): AudioTranscodeExecutor {
  return (opts) => transcodeAudioSegment({ ...opts, ffmpeg });
}

export function createEmptyTranscodeResult(sampleRate: number): TranscodeResult {
  return {
    packets: [],
    decoderConfig: makeAacDecoderConfig({
      codec: 'mp4a.40.2',
      numberOfChannels: DEFAULT_OUTPUT_CHANNELS,
      sampleRate,
    }),
    metrics: {
      inputPackets: 0,
      inputBytes: 0,
      audioDurationSec: 0,
      concatMs: 0,
      writeMs: 0,
      ffmpegMs: 0,
      readMs: 0,
      cleanupMs: 0,
      parseMs: 0,
      totalMs: 0,
      outputPackets: 0,
      outputBytes: 0,
      outputDurationSec: 0,
      ffmpegSpeed: null,
      ffmpegTimeMs: null,
      realtimeRatio: 0,
    },
  };
}

export function concatEncodedPacketData(packets: EncodedPacket[]): {
  data: Uint8Array;
  inputBytes: number;
  audioDurationSec: number;
} {
  const inputBytes = packets.reduce((sum, p) => sum + p.data.byteLength, 0);
  const data = new Uint8Array(inputBytes);
  let offset = 0;
  for (const pkt of packets) {
    data.set(pkt.data, offset);
    offset += pkt.data.byteLength;
  }

  const firstPkt = packets[0];
  const lastPkt = packets[packets.length - 1];
  const audioDurationSec = lastPkt.timestamp + lastPkt.duration - firstPkt.timestamp;

  return { data, inputBytes, audioDurationSec };
}

export interface PreparedTranscodeInput {
  data: Uint8Array;
  inputBytes: number;
  audioDurationSec: number;
  inputFormat?: string | null;
  inputExtension?: string;
}

async function wrapOpusPacketsInOgg(
  packets: EncodedPacket[],
  decoderConfig: AudioDecoderConfig,
): Promise<Uint8Array> {
  const target = new BufferTarget();
  const output = new Output({
    format: new OggOutputFormat(),
    target,
  });
  const source = new EncodedAudioPacketSource('opus');
  const meta: EncodedAudioChunkMetadata = {
    decoderConfig: opusDecoderConfigWithDescription(decoderConfig),
  };

  output.addAudioTrack(source);
  await output.start();
  for (const packet of packets) {
    await source.add(packet, meta);
  }
  source.close();
  await output.finalize();

  if (!target.buffer) {
    throw new Error('Opus Ogg wrapper did not produce output');
  }
  return new Uint8Array(target.buffer);
}

function opusDecoderConfigWithDescription(config: AudioDecoderConfig): AudioDecoderConfig {
  if (config.description && config.description.byteLength > 0) return config;
  return {
    ...config,
    description: buildOpusIdentificationHeader(config),
  };
}

function buildOpusIdentificationHeader(config: AudioDecoderConfig): Uint8Array {
  const channels = Math.max(1, Math.min(255, config.numberOfChannels || DEFAULT_OUTPUT_CHANNELS));
  const sampleRate = config.sampleRate || DEFAULT_OUTPUT_SAMPLE_RATE;
  const mapping = channels <= 2 ? null : OPUS_CHANNEL_MAPPING[channels];
  const channelMappingFamily = mapping ? 1 : 0;
  const channelMappingBytes = mapping ? 2 + channels : 0;
  const header = new Uint8Array(19 + channelMappingBytes);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x4f707573, false); // 'Opus'
  view.setUint32(4, 0x48656164, false); // 'Head'
  view.setUint8(8, 1);
  view.setUint8(9, channels);
  view.setUint16(10, 0, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true);
  view.setUint8(18, channelMappingFamily);
  if (mapping) {
    view.setUint8(19, mapping.streams);
    view.setUint8(20, mapping.coupledStreams);
    header.set(mapping.mapping, 21);
  }
  return header;
}

export async function prepareTranscodeInput(
  opts: TranscodeOptions,
): Promise<PreparedTranscodeInput> {
  const concatenated = concatEncodedPacketData(opts.packets);
  if (opts.sourceCodec !== 'opus') {
    if (!opts.sourceCodec) {
      throw new Error('Audio transcode requires a source codec');
    }
    if (!isAudioTranscodeInputSupported(opts.sourceCodec)) {
      throw new Error(`Unsupported audio transcode source codec: ${opts.sourceCodec}`);
    }
    return {
      ...concatenated,
      inputFormat: INPUT_FORMAT[opts.sourceCodec],
      inputExtension: INPUT_EXTENSION[opts.sourceCodec] ?? opts.sourceCodec,
    };
  }

  if (!opts.audioDecoderConfig) {
    throw new Error('Opus audio transcode requires decoder config for Ogg wrapping');
  }

  return {
    data: await wrapOpusPacketsInOgg(opts.packets, opts.audioDecoderConfig),
    inputBytes: concatenated.inputBytes,
    audioDurationSec: concatenated.audioDurationSec,
    inputFormat: 'ogg',
    inputExtension: 'ogg',
  };
}

export function packetsFromAdtsData(
  aacData: Uint8Array,
  sampleRate: number,
  audioStartSec: number,
  options: {
    trimStartSec?: number;
    leadingSilenceSec?: number;
    targetDurationSec?: number;
    targetFrameCount?: number;
  } = {},
): {
  packets: EncodedPacket[];
  decoderConfig: AudioDecoderConfig;
  parseMs: number;
  outputBytes: number;
  outputDurationSec: number;
} {
  const tParse = now();
  const allFrames = parseAdtsFrames(aacData);
  // Drop the first ADTS frame: ffmpeg's native AAC encoder has initial_padding
  // of 1024 samples (one frame). In ADTS output this priming frame is included
  // verbatim, so keeping it shifts real audio content by ~21 ms at 48 kHz.
  const unprimedFrames = allFrames.length > 1 ? allFrames.slice(1) : allFrames;
  // Use actual output sample rate from ADTS headers, not the passed source rate —
  // ffmpeg may output at a different rate than the source codec.
  const actualSampleRate = unprimedFrames[0]?.sampleRate ?? sampleRate;
  const frameDuration = SAMPLES_PER_AAC_FRAME / actualSampleRate;
  const trimFrameCount = Math.max(
    0,
    Math.round(positiveFinite(options.trimStartSec) / frameDuration),
  );
  const frames = unprimedFrames.slice(trimFrameCount);
  const startSec = snapToSampleGrid(audioStartSec, actualSampleRate);

  const sourcePackets = frames.map((frame, i) =>
    makeAacPacket(frame.data, startSec + i * frameDuration, frameDuration, i),
  );
  const packets = padAacPacketsToSegment({
    packets: sourcePackets,
    sampleRate: actualSampleRate,
    channels: frames[0]?.channels ?? DEFAULT_OUTPUT_CHANNELS,
    startSec,
    leadingSilenceSec: options.leadingSilenceSec,
    targetDurationSec: options.targetDurationSec,
    targetFrameCount: options.targetFrameCount,
  });
  const parseMs = now() - tParse;
  const outputBytes = packets.reduce((sum, packet) => sum + packet.data.byteLength, 0);

  return {
    packets,
    decoderConfig: {
      codec: 'mp4a.40.2', // AAC-LC
      numberOfChannels: frames[0]?.channels ?? DEFAULT_OUTPUT_CHANNELS,
      sampleRate: frames[0]?.sampleRate ?? sampleRate,
    },
    parseMs,
    outputBytes,
    outputDurationSec: packets.length * frameDuration,
  };
}

export function buildTranscodeResultFromAdts(params: {
  inputPackets: number;
  inputBytes: number;
  audioDurationSec: number;
  concatMs: number;
  sampleRate: number;
  audioStartSec: number;
  outputStartSec?: number;
  trimStartSec?: number;
  leadingSilenceSec?: number;
  targetDurationSec?: number;
  targetFrameCount?: number;
  aacData: Uint8Array;
  ffmpegMetrics: FfmpegTranscodeMetrics;
  totalMs: number;
}): TranscodeResult {
  const parsed = packetsFromAdtsData(
    params.aacData,
    params.sampleRate,
    params.outputStartSec ?? params.audioStartSec,
    {
      trimStartSec: params.trimStartSec,
      leadingSilenceSec: params.leadingSilenceSec,
      targetDurationSec: params.targetDurationSec,
      targetFrameCount: params.targetFrameCount,
    },
  );
  const metrics: TranscodeMetrics = {
    inputPackets: params.inputPackets,
    inputBytes: params.inputBytes,
    audioDurationSec: params.audioDurationSec,
    concatMs: params.concatMs,
    writeMs: params.ffmpegMetrics.writeMs,
    ffmpegMs: params.ffmpegMetrics.ffmpegMs,
    readMs: params.ffmpegMetrics.readMs,
    cleanupMs: params.ffmpegMetrics.cleanupMs,
    parseMs: parsed.parseMs,
    totalMs: params.totalMs,
    outputPackets: parsed.packets.length,
    outputBytes: parsed.outputBytes,
    outputDurationSec: parsed.outputDurationSec,
    targetFrameCount: params.targetFrameCount,
    ffmpegSpeed: params.ffmpegMetrics.ffmpegSpeed,
    ffmpegTimeMs: params.ffmpegMetrics.ffmpegTimeMs,
    realtimeRatio:
      params.audioDurationSec > 0 ? params.totalMs / (params.audioDurationSec * 1000) : 0,
  };

  return {
    packets: parsed.packets,
    decoderConfig: parsed.decoderConfig,
    metrics,
  };
}

export async function runFfmpegAudioTranscode(opts: {
  ffmpeg: FfmpegRunner;
  inputData: Uint8Array;
  sampleRate: number;
  sourceCodec?: string;
  inputFormat?: string | null;
  inputExtension?: string;
}): Promise<RawAudioTranscodeResult> {
  if (!opts.sourceCodec) {
    throw new Error('Audio transcode requires a source codec');
  }
  if (!isAudioTranscodeInputSupported(opts.sourceCodec)) {
    throw new Error(`Unsupported audio transcode source codec: ${opts.sourceCodec}`);
  }
  const codec = opts.sourceCodec;
  const inputFormat =
    opts.inputFormat === null ? null : (opts.inputFormat ?? INPUT_FORMAT[codec] ?? codec);
  const inputExtension = opts.inputExtension ?? INPUT_EXTENSION[codec] ?? inputFormat;
  const jobId = nextTranscodeJobId();
  const inputName = `transcode-input-${jobId}.${inputExtension}`;
  const outputName = `transcode-output-${jobId}.aac`;

  let writeMs = 0;
  let ffmpegMs = 0;
  let readMs = 0;
  let cleanupMs = 0;
  let ffmpegSpeed: number | null = null;
  let ffmpegTimeMs: number | null = null;
  let aacData: Uint8Array = new Uint8Array(0);

  await withRunnerLock(opts.ffmpeg, async () => {
    try {
      const tWrite = now();
      await opts.ffmpeg.writeInput(inputName, opts.inputData);
      writeMs = now() - tWrite;

      const tFfmpeg = now();
      const inputArgs = inputFormat ? ['-f', inputFormat] : [];
      const result = await opts.ffmpeg.run([
        '-hide_banner',
        '-loglevel',
        'info',
        ...inputArgs,
        '-i',
        inputName,
        '-c:a',
        'aac',
        '-ac',
        String(DEFAULT_OUTPUT_CHANNELS),
        '-b:a',
        '160k',
        '-f',
        'adts',
        '-y',
        outputName,
      ]);
      ffmpegMs = now() - tFfmpeg;

      if (result.exitCode !== 0) {
        throw new Error(`Audio transcode failed: ${result.stderr}`);
      }

      ({ speed: ffmpegSpeed, timeMs: ffmpegTimeMs } = parseFfmpegStats(result.stderr));

      const tRead = now();
      aacData = await opts.ffmpeg.readOutput(outputName);
      readMs = now() - tRead;
    } finally {
      const tCleanup = now();
      await opts.ffmpeg.deleteFile?.(inputName);
      await opts.ffmpeg.deleteFile?.(outputName);
      cleanupMs = now() - tCleanup;
    }
  });

  return {
    aacData,
    metrics: {
      writeMs,
      ffmpegMs,
      readMs,
      cleanupMs,
      ffmpegSpeed,
      ffmpegTimeMs,
    },
  };
}

export async function transcodeAudioSegment(
  opts: TranscodeOptions & { ffmpeg: FfmpegRunner },
): Promise<TranscodeResult> {
  if (opts.packets.length === 0) {
    return createEmptyTranscodeResult(opts.sampleRate);
  }

  const tTotal = now();
  const tConcat = now();
  const input = await prepareTranscodeInput(opts);
  const concatMs = now() - tConcat;

  const raw = await runFfmpegAudioTranscode({
    ffmpeg: opts.ffmpeg,
    inputData: input.data,
    sampleRate: opts.sampleRate,
    sourceCodec: opts.sourceCodec,
    inputFormat: input.inputFormat,
    inputExtension: input.inputExtension,
  });

  return buildTranscodeResultFromAdts({
    inputPackets: opts.packets.length,
    inputBytes: input.inputBytes,
    audioDurationSec: input.audioDurationSec,
    concatMs,
    sampleRate: opts.sampleRate,
    audioStartSec: opts.audioStartSec,
    outputStartSec: opts.outputStartSec,
    trimStartSec: opts.trimStartSec,
    leadingSilenceSec: opts.leadingSilenceSec,
    targetDurationSec: opts.targetDurationSec,
    targetFrameCount: opts.targetFrameCount,
    aacData: raw.aacData,
    ffmpegMetrics: raw.metrics,
    totalMs: now() - tTotal,
  });
}
