/**
 * AV1 Packet Builder for dav1d.js
 * 
 * Implements the documented packet preparation recipe from:
 * /Users/ventsislav.georgiev/personal/bookplay/docs/dav1d-js-packet-prep-guide.md
 * 
 * Converts Matroska/WebM AV1 blocks into dav1d.js-compatible OBU packets.
 * 
 * Reference: dav1d.js commit 2e972af
 */

/**
 * OBU Type constants (AV1 spec)
 */
export const OBU_TYPES = {
  TEMPORAL_DELIMITER: 2,
  SEQUENCE_HEADER: 1,
  FRAME: 6,
  PADDING: 15,
} as const;

/**
 * OBU header byte formula:
 * bit 7:     obu_forbidden_bit (always 0)
 * bits 6-3:  obu_type (4 bits)
 * bit 2:     obu_extension_flag
 * bit 1:     obu_has_size_field
 * bit 0:     obu_reserved_bit (always 0)
 * 
 * For Sequence Header (type=1) with a size field:
 *   obu_type=1, extension_flag=0, has_size_field=1
 *   = (1 << 3) | (0 << 2) | (1 << 1) = 0x0a
 */
export function createObuHeader(
  obuType: number,
  hasExtension: boolean = false,
  hasSizeField: boolean = false,
): number {
  return (obuType << 3) | (hasExtension ? 0x04 : 0) | (hasSizeField ? 0x02 : 0);
}

/**
 * Encode LEB128 (Little Endian Base 128) variable-length integer.
 * Used for OBU size fields in LOBS format.
 * 
 * @param value - The value to encode
 * @returns Uint8Array containing the LEB128-encoded bytes
 */
export function encodeLeb128(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  bytes.push(v & 0x7f);
  
  return new Uint8Array(bytes);
}

/**
 * Decode LEB128 variable-length integer from buffer.
 * 
 * @param buffer - Buffer to read from
 * @param offset - Starting offset
 * @returns { value: number, bytesRead: number }
 */
export function decodeLeb128(buffer: Uint8Array, offset: number): { value: number; bytesRead: number } {
  if (offset >= buffer.length) {
    throw new Error(`LEB128 offset ${offset} out of bounds (buffer length ${buffer.length})`);
  }

  let value = 0;
  let shift = 0;
  let bytesRead = 0;
  
  for (let i = offset; i < buffer.length && bytesRead < 8; i++, bytesRead++) {
    const byte = buffer[i];
    value |= (byte & 0x7f) << shift;
    
    if ((byte & 0x80) === 0) {
      bytesRead++;
      break;
    }
    shift += 7;
  }

  if (bytesRead === 0) {
    throw new Error(`LEB128 offset ${offset} out of bounds (buffer length ${buffer.length})`);
  }
  
  return { value, bytesRead };
}

/**
 * Detect OBU type from header byte.
 * 
 * @param headerByte - First byte of OBU
 * @returns OBU type (0-15)
 */
export function getObuType(headerByte: number): number {
  return (headerByte >> 3) & 0x0f;
}

/**
 * Check if OBU has extension flag set.
 */
export function hasObuExtension(headerByte: number): boolean {
  return (headerByte & 0x04) !== 0;
}

/**
 * Check if OBU has size field.
 */
export function hasObuSizeField(headerByte: number): boolean {
  return (headerByte & 0x02) !== 0;
}

/**
 * Parse OBU header and return metadata.
 * 
 * @param buffer - Buffer containing OBU
 * @param offset - Starting offset
 * @returns { type, hasExtension, hasSizeField, headerSize, payloadSize, totalSize }
 */
export function parseObuHeader(
  buffer: Uint8Array,
  offset: number = 0,
): {
  type: number;
  hasExtension: boolean;
  hasSizeField: boolean;
  headerSize: number;
  payloadSize: number;
  totalSize: number;
} {
  if (offset >= buffer.length) {
    throw new Error('OBU header offset out of bounds');
  }
  
  const headerByte = buffer[offset];
  const type = getObuType(headerByte);
  const hasExtension = hasObuExtension(headerByte);
  const hasSizeField = hasObuSizeField(headerByte);
  
  let headerSize = 1;
  let payloadSize = 0;
  
  // Extension byte (if present)
  if (hasExtension) {
    headerSize++;
  }
  
  // Size field (if present)
  if (hasSizeField) {
    const sizeOffset = offset + headerSize;
    if (sizeOffset >= buffer.length) {
      throw new Error('OBU size field offset out of bounds');
    }
    
    const { value, bytesRead } = decodeLeb128(buffer, sizeOffset);
    payloadSize = value;
    headerSize += bytesRead;
  } else {
    // No size field: payload extends to end of buffer (or next OBU)
    // For now, assume it extends to end
    payloadSize = buffer.length - offset - headerSize;
  }
  
  return {
    type,
    hasExtension,
    hasSizeField,
    headerSize,
    payloadSize,
    totalSize: headerSize + payloadSize,
  };
}

/**
 * Matroska/WebM AV1 CodecPrivate structure (4+ bytes).
 * 
 * Byte 0:
 *   bit 7:     marker (always 1)
 *   bits 6-0:  version (currently 1)
 * Byte 1:
 *   bits 7-5:  seq_profile (3 bits)
 *   bits 4-0:  seq_level_idx_0 (5 bits)
 * Byte 2:
 *   bit 7:     seq_tier_0
 *   bit 6:     high_bitdepth
 *   bit 5:     twelve_bit
 *   bit 4:     monochrome
 *   bit 3:     chroma_subsampling_x
 *   bit 2:     chroma_subsampling_y
 *   bits 1-0:  chroma_sample_position (2 bits)
 * Byte 3:
 *   bits 7-4:  reserved (4 bits, must be 0)
 *   bits 3-0:  initial_presentation_delay_present (1 bit) + delay (3 bits)
 * Bytes 4+:
 *   Sequence Header OBU (if present)
 */
export interface Av1CodecPrivate {
  version: number;
  seqProfile: number;
  seqLevelIdx0: number;
  seqTier0: boolean;
  highBitdepth: boolean;
  twelveBit: boolean;
  monochrome: boolean;
  chromaSubsamplingX: boolean;
  chromaSubsamplingY: boolean;
  chromaSamplePosition: number;
  initialPresentationDelayPresent: boolean;
  initialPresentationDelay: number;
  sequenceHeaderObu: Uint8Array | null;
}

export interface Dav1dJsAv1Compatibility {
  compatible: boolean;
  reason: string | null;
}

/**
 * Parse Matroska/WebM AV1 CodecPrivate.
 * 
 * @param codecPrivate - CodecPrivate bytes (4+ bytes)
 * @returns Parsed codec private structure
 */
export function parseAv1CodecPrivate(codecPrivate: Uint8Array): Av1CodecPrivate {
  if (codecPrivate.length < 4) {
    throw new Error(`AV1 CodecPrivate must be at least 4 bytes, got ${codecPrivate.length}`);
  }
  
  const byte0 = codecPrivate[0];
  const byte1 = codecPrivate[1];
  const byte2 = codecPrivate[2];
  const byte3 = codecPrivate[3];
  
  const version = byte0 & 0x7f;
  const seqProfile = (byte1 >> 5) & 0x07;
  const seqLevelIdx0 = byte1 & 0x1f;
  const seqTier0 = (byte2 & 0x80) !== 0;
  const highBitdepth = (byte2 & 0x40) !== 0;
  const twelveBit = (byte2 & 0x20) !== 0;
  const monochrome = (byte2 & 0x10) !== 0;
  const chromaSubsamplingX = (byte2 & 0x08) !== 0;
  const chromaSubsamplingY = (byte2 & 0x04) !== 0;
  const chromaSamplePosition = byte2 & 0x03;
  
  const initialPresentationDelayPresent = (byte3 & 0x10) !== 0;
  const initialPresentationDelay = initialPresentationDelayPresent ? (byte3 & 0x0f) : 0;
  
  // Sequence Header OBU (if present, starts at byte 4)
  const sequenceHeaderObu = codecPrivate.length > 4 ? codecPrivate.slice(4) : null;
  
  return {
    version,
    seqProfile,
    seqLevelIdx0,
    seqTier0,
    highBitdepth,
    twelveBit,
    monochrome,
    chromaSubsamplingX,
    chromaSubsamplingY,
    chromaSamplePosition,
    initialPresentationDelayPresent,
    initialPresentationDelay,
    sequenceHeaderObu,
  };
}

export function checkDav1dJsAv1Compatibility(description?: AllowSharedBufferSource | null): Dav1dJsAv1Compatibility {
  if (!description) {
    return { compatible: false, reason: 'missing-codec-private' };
  }

  let config: Av1CodecPrivate;
  try {
    config = parseAv1CodecPrivate(toUint8Array(description));
  } catch {
    return { compatible: false, reason: 'invalid-codec-private' };
  }

  if (config.highBitdepth) {
    return { compatible: false, reason: config.twelveBit ? 'av1-12bit' : 'av1-high-bitdepth' };
  }
  if (config.monochrome) {
    return { compatible: false, reason: 'av1-monochrome' };
  }
  if (!config.chromaSubsamplingX || !config.chromaSubsamplingY) {
    return { compatible: false, reason: 'av1-non-420' };
  }

  return { compatible: true, reason: null };
}

export function checkDav1dBridgeAv1Compatibility(description?: AllowSharedBufferSource | null): Dav1dJsAv1Compatibility {
  if (!description) {
    return { compatible: false, reason: 'missing-codec-private' };
  }

  let config: Av1CodecPrivate;
  try {
    config = parseAv1CodecPrivate(toUint8Array(description));
  } catch {
    return { compatible: false, reason: 'invalid-codec-private' };
  }

  if (config.twelveBit) {
    return { compatible: false, reason: 'av1-12bit' };
  }
  if (config.monochrome) {
    return { compatible: false, reason: 'av1-monochrome' };
  }
  if (!config.chromaSubsamplingX || !config.chromaSubsamplingY) {
    return { compatible: false, reason: 'av1-non-420' };
  }

  return { compatible: true, reason: null };
}

function toUint8Array(buffer: AllowSharedBufferSource): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new Uint8Array(buffer);
}

/**
 * Build AV1 packet for dav1d.js from Matroska/WebM block.
 * 
 * Recipe:
 * 1. Optionally prepend Temporal Delimiter OBU (0x08)
 * 2. Optionally prepend Sequence Header OBU from CodecPrivate (if not in-band)
 * 3. Append Block payload
 * 
 * @param blockPayload - Raw block payload from Matroska/WebM
 * @param codecPrivate - AV1 CodecPrivate (4+ bytes)
 * @param options - Build options
 * @returns Concatenated OBU bytes ready for dav1d.js
 */
/**
 * Wrap an OBU with size field (LOBS format).
 * Used when multiple OBUs are in a single packet.
 */
function wrapObuWithSize(obu: Uint8Array): Uint8Array {
  const headerByte = obu[0];
  const hasExtension = (headerByte & 0x04) !== 0;
  const hasSizeField = (headerByte & 0x02) !== 0;
  
  // If already has size field, return as-is
  if (hasSizeField) {
    return obu;
  }
  
  // Calculate payload size (everything after header, accounting for extension)
  let payloadStart = 1;
  if (hasExtension) {
    payloadStart = 2; // header + extension byte
  }
  
  const payloadSize = obu.length - payloadStart;
  const sizeBytes = encodeLeb128(payloadSize);
  
  // Create new OBU with size field
  const newHeaderByte = headerByte | 0x02; // Set size field flag
  const result = new Uint8Array(1 + sizeBytes.length + payloadSize);
  
  result[0] = newHeaderByte;
  result.set(sizeBytes, 1);
  result.set(obu.slice(payloadStart), 1 + sizeBytes.length);
  
  return result;
}

export function buildAv1Packet(
  blockPayload: Uint8Array,
  codecPrivate: Uint8Array,
  options: {
    prependTemporalDelimiter?: boolean;
    prependSequenceHeader?: boolean;
    detectInBandSequenceHeader?: boolean;
  } = {},
): Uint8Array {
  const {
    prependTemporalDelimiter = true,
    prependSequenceHeader = true,
    detectInBandSequenceHeader = true,
  } = options;
  
  const parts: Uint8Array[] = [];
  
  // 1. Prepend Temporal Delimiter OBU (stateless-safe default)
  if (prependTemporalDelimiter) {
    parts.push(new Uint8Array([createObuHeader(OBU_TYPES.TEMPORAL_DELIMITER, false, true), 0x00]));
  }
  
  // 2. Optionally prepend Sequence Header from CodecPrivate
  if (prependSequenceHeader) {
    const parsed = parseAv1CodecPrivate(codecPrivate);
    
    // Check if block already contains sequence header (if detectInBandSequenceHeader is true)
    let hasInBandSequenceHeader = false;
    if (detectInBandSequenceHeader && blockPayload.length > 0) {
      const firstObuType = getObuType(blockPayload[0]);
      hasInBandSequenceHeader = firstObuType === OBU_TYPES.SEQUENCE_HEADER;
    }
    
    // Prepend sequence header from CodecPrivate if not in-band
    if (!hasInBandSequenceHeader && parsed.sequenceHeaderObu) {
      parts.push(parsed.sequenceHeaderObu);
    }
  }
  
  // 3. Append block payload
  parts.push(blockPayload);
  
  // Concatenate all parts (raw, no size fields)
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  
  return result;
}

/**
 * Validate AV1 packet structure (basic checks).
 * 
 * @param packet - OBU packet bytes
 * @returns { valid: boolean, errors: string[] }
 */
export function validateAv1Packet(packet: Uint8Array): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (packet.length === 0) {
    errors.push('Packet is empty');
    return { valid: false, errors };
  }
  
  let offset = 0;
  let obuCount = 0;
  
  try {
    while (offset < packet.length && obuCount < 100) {
      const header = parseObuHeader(packet, offset);
      
      // Validate OBU type
      if (header.type > 15) {
        errors.push(`Invalid OBU type at offset ${offset}: ${header.type}`);
      }
      
      // Check bounds
      if (offset + header.totalSize > packet.length) {
        errors.push(
          `OBU at offset ${offset} extends beyond packet (total=${packet.length}, obu_end=${offset + header.totalSize})`,
        );
        break;
      }
      
      offset += header.totalSize;
      obuCount++;
    }
    
    if (obuCount >= 100) {
      errors.push('Packet contains too many OBUs (>= 100)');
    }
  } catch (e) {
    errors.push(`Parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract all OBUs from packet.
 * 
 * @param packet - OBU packet bytes
 * @returns Array of { type, data, offset }
 */
export function extractObus(packet: Uint8Array): Array<{ type: number; data: Uint8Array; offset: number }> {
  const obus: Array<{ type: number; data: Uint8Array; offset: number }> = [];
  let offset = 0;
  
  while (offset < packet.length) {
    try {
      const header = parseObuHeader(packet, offset);
      const obuData = packet.slice(offset, offset + header.totalSize);
      
      obus.push({
        type: header.type,
        data: obuData,
        offset,
      });
      
      offset += header.totalSize;
    } catch {
      break;
    }
  }
  
  return obus;
}

export default {
  OBU_TYPES,
  createObuHeader,
  encodeLeb128,
  decodeLeb128,
  getObuType,
  hasObuExtension,
  hasObuSizeField,
  parseObuHeader,
  parseAv1CodecPrivate,
  buildAv1Packet,
  validateAv1Packet,
  extractObus,
};
