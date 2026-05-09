export interface WebCodecsCodecProbe {
  supported: boolean;
  configSupported: boolean;
  encodeFlushSupported?: boolean;
  error?: string;
}

export interface WebCodecsTranscodeProbeResult {
  available: boolean;
  av1Decode: WebCodecsCodecProbe;
  h264Encode: WebCodecsCodecProbe;
  h264Codec: string;
  hevcEncode: WebCodecsCodecProbe;
  targetWidth: number;
  targetHeight: number;
  canUseHardwarePath: boolean;
}

export const H264_WEB_CODECS_CODEC = 'avc1.42E01F';
export const H264_WEB_CODECS_CODEC_CANDIDATES = [
  'avc1.64001F', // High profile, level 3.1
  'avc1.4D401F', // Main profile, level 3.1
  H264_WEB_CODECS_CODEC, // Baseline fallback
] as const;
const HEVC_WEB_CODECS_CODEC = 'hvc1.1.6.L93.B0';
const WEB_CODECS_PROBE_BITRATE = 2_800_000;
const WEB_CODECS_PROBE_FRAME_RATE = 24;
const WEB_CODECS_MAX_WIDTH = 1280;

export async function probeWebCodecsTranscodeSupport(
  av1DecoderConfig: VideoDecoderConfig,
): Promise<WebCodecsTranscodeProbeResult> {
  const target = targetDimensions(av1DecoderConfig.codedWidth, av1DecoderConfig.codedHeight);
  const available = typeof VideoDecoder !== 'undefined'
    && typeof VideoEncoder !== 'undefined'
    && typeof VideoFrame !== 'undefined';

  if (!available) {
    const unavailable = { supported: false, configSupported: false, error: 'WebCodecs API unavailable' };
    return {
      available: false,
      av1Decode: unavailable,
      h264Encode: unavailable,
      h264Codec: H264_WEB_CODECS_CODEC,
      hevcEncode: unavailable,
      targetWidth: target.width,
      targetHeight: target.height,
      canUseHardwarePath: false,
    };
  }

  const av1Decode = await probeVideoDecoder(av1DecoderConfig);
  const { codec: h264Codec, probe: h264Encode } = await probeH264Encoder(target);
  const hevcEncode = await probeVideoEncoder(makeEncoderConfig(HEVC_WEB_CODECS_CODEC, target));

  return {
    available: true,
    av1Decode,
    h264Encode,
    h264Codec,
    hevcEncode,
    targetWidth: target.width,
    targetHeight: target.height,
    canUseHardwarePath: av1Decode.supported && (h264Encode.supported || hevcEncode.supported),
  };
}

export function formatWebCodecsTranscodeProbe(result: WebCodecsTranscodeProbeResult): string {
  return [
    `available=${result.available ? 'yes' : 'no'}`,
    `target=${result.targetWidth}x${result.targetHeight}`,
    `av1Decode=${formatProbe(result.av1Decode)}`,
    `h264Encode=${formatProbe(result.h264Encode)} codec=${result.h264Codec}`,
    `hevcEncode=${formatProbe(result.hevcEncode)}`,
    `hardwarePath=${result.canUseHardwarePath ? 'possible' : 'unavailable'}`,
  ].join(' ');
}

async function probeH264Encoder(target: { width: number; height: number }): Promise<{
  codec: string;
  probe: WebCodecsCodecProbe;
}> {
  let fallbackProbe: WebCodecsCodecProbe | null = null;
  for (const codec of H264_WEB_CODECS_CODEC_CANDIDATES) {
    const probe = await probeVideoEncoder(makeEncoderConfig(codec, target));
    if (codec === H264_WEB_CODECS_CODEC) fallbackProbe = probe;
    if (probe.supported) {
      return { codec, probe };
    }
  }
  return {
    codec: H264_WEB_CODECS_CODEC,
    probe: fallbackProbe ?? { supported: false, configSupported: false },
  };
}

function targetDimensions(width = WEB_CODECS_MAX_WIDTH, height = 720): { width: number; height: number } {
  const safeWidth = Math.max(2, width);
  const safeHeight = Math.max(2, height);
  const scale = Math.min(1, WEB_CODECS_MAX_WIDTH / safeWidth);
  return {
    width: even(Math.round(safeWidth * scale)),
    height: even(Math.round(safeHeight * scale)),
  };
}

function makeEncoderConfig(codec: string, target: { width: number; height: number }): VideoEncoderConfig {
  return {
    codec,
    width: target.width,
    height: target.height,
    bitrate: WEB_CODECS_PROBE_BITRATE,
    bitrateMode: 'variable',
    framerate: WEB_CODECS_PROBE_FRAME_RATE,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
    alpha: 'discard',
  };
}

async function probeVideoDecoder(config: VideoDecoderConfig): Promise<WebCodecsCodecProbe> {
  try {
    const support = await VideoDecoder.isConfigSupported({
      ...config,
      hardwareAcceleration: 'prefer-hardware',
    });
    return { supported: support.supported === true, configSupported: support.supported === true };
  } catch (error) {
    return { supported: false, configSupported: false, error: errorMessage(error) };
  }
}

async function probeVideoEncoder(config: VideoEncoderConfig): Promise<WebCodecsCodecProbe> {
  try {
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) {
      return { supported: false, configSupported: false };
    }

    const encodeFlushSupported = await tryEncodeOneFrame(config);
    return {
      supported: encodeFlushSupported,
      configSupported: true,
      encodeFlushSupported,
    };
  } catch (error) {
    return { supported: false, configSupported: false, error: errorMessage(error) };
  }
}

async function tryEncodeOneFrame(config: VideoEncoderConfig): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      resolve(supported);
    };

    const timeout = setTimeout(() => finish(false), 3_000);
    let frame: VideoFrame | null = null;
    let encoder: VideoEncoder | null = null;

    try {
      encoder = new VideoEncoder({
        output: () => {},
        error: () => {
          clearTimeout(timeout);
          frame?.close();
          encoder?.close();
          finish(false);
        },
      });
      encoder.configure(config);
      frame = new VideoFrame(new Uint8Array(config.width * config.height * 4), {
        format: 'RGBA',
        codedWidth: config.width,
        codedHeight: config.height,
        timestamp: 0,
      });
      encoder.encode(frame, { keyFrame: true });
      frame.close();
      frame = null;
      encoder.flush()
        .then(() => {
          clearTimeout(timeout);
          encoder?.close();
          finish(true);
        })
        .catch(() => {
          clearTimeout(timeout);
          encoder?.close();
          finish(false);
        });
    } catch {
      clearTimeout(timeout);
      frame?.close();
      encoder?.close();
      finish(false);
    }
  });
}

function formatProbe(probe: WebCodecsCodecProbe): string {
  if (probe.supported) return 'yes';
  if (probe.error) return `no(${probe.error})`;
  if (probe.configSupported && probe.encodeFlushSupported === false) return 'no(flush-failed)';
  return 'no';
}

function even(value: number): number {
  const rounded = Math.max(2, value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
