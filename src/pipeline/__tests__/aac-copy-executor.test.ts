/**
 * Tests for AAC Copy Executor
 *
 * Validates:
 * - ADTS packet stripping and ASC generation
 * - Timestamp recomputation
 * - Decoder config generation
 * - Fallback detection (unsupported containers, invalid packets)
 * - Metrics computation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EncodedPacket } from 'mediabunny';
import {
  executeAacCopy,
  shouldAttemptAacCopy,
  type AacCopyOptions,
} from '../aac-copy-executor.js';

/**
 * Helper: Create a minimal ADTS frame header.
 * ADTS frame: [Sync (12 bits: 0xFFF)] [MPEG Version (1 bit)] [Layer (2 bits)] [Protection (1 bit)]
 *             [Profile (2 bits)] [Sample Rate Index (4 bits)] [Private (1 bit)] [Channels (3 bits)]
 *             [Original (1 bit)] [Home (1 bit)] [Emphasis (2 bits)] [Frame Length (13 bits)] ...
 */
function createAdtsFrame(
  profile: number = 1, // AAC-LC
  sampleRateIndex: number = 3, // 48000 Hz
  channels: number = 2,
  payloadSize: number = 100,
): Uint8Array {
  const frameLength = 7 + payloadSize; // 7-byte header + payload
  const frame = new Uint8Array(frameLength);

  // Byte 0-1: Sync word (0xFFF) + MPEG version (1) + Layer (00) + Protection (1)
  frame[0] = 0xff;
  frame[1] = 0xf1; // 1111 0001: sync + MPEG-4 + no CRC

  // Byte 2: Profile (2 bits) + Sample Rate Index (4 bits) + Private (1 bit) + Channels high (1 bit)
  frame[2] = ((profile & 0x03) << 6) | ((sampleRateIndex & 0x0f) << 2) | ((channels >> 2) & 0x01);

  // Byte 3: Channels low (2 bits) + Original (1 bit) + Home (1 bit) + Emphasis (2 bits) + Frame Length high (2 bits)
  frame[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);

  // Byte 4: Frame Length mid (8 bits)
  frame[4] = (frameLength >> 3) & 0xff;

  // Byte 5: Frame Length low (3 bits) + Buffer fullness high (5 bits)
  frame[5] = ((frameLength & 0x07) << 5) | 0x1f; // 0x1f = buffer fullness all 1s (VBR)

  // Byte 6: Buffer fullness low (6 bits) + Number of raw data blocks (2 bits)
  frame[6] = 0xfc; // 1111 1100: buffer fullness + 0 raw data blocks

  // Fill payload with dummy data
  for (let i = 7; i < frameLength; i++) {
    frame[i] = 0xaa; // Dummy payload
  }

  return frame;
}

describe('AAC Copy Executor', () => {
  describe('executeAacCopy', () => {
    it('should copy ADTS packets and strip headers for MP4', async () => {
      const adtsFrame1 = createAdtsFrame(1, 3, 2, 100);
      const adtsFrame2 = createAdtsFrame(1, 3, 2, 100);

      const packets = [
        new EncodedPacket(adtsFrame1, 'key', 0.0, 0.02125, 0), // 1024 samples @ 48kHz = 21.33ms
        new EncodedPacket(adtsFrame2, 'key', 0.02125, 0.02125, 1),
      ];

      const result = await executeAacCopy({
        packets,
        containerFormat: 'mp4',
        sampleRate: 48000,
        channels: 2,
        audioStartSec: 0.0,
      });

      expect(result.packets).toHaveLength(2);
      expect(result.packets[0].data.byteLength).toBe(100); // Header stripped
      expect(result.decoderConfig.codec).toBe('mp4a.40.2');
      expect(result.decoderConfig.numberOfChannels).toBe(2);
      expect(result.decoderConfig.sampleRate).toBe(48000);
      expect(result.metrics.appliedAdtsToAsc).toBe(true);
      expect(result.metrics.outputPackets).toBe(2);
    });

    it('should recompute timestamps relative to outputStartSec', async () => {
      const adtsFrame = createAdtsFrame(1, 3, 2, 100);
      const packets = [
        new EncodedPacket(adtsFrame, 'key', 1.0, 0.02125, 0),
        new EncodedPacket(adtsFrame, 'key', 1.02125, 0.02125, 1),
      ];

      const result = await executeAacCopy({
        packets,
        containerFormat: 'mp4',
        sampleRate: 48000,
        channels: 2,
        audioStartSec: 1.0,
        outputStartSec: 0.5, // Shift output start
      });

      expect(result.packets[0].timestamp).toBe(0.5); // 0.5 + (1.0 - 1.0)
      expect(result.packets[1].timestamp).toBeCloseTo(0.52125, 5); // 0.5 + (1.02125 - 1.0)
    });

    it('should throw for unsupported container format', async () => {
      const adtsFrame = createAdtsFrame();
      const packets = [new EncodedPacket(adtsFrame, 'key', 0.0, 0.02125, 0)];

      await expect(
        executeAacCopy({
          packets,
          containerFormat: 'unsupported-format',
          sampleRate: 48000,
          channels: 2,
          audioStartSec: 0.0,
        }),
      ).rejects.toThrow(/not supported for container format/);
    });

    it('should throw for empty packet list', async () => {
      await expect(
        executeAacCopy({
          packets: [],
          containerFormat: 'mp4',
          sampleRate: 48000,
          channels: 2,
          audioStartSec: 0.0,
        }),
      ).rejects.toThrow(/No audio packets provided/);
    });

    it('should compute correct metrics', async () => {
      const adtsFrame = createAdtsFrame(1, 3, 2, 100);
      const packets = [
        new EncodedPacket(adtsFrame, 'key', 0.0, 0.02125, 0),
        new EncodedPacket(adtsFrame, 'key', 0.02125, 0.02125, 1),
      ];

      const result = await executeAacCopy({
        packets,
        containerFormat: 'mp4',
        sampleRate: 48000,
        channels: 2,
        audioStartSec: 0.0,
      });

      expect(result.metrics.inputPackets).toBe(2);
      expect(result.metrics.inputBytes).toBe(214); // 2 * 107 (7-byte header + 100 payload)
      expect(result.metrics.outputPackets).toBe(2);
      expect(result.metrics.outputBytes).toBe(200); // 2 * 100 (headers stripped)
      expect(result.metrics.appliedAdtsToAsc).toBe(true);
      expect(result.metrics.packetsValidated).toBe(true);
      expect(result.metrics.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('should respect abort signal', async () => {
      const controller = new AbortController();
      const adtsFrame = createAdtsFrame();
      const packets = [new EncodedPacket(adtsFrame, 'key', 0.0, 0.02125, 0)];

      controller.abort();

      await expect(
        executeAacCopy({
          packets,
          containerFormat: 'mp4',
          sampleRate: 48000,
          channels: 2,
          audioStartSec: 0.0,
          signal: controller.signal,
        }),
      ).rejects.toThrow('AbortError');
    });
  });

  describe('shouldAttemptAacCopy', () => {
    it('should recommend copy for ADTS in MP4', () => {
      const adtsFrame = createAdtsFrame();
      const packets = [new EncodedPacket(adtsFrame, 'key', 0.0, 0.02125, 0)];

      const decision = shouldAttemptAacCopy(packets, 'mp4');
      expect(decision.shouldCopy).toBe(true);
      expect(decision.reason).toContain('ADTS');
    });

    it('should reject copy for unsupported container', () => {
      const adtsFrame = createAdtsFrame();
      const packets = [new EncodedPacket(adtsFrame, 'key', 0.0, 0.02125, 0)];

      const decision = shouldAttemptAacCopy(packets, 'unsupported');
      expect(decision.shouldCopy).toBe(false);
      expect(decision.reason).toContain('does not support');
    });

    it('should reject copy for empty packet list', () => {
      const decision = shouldAttemptAacCopy([], 'mp4');
      expect(decision.shouldCopy).toBe(false);
      expect(decision.reason).toContain('No packets');
    });

    it('should reject copy for invalid ADTS header', () => {
      const invalidAdts = new Uint8Array([0xff, 0xf0, 0x00, 0x00]); // Invalid ADTS
      const packets = [new EncodedPacket(invalidAdts, 'key', 0.0, 0.02125, 0)];

      const decision = shouldAttemptAacCopy(packets, 'mp4');
      expect(decision.shouldCopy).toBe(false);
      expect(decision.reason).toContain('Could not parse');
    });
  });
});
