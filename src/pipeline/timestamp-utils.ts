import type { EncodedPacket } from 'mediabunny';

/**
 * Centralized timestamp utilities for the mux pipeline.
 *
 * The pipeline uses seconds (floating-point) for all timestamps.
 * WebCodecs VideoFrame.timestamp is in microseconds (integer).
 *
 * Key constants:
 * - USEC_PER_SEC = 1_000_000 (microseconds per second)
 * - EPSILON_SEC = 1 / 1000 (1 millisecond tolerance for floating-point comparisons)
 */

export const USEC_PER_SEC = 1_000_000;
export const EPSILON_SEC = 1 / 1000; // 1 millisecond

/**
 * Convert seconds (floating-point) to microseconds (integer).
 * Used when passing timestamps to WebCodecs APIs.
 *
 * @param sec - Time in seconds
 * @returns Time in microseconds, rounded to nearest integer
 */
export function secToUsec(sec: number): number {
  return Math.round(sec * USEC_PER_SEC);
}

/**
 * Convert microseconds (integer) to seconds (floating-point).
 * Used when receiving timestamps from WebCodecs APIs.
 *
 * @param usec - Time in microseconds
 * @returns Time in seconds
 */
export function usecToSec(usec: number): number {
  return usec / USEC_PER_SEC;
}

/**
 * Check if a timestamp is valid (finite, non-negative).
 *
 * @param ts - Timestamp in seconds
 * @returns true if valid
 */
export function isValidTimestamp(ts: number): boolean {
  return Number.isFinite(ts) && ts >= 0;
}

/**
 * Check if two timestamps are approximately equal within EPSILON_SEC tolerance.
 *
 * @param ts1 - First timestamp in seconds
 * @param ts2 - Second timestamp in seconds
 * @returns true if |ts1 - ts2| <= EPSILON_SEC
 */
export function timestampsEqual(ts1: number, ts2: number): boolean {
  return Math.abs(ts1 - ts2) <= EPSILON_SEC;
}

/**
 * Check if ts1 is approximately less than ts2 (accounting for floating-point error).
 *
 * @param ts1 - First timestamp in seconds
 * @param ts2 - Second timestamp in seconds
 * @returns true if ts1 < ts2 - EPSILON_SEC
 */
export function timestampLess(ts1: number, ts2: number): boolean {
  return ts1 < ts2 - EPSILON_SEC;
}

/**
 * Check if ts1 is approximately greater than ts2 (accounting for floating-point error).
 *
 * @param ts1 - First timestamp in seconds
 * @param ts2 - Second timestamp in seconds
 * @returns true if ts1 > ts2 + EPSILON_SEC
 */
export function timestampGreater(ts1: number, ts2: number): boolean {
  return ts1 > ts2 + EPSILON_SEC;
}

/**
 * Check if ts1 is approximately less than or equal to ts2.
 *
 * @param ts1 - First timestamp in seconds
 * @param ts2 - Second timestamp in seconds
 * @returns true if ts1 <= ts2 + EPSILON_SEC
 */
export function timestampLessOrEqual(ts1: number, ts2: number): boolean {
  return ts1 <= ts2 + EPSILON_SEC;
}

/**
 * Check if ts1 is approximately greater than or equal to ts2.
 *
 * @param ts1 - First timestamp in seconds
 * @param ts2 - Second timestamp in seconds
 * @returns true if ts1 >= ts2 - EPSILON_SEC
 */
export function timestampGreaterOrEqual(ts1: number, ts2: number): boolean {
  return ts1 >= ts2 - EPSILON_SEC;
}

/**
 * Validate basic packet timestamp ordering invariants.
 *
 * Encoded video packets are passed through in decode order while their
 * timestamps are presentation timestamps. B-frames therefore legitimately make
 * video presentation timestamps non-monotonic in packet order. Audio has no
 * equivalent reordering in this pipeline, so audio timestamps must remain
 * monotonic.
 *
 * @param videoPackets - Video packets to validate
 * @param audioPackets - Audio packets to validate
 * @param segmentIndex - Segment index for error messages
 * @throws Error if timestamps are not monotonically increasing
 */
export function assertMonotonicTimestamps(
  videoPackets: EncodedPacket[],
  audioPackets: EncodedPacket[],
  segmentIndex: number,
): void {
  for (let i = 0; i < videoPackets.length; i++) {
    const packet = videoPackets[i];
    if (!isValidTimestamp(packet.timestamp)) {
      throw new Error(
        `seg ${segmentIndex} video packet ${i} invalid timestamp: ${packet.timestamp}`,
      );
    }
  }

  for (let i = 1; i < audioPackets.length; i++) {
    const prev = audioPackets[i - 1];
    const curr = audioPackets[i];
    if (curr.timestamp < prev.timestamp) {
      throw new Error(
        `seg ${segmentIndex} audio packet ${i} timestamp regression: ` +
        `packet[${i - 1}].timestamp=${prev.timestamp.toFixed(6)} > ` +
        `packet[${i}].timestamp=${curr.timestamp.toFixed(6)}`
      );
    }
  }
}
