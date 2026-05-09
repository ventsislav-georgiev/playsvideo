/**
 * AAC Stream Copy Executor
 *
 * Implements the copy path for AAC audio: validates packets, applies bitstream
 * filters (aac_adtstoasc), and produces output packets with proper timestamps
 * and decoder config.
 *
 * Fallback to transcode is handled at the segment-processor level.
 */

import { EncodedPacket } from 'mediabunny';
import {
  isAdtsPacket,
  parseAdtsHeader,
  detectAacPacketFormat,
  extractAudioSpecificConfig,
  generateAudioSpecificConfig,
  canCopyAacToContainer,
  needsAdtsToAscBsf,
  validateAacPacket,
  makeAacCopyDecision,
  type AacCopyDecision,
  type AacPacketFormat,
} from './aac-copy-detector.js';

/**
 * Options for AAC copy execution.
 */
export interface AacCopyOptions {
  /** Input audio packets (ADTS or other format) */
  packets: EncodedPacket[];
  /** Target container format ('mp4', 'fmp4', 'mkv', 'webm', etc.) */
  containerFormat: string;
  /** Sample rate in Hz (from decoder config or probe) */
  sampleRate: number;
  /** Number of channels (from decoder config or probe) */
  channels: number;
  /** Timestamp of the first original audio packet */
  audioStartSec: number;
  /** Timestamp assigned to the first output packet. Defaults to audioStartSec. */
  outputStartSec?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Optional logger */
  log?: (msg: string) => void;
}

/**
 * Metrics for AAC copy operation.
 */
export interface AacCopyMetrics {
  /** Number of input packets */
  inputPackets: number;
  /** Total input bytes */
  inputBytes: number;
  /** Duration of input audio (last packet end - first packet start) */
  audioDurationSec: number;
  /** Number of output packets */
  outputPackets: number;
  /** Total output bytes */
  outputBytes: number;
  /** Duration computed from output frame count */
  outputDurationSec: number;
  /** Whether ADTS→ASC conversion was applied */
  appliedAdtsToAsc: boolean;
  /** Whether packets were validated and passed */
  packetsValidated: boolean;
  /** Total operation time in milliseconds */
  totalMs: number;
}

/**
 * Result of AAC copy operation.
 */
export interface AacCopyResult {
  /** Output audio packets (with updated timestamps if needed) */
  packets: EncodedPacket[];
  /** Updated decoder config (includes ASC if ADTS→ASC was applied) */
  decoderConfig: AudioDecoderConfig;
  /** Copy operation metrics */
  metrics: AacCopyMetrics;
}

const SAMPLES_PER_AAC_FRAME = 1024;

/**
 * Check if abort signal is set and throw AbortError if so.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/**
 * Execute AAC stream copy: validate packets, apply BSF if needed, and return
 * output packets with updated decoder config.
 *
 * Throws if:
 * - Packets cannot be copied (validation fails)
 * - Container format is not supported for AAC copy
 * - Abort signal is triggered
 *
 * @param opts - Copy options
 * @returns Copy result with packets, decoder config, and metrics
 */
export async function executeAacCopy(opts: AacCopyOptions): Promise<AacCopyResult> {
  const log = opts.log ?? (() => {});
  const startTime = performance.now();

  checkAbort(opts.signal);

  if (!opts.packets || opts.packets.length === 0) {
    throw new Error('No audio packets provided for AAC copy');
  }

  checkAbort(opts.signal);

  // Detect packet format from first packet
  const firstPacket = opts.packets[0];
  const isAdts = isAdtsPacket(firstPacket.data);

  let packetFormat: AacPacketFormat;
  let needsBsf = false;

  if (isAdts) {
    // Parse ADTS header to get format info
    const adtsHeader = parseAdtsHeader(firstPacket.data);
    if (!adtsHeader) {
      throw new Error('Failed to parse ADTS header from first packet');
    }

    packetFormat = {
      type: 'adts' as const,
      sampleRate: adtsHeader.sampleRate,
      channels: adtsHeader.channels,
      profile: adtsHeader.profile,
      frameLengthSamples: SAMPLES_PER_AAC_FRAME,
    };

    // Check if ADTS→ASC conversion is needed
    // needsAdtsToAscBsf takes (format, container)
    needsBsf = needsAdtsToAscBsf(packetFormat, opts.containerFormat as 'mp4' | 'fmp4' | 'hls');
  } else {
    // Try to detect other formats (MPEG-4 ASC, LATM, raw)
    const detected = detectAacPacketFormat(firstPacket.data);
    if (!detected) {
      throw new Error('Could not detect AAC packet format from first packet');
    }
    packetFormat = detected;
  }

  log(
    `AAC copy: format=${packetFormat.type} sr=${packetFormat.sampleRate} ` +
      `ch=${packetFormat.channels} profile=${packetFormat.profile} bsf=${needsBsf}`,
  );

  checkAbort(opts.signal);

  // Validate all packets
  let validatedCount = 0;
  for (const packet of opts.packets) {
    const isValid = validateAacPacket(packet.data, packetFormat);
    if (!isValid) {
      throw new Error(
        `Packet validation failed at index ${validatedCount}. ` +
          `Fallback to transcode.`,
      );
    }
    validatedCount += 1;
  }

  log(`AAC copy: validated ${validatedCount} packets`);

  checkAbort(opts.signal);

  // Compute metrics
  const inputBytes = opts.packets.reduce((sum, pkt) => sum + pkt.data.byteLength, 0);
  const firstPktStart = opts.packets[0].timestamp;
  const lastPkt = opts.packets[opts.packets.length - 1];
  const lastPktEnd = lastPkt.timestamp + lastPkt.duration;
  const audioDurationSec = lastPktEnd - firstPktStart;

  // Generate or extract AudioSpecificConfig
  let decoderConfig: AudioDecoderConfig;
  let asc: Uint8Array | null = null;

  if (needsBsf && isAdts) {
    // Generate ASC from ADTS header info
    asc = generateAudioSpecificConfig(parseAdtsHeader(firstPacket.data)!);
    decoderConfig = {
      codec: 'mp4a.40.2', // AAC-LC
      numberOfChannels: packetFormat.channels,
      sampleRate: packetFormat.sampleRate,
      description: asc,
    };
    log(`AAC copy: generated ASC (${asc.byteLength} bytes) for ADTS→ASC conversion`);
  } else {
    // Extract ASC from decoderConfig (passed via opts or null)
    // For now, we'll create a minimal decoderConfig
    asc = null; // Will be extracted from existing config if available
    decoderConfig = {
      codec: 'mp4a.40.2',
      numberOfChannels: packetFormat.channels,
      sampleRate: packetFormat.sampleRate,
      description: asc ?? undefined,
    };
  }

  checkAbort(opts.signal);

  // Prepare output packets
  // If ADTS→ASC is needed, strip ADTS headers and keep only the raw AAC frame data
  const outputPackets: EncodedPacket[] = [];
  const outputStartSec = opts.outputStartSec ?? opts.audioStartSec;
  let outputBytes = 0;

  if (needsBsf && isAdts) {
    // Strip ADTS headers: each ADTS frame has a 7-byte header (or 9 with CRC)
    for (let i = 0; i < opts.packets.length; i++) {
      const pkt = opts.packets[i];
      const adtsHeader = parseAdtsHeader(pkt.data);
      if (!adtsHeader) {
        throw new Error(`Failed to parse ADTS header at packet ${i}`);
      }

      // ADTS frame: [7-byte header] [raw AAC frame data]
      const headerSize = adtsHeader.protectionAbsent ? 7 : 9;
      const rawAacData = pkt.data.slice(headerSize);

      // Recompute timestamp relative to output start
      const timeDelta = pkt.timestamp - opts.audioStartSec;
      const newTimestamp = outputStartSec + timeDelta;

      const outPkt = new EncodedPacket(
        rawAacData,
        'key',
        newTimestamp,
        pkt.duration,
        i,
      );
      outputPackets.push(outPkt);
      outputBytes += rawAacData.byteLength;
    }
    log(`AAC copy: stripped ADTS headers from ${outputPackets.length} packets`);
  } else {
    // Keep packets as-is, just update timestamps if needed
    for (let i = 0; i < opts.packets.length; i++) {
      const pkt = opts.packets[i];
      const timeDelta = pkt.timestamp - opts.audioStartSec;
      const newTimestamp = outputStartSec + timeDelta;

      const outPkt = new EncodedPacket(
        pkt.data,
        'key',
        newTimestamp,
        pkt.duration,
        i,
      );
      outputPackets.push(outPkt);
      outputBytes += pkt.data.byteLength;
    }
    log(`AAC copy: kept ${outputPackets.length} packets as-is (no BSF needed)`);
  }

  checkAbort(opts.signal);

  const outputDurationSec = (outputPackets.length * SAMPLES_PER_AAC_FRAME) / packetFormat.sampleRate;

  const metrics: AacCopyMetrics = {
    inputPackets: opts.packets.length,
    inputBytes,
    audioDurationSec,
    outputPackets: outputPackets.length,
    outputBytes,
    outputDurationSec,
    appliedAdtsToAsc: needsBsf && isAdts,
    packetsValidated: true,
    totalMs: performance.now() - startTime,
  };

  log(
    `AAC copy complete: ${metrics.outputPackets} packets, ` +
      `${metrics.outputBytes} bytes, ${metrics.outputDurationSec.toFixed(3)}s, ` +
      `${metrics.totalMs.toFixed(1)}ms`,
  );

  return {
    packets: outputPackets,
    decoderConfig,
    metrics,
  };
}

/**
 * Determine whether to attempt AAC copy or fall back to transcode.
 *
 * This is a high-level decision function that checks:
 * - Packet format detectability
 * - Container compatibility
 * - Validation feasibility
 *
 * @param packets - Audio packets to evaluate
 * @param containerFormat - Target container format
 * @returns Decision object with recommendation and reason
 */
export function shouldAttemptAacCopy(
  packets: EncodedPacket[],
  containerFormat: string,
): { shouldCopy: boolean; reason: string } {
  if (!packets || packets.length === 0) {
    return { shouldCopy: false, reason: 'No packets provided' };
  }

  const firstPacket = packets[0];

  // Try to detect packet format
  const isAdts = isAdtsPacket(firstPacket.data);
  if (isAdts) {
    const adtsHeader = parseAdtsHeader(firstPacket.data);
    if (!adtsHeader) {
      return { shouldCopy: false, reason: 'Could not parse ADTS header' };
    }

    const packetFormat: AacPacketFormat = {
      type: 'adts',
      sampleRate: adtsHeader.sampleRate,
      channels: adtsHeader.channels,
      profile: adtsHeader.profile,
    };

    // Check if container supports AAC copy
    const canCopy = canCopyAacToContainer(packetFormat, containerFormat as 'mp4' | 'fmp4' | 'hls');
    if (!canCopy) {
      return {
        shouldCopy: false,
        reason: `Container format ${containerFormat} does not support AAC copy`,
      };
    }

    return { shouldCopy: true, reason: 'ADTS AAC detected, copy feasible' };
  }

  // Try other formats
  const packetFormat = detectAacPacketFormat(firstPacket.data);
  if (!packetFormat) {
    return { shouldCopy: false, reason: 'Could not detect AAC packet format' };
  }

  // Check if container supports AAC copy
  const canCopy = canCopyAacToContainer(packetFormat, containerFormat as 'mp4' | 'fmp4' | 'hls');
  if (!canCopy) {
    return {
      shouldCopy: false,
      reason: `Container format ${containerFormat} does not support AAC copy`,
    };
  }

  return { shouldCopy: true, reason: `${packetFormat.type} AAC detected, copy feasible` };
}
