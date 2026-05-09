import { describe, expect, it } from 'vitest';
import {
  checkDav1dBridgeAv1Compatibility,
  checkDav1dJsAv1Compatibility,
} from '../../src/pipeline/av1-packet-builder.js';
import { hasDecodableAv1Frame, prepareDav1dAv1Packet } from '../../src/pipeline/dav1d-video-transcode.js';

const SEQUENCE_HEADER_OBU = new Uint8Array([0x0a, 0x01, 0x00]);
const TEMPORAL_DELIMITER_OBU = new Uint8Array([0x12, 0x00]);
const FRAME_HEADER_OBU = new Uint8Array([0x1a, 0x00]);
const FRAME_OBU = new Uint8Array([0x32, 0x01, 0x00]);

function decoderConfigWith(configObus: Uint8Array): VideoDecoderConfig {
  return {
    codec: 'av01.0.08M.08',
    codedWidth: 16,
    codedHeight: 16,
    description: new Uint8Array([0x81, 0x00, 0x00, 0x00, ...configObus]),
  };
}

describe('AV1 packet conditioning', () => {
  it('passes packets through when decoder config should not be included', () => {
    expect(prepareDav1dAv1Packet(FRAME_OBU, decoderConfigWith(SEQUENCE_HEADER_OBU), false)).toBe(FRAME_OBU);
  });

  it('passes empty packets through', () => {
    const packet = new Uint8Array([]);
    expect(prepareDav1dAv1Packet(packet, decoderConfigWith(SEQUENCE_HEADER_OBU), true)).toBe(packet);
  });

  it('detects an in-band sequence header OBU and avoids prepending config OBUs', () => {
    const packet = new Uint8Array([...SEQUENCE_HEADER_OBU, ...FRAME_OBU]);
    expect(prepareDav1dAv1Packet(packet, decoderConfigWith(SEQUENCE_HEADER_OBU), true)).toBe(packet);
  });

  it('prepends config OBUs for the first packet when it lacks a sequence header', () => {
    const packet = new Uint8Array([...TEMPORAL_DELIMITER_OBU, ...FRAME_OBU]);
    const prepared = prepareDav1dAv1Packet(packet, decoderConfigWith(SEQUENCE_HEADER_OBU), true);

    expect(prepared).not.toBe(packet);
    expect([...prepared]).toEqual([...SEQUENCE_HEADER_OBU, ...packet]);
  });

  it('handles ArrayBufferView decoder descriptions with byte offsets', () => {
    const backing = new Uint8Array([0xff, 0xff, 0x81, 0x00, 0x00, 0x00, ...SEQUENCE_HEADER_OBU, 0xff]);
    const config: VideoDecoderConfig = {
      codec: 'av01.0.08M.08',
      codedWidth: 16,
      codedHeight: 16,
      description: new DataView(backing.buffer, 2, 4 + SEQUENCE_HEADER_OBU.byteLength),
    };

    const prepared = prepareDav1dAv1Packet(FRAME_OBU, config, true);
    expect([...prepared]).toEqual([...SEQUENCE_HEADER_OBU, ...FRAME_OBU]);
  });

  it('passes through when decoder config has no usable config OBUs', () => {
    const config: VideoDecoderConfig = {
      codec: 'av01.0.08M.08',
      codedWidth: 16,
      codedHeight: 16,
      description: new Uint8Array([0x81, 0x00, 0x00, 0x00]),
    };

    expect(prepareDav1dAv1Packet(FRAME_OBU, config, true)).toBe(FRAME_OBU);
  });

  it('identifies metadata-only AV1 packets as non-decodable', () => {
    const metadataObu = new Uint8Array([0x2a, 0x01, 0x00]);
    const metadataOnlyPacket = new Uint8Array([...SEQUENCE_HEADER_OBU, ...TEMPORAL_DELIMITER_OBU, ...metadataObu]);

    expect(hasDecodableAv1Frame(metadataOnlyPacket)).toBe(false);
  });

  it('identifies frame OBUs as decodable', () => {
    const packet = new Uint8Array([...TEMPORAL_DELIMITER_OBU, ...FRAME_OBU]);

    expect(hasDecodableAv1Frame(packet)).toBe(true);
  });

  it('keeps AV1 frame-header packets in the dav1d decode stream', () => {
    const packet = new Uint8Array([...TEMPORAL_DELIMITER_OBU, ...FRAME_HEADER_OBU]);

    expect(hasDecodableAv1Frame(packet)).toBe(true);
  });

  it('allows dav1d.js only for 8-bit 4:2:0 AV1 codec private data', () => {
    const description = new Uint8Array([0x81, 0x00, 0x0c, 0x00, ...SEQUENCE_HEADER_OBU]);

    expect(checkDav1dJsAv1Compatibility(description)).toEqual({ compatible: true, reason: null });
  });

  it('rejects high-bit-depth AV1 for dav1d.js fallback', () => {
    const description = new Uint8Array([0x81, 0x00, 0x4c, 0x00, ...SEQUENCE_HEADER_OBU]);

    expect(checkDav1dJsAv1Compatibility(description)).toEqual({
      compatible: false,
      reason: 'av1-high-bitdepth',
    });
  });

  it('allows 10-bit 4:2:0 AV1 for the downconverting dav1d bridge', () => {
    const description = new Uint8Array([0x81, 0x00, 0x4c, 0x00, ...SEQUENCE_HEADER_OBU]);

    expect(checkDav1dBridgeAv1Compatibility(description)).toEqual({ compatible: true, reason: null });
  });

  it('keeps 12-bit AV1 disabled for the initial dav1d bridge rollout', () => {
    const description = new Uint8Array([0x81, 0x00, 0x6c, 0x00, ...SEQUENCE_HEADER_OBU]);

    expect(checkDav1dBridgeAv1Compatibility(description)).toEqual({
      compatible: false,
      reason: 'av1-12bit',
    });
  });

  it('rejects non-4:2:0 AV1 for dav1d.js fallback', () => {
    const description = new Uint8Array([0x81, 0x00, 0x08, 0x00, ...SEQUENCE_HEADER_OBU]);

    expect(checkDav1dJsAv1Compatibility(description)).toEqual({
      compatible: false,
      reason: 'av1-non-420',
    });
    expect(checkDav1dBridgeAv1Compatibility(description)).toEqual({
      compatible: false,
      reason: 'av1-non-420',
    });
  });
});
