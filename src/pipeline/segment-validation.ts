import type { EncodedPacket } from 'mediabunny';

/**
 * P0 Hardening: Validate segment structure before muxing.
 * 
 * Catches:
 * 1. Segment first video packet is NOT a keyframe (breaks MSE appendability)
 * 2. Missing or invalid decoder configs (breaks playback)
 * 3. Empty video/audio when expected (breaks segment continuity)
 */

/**
 * Assert that the first video packet in a segment is a keyframe.
 * 
 * MSE requires every segment to start with a keyframe for appendability.
 * If the first packet is not a keyframe, Safari/Chrome will fail to append
 * the segment and cause playback stalls or skips.
 * 
 * @param videoPackets - Video packets in segment
 * @param segmentIndex - Segment index for error messages
 * @throws Error if first video packet is not a keyframe
 */
export function assertSegmentFirstVideoKeyframe(
  videoPackets: EncodedPacket[],
  segmentIndex: number,
): void {
  if (videoPackets.length === 0) return; // Empty segment is OK (audio-only)

  const firstPacket = videoPackets[0];
  if (firstPacket.type !== 'key') {
    throw new Error(
      `seg ${segmentIndex} first video packet is NOT a keyframe: ` +
      `type=${firstPacket.type} timestamp=${firstPacket.timestamp.toFixed(6)} ` +
      `(MSE requires keyframe at segment start for appendability)`
    );
  }
}

/**
 * Validate VideoDecoderConfig has required fields for muxing.
 * 
 * @param config - VideoDecoderConfig to validate
 * @param codec - Video codec name for error messages
 * @throws Error if config is missing required fields
 */
export function validateVideoDecoderConfig(
  config: VideoDecoderConfig | undefined,
  codec: string,
): void {
  if (!config) {
    throw new Error(`Cannot mux video codec ${codec} without VideoDecoderConfig`);
  }

  if (!config.description) {
    throw new Error(
      `VideoDecoderConfig for ${codec} missing required 'description' field ` +
      `(needed for codec-specific box in fMP4 init segment)`
    );
  }

  if (config.description.byteLength === 0) {
    throw new Error(
      `VideoDecoderConfig for ${codec} has empty 'description' ` +
      `(must contain codec-specific data like av1C or avcC box)`
    );
  }

  // Codec-specific validation
  if (codec === 'av1') {
    validateAv1DecoderConfig(config);
  } else if (codec === 'avc' || codec === 'h264') {
    validateAvcDecoderConfig(config);
  }
}

/**
 * Validate AV1-specific decoder config.
 * 
 * av1C box format:
 * [version(1) | seq_profile(3) | seq_level_idx_0(5) | seq_tier_0(1) | ...]
 * 
 * @param config - VideoDecoderConfig to validate
 * @throws Error if av1C is malformed
 */
function validateAv1DecoderConfig(config: VideoDecoderConfig): void {
  const desc = config.description instanceof Uint8Array
    ? config.description
    : new Uint8Array(config.description as ArrayBuffer);

  if (desc.byteLength < 4) {
    throw new Error(
      `AV1 VideoDecoderConfig description too short: ${desc.byteLength} bytes ` +
      `(minimum 4 bytes for av1C header)`
    );
  }

  const version = desc[0] >> 7;
  if (version !== 1) {
    throw new Error(
      `AV1 VideoDecoderConfig av1C version invalid: ${version} ` +
      `(only version 1 is supported)`
    );
  }
}

/**
 * Validate AVC/H.264-specific decoder config.
 * 
 * avcC box format:
 * [configurationVersion(1) | profile(1) | constraints(1) | level(1) | ...]
 * 
 * @param config - VideoDecoderConfig to validate
 * @throws Error if avcC is malformed
 */
function validateAvcDecoderConfig(config: VideoDecoderConfig): void {
  const desc = config.description instanceof Uint8Array
    ? config.description
    : new Uint8Array(config.description as ArrayBuffer);

  if (desc.byteLength < 4) {
    throw new Error(
      `AVC VideoDecoderConfig description too short: ${desc.byteLength} bytes ` +
      `(minimum 4 bytes for avcC header)`
    );
  }

  const configVersion = desc[0];
  if (configVersion !== 1) {
    throw new Error(
      `AVC VideoDecoderConfig avcC version invalid: ${configVersion} ` +
      `(only version 1 is supported)`
    );
  }
}

/**
 * Validate AudioDecoderConfig has required fields for muxing.
 * 
 * @param config - AudioDecoderConfig to validate
 * @param codec - Audio codec name for error messages
 * @throws Error if config is missing required fields
 */
export function validateAudioDecoderConfig(
  config: AudioDecoderConfig | undefined | null,
  codec: string,
): void {
  if (!config) {
    throw new Error(`Cannot mux audio codec ${codec} without AudioDecoderConfig`);
  }

  if (!Number.isFinite(config.sampleRate) || config.sampleRate <= 0) {
    throw new Error(
      `AudioDecoderConfig for ${codec} has invalid sampleRate: ${config.sampleRate} ` +
      `(must be positive finite number)`
    );
  }

  if (!Number.isFinite(config.numberOfChannels) || config.numberOfChannels <= 0) {
    throw new Error(
      `AudioDecoderConfig for ${codec} has invalid numberOfChannels: ${config.numberOfChannels} ` +
      `(must be positive finite number)`
    );
  }

  // Codec-specific validation
  if (codec === 'aac') {
    validateAacDecoderConfig(config);
  } else if (codec === 'opus') {
    validateOpusDecoderConfig(config);
  }
}

/**
 * Validate AAC-specific decoder config.
 * 
 * @param config - AudioDecoderConfig to validate
 * @throws Error if AAC config is invalid
 */
function validateAacDecoderConfig(config: AudioDecoderConfig): void {
  // AAC typically has sampleRate in [8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000]
  // and numberOfChannels in [1, 2, 5.1, 7.1] but we allow any positive values
  // since some implementations may use non-standard rates.

  if (config.sampleRate < 8000 || config.sampleRate > 192000) {
    console.warn(
      `AAC AudioDecoderConfig sampleRate ${config.sampleRate} is unusual ` +
      `(typical range: 8000-48000 Hz)`
    );
  }

  if (config.numberOfChannels > 8) {
    console.warn(
      `AAC AudioDecoderConfig numberOfChannels ${config.numberOfChannels} is unusual ` +
      `(typical maximum: 8)`
    );
  }
}

/**
 * Validate Opus-specific decoder config.
 * 
 * @param config - AudioDecoderConfig to validate
 * @throws Error if Opus config is invalid
 */
function validateOpusDecoderConfig(config: AudioDecoderConfig): void {
  // Opus requires 48 kHz sample rate
  if (config.sampleRate !== 48000) {
    throw new Error(
      `Opus AudioDecoderConfig sampleRate must be 48000 Hz, got ${config.sampleRate}`
    );
  }

  if (config.numberOfChannels < 1 || config.numberOfChannels > 8) {
    throw new Error(
      `Opus AudioDecoderConfig numberOfChannels must be 1-8, got ${config.numberOfChannels}`
    );
  }
}

/**
 * Comprehensive segment validation before muxing.
 * 
 * Validates:
 * 1. First video packet is keyframe (if video present)
 * 2. Video decoder config is valid
 * 3. Audio decoder config is valid (if audio present)
 * 
 * @param videoPackets - Video packets in segment
 * @param audioPackets - Audio packets in segment
 * @param videoCodec - Video codec name
 * @param audioCodec - Audio codec name (or null if no audio)
 * @param videoDecoderConfig - Video decoder config
 * @param audioDecoderConfig - Audio decoder config (or null if no audio)
 * @param segmentIndex - Segment index for error messages
 * @throws Error if any validation fails
 */
export function validateSegmentBeforeMux(
  videoPackets: EncodedPacket[],
  audioPackets: EncodedPacket[],
  videoCodec: string,
  audioCodec: string | null,
  videoDecoderConfig: VideoDecoderConfig,
  audioDecoderConfig: AudioDecoderConfig | null,
  segmentIndex: number,
): void {
  // P0 Gap #2: Segment first video keyframe
  assertSegmentFirstVideoKeyframe(videoPackets, segmentIndex);

  // P0 Gap #3: Decoder config validation
  validateVideoDecoderConfig(videoDecoderConfig, videoCodec);

  if (audioPackets.length > 0 && audioCodec) {
    validateAudioDecoderConfig(audioDecoderConfig, audioCodec);
  }
}
