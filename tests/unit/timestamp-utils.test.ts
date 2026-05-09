import { EncodedPacket } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { assertMonotonicTimestamps } from '../../src/pipeline/timestamp-utils.js';

describe('timestamp utils', () => {
  it('allows video presentation timestamps to go backward in decode order', () => {
    const videoPackets = [
      new EncodedPacket(new Uint8Array([0x01]), 'key', 0, 0.041, 0),
      new EncodedPacket(new Uint8Array([0x02]), 'delta', 0.209, 0.041, 1),
      new EncodedPacket(new Uint8Array([0x03]), 'delta', 0.125, 0.041, 2),
    ];

    expect(() => assertMonotonicTimestamps(videoPackets, [], 0)).not.toThrow();
  });

  it('still rejects audio timestamp regressions', () => {
    const audioPackets = [
      new EncodedPacket(new Uint8Array([0x01]), 'key', 0.1, 0.02, 0),
      new EncodedPacket(new Uint8Array([0x02]), 'key', 0.08, 0.02, 1),
    ];

    expect(() => assertMonotonicTimestamps([], audioPackets, 0)).toThrow(/audio packet 1 timestamp regression/);
  });
});
