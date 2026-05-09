/**
 * AAC Copy Integration Layer
 *
 * Bridges AAC copy executor into the segment processor workflow.
 * Provides decision logic and fallback handling for copy vs. transcode.
 */

import type { EncodedPacket } from 'mediabunny';
import {
  executeAacCopy,
  shouldAttemptAacCopy,
  type AacCopyResult,
  type AacCopyMetrics,
} from './aac-copy-executor.js';
import type { AudioTranscodeExecutor, TranscodeResult } from './audio-transcode.js';

/**
 * Configuration for AAC copy integration.
 */
export interface AacCopyIntegrationConfig {
  /** Whether to attempt AAC copy before falling back to transcode */
  enableAacCopy: boolean;
  /** Target container format (e.g., 'mp4', 'fmp4', 'mkv') */
  containerFormat: string;
  /** Source audio codec (e.g., 'aac', 'ac3', 'mp3') */
  sourceCodec: string | null;
  /** Fallback transcode executor (used if copy fails) */
  transcodeExecutor: AudioTranscodeExecutor;
  /** Optional logger */
  log?: (msg: string) => void;
}

/**
 * Result of copy-or-transcode decision.
 */
export interface CopyOrTranscodeResult {
  /** Whether copy was attempted and succeeded */
  copiedSuccessfully: boolean;
  /** Copy metrics if copy was attempted */
  copyMetrics?: AacCopyMetrics;
  /** Transcode metrics if transcode was used */
  transcodeMetrics?: any; // TranscodeMetrics from audio-transcode
  /** Final output packets */
  packets: EncodedPacket[];
  /** Final decoder config */
  decoderConfig: AudioDecoderConfig;
  /** Reason for the decision (copy/transcode/fallback) */
  reason: string;
}

/**
 * Attempt AAC copy, with automatic fallback to transcode on failure.
 *
 * Decision logic:
 * 1. If enableAacCopy is false, skip to transcode
 * 2. If source codec is not AAC, skip to transcode
 * 3. If shouldAttemptAacCopy returns false, skip to transcode
 * 4. Try executeAacCopy; if it succeeds, return copy result
 * 5. If copy fails, log warning and fall back to transcode
 *
 * @param packets - Audio packets to process
 * @param config - Integration configuration
 * @param transcodeOpts - Options to pass to transcode executor if fallback is needed
 * @param signal - Abort signal
 * @returns Copy or transcode result
 */
export async function copyOrTranscode(
  packets: EncodedPacket[],
  config: AacCopyIntegrationConfig,
  transcodeOpts: Parameters<AudioTranscodeExecutor>[0],
  signal?: AbortSignal,
): Promise<CopyOrTranscodeResult> {
  const log = config.log ?? (() => {});

  // Check if copy is enabled
  if (!config.enableAacCopy) {
    log('AAC copy disabled, using transcode');
    const transcodeResult = await config.transcodeExecutor(transcodeOpts, signal);
    return {
      copiedSuccessfully: false,
      transcodeMetrics: transcodeResult.metrics,
      packets: transcodeResult.packets,
      decoderConfig: transcodeResult.decoderConfig,
      reason: 'AAC copy disabled',
    };
  }

  // Check if source codec is AAC
  if (config.sourceCodec !== 'aac') {
    log(`Source codec is ${config.sourceCodec}, not AAC; using transcode`);
    const transcodeResult = await config.transcodeExecutor(transcodeOpts, signal);
    return {
      copiedSuccessfully: false,
      transcodeMetrics: transcodeResult.metrics,
      packets: transcodeResult.packets,
      decoderConfig: transcodeResult.decoderConfig,
      reason: `Source codec ${config.sourceCodec} requires transcode`,
    };
  }

  // Check if copy is feasible
  const decision = shouldAttemptAacCopy(packets, config.containerFormat);
  if (!decision.shouldCopy) {
    log(`AAC copy not feasible: ${decision.reason}; using transcode`);
    const transcodeResult = await config.transcodeExecutor(transcodeOpts, signal);
    return {
      copiedSuccessfully: false,
      transcodeMetrics: transcodeResult.metrics,
      packets: transcodeResult.packets,
      decoderConfig: transcodeResult.decoderConfig,
      reason: `Copy not feasible: ${decision.reason}`,
    };
  }

  // Attempt copy
  log(`Attempting AAC copy: ${decision.reason}`);
  try {
    const copyResult = await executeAacCopy(
      {
        packets,
        containerFormat: config.containerFormat,
        sampleRate: transcodeOpts.sampleRate,
        channels: transcodeOpts.audioDecoderConfig?.numberOfChannels ?? 2,
        audioStartSec: transcodeOpts.audioStartSec,
        outputStartSec: transcodeOpts.outputStartSec,
        signal,
        log,
      },
    );

    log(
      `AAC copy succeeded: ${copyResult.metrics.outputPackets} packets, ` +
        `${copyResult.metrics.outputBytes} bytes, ` +
        `${copyResult.metrics.totalMs.toFixed(1)}ms`,
    );

    return {
      copiedSuccessfully: true,
      copyMetrics: copyResult.metrics,
      packets: copyResult.packets,
      decoderConfig: copyResult.decoderConfig,
      reason: 'AAC copy succeeded',
    };
  } catch (error) {
    // Copy failed; fall back to transcode
    const errorMsg = error instanceof Error ? error.message : String(error);
    log(`AAC copy failed: ${errorMsg}; falling back to transcode`);

    try {
      const transcodeResult = await config.transcodeExecutor(transcodeOpts, signal);
      return {
        copiedSuccessfully: false,
        transcodeMetrics: transcodeResult.metrics,
        packets: transcodeResult.packets,
        decoderConfig: transcodeResult.decoderConfig,
        reason: `Copy failed (${errorMsg}), transcoded instead`,
      };
    } catch (transcodeError) {
      // Both copy and transcode failed
      const transcodeErrorMsg = transcodeError instanceof Error ? transcodeError.message : String(transcodeError);
      throw new Error(
        `AAC copy failed (${errorMsg}) and transcode fallback also failed (${transcodeErrorMsg})`,
      );
    }
  }
}

/**
 * Determine whether to enable AAC copy based on source codec and container.
 *
 * Returns true if:
 * - Source codec is AAC
 * - Container format supports AAC copy (mp4, fmp4, mkv, webm)
 *
 * @param sourceCodec - Source audio codec
 * @param containerFormat - Target container format
 * @returns Whether AAC copy should be enabled
 */
export function shouldEnableAacCopy(sourceCodec: string | null, containerFormat: string): boolean {
  if (sourceCodec !== 'aac') {
    return false;
  }

  const supportedContainers = ['mp4', 'fmp4', 'mkv', 'webm'];
  return supportedContainers.includes(containerFormat.toLowerCase());
}
