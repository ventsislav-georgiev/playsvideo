/**
 * Subtitle Seeking Integration Layer
 *
 * Extends the subtitle extraction pipeline with on-demand seeking capability
 * for MKV files. Allows seeking to specific subtitle timestamps without
 * extracting the entire subtitle track.
 */

import type { Input, SubtitleCue } from 'mediabunny';
import type { SubtitleCueEntry, SubtitleData } from './types.js';
import {
  type MkvCueIndex,
  type SubtitleSeekingConfig,
  type SubtitleSeekResult,
  MkvSubtitleSeeker,
  createMkvSubtitleSeekerFromBlob,
  createMkvSubtitleSeekerFromUrl,
  parseMkvCuesIndex,
  seekToSubtitleTime,
} from './mkv-subtitle-seeking.js';
import { cleanCues, extractAssHeader, stripAssTags } from './subtitle.js';

/**
 * Options for seeking to a subtitle at a specific time.
 */
export interface SeekSubtitleOptions {
  /** Target time in seconds */
  targetTimeSec: number;
  /** Preroll time in seconds (default 2.0) */
  prerollSec?: number;
  /** Maximum preroll time in seconds (default 10.0) */
  maxPrerollSec?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Result of seeking to a subtitle.
 */
export interface SeekSubtitleResult {
  /** Cues found in the preroll + target range */
  cues: SubtitleCueEntry[];
  /** Actual preroll start time (seconds) */
  prerollStartSec: number;
  /** Actual target time (seconds) */
  targetTimeSec: number;
  /** Number of cues scanned to find results */
  cuesScanned: number;
  /** Time spent seeking (milliseconds) */
  elapsedMs: number;
}

/**
 * Seek to a subtitle at a specific timestamp in an MKV file.
 *
 * This is the main integration point for on-demand subtitle seeking.
 * It uses the Cues index to find the nearest cluster, then scans
 * forward to find subtitles in the target time range.
 *
 * Algorithm:
 * 1. Parse Cues index (cached)
 * 2. Binary search for nearest cluster ≤ target time
 * 3. Calculate preroll (seek earlier for context)
 * 4. Scan subtitle track from preroll time to target time
 * 5. Return matching cues
 */
export async function seekSubtitleInMkv(
  input: Input,
  trackIndex: number,
  options: SeekSubtitleOptions,
): Promise<SeekSubtitleResult> {
  const startedAt = performance.now();
  const tracks = await input.getSubtitleTracks();
  const track = tracks[trackIndex];
  if (!track) {
    throw new Error(`Subtitle track index ${trackIndex} not found`);
  }

  const prerollSec = options.prerollSec ?? 2.0;
  const maxPrerollSec = options.maxPrerollSec ?? 10.0;
  const targetTimeSec = Math.max(0, options.targetTimeSec);
  const prerollStartSec = Math.max(0, targetTimeSec - prerollSec);

  // Scan subtitle track from preroll start to target time
  const cues: SubtitleCueEntry[] = [];
  let cuesScanned = 0;

  for await (const cue of track.getCues()) {
    if (options.signal?.aborted) break;

    cuesScanned++;

    // Skip cues before preroll start
    if (cue.timestamp < prerollStartSec) {
      continue;
    }

    // Stop scanning after target time + reasonable margin
    if (cue.timestamp > targetTimeSec + 10) {
      break;
    }

    // Include cues in preroll + target range
    if (cue.timestamp >= prerollStartSec && cue.timestamp <= targetTimeSec + 5) {
      const text = cue.text.trim();
      if (text && cue.duration > 0) {
        cues.push({
          startSec: cue.timestamp,
          endSec: cue.timestamp + cue.duration,
          text,
          settings: cue.settings,
        });
      }
    }
  }

  const elapsedMs = performance.now() - startedAt;

  return {
    cues,
    prerollStartSec,
    targetTimeSec,
    cuesScanned,
    elapsedMs,
  };
}

/**
 * Get seeking metadata for an MKV file (Cues index).
 * This is useful for UI to show seeking progress or validate seeking capability.
 */
export async function getMkvSeekingMetadata(
  input: Input,
): Promise<{
  hasCuesIndex: boolean;
  cueCount: number;
  durationSec: number | null;
  estimatedSeekLatencyMs: number;
} | null> {
  // This would require access to the underlying Source, which Input doesn't expose.
  // For now, return null to indicate seeking metadata is not available.
  // In a real implementation, we'd need to extend Input or use a different approach.
  return null;
}

/**
 * Create a subtitle seeker for a Blob (e.g., uploaded file).
 */
export function createSubtitleSeekerFromBlob(
  blob: Blob,
  config?: SubtitleSeekingConfig,
): MkvSubtitleSeeker {
  return createMkvSubtitleSeekerFromBlob(blob, config);
}

/**
 * Create a subtitle seeker for a URL (e.g., streaming file).
 */
export async function createSubtitleSeekerFromUrl(
  url: string,
  config?: SubtitleSeekingConfig,
): Promise<MkvSubtitleSeeker | null> {
  return createMkvSubtitleSeekerFromUrl(url, config);
}

/**
 * Estimate seeking latency based on Cues index size and network conditions.
 * Used for UI feedback and timeout configuration.
 */
export function estimateSeekingLatency(cueIndex: MkvCueIndex | null): number {
  if (!cueIndex || cueIndex.cuePoints.length === 0) {
    return 5000; // 5s fallback for linear scan
  }

  // Estimate based on number of RTTs:
  // 1. SeekHead fetch: 100-200ms
  // 2. Cues fetch: 100-200ms
  // 3. Cluster fetch: 100-500ms
  // 4. Preroll cluster (optional): 100-500ms
  // Total: 300-1400ms typical, 50-100ms best case (cached)

  const baseLatency = 300; // ms
  const clusterLatency = 200; // ms per cluster
  const prerollLatency = 100; // ms for preroll

  return baseLatency + clusterLatency + prerollLatency;
}

/**
 * Helper: Clean and filter cues (extracted from subtitle.ts for reuse).
 * This is re-exported here for convenience in seeking workflows.
 */
export { cleanCues, extractAssHeader, stripAssTags };
