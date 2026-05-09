/**
 * AAC esds Box Validator
 *
 * Validates that JS-muxed fMP4 init segments contain correct AAC esds boxes
 * with valid DecoderSpecificInfo (AudioSpecificConfig).
 *
 * Parses esds box structure:
 * - esds (tag 0x00, size 4 bytes)
 *   - version/flags (4 bytes)
 *   - ES_Descriptor (tag 0x03)
 *     - ES_ID (2 bytes)
 *     - streamDependenceFlag, URL_Flag, OCRstreamFlag (1 byte flags)
 *     - DecoderConfigDescriptor (tag 0x04)
 *       - objectTypeIndication (1 byte)
 *       - streamType (1 byte, upper 6 bits)
 *       - bufferSizeDB (3 bytes)
 *       - maxBitrate (4 bytes)
 *       - avgBitrate (4 bytes)
 *       - DecoderSpecificInfo (tag 0x05) ← AudioSpecificConfig
 *         - size (variable length)
 *         - ASC bytes (2+ bytes)
 */

/**
 * Parsed AAC esds box information
 */
export interface AacEsdsInfo {
  found: boolean;
  objectTypeIndication?: number;
  sampleRate?: number;
  channels?: number;
  ascSize?: number;
  ascBytes?: Uint8Array;
  decoderSpecificInfoFound?: boolean;
  errors: string[];
}

/**
 * Parse variable-length size field (MPEG-4 descriptor format)
 * Each byte: bit 7 = continuation flag, bits 6-0 = value
 */
function parseVariableLengthSize(data: Uint8Array, offset: number): { size: number; bytesRead: number } {
  let size = 0;
  let bytesRead = 0;
  for (let i = 0; i < 4 && offset + i < data.length; i++) {
    const byte = data[offset + i];
    bytesRead++;
    size = (size << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { size, bytesRead };
}

/**
 * Parse AudioSpecificConfig (ASC) to extract sample rate and channels
 *
 * ASC structure (ISO/IEC 14496-3):
 * - audioObjectType (5 bits)
 * - samplingFrequencyIndex (4 bits)
 * - channelConfiguration (4 bits)
 * - ... (additional fields for specific object types)
 */
function parseAudioSpecificConfig(asc: Uint8Array): { sampleRate?: number; channels?: number; errors: string[] } {
  const errors: string[] = [];
  if (asc.length < 2) {
    errors.push(`ASC too short: ${asc.length} bytes (need >= 2)`);
    return { errors };
  }

  const byte0 = asc[0];
  const byte1 = asc[1];

  // audioObjectType (5 bits)
  const audioObjectType = (byte0 >> 3) & 0x1f;
  if (audioObjectType === 0 || audioObjectType > 4) {
    errors.push(`Invalid audioObjectType: ${audioObjectType} (expected 1-4 for AAC)`);
  }

  // samplingFrequencyIndex (4 bits)
  const samplingFrequencyIndex = ((byte0 & 0x07) << 1) | ((byte1 >> 7) & 0x01);
  const sampleRateTable = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350, 0, 0, 0, // 0xF = escape sequence
  ];
  const sampleRate = sampleRateTable[samplingFrequencyIndex];
  if (sampleRate === 0) {
    errors.push(`Invalid samplingFrequencyIndex: ${samplingFrequencyIndex}`);
  }

  // channelConfiguration (4 bits)
  const channelConfiguration = (byte1 >> 3) & 0x0f;
  const channelTable = [0, 1, 2, 3, 4, 5, 6, 8, 0, 0, 0, 0, 0, 0, 0, 0];
  const channels = channelTable[channelConfiguration];
  if (channels === 0) {
    errors.push(`Invalid channelConfiguration: ${channelConfiguration}`);
  }

  return { sampleRate, channels, errors };
}

/**
 * Find and parse esds box in init segment
 *
 * fMP4 init segment structure:
 * - ftyp box
 * - moov box
 *   - mvhd box
 *   - trak box (video)
 *   - trak box (audio)
 *     - tkhd box
 *     - edts box (optional)
 *     - mdia box
 *       - mdhd box
 *       - hdlr box
 *       - minf box
 *         - smhd box
 *         - dinf box
 *         - stbl box
 *           - stsd box ← contains esds
 *             - AudioSampleEntry
 *               - esds box ← HERE
 */
function findEsdsBox(initSegment: Uint8Array): { offset: number; size: number } | null {
  // Simple box parser: look for 'esds' box tag
  const esdsTag = new Uint8Array([0x65, 0x73, 0x64, 0x73]); // 'esds'
  for (let i = 0; i < initSegment.length - 8; i++) {
    let match = true;
    for (let j = 0; j < 4; j++) {
      if (initSegment[i + 4 + j] !== esdsTag[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Found 'esds' tag; read size from previous 4 bytes
      const size =
        (initSegment[i] << 24) |
        (initSegment[i + 1] << 16) |
        (initSegment[i + 2] << 8) |
        initSegment[i + 3];
      return { offset: i, size };
    }
  }
  return null;
}

/**
 * Parse esds box and extract DecoderSpecificInfo (AudioSpecificConfig)
 */
function parseEsdsBox(initSegment: Uint8Array, esdsOffset: number, esdsSize: number): AacEsdsInfo {
  const info: AacEsdsInfo = {
    found: true,
    errors: [],
  };

  if (esdsOffset + esdsSize > initSegment.length) {
    info.errors.push(`esds box extends beyond init segment: offset=${esdsOffset} size=${esdsSize} total=${initSegment.length}`);
    return info;
  }

  let pos = esdsOffset + 8; // Skip size (4) + tag (4)

  // version/flags (4 bytes)
  if (pos + 4 > initSegment.length) {
    info.errors.push('esds: missing version/flags');
    return info;
  }
  pos += 4;

  // ES_Descriptor (tag 0x03)
  if (pos >= initSegment.length || initSegment[pos] !== 0x03) {
    info.errors.push(`esds: expected ES_Descriptor tag 0x03, got 0x${initSegment[pos]?.toString(16) ?? 'EOF'}`);
    return info;
  }
  pos++;

  // ES_Descriptor size (variable length)
  const esDescSize = parseVariableLengthSize(initSegment, pos);
  pos += esDescSize.bytesRead;

  // ES_ID (2 bytes) + streamDependenceFlag/URL_Flag/OCRstreamFlag (1 byte)
  if (pos + 3 > initSegment.length) {
    info.errors.push('esds: missing ES_ID and flags');
    return info;
  }
  pos += 3;

  // DecoderConfigDescriptor (tag 0x04)
  if (pos >= initSegment.length || initSegment[pos] !== 0x04) {
    info.errors.push(`esds: expected DecoderConfigDescriptor tag 0x04, got 0x${initSegment[pos]?.toString(16) ?? 'EOF'}`);
    return info;
  }
  pos++;

  // DecoderConfigDescriptor size (variable length)
  const decConfigSize = parseVariableLengthSize(initSegment, pos);
  pos += decConfigSize.bytesRead;

  // objectTypeIndication (1 byte)
  if (pos >= initSegment.length) {
    info.errors.push('esds: missing objectTypeIndication');
    return info;
  }
  info.objectTypeIndication = initSegment[pos];
  pos++;

  // streamType (1 byte, upper 6 bits) + bufferSizeDB (3 bytes)
  if (pos + 4 > initSegment.length) {
    info.errors.push('esds: missing streamType/bufferSizeDB');
    return info;
  }
  pos += 4;

  // maxBitrate (4 bytes) + avgBitrate (4 bytes)
  if (pos + 8 > initSegment.length) {
    info.errors.push('esds: missing bitrate fields');
    return info;
  }
  pos += 8;

  // DecoderSpecificInfo (tag 0x05)
  if (pos >= initSegment.length || initSegment[pos] !== 0x05) {
    info.errors.push(`esds: expected DecoderSpecificInfo tag 0x05, got 0x${initSegment[pos]?.toString(16) ?? 'EOF'}`);
    return info;
  }
  info.decoderSpecificInfoFound = true;
  pos++;

  // DecoderSpecificInfo size (variable length)
  const dsiSize = parseVariableLengthSize(initSegment, pos);
  pos += dsiSize.bytesRead;
  info.ascSize = dsiSize.size;

  // AudioSpecificConfig bytes
  if (pos + dsiSize.size > initSegment.length) {
    info.errors.push(`esds: DecoderSpecificInfo extends beyond segment: pos=${pos} size=${dsiSize.size} total=${initSegment.length}`);
    return info;
  }

  if (dsiSize.size < 2) {
    info.errors.push(`esds: DecoderSpecificInfo too small: ${dsiSize.size} bytes (need >= 2)`);
    return info;
  }

  info.ascBytes = initSegment.slice(pos, pos + dsiSize.size);

  // Parse ASC
  const ascParse = parseAudioSpecificConfig(info.ascBytes);
  info.sampleRate = ascParse.sampleRate;
  info.channels = ascParse.channels;
  info.errors.push(...ascParse.errors);

  return info;
}

/**
 * Validate AAC esds box in fMP4 init segment
 *
 * @param initSegment - fMP4 init segment bytes
 * @param expectedConfig - Expected AudioDecoderConfig
 * @param log - Optional logger
 * @returns Validation result with errors/warnings
 */
export function validateAacEsds(
  initSegment: Uint8Array,
  expectedConfig: AudioDecoderConfig | null,
  log?: (msg: string) => void,
): AacEsdsInfo {
  const logger = log ?? (() => {});

  // Find esds box
  const esdsBox = findEsdsBox(initSegment);
  if (!esdsBox) {
    const info: AacEsdsInfo = {
      found: false,
      errors: ['No esds box found in init segment'],
    };
    logger(`AAC esds validation: ${info.errors[0]}`);
    return info;
  }

  // Parse esds box
  const info = parseEsdsBox(initSegment, esdsBox.offset, esdsBox.size);

  // Validate against expected config
  if (expectedConfig) {
    if (info.sampleRate && info.sampleRate !== expectedConfig.sampleRate) {
      info.errors.push(
        `Sample rate mismatch: esds=${info.sampleRate} expected=${expectedConfig.sampleRate}`,
      );
    }
    if (info.channels && info.channels !== expectedConfig.numberOfChannels) {
      info.errors.push(
        `Channel count mismatch: esds=${info.channels} expected=${expectedConfig.numberOfChannels}`,
      );
    }
  }

  // Log results
  if (info.errors.length === 0) {
    logger(
      `AAC esds validation: OK sr=${info.sampleRate} ch=${info.channels} asc=${info.ascSize}B`,
    );
  } else {
    logger(`AAC esds validation: FAILED ${info.errors.join('; ')}`);
  }

  return info;
}

/**
 * Validate AAC esds and throw on critical errors
 *
 * @param initSegment - fMP4 init segment bytes
 * @param expectedConfig - Expected AudioDecoderConfig
 * @param log - Optional logger
 * @throws Error if critical validation failures
 */
export function validateAacEsdsStrict(
  initSegment: Uint8Array,
  expectedConfig: AudioDecoderConfig | null,
  log?: (msg: string) => void,
): void {
  const info = validateAacEsds(initSegment, expectedConfig, log);

  // Critical errors: missing esds, missing DecoderSpecificInfo, ASC parse errors
  const criticalErrors = info.errors.filter(
    (e) =>
      e.includes('No esds box') ||
      e.includes('DecoderSpecificInfo tag') ||
      e.includes('Invalid') ||
      e.includes('too small'),
  );

  if (criticalErrors.length > 0) {
    throw new Error(`AAC esds validation failed: ${criticalErrors.join('; ')}`);
  }
}
