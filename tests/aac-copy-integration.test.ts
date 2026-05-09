/**
 * Integration tests for AAC copy orchestration in segment processor.
 */

import { describe, it, expect, vi } from 'vitest';
import { copyOrTranscode, shouldEnableAacCopy } from '../src/pipeline/aac-copy-integration.js';
import type { EncodedPacket } from 'mediabunny';

// Mock EncodedPacket for testing
function createMockPacket(data: Uint8Array, timestamp: number, duration: number): EncodedPacket {
  return {
    data,
    type: 'key',
    timestamp,
    duration,
    sequenceNumber: 0,
    byteLength: data.byteLength,
    sideData: undefined,
  } as unknown as EncodedPacket;
}

describe('shouldEnableAacCopy', () => {
  it('returns true for AAC + fmp4', () => {
    expect(shouldEnableAacCopy('aac', 'fmp4')).toBe(true);
  });

  it('returns true for AAC + mp4', () => {
    expect(shouldEnableAacCopy('aac', 'mp4')).toBe(true);
  });

  it('returns true for AAC + mkv', () => {
    expect(shouldEnableAacCopy('aac', 'mkv')).toBe(true);
  });

  it('returns true for AAC + webm', () => {
    expect(shouldEnableAacCopy('aac', 'webm')).toBe(true);
  });

  it('returns false for non-AAC codec', () => {
    expect(shouldEnableAacCopy('mp3', 'fmp4')).toBe(false);
    expect(shouldEnableAacCopy('ac3', 'fmp4')).toBe(false);
    expect(shouldEnableAacCopy(null, 'fmp4')).toBe(false);
  });

  it('returns false for unsupported container', () => {
    expect(shouldEnableAacCopy('aac', 'avi')).toBe(false);
    expect(shouldEnableAacCopy('aac', 'mov')).toBe(false);
  });

  it('is case-insensitive for container format', () => {
    expect(shouldEnableAacCopy('aac', 'FMP4')).toBe(true);
    expect(shouldEnableAacCopy('aac', 'FMMP4')).toBe(false); // FMMP4 is not a valid format
  });
});

describe('copyOrTranscode', () => {
  it('skips copy when enableAacCopy is false', async () => {
    const mockTranscode = vi.fn().mockResolvedValue({
      packets: [],
      decoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      metrics: { totalMs: 10, ffmpegSpeed: null },
    });

    const result = await copyOrTranscode(
      [],
      {
        enableAacCopy: false,
        containerFormat: 'fmp4',
        sourceCodec: 'aac',
        transcodeExecutor: mockTranscode,
      },
      {
        packets: [],
        sampleRate: 48000,
        audioStartSec: 0,
        outputStartSec: 0,
        trimStartSec: 0,
        leadingSilenceSec: 0,
        targetDurationSec: 1,
        targetFrameCount: 48,
        sourceCodec: 'aac',
        audioDecoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      },
    );

    expect(result.copiedSuccessfully).toBe(false);
    expect(result.reason).toContain('disabled');
    expect(mockTranscode).toHaveBeenCalled();
  });

  it('skips copy when source codec is not AAC', async () => {
    const mockTranscode = vi.fn().mockResolvedValue({
      packets: [],
      decoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      metrics: { totalMs: 10, ffmpegSpeed: null },
    });

    const result = await copyOrTranscode(
      [],
      {
        enableAacCopy: true,
        containerFormat: 'fmp4',
        sourceCodec: 'mp3',
        transcodeExecutor: mockTranscode,
      },
      {
        packets: [],
        sampleRate: 48000,
        audioStartSec: 0,
        outputStartSec: 0,
        trimStartSec: 0,
        leadingSilenceSec: 0,
        targetDurationSec: 1,
        targetFrameCount: 48,
        sourceCodec: 'mp3',
        audioDecoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      },
    );

    expect(result.copiedSuccessfully).toBe(false);
    expect(result.reason).toContain('mp3');
    expect(mockTranscode).toHaveBeenCalled();
  });

  it('falls back to transcode when copy fails', async () => {
    const mockTranscode = vi.fn().mockResolvedValue({
      packets: [createMockPacket(new Uint8Array(100), 0, 0.02)],
      decoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      metrics: { totalMs: 50, ffmpegSpeed: 1.0, audioDurationSec: 1, outputDurationSec: 1, realtimeRatio: 1 },
    });

    // Mock the executeAacCopy to fail
    vi.doMock('../aac-copy-executor.js', () => ({
      executeAacCopy: vi.fn().mockRejectedValue(new Error('Copy failed')),
      shouldAttemptAacCopy: () => ({ shouldCopy: true, reason: 'test' }),
    }));

    const result = await copyOrTranscode(
      [createMockPacket(new Uint8Array(100), 0, 0.02)],
      {
        enableAacCopy: true,
        containerFormat: 'fmp4',
        sourceCodec: 'aac',
        transcodeExecutor: mockTranscode,
      },
      {
        packets: [createMockPacket(new Uint8Array(100), 0, 0.02)],
        sampleRate: 48000,
        audioStartSec: 0,
        outputStartSec: 0,
        trimStartSec: 0,
        leadingSilenceSec: 0,
        targetDurationSec: 1,
        targetFrameCount: 48,
        sourceCodec: 'aac',
        audioDecoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      },
    );

    expect(result.copiedSuccessfully).toBe(false);
    expect(result.reason).toContain('Copy not feasible');
    expect(mockTranscode).toHaveBeenCalled();
  });

  it('includes transcode metrics in result when transcode is used', async () => {
    const mockTranscode = vi.fn().mockResolvedValue({
      packets: [createMockPacket(new Uint8Array(100), 0, 0.02)],
      decoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      metrics: {
        totalMs: 50,
        ffmpegSpeed: 1.0,
        audioDurationSec: 1,
        outputDurationSec: 1,
        realtimeRatio: 1,
        ffmpegMs: 40,
      },
    });

    const result = await copyOrTranscode(
      [],
      {
        enableAacCopy: false,
        containerFormat: 'fmp4',
        sourceCodec: 'aac',
        transcodeExecutor: mockTranscode,
      },
      {
        packets: [],
        sampleRate: 48000,
        audioStartSec: 0,
        outputStartSec: 0,
        trimStartSec: 0,
        leadingSilenceSec: 0,
        targetDurationSec: 1,
        targetFrameCount: 48,
        sourceCodec: 'aac',
        audioDecoderConfig: { sampleRate: 48000, numberOfChannels: 2 },
      },
    );

    expect(result.transcodeMetrics).toBeDefined();
    expect(result.transcodeMetrics?.totalMs).toBe(50);
    expect(result.transcodeMetrics?.ffmpegSpeed).toBe(1.0);
  });
});
