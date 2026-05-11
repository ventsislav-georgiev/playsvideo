import Hls from 'hls.js/light';
import { isVideoTranscodeInputSupported } from './pipeline/video-transcode.js';
import { createBrowserProber, getAvailableMediaSource, type MediaSourceLike } from './pipeline/codec-probe.js';
import { getAv1Fallback, getAv1UnsupportedMessage, getAv1MalformedMessage } from './av1-capability.js';

export type PlaybackMode = 'hls' | 'direct-url' | 'direct-bytes';

export interface HlsPlaybackOption {
  mode: 'hls';
  id?: string;
}

export interface DirectPlaybackOption {
  mode: 'direct-url' | 'direct-bytes';
  id?: string;
  url?: string;
  mimeType: string | null;
}

export type PlaybackOption = HlsPlaybackOption | DirectPlaybackOption;

export interface PlaybackMediaMetadata {
  /**
   * Container-level short codec names from demux (e.g. `avc`, `ac3`).
   * These are the inputs used by the remux/HLS pipeline heuristics.
   */
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;

  /**
   * Full decoder config codec strings (e.g. `avc1.640028`, `mp4a.40.2`).
   * These are the inputs used for direct/native `canPlayType()` checks.
   */
  videoCodec: string | null;
  audioCodec: string | null;

  /** Whether demux supplied decoder metadata required for fMP4 audio passthrough. */
  hasAudioDecoderConfig?: boolean;

  /** Whether the source contains an audio track, even if its codec metadata is incomplete. */
  hasAudioTrack?: boolean;

  /** Whether the source video codec is AV1. */
  isAv1Video?: boolean;

  /** AV1 metadata validation result (if applicable). */
  av1MetadataValid?: boolean | null;
}

export type CanPlayTypeResult = '' | 'maybe' | 'probably';

export interface PipelinePlaybackProbe {
  canPlayAudio(shortCodec: string, fullCodecString?: string): boolean;
  canPlayVideo(shortCodec: string, fullCodecString?: string): boolean;
}

export interface PlaybackCapabilityContext {
  canPlayType?: (mimeType: string) => CanPlayTypeResult;
  hlsSupported?: boolean;
  pipelineProbe?: PipelinePlaybackProbe;

  /** AV1 support detection result (cached). */
  av1Supported?: 'supported' | 'unsupported' | 'unknown' | null;

  /** Hardware HEVC decode capability via WebCodecs (cached). */
  hevcHardwareDecode?: 'supported' | 'unsupported' | 'unknown' | null;
}

export interface BrowserPlaybackCapabilityOptions {
  hlsSupported?: boolean;
  pipelineProbe?: PipelinePlaybackProbe;
  mediaSource?: MediaSourceLike | null;

  /** Pre-detected AV1 support status. */
  av1Supported?: 'supported' | 'unsupported' | 'unknown' | null;

  /** Pre-detected hardware HEVC decode status. */
  hevcHardwareDecode?: 'supported' | 'unsupported' | 'unknown' | null;
}

export type PlaybackDiagnosticCode =
  | 'direct-missing-capability'
  | 'direct-missing-mime-type'
  | 'direct-missing-video-codec'
  | 'direct-supported'
  | 'direct-unsupported'
  | 'hls-missing-capability'
  | 'hls-runtime-unsupported'
  | 'hls-missing-video-codec'
  | 'hls-video-supported'
  | 'hls-video-transcode'
  | 'hls-video-unsupported'
  | 'hls-audio-supported'
  | 'hls-audio-missing-decoder-config'
  | 'hls-audio-transcode'
  | 'hls-no-audio-track'
  | 'hls-av1-unsupported'
  | 'hls-av1-malformed'
  | 'hls-av1-fallback'
  | 'selected-direct'
  | 'selected-hls'
  | 'no-supported-option';

export interface PlaybackDiagnostic {
  code: PlaybackDiagnosticCode;
  message: string;
}

export type PlaybackOptionStatus = 'supported' | 'blocked' | 'unknown';

export interface PlaybackOptionEvaluation {
  option: PlaybackOption;
  status: PlaybackOptionStatus;
  selected: boolean;
  diagnostics: PlaybackDiagnostic[];
  directCanPlayType: CanPlayTypeResult | null;
  pipelineVideoSupported: boolean | null;
  pipelineVideoRequiresTranscode: boolean | null;
  pipelineAudioSupported: boolean | null;
  pipelineAudioRequiresTranscode: boolean | null;

  /** AV1 support status for this option (if applicable). */
  av1Supported?: boolean | null;

  /** Whether AV1 fallback was triggered. */
  av1FallbackTriggered?: boolean;
}

export interface PlaybackRecommendation {
  option: PlaybackOption;
  reason: PlaybackDiagnostic;
}

export interface EvaluatePlaybackOptionsInput {
  options: PlaybackOption[];
  media: PlaybackMediaMetadata;
  capabilities: PlaybackCapabilityContext;
  preferenceOrder?: PlaybackMode[];
}

export interface PlaybackEvaluationResult {
  recommended: PlaybackRecommendation | null;
  evaluations: PlaybackOptionEvaluation[];
}

const DEFAULT_PREFERENCE_ORDER: PlaybackMode[] = ['direct-url', 'direct-bytes', 'hls'];
const HEVC_PREFERENCE_ORDER: PlaybackMode[] = ['hls', 'direct-url', 'direct-bytes'];

function isHevcCodec(codec: string | null | undefined): boolean {
  if (!codec) return false;
  return /\b(hev1|hvc1|hevc|h\.?265)\b/i.test(codec);
}

function derivePreferenceOrder(
  media: PlaybackMediaMetadata,
  capabilities: PlaybackCapabilityContext,
): PlaybackMode[] {
  if (isHevcCodec(media.videoCodec)) {
    // Direct/native HEVC decode is smooth when the browser has hardware HEVC
    // support (e.g. macOS/iOS Safari). When hardware decode is unavailable or
    // unknown, prefer the remux/HLS path so segments at least bypass the
    // open-GOP keyframe@0 trap; pure software HEVC decode in Chromium may
    // still drop frames on heavy encodes regardless of the source path.
    if (capabilities.hevcHardwareDecode === 'supported') return DEFAULT_PREFERENCE_ORDER;
    return HEVC_PREFERENCE_ORDER;
  }
  return DEFAULT_PREFERENCE_ORDER;
}

/**
 * Convenience helper for browser integrations.
 *
 * The returned object is plain data/functions, so `evaluatePlaybackOptions()`
 * stays pure and testable. The heuristics mirror the current engine split:
 * direct/native uses `canPlayType()`, while remux/HLS uses the pipeline codec
 * probe built on `MediaSource.isTypeSupported()`.
 */
export function createBrowserPlaybackCapabilities(
  video: Pick<HTMLVideoElement, 'canPlayType'>,
  options: BrowserPlaybackCapabilityOptions = {},
): PlaybackCapabilityContext {
  const hlsMediaSource = typeof Hls.getMediaSource === 'function' ? Hls.getMediaSource() : undefined;
  const mediaSource = options.mediaSource ?? hlsMediaSource ?? getAvailableMediaSource();
  return {
    canPlayType: (mimeType) => normalizeCanPlayType(video.canPlayType(mimeType)),
    hlsSupported: options.hlsSupported ?? Hls.isSupported(),
    pipelineProbe: options.pipelineProbe ?? createBrowserProber(mediaSource ?? null),
    av1Supported: options.av1Supported ?? null,
    hevcHardwareDecode: options.hevcHardwareDecode ?? null,
  };
}

export function evaluatePlaybackOptions(
  input: EvaluatePlaybackOptionsInput,
): PlaybackEvaluationResult {
  const preferenceOrder =
    input.preferenceOrder ?? derivePreferenceOrder(input.media, input.capabilities);
  const evaluations = input.options.map((option) =>
    evaluateOption(option, input.media, input.capabilities),
  );

  const recommendedIndex = pickRecommendedIndex(evaluations, preferenceOrder);
  let recommended: PlaybackRecommendation | null = null;

  if (recommendedIndex !== null) {
    const evaluation = evaluations[recommendedIndex];
    evaluation.selected = true;
    const hevcRouted = evaluation.option.mode === 'hls' && isHevcCodec(input.media.videoCodec);
    recommended = {
      option: evaluation.option,
      reason:
        evaluation.option.mode === 'hls'
          ? {
              code: 'selected-hls',
              message: hevcRouted
                ? 'Recommended HLS playback because HEVC sources are routed through remux to avoid native decode flicker.'
                : 'Recommended HLS playback because no higher-preference direct option was supported.',
            }
          : {
              code: 'selected-direct',
              message:
                'Recommended direct playback because the browser natively accepts the source container and codecs.',
            },
    };
    evaluation.diagnostics.push(recommended.reason);
  }

  return { recommended, evaluations };
}

export function recommendPlaybackOption(
  input: EvaluatePlaybackOptionsInput,
): PlaybackRecommendation | null {
  return evaluatePlaybackOptions(input).recommended;
}

function evaluateOption(
  option: PlaybackOption,
  media: PlaybackMediaMetadata,
  capabilities: PlaybackCapabilityContext,
): PlaybackOptionEvaluation {
  return option.mode === 'hls'
    ? evaluateHlsOption(option, media, capabilities)
    : evaluateDirectOption(option, media, capabilities);
}

function evaluateDirectOption(
  option: DirectPlaybackOption,
  media: PlaybackMediaMetadata,
  capabilities: PlaybackCapabilityContext,
): PlaybackOptionEvaluation {
  const diagnostics: PlaybackDiagnostic[] = [];

  if (!capabilities.canPlayType) {
    diagnostics.push({
      code: 'direct-missing-capability',
      message: 'Direct playback evaluation requires a `canPlayType()` capability.',
    });
    return makeEvaluation(option, 'unknown', diagnostics);
  }

  if (!option.mimeType) {
    diagnostics.push({
      code: 'direct-missing-mime-type',
      message: 'Direct playback evaluation requires the source MIME type.',
    });
    return makeEvaluation(option, 'unknown', diagnostics);
  }

  if (!media.videoCodec) {
    diagnostics.push({
      code: 'direct-missing-video-codec',
      message: 'Direct playback evaluation requires the parsed video codec string.',
    });
    return makeEvaluation(option, 'unknown', diagnostics);
  }

  const codecList = media.audioCodec
    ? `${media.videoCodec}, ${media.audioCodec}`
    : media.videoCodec;
  const fullMime = `${option.mimeType}; codecs="${codecList}"`;
  const result = normalizeCanPlayType(capabilities.canPlayType(fullMime));

  if (result === 'maybe' || result === 'probably') {
    diagnostics.push({
      code: 'direct-supported',
      message: `Direct playback is supported: canPlayType("${fullMime}") returned "${result}".`,
    });
    return makeEvaluation(option, 'supported', diagnostics, { directCanPlayType: result });
  }

  diagnostics.push({
    code: 'direct-unsupported',
    message: `Direct playback is unsupported: canPlayType("${fullMime}") returned "${result}".`,
  });
  return makeEvaluation(option, 'blocked', diagnostics, { directCanPlayType: result });
}


/**
 * Evaluates AV1 codec support and metadata validity.
 * Returns diagnostics and fallback decision if AV1 is unsupported or malformed.
 */
function evaluateAv1Codec(
  media: PlaybackMediaMetadata,
  capabilities: PlaybackCapabilityContext,
): {
  av1Supported: boolean | null;
  av1FallbackTriggered: boolean;
  diagnostics: PlaybackDiagnostic[];
} {
  const diagnostics: PlaybackDiagnostic[] = [];
  let av1Supported: boolean | null = null;
  let av1FallbackTriggered = false;

  // Only evaluate if source is AV1
  if (!media.isAv1Video) {
    return { av1Supported: null, av1FallbackTriggered: false, diagnostics };
  }

  // Check AV1 device support
  if (capabilities.av1Supported === 'unsupported') {
    av1Supported = false;
    av1FallbackTriggered = true;
    diagnostics.push({
      code: 'hls-av1-unsupported',
      message: getAv1UnsupportedMessage(),
    });
    return { av1Supported, av1FallbackTriggered, diagnostics };
  }

  // Check AV1 metadata validity (if validation was performed)
  if (media.av1MetadataValid === false) {
    av1Supported = false;
    av1FallbackTriggered = true;
    diagnostics.push({
      code: 'hls-av1-malformed',
      message: getAv1MalformedMessage(),
    });
    return { av1Supported, av1FallbackTriggered, diagnostics };
  }

  // AV1 is supported or unknown (assume supported for now)
  if (capabilities.av1Supported === 'supported') {
    av1Supported = true;
  }

  return { av1Supported, av1FallbackTriggered, diagnostics };
}

function evaluateHlsOption(
  option: HlsPlaybackOption,
  media: PlaybackMediaMetadata,
  capabilities: PlaybackCapabilityContext,
): PlaybackOptionEvaluation {
  const diagnostics: PlaybackDiagnostic[] = [];

  if (capabilities.hlsSupported === undefined || !capabilities.pipelineProbe) {
    diagnostics.push({
      code: 'hls-missing-capability',
      message: 'HLS evaluation requires both `hlsSupported` and a pipeline codec probe.',
    });
    return makeEvaluation(option, 'unknown', diagnostics);
  }

  if (!capabilities.hlsSupported) {
    diagnostics.push({
      code: 'hls-runtime-unsupported',
      message: 'HLS playback is unavailable in this browser/runtime.',
    });
    return makeEvaluation(option, 'blocked', diagnostics);
  }

  if (!media.sourceVideoCodec) {
    diagnostics.push({
      code: 'hls-missing-video-codec',
      message: 'HLS evaluation requires the parsed source video codec.',
    });
    return makeEvaluation(option, 'unknown', diagnostics);
  }

  // Evaluate AV1 codec support and metadata validity
  const av1Evaluation = evaluateAv1Codec(media, capabilities);
  diagnostics.push(...av1Evaluation.diagnostics);

  // If AV1 is unsupported or malformed, trigger fallback to alternative codec
  if (av1Evaluation.av1FallbackTriggered) {
    const fallbackCodec = getAv1Fallback();
    diagnostics.push({
      code: 'hls-av1-fallback',
      message: `AV1 fallback triggered. Attempting to play with ${fallbackCodec.toUpperCase()} codec instead.`,
    });
    // Continue evaluation with fallback codec assumption
    // The engine will handle actual codec substitution
  }

  const pipelineVideoSupported = capabilities.pipelineProbe.canPlayVideo(
    media.sourceVideoCodec,
    media.videoCodec ?? undefined,
  );
  const pipelineVideoRequiresTranscode =
    !pipelineVideoSupported && isVideoTranscodeInputSupported(media.sourceVideoCodec);
  if (!pipelineVideoSupported) {
    if (pipelineVideoRequiresTranscode) {
      diagnostics.push({
        code: 'hls-video-transcode',
        message:
          'The remux/HLS path cannot play this source video codec here, so video will be transcoded to H.264.',
      });
    } else {
      diagnostics.push({
        code: 'hls-video-unsupported',
        message: 'The remux/HLS path cannot play the source video codec in this environment.',
      });
      return makeEvaluation(option, 'blocked', diagnostics, {
        pipelineVideoSupported,
        av1Supported: av1Evaluation.av1Supported,
        av1FallbackTriggered: av1Evaluation.av1FallbackTriggered,
      });
    }
  } else {
    diagnostics.push({
      code: 'hls-video-supported',
      message: 'The remux/HLS path can play the source video codec.',
    });
  }

  if (!media.sourceAudioCodec && media.hasAudioTrack === true) {
    diagnostics.push({
      code: 'hls-audio-missing-decoder-config',
      message: 'The source has an audio track, but its codec metadata is unavailable; audio will be transcoded to AAC.',
    });
    return makeEvaluation(option, 'supported', diagnostics, {
      pipelineVideoSupported,
      pipelineVideoRequiresTranscode,
      pipelineAudioSupported: false,
      pipelineAudioRequiresTranscode: true,
      av1Supported: av1Evaluation.av1Supported,
      av1FallbackTriggered: av1Evaluation.av1FallbackTriggered,
    });
  }

  if (!media.sourceAudioCodec) {
    diagnostics.push({
      code: 'hls-no-audio-track',
      message: 'No source audio track was provided; video-only HLS playback is viable.',
    });
    return makeEvaluation(option, 'supported', diagnostics, {
      pipelineVideoSupported,
      pipelineVideoRequiresTranscode,
      pipelineAudioSupported: null,
      pipelineAudioRequiresTranscode: false,
      av1Supported: av1Evaluation.av1Supported,
      av1FallbackTriggered: av1Evaluation.av1FallbackTriggered,
    });
  }

  if (media.hasAudioDecoderConfig === false) {
    diagnostics.push({
      code: 'hls-audio-missing-decoder-config',
      message: 'The remux/HLS path needs audio decoder metadata for passthrough; audio will be transcoded to AAC.',
    });
    return makeEvaluation(option, 'supported', diagnostics, {
      pipelineVideoSupported,
      pipelineVideoRequiresTranscode,
      pipelineAudioSupported: false,
      pipelineAudioRequiresTranscode: true,
      av1Supported: av1Evaluation.av1Supported,
      av1FallbackTriggered: av1Evaluation.av1FallbackTriggered,
    });
  }

  const pipelineAudioSupported = capabilities.pipelineProbe.canPlayAudio(
    media.sourceAudioCodec,
    media.audioCodec ?? undefined,
  );

  if (pipelineAudioSupported) {
    diagnostics.push({
      code: 'hls-audio-supported',
      message: 'The remux/HLS path can keep the source audio codec without transcoding.',
    });
    return makeEvaluation(option, 'supported', diagnostics, {
      pipelineVideoSupported,
      pipelineVideoRequiresTranscode,
      pipelineAudioSupported,
      pipelineAudioRequiresTranscode: false,
      av1Supported: av1Evaluation.av1Supported,
      av1FallbackTriggered: av1Evaluation.av1FallbackTriggered,
    });
  }

  diagnostics.push({
    code: 'hls-audio-transcode',
    message: 'The remux/HLS path remains viable, but audio will be transcoded to AAC.',
  });
  return makeEvaluation(option, 'supported', diagnostics, {
      pipelineVideoSupported,
      pipelineVideoRequiresTranscode,
      pipelineAudioSupported,
      pipelineAudioRequiresTranscode: true,
      av1Supported: av1Evaluation.av1Supported,
      av1FallbackTriggered: av1Evaluation.av1FallbackTriggered,
    });
}

function makeEvaluation(
  option: PlaybackOption,
  status: PlaybackOptionStatus,
  diagnostics: PlaybackDiagnostic[],
  overrides: Partial<
    Omit<PlaybackOptionEvaluation, 'option' | 'status' | 'selected' | 'diagnostics'>
  > = {},
): PlaybackOptionEvaluation {
  return {
    option,
    status,
    selected: false,
    diagnostics,
    directCanPlayType: null,
    pipelineVideoSupported: null,
    pipelineVideoRequiresTranscode: null,
    pipelineAudioSupported: null,
    pipelineAudioRequiresTranscode: null,
    av1Supported: null,
    av1FallbackTriggered: false,
    ...overrides,
  };
}

function pickRecommendedIndex(
  evaluations: PlaybackOptionEvaluation[],
  preferenceOrder: PlaybackMode[],
): number | null {
  const supportedIndexes = evaluations
    .map((evaluation, index) => ({ evaluation, index }))
    .filter(({ evaluation }) => evaluation.status === 'supported');

  if (supportedIndexes.length === 0) {
    return null;
  }

  const modeRank = new Map(preferenceOrder.map((mode, index) => [mode, index]));
  supportedIndexes.sort((a, b) => {
    const aRank = modeRank.get(a.evaluation.option.mode) ?? Number.MAX_SAFE_INTEGER;
    const bRank = modeRank.get(b.evaluation.option.mode) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.index - b.index;
  });

  return supportedIndexes[0].index;
}

function normalizeCanPlayType(value: string): CanPlayTypeResult {
  if (value === 'maybe' || value === 'probably') {
    return value;
  }
  return '';
}
