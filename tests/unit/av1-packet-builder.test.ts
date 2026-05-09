import { describe, expect, it } from 'vitest';
import {
  OBU_TYPES,
  buildAv1Packet,
  createObuHeader,
  decodeLeb128,
  encodeLeb128,
  extractObus,
  getObuType,
  hasObuSizeField,
  parseAv1CodecPrivate,
  parseObuHeader,
  validateAv1Packet,
} from '../../src/pipeline/av1-packet-builder';

const SEQUENCE_HEADER_OBU = new Uint8Array([0x0a, 0x01, 0x00]);
const TEMPORAL_DELIMITER_OBU = new Uint8Array([0x12, 0x00]);
const FRAME_OBU = new Uint8Array([0x32, 0x01, 0x00]);

describe('AV1 Packet Builder', () => {
  it('creates spec-correct OBU headers', () => {
    expect(createObuHeader(OBU_TYPES.SEQUENCE_HEADER, false, true)).toBe(0x0a);
    expect(createObuHeader(OBU_TYPES.TEMPORAL_DELIMITER, false, true)).toBe(0x12);
    expect(createObuHeader(OBU_TYPES.FRAME, false, true)).toBe(0x32);
  });

  it('extracts OBU types from header bytes', () => {
    expect(getObuType(0x0a)).toBe(OBU_TYPES.SEQUENCE_HEADER);
    expect(getObuType(0x12)).toBe(OBU_TYPES.TEMPORAL_DELIMITER);
    expect(getObuType(0x32)).toBe(OBU_TYPES.FRAME);
    expect(hasObuSizeField(0x32)).toBe(true);
  });

  it('round-trips LEB128 values and rejects out-of-bounds offsets', () => {
    for (const value of [0, 1, 127, 128, 16_383, 16_384, 2_097_151]) {
      const encoded = encodeLeb128(value);
      expect(decodeLeb128(encoded, 0).value).toBe(value);
    }

    expect(() => decodeLeb128(new Uint8Array([]), 0)).toThrow(/out of bounds/);
  });

  it('parses an OBU with a size field', () => {
    const header = parseObuHeader(SEQUENCE_HEADER_OBU, 0);
    expect(header.type).toBe(OBU_TYPES.SEQUENCE_HEADER);
    expect(header.hasSizeField).toBe(true);
    expect(header.payloadSize).toBe(1);
    expect(header.totalSize).toBe(SEQUENCE_HEADER_OBU.byteLength);
  });

  it('parses CodecPrivate config OBUs after the fixed four-byte header', () => {
    const parsed = parseAv1CodecPrivate(new Uint8Array([0x81, 0x00, 0x00, 0x00, ...SEQUENCE_HEADER_OBU]));
    expect(parsed.version).toBe(1);
    expect(parsed.sequenceHeaderObu).toEqual(SEQUENCE_HEADER_OBU);
  });

  it('builds a packet with temporal delimiter and sequence header when missing in-band', () => {
    const packet = buildAv1Packet(FRAME_OBU, new Uint8Array([0x81, 0x00, 0x00, 0x00, ...SEQUENCE_HEADER_OBU]), {
      prependTemporalDelimiter: true,
      prependSequenceHeader: true,
      detectInBandSequenceHeader: true,
    });

    expect([...packet]).toEqual([...TEMPORAL_DELIMITER_OBU, ...SEQUENCE_HEADER_OBU, ...FRAME_OBU]);
  });

  it('does not duplicate an in-band sequence header', () => {
    const blockPayload = new Uint8Array([...SEQUENCE_HEADER_OBU, ...FRAME_OBU]);
    const packet = buildAv1Packet(blockPayload, new Uint8Array([0x81, 0x00, 0x00, 0x00, ...SEQUENCE_HEADER_OBU]), {
      prependTemporalDelimiter: false,
      prependSequenceHeader: true,
      detectInBandSequenceHeader: true,
    });

    expect(packet).toEqual(blockPayload);
  });

  it('validates and extracts size-field OBUs', () => {
    const packet = new Uint8Array([...TEMPORAL_DELIMITER_OBU, ...SEQUENCE_HEADER_OBU, ...FRAME_OBU]);
    expect(validateAv1Packet(packet).valid).toBe(true);

    const obus = extractObus(packet);
    expect(obus.map((obu) => obu.type)).toEqual([
      OBU_TYPES.TEMPORAL_DELIMITER,
      OBU_TYPES.SEQUENCE_HEADER,
      OBU_TYPES.FRAME,
    ]);
  });
});
