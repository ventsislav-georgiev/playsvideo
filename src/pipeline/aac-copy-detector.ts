/**
 * AAC Stream Copy Detection & Validation
 *
 * Detects AAC packet formats (ADTS, MPEG-4 ASC, LATM, raw) and validates
 * whether AAC can be safely stream-copied (without transcode) into target
 * containers (MP4, fMP4, HLS).
 *
 * Key insight: ADTS AAC from TS/MPEG sources requires ADTS→ASC conversion
 * via `-bsf:a aac_adtstoasc` when remuxing into MP4-family containers.
 * This module detects the packet format and provides the ASC bytes needed
 * for the init segment.
 */

/**
 * AAC profile identifiers (from ADTS/ASC headers).
 * Profile is encoded as 2 bits: 0=LC, 1=HE (SBR), 2=HE-v2 (PS), 3=LD/ELD.
 */
export type AacProfile = 'lc' | 'he' | 'he-v2' | 'ld' | 'eld';

/**
 * AAC packet format classification.
 * Determines how to extract/validate AudioSpecificConfig and whether
 * bitstream filters are needed for remuxing.
 */
export interface AacPacketFormat {
  /** Packet format type */
  type: 'adts' | 'mpeg4-asc' | 'latm' | 'raw';
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels */
  channels: number;
  /** AAC profile (LC, HE, HE-v2, LD, ELD) */
  profile: AacProfile;
  /** Frame length in samples (usually 1024 for AAC-LC) */
  frameLengthSamples?: number;
}

/**
 * ADTS frame header structure (first 7 bytes).
 * Used to extract sample rate, channels, and profile from ADTS packets.
 */
interface AdtsHeader {
  profile: AacProfile;
  sampleRateIndex: number;
  sampleRate: number;
  channels: number;
  frameLength: number;
  protectionAbsent: boolean;
}

/**
 * Sample rate table indexed by ADTS sample rate index (4 bits).
 * Index 13 (7350 Hz) is rarely used; indices 14-15 are reserved.
 */
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * AAC profile names indexed by profile bits (2 bits).
 * 0=LC, 1=HE (SBR), 2=HE-v2 (PS), 3=LD/ELD.
 */
const AAC_PROFILES: AacProfile[] = ['lc', 'he', 'he-v2', 'ld'];

/**
 * Detect if a packet starts with an ADTS sync word (0xFFF).
 * ADTS frame: [Sync (12 bits: 0xFFF)] [MPEG Version (1 bit)] [Layer (2 bits)] ...
 *
 * @param packet - Audio packet bytes
 * @returns true if packet starts with ADTS sync word
 */
export function isAdtsPacket(packet: Uint8Array): boolean {
  if (!packet || packet.byteLength < 2) return false;
  // Sync word is 12 bits: 0xFFF (all 1s)
  // Stored in first 2 bytes: [0xFF] [0xF?]
  return packet[0] === 0xff && (packet[1] & 0xf0) === 0xf0;
}

/**
 * Parse ADTS frame header (first 7 bytes).
 * Extracts profile, sample rate, channels, and frame length.
 *
 * ADTS header layout (56 bits / 7 bytes):
 * Byte 0: [Sync (8 bits: 0xFF)]
 * Byte 1: [Sync (4 bits: 0xF)] [MPEG Version (1 bit)] [Layer (2 bits)] [Protection Absent (1 bit)]
 * Byte 2: [Profile (2 bits)] [Sample Rate Index (4 bits)] [Private Bit (1 bit)] [Channels (3 bits, high 1 bit)]
 * Byte 3: [Channels (2 bits, low 2 bits)] [Original (1 bit)] [Home (1 bit)] [Emphasis (2 bits)] [Frame Length (5 bits, high 5 bits)]
 * Byte 4: [Frame Length (8 bits, middle 8 bits)]
 * Byte 5: [Frame Length (3 bits, low 3 bits)] [Buffer Fullness (11 bits, high 5 bits)]
 * Byte 6: [Buffer Fullness (6 bits, low 6 bits)] [RBUs (2 bits)]
 *
 * @param packet - Audio packet with ADTS header
 * @returns Parsed ADTS header or null if invalid
 */
export function parseAdtsHeader(packet: Uint8Array): AdtsHeader | null {
  if (!isAdtsPacket(packet) || packet.byteLength < 7) {
    return null;
  }

  // Byte 1: [Sync (4)] [MPEG Version (1)] [Layer (2)] [Protection Absent (1)]
  const protectionAbsent = (packet[1] & 0x01) === 0x01;

  // Byte 2: [Profile (2)] [Sample Rate Index (4)] [Private (1)] [Channels (3, high 1)]
  const profile = (packet[2] >> 6) & 0x03;
  const sampleRateIndex = (packet[2] >> 2) & 0x0f;
  const channelsHigh = packet[2] & 0x01;

  // Byte 3: [Channels (2, low 2)] [Original (1)] [Home (1)] [Emphasis (2)] [Frame Length (5, high 5)]
  const channelsLow = (packet[3] >> 6) & 0x03;
  const channels = ((channelsHigh << 2) | channelsLow) + 1; // +1 because 0=mono, 1=stereo, etc.

  // Frame length: 13 bits across bytes 3-5
  const frameLengthHigh = packet[3] & 0x03;
  const frameLengthMid = packet[4];
  const frameLengthLow = (packet[5] >> 5) & 0x07;
  const frameLength = ((frameLengthHigh << 11) | (frameLengthMid << 3) | frameLengthLow) + 1; // +1 per spec

  const sampleRate = ADTS_SAMPLE_RATES[sampleRateIndex];
  if (!sampleRate) {
    return null; // Invalid sample rate index
  }

  return {
    profile: AAC_PROFILES[profile] ?? 'lc',
    sampleRateIndex,
    sampleRate,
    channels,
    frameLength,
    protectionAbsent,
  };
}

/**
 * Detect AAC packet format from packet bytes.
 * Classifies as ADTS, MPEG-4 ASC, LATM, or raw based on packet structure.
 *
 * @param packet - Audio packet bytes
 * @returns Detected packet format or null if not AAC
 */
export function detectAacPacketFormat(packet: Uint8Array): AacPacketFormat | null {
  if (!packet || packet.byteLength === 0) {
    return null;
  }

  // Try ADTS first (most common in TS/MPEG sources)
  if (isAdtsPacket(packet)) {
    const header = parseAdtsHeader(packet);
    if (header) {
      return {
        type: 'adts',
        sampleRate: header.sampleRate,
        channels: header.channels,
        profile: header.profile,
        frameLengthSamples: 1024, // AAC-LC always uses 1024 samples per frame
      };
    }
  }

  // LATM detection: starts with 0x56 or 0x57 (sync word for LATM)
  // LATM is less common in browser contexts; skip for now
  // if (packet[0] === 0x56 || packet[0] === 0x57) { ... }

  // Raw AAC (MPEG-4 ASC) detection: no sync word, just raw audio data
  // This is harder to detect reliably without decoderConfig context.
  // For now, assume raw if not ADTS and decoderConfig is available.

  return null;
}

/**
 * Extract AudioSpecificConfig (ASC) from AudioDecoderConfig.
 * ASC is the MPEG-4 audio configuration stored in the init segment.
 *
 * AudioDecoderConfig.description contains the ASC bytes (usually 2-4 bytes for AAC-LC).
 * ASC structure (variable length):
 * - Audio Object Type (5 bits): 2=AAC-LC, 5=SBR (HE-AAC), 29=PS (HE-AAC v2)
 * - Sample Rate Index (4 bits): 0-12 (see ADTS_SAMPLE_RATES)
 * - Channels (4 bits): 0-7 (0=implicit, 1=mono, 2=stereo, etc.)
 * - Frame Length Flag (1 bit): 0=1024 samples, 1=960 samples
 * - Depends On Core Coder (1 bit)
 * - Extension Audio Object Type (1 bit)
 * - [Optional extension fields...]
 *
 * @param decoderConfig - AudioDecoderConfig from demux
 * @returns ASC bytes or null if not available/invalid
 */
export function extractAudioSpecificConfig(decoderConfig: AudioDecoderConfig | null): Uint8Array | null {
  if (!decoderConfig || !decoderConfig.description) {
    return null;
  }

  // Convert description to Uint8Array (handles ArrayBuffer, SharedArrayBuffer, etc.)
  let asc: Uint8Array;
  if (decoderConfig.description instanceof ArrayBuffer) {
    asc = new Uint8Array(decoderConfig.description);
  } else if (ArrayBuffer.isView(decoderConfig.description)) {
    asc = new Uint8Array(
      decoderConfig.description.buffer,
      decoderConfig.description.byteOffset,
      decoderConfig.description.byteLength,
    );
  } else {
    return null;
  }

  // ASC is typically 2-4 bytes for AAC-LC
  if (asc.byteLength < 2) {
    return null;
  }

  return asc;
}

/**
 * Generate AudioSpecificConfig (ASC) from ADTS header.
 * Used when converting ADTS packets to MPEG-4 ASC format.
 *
 * ASC encoding (first 2 bytes for AAC-LC):
 * Byte 0: [Audio Object Type (5 bits)] [Sample Rate Index (3 bits, high)]
 * Byte 1: [Sample Rate Index (1 bit, low)] [Channels (4 bits)] [Frame Length (1 bit)] [Depends On Core (1 bit)] [Extension (1 bit)]
 *
 * @param header - Parsed ADTS header
 * @returns Generated ASC bytes (2 bytes for AAC-LC)
 */
export function generateAudioSpecificConfig(header: AdtsHeader): Uint8Array {
  // Audio Object Type: 2 = AAC-LC (most common)
  const audioObjectType = 2;

  // Byte 0: [Audio Object Type (5 bits)] [Sample Rate Index (3 bits, high)]
  const byte0 = ((audioObjectType << 3) | (header.sampleRateIndex >> 1)) & 0xff;

  // Byte 1: [Sample Rate Index (1 bit, low)] [Channels (4 bits)] [Frame Length (1 bit)] [Depends On Core (1 bit)] [Extension (1 bit)]
  const sampleRateIndexLow = (header.sampleRateIndex & 0x01) << 7;
  const channelConfig = (header.channels & 0x0f) << 3;
  const frameLengthFlag = 0; // 0 = 1024 samples (standard)
  const dependsOnCoreCoder = 0;
  const extensionAudioObjectType = 0;
  const byte1 =
    sampleRateIndexLow | channelConfig | (frameLengthFlag << 2) | (dependsOnCoreCoder << 1) | extensionAudioObjectType;

  return new Uint8Array([byte0, byte1]);
}

/**
 * Determine if AAC can be safely stream-copied into a target container.
 * AAC is compatible with MP4, fMP4, and HLS containers.
 *
 * @param format - Detected AAC packet format
 * @param container - Target container type
 * @returns true if copy is safe
 */
export function canCopyAacToContainer(
  format: AacPacketFormat,
  container: 'mp4' | 'fmp4' | 'hls',
): boolean {
  // AAC is compatible with all MP4-family containers
  // The only caveat: ADTS packets need ADTS→ASC conversion (handled by BSF)
  return container === 'mp4' || container === 'fmp4' || container === 'hls';
}

/**
 * Determine if ADTS→ASC conversion (via BSF) is needed.
 * Required when copying ADTS AAC into MP4-family containers.
 *
 * @param format - Detected AAC packet format
 * @param container - Target container type
 * @returns true if BSF is needed
 */
export function needsAdtsToAscBsf(format: AacPacketFormat, container: 'mp4' | 'fmp4' | 'hls'): boolean {
  // ADTS packets need conversion when remuxing into MP4-family containers
  return format.type === 'adts' && (container === 'mp4' || container === 'fmp4' || container === 'hls');
}

/**
 * Validate that a packet is valid AAC based on detected format.
 * Performs basic sanity checks (sync word, frame length, etc.).
 *
 * @param packet - Audio packet bytes
 * @param format - Detected packet format
 * @returns true if packet appears valid
 */
export function validateAacPacket(packet: Uint8Array, format: AacPacketFormat): boolean {
  if (!packet || packet.byteLength === 0) {
    return false;
  }

  switch (format.type) {
    case 'adts': {
      // Validate ADTS sync word and frame length
      if (!isAdtsPacket(packet)) {
        return false;
      }
      const header = parseAdtsHeader(packet);
      if (!header) {
        return false;
      }
      // Frame length should be reasonable (typically 1024-2048 bytes)
      if (header.frameLength < 100 || header.frameLength > 8192) {
        return false;
      }
      return true;
    }

    case 'mpeg4-asc':
    case 'raw':
      // Raw AAC frames are harder to validate without full decode
      // Just check that packet is not empty
      return packet.byteLength > 0;

    case 'latm':
      // LATM validation would require parsing LATM header
      // Skip for now
      return packet.byteLength > 0;

    default:
      return false;
  }
}

/**
 * Summary of AAC copy decision for logging/metrics.
 */
export interface AacCopyDecision {
  canCopy: boolean;
  reason: string;
  format?: AacPacketFormat;
  needsBsf?: boolean;
  asc?: Uint8Array;
}

/**
 * Make a complete AAC copy decision based on packet and container.
 * Returns detailed reasoning for logging and metrics.
 *
 * @param packet - First audio packet from segment
 * @param decoderConfig - AudioDecoderConfig from demux
 * @param container - Target container type
 * @returns Copy decision with reasoning
 */
export function makeAacCopyDecision(
  packet: Uint8Array | null,
  decoderConfig: AudioDecoderConfig | null,
  container: 'mp4' | 'fmp4' | 'hls',
): AacCopyDecision {
  if (!packet || packet.byteLength === 0) {
    return {
      canCopy: false,
      reason: 'No audio packet available',
    };
  }

  const format = detectAacPacketFormat(packet);
  if (!format) {
    return {
      canCopy: false,
      reason: 'Not AAC or unsupported AAC format',
    };
  }

  if (!canCopyAacToContainer(format, container)) {
    return {
      canCopy: false,
      reason: `AAC not compatible with ${container} container`,
      format,
    };
  }

  if (!validateAacPacket(packet, format)) {
    return {
      canCopy: false,
      reason: 'AAC packet validation failed',
      format,
    };
  }

  const needsBsf = needsAdtsToAscBsf(format, container);
  let asc: Uint8Array | undefined;

  if (needsBsf) {
    // For ADTS, generate ASC from header
    const header = parseAdtsHeader(packet);
    if (header) {
      asc = generateAudioSpecificConfig(header);
    }
  } else {
    // For raw/MPEG-4 ASC, extract from decoderConfig
    const extracted = extractAudioSpecificConfig(decoderConfig);
    if (extracted) {
      asc = extracted;
    }
  }

  return {
    canCopy: true,
    reason: 'AAC copy is safe',
    format,
    needsBsf,
    asc,
  };
}
