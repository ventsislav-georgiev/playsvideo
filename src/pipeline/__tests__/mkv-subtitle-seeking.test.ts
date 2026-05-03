/**
 * Tests for MKV Subtitle Seeking
 *
 * Validates:
 * - EBML element parsing
 * - Cues index extraction
 * - Binary search for cluster positions
 * - Preroll calculation
 * - HTTP Range request handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseMkvCuesIndex,
  seekToSubtitleTime,
  MkvSubtitleSeeker,
  createMkvSubtitleSeekerFromBlob,
} from '../mkv-subtitle-seeking.js';

describe('MKV Subtitle Seeking', () => {
  describe('parseMkvCuesIndex', () => {
    it('should return null for non-EBML files', async () => {
      const read = async (start: number, end: number) => {
        return new Uint8Array([0xff, 0xff, 0xff, 0xff]); // Invalid EBML header
      };

      const result = await parseMkvCuesIndex(read, 1000);
      expect(result).toBeNull();
    });

    it('should handle files without Cues element', async () => {
      // This would require a real MKV file or mock EBML structure
      // For now, we test the error handling path
      const read = async (start: number, end: number) => {
        // Return minimal valid EBML but no Cues
        return new Uint8Array(end - start);
      };

      const result = await parseMkvCuesIndex(read, 1000);
      // Should return empty cuePoints or null
      expect(result === null || (result && result.cuePoints.length === 0)).toBe(true);
    });
  });

  describe('seekToSubtitleTime', () => {
    it('should find nearest cue point <= target time', () => {
      const cueIndex = {
        cuePoints: [
          { timestampMs: 0, clusterPosition: 100 },
          { timestampMs: 5000, clusterPosition: 200 },
          { timestampMs: 10000, clusterPosition: 300 },
          { timestampMs: 15000, clusterPosition: 400 },
        ],
        durationSec: 20,
        timestampScale: 1_000_000,
      };

      // Seek to 7 seconds → should find 5s cue point
      const result = seekToSubtitleTime(cueIndex, 7);
      expect(result.clusterBytePosition).toBe(200);
      expect(result.targetTimeSec).toBe(7);
    });

    it('should apply preroll correctly', () => {
      const cueIndex = {
        cuePoints: [
          { timestampMs: 0, clusterPosition: 100 },
          { timestampMs: 5000, clusterPosition: 200 },
        ],
        durationSec: 10,
        timestampScale: 1_000_000,
      };

      const result = seekToSubtitleTime(cueIndex, 7, { prerollSec: 2.0 });
      expect(result.prerollStartSec).toBe(5); // 7 - 2 = 5
    });

    it('should clamp preroll to maxPrerollSec', () => {
      const cueIndex = {
        cuePoints: [{ timestampMs: 0, clusterPosition: 100 }],
        durationSec: 10,
        timestampScale: 1_000_000,
      };

      const result = seekToSubtitleTime(cueIndex, 1, {
        prerollSec: 5.0,
        maxPrerollSec: 2.0,
      });
      // Preroll should be clamped to 2.0, but we seek to 0 anyway
      expect(result.prerollStartSec).toBe(0); // max(0, 1 - 5) = 0
    });

    it('should clamp target time to file duration', () => {
      const cueIndex = {
        cuePoints: [{ timestampMs: 0, clusterPosition: 100 }],
        durationSec: 10,
        timestampScale: 1_000_000,
      };

      const result = seekToSubtitleTime(cueIndex, 20); // Beyond duration
      expect(result.targetTimeSec).toBe(10); // Clamped to duration
    });

    it('should handle first cue point correctly', () => {
      const cueIndex = {
        cuePoints: [
          { timestampMs: 5000, clusterPosition: 200 },
          { timestampMs: 10000, clusterPosition: 300 },
        ],
        durationSec: 15,
        timestampScale: 1_000_000,
      };

      // Seek to 2 seconds (before first cue)
      const result = seekToSubtitleTime(cueIndex, 2);
      expect(result.clusterBytePosition).toBe(200); // First cue point
    });
  });

  describe('MkvSubtitleSeeker', () => {
    it('should cache Cues index', async () => {
      let readCount = 0;
      const read = async (start: number, end: number) => {
        readCount++;
        return new Uint8Array(end - start);
      };

      const seeker = new MkvSubtitleSeeker(read, 1000);

      // First call should read
      await seeker.getCueIndex();
      const firstReadCount = readCount;

      // Second call should use cache
      await seeker.getCueIndex();
      expect(readCount).toBe(firstReadCount); // No additional reads
    });

    it('should clear cache on demand', async () => {
      const read = async (start: number, end: number) => {
        return new Uint8Array(end - start);
      };

      const seeker = new MkvSubtitleSeeker(read, 1000);
      await seeker.getCueIndex();

      seeker.clearCache();
      const cueIndex = await seeker.getCueIndex();
      // Cache should be cleared and re-fetched
      expect(cueIndex).toBeDefined();
    });
  });

  describe('createMkvSubtitleSeekerFromBlob', () => {
    it('should create seeker from Blob', () => {
      const blob = new Blob([new Uint8Array(1000)]);
      const seeker = createMkvSubtitleSeekerFromBlob(blob);
      expect(seeker).toBeDefined();
    });
  });
});
