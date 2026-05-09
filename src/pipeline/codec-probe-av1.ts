/**
 * AV1-aware codec prober that integrates WebCodecs-based capability detection.
 *
 * This module wraps the standard codec prober and adds AV1-specific handling:
 * - Detects AV1 support via WebCodecs API (more reliable than MSE on Safari/iOS)
 * - Falls back to H.264 when AV1 is unsupported
 * - Provides diagnostic information for debugging
 */

import { getCachedAv1Support, getAv1Fallback } from '../av1-capability.js';
import type { CodecProber } from './codec-probe.js';

export interface Av1AwareCodecProber extends CodecProber {
  /** Get AV1 support status (cached). */
  getAv1Support(): Promise<'supported' | 'unsupported' | 'unknown'>;
  /** Check if AV1 should be used or if fallback is needed. */
  shouldUseAv1(): Promise<boolean>;
  /** Get fallback codec when AV1 is unavailable. */
  getAv1Fallback(): 'avc' | 'vp9';
}

/**
 * Wraps a standard CodecProber with AV1-aware logic.
 * When AV1 is requested but unsupported, automatically suggests fallback codec.
 */
export function createAv1AwareProber(baseProber: CodecProber): Av1AwareCodecProber {
  let av1SupportCache: 'supported' | 'unsupported' | 'unknown' | null = null;

  return {
    canPlayAudio(shortCodec, fullCodecString) {
      return baseProber.canPlayAudio(shortCodec, fullCodecString);
    },

    canPlayVideo(shortCodec, fullCodecString) {
      // For AV1, check WebCodecs support first
      if (shortCodec === 'av1') {
        // This is async, but we can't await here. Return false and let caller use getAv1Support()
        // For synchronous checks, fall back to MSE
        return baseProber.canPlayVideo(shortCodec, fullCodecString);
      }
      return baseProber.canPlayVideo(shortCodec, fullCodecString);
    },

    async getAv1Support() {
      if (av1SupportCache !== null) {
        return av1SupportCache;
      }
      av1SupportCache = await getCachedAv1Support();
      return av1SupportCache;
    },

    async shouldUseAv1() {
      const support = await this.getAv1Support();
      return support === 'supported';
    },

    getAv1Fallback() {
      return getAv1Fallback();
    },
  };
}

/**
 * Diagnostic helper: checks AV1 support and returns detailed status.
 */
export async function diagnoseAv1Support(): Promise<{
  av1Support: 'supported' | 'unsupported' | 'unknown';
  mseSupport: boolean;
  webCodecsAvailable: boolean;
  recommendation: 'use-av1' | 'use-fallback' | 'unknown';
  fallbackCodec: 'avc' | 'vp9';
}> {
  const av1Support = await getCachedAv1Support();
  const webCodecsAvailable = 'VideoDecoder' in globalThis;
  const mseSupport = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="av01.0.01M.08"');

  return {
    av1Support,
    mseSupport,
    webCodecsAvailable,
    recommendation: av1Support === 'supported' ? 'use-av1' : 'use-fallback',
    fallbackCodec: getAv1Fallback(),
  };
}
