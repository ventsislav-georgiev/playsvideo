import { EncodedPacket, type EncodedPacketSink } from 'mediabunny';
import type { AudioTranscodeExecutor } from './audio-transcode.js';
import { collectPacketsInRange, type SegmentBoundaryResolver } from './demux.js';
import { muxToFmp4 } from './mux.js';
import { checkAbort } from './source-signal.js';
import type { PlannedSegment } from './types.js';

const AAC_SAMPLES_PER_FRAME = 1024;
const AUDIO_TRANSCODE_PREROLL_FRAMES = 6;
const AUDIO_TRANSCODE_POSTROLL_FRAMES = 6;

export interface SegmentProcessorConfig {
  videoSink: EncodedPacketSink;
  audioSink: EncodedPacketSink | null;
  videoCodec: string;
  audioCodec: string | null;
  videoDecoderConfig: VideoDecoderConfig;
  sourceAudioDecoderConfig?: AudioDecoderConfig | null;
  audioDecoderConfig: AudioDecoderConfig | null;
  plan: PlannedSegment[];
  doTranscode: boolean;
  transcodeAudio: AudioTranscodeExecutor;
  sourceCodec?: string;
  resolveSegmentBoundary?: SegmentBoundaryResolver;
  log?: (msg: string) => void;
}

export interface SegmentProcessorResult {
  mediaData: Uint8Array;
  initSegment: Uint8Array | null;
  /** Updated audioDecoderConfig if transcode changed it */
  audioDecoderConfig: AudioDecoderConfig | null;
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

/**
 * Processes a single segment through the pipeline: collect packets → transcode → mux.
 *
 * Accepts an AbortSignal and checks it between stages. If aborted, throws AbortError.
 * Does NOT modify any shared mutable state — returns all results.
 */
export async function processSegmentWithAbort(
  config: SegmentProcessorConfig,
  index: number,
  signal?: AbortSignal,
): Promise<SegmentProcessorResult> {
  const log = config.log ?? (() => {});

  const plannedSeg = config.plan[index];
  if (!plannedSeg) throw new Error(`Invalid segment index: ${index}`);
  let seg = plannedSeg;
  if (config.resolveSegmentBoundary) {
    const startSec = await config.resolveSegmentBoundary(index);
    const endSec = await config.resolveSegmentBoundary(index + 1);
    seg = {
      ...plannedSeg,
      startSec,
      durationSec: Math.max(1 / 1000, endSec - startSec),
    };
  }
  const endSec = seg.startSec + seg.durationSec;
  log(`seg ${index} start range=[${seg.startSec.toFixed(2)},${endSec.toFixed(2)})`);

  checkAbort(signal);

  // Stage 1: Collect video packets
  const tVid = performance.now();
  const videoPackets = await collectPacketsInRange(config.videoSink, seg.startSec, endSec, {
    startFromKeyframe: true,
  });
  log(`seg ${index} video-collect ${elapsed(tVid)} pkts=${videoPackets.length}`);

  if (videoPackets.length > 0) {
    const first = videoPackets[0];
    const last = videoPackets[videoPackets.length - 1];
    const startDelta = first.timestamp - seg.startSec;
    const endGapBeforeStretch = endSec - (last.timestamp + last.duration);
    log(
      `seg ${index} continuity-video pre startDelta=${startDelta.toFixed(6)} endGap=${endGapBeforeStretch.toFixed(6)}`,
    );
  }

  // Stretch the last video frame's duration to cover to the segment boundary.
  // Without this, a gap forms between the last frame's end (timestamp+duration)
  // and the next segment's first keyframe — Safari MSE stalls at these gaps
  // and seeks past them, causing visible playback skips.
  if (videoPackets.length > 0) {
    const last = videoPackets[videoPackets.length - 1];
    const videoEnd = last.timestamp + last.duration;
    if (videoEnd < endSec) {
      const stretchedDuration = endSec - last.timestamp;
      videoPackets[videoPackets.length - 1] = new EncodedPacket(
        last.data,
        last.type,
        last.timestamp,
        stretchedDuration,
        last.sequenceNumber,
        last.byteLength,
        last.sideData,
      );
    }
  }

  if (videoPackets.length > 0) {
    const vidFirst = videoPackets[0].timestamp;
    const vidLast = videoPackets[videoPackets.length - 1];
    const vidEnd = vidLast.timestamp + vidLast.duration;
    log(
      `seg ${index} src-video ts=[${vidFirst.toFixed(4)},${vidEnd.toFixed(4)}] dur=${(vidEnd - vidFirst).toFixed(4)} pkts=${videoPackets.length}`,
    );
    log(
      `seg ${index} continuity-video post startDelta=${(vidFirst - seg.startSec).toFixed(6)} endGap=${(endSec - vidEnd).toFixed(6)}`,
    );
  }

  checkAbort(signal);

  // Stage 2: Collect audio packets
  const tAud = performance.now();
  let audioPackets: EncodedPacket[] = config.audioSink
    ? await collectPacketsInRange(config.audioSink, seg.startSec, endSec)
    : [];
  let transcodeAudioPackets = audioPackets;
  let transcodeTrimStartSec = 0;
  const outputSampleRate = config.audioDecoderConfig?.sampleRate ?? 48000;
  const outputFrameDurationSec = AAC_SAMPLES_PER_FRAME / outputSampleRate;
  const audioFrameStart = Math.round(seg.startSec / outputFrameDurationSec);
  const audioFrameEnd = Math.round(endSec / outputFrameDurationSec);
  const audioOutputStartSec = audioFrameStart * outputFrameDurationSec;
  const targetFrameCount = Math.max(0, audioFrameEnd - audioFrameStart);
  if (config.doTranscode && config.audioSink) {
    const prerollSec = AUDIO_TRANSCODE_PREROLL_FRAMES * outputFrameDurationSec;
    const postrollSec = AUDIO_TRANSCODE_POSTROLL_FRAMES * outputFrameDurationSec;
    const transcodeStartSec = index > 0 ? Math.max(0, seg.startSec - prerollSec) : seg.startSec;
    const transcodeEndSec = endSec + postrollSec;
    transcodeAudioPackets = await collectPacketsInRange(config.audioSink, transcodeStartSec, transcodeEndSec, {
      includePacketBeforeStart: true,
    });
    transcodeTrimStartSec = Math.max(0, seg.startSec - (transcodeAudioPackets[0]?.timestamp ?? seg.startSec));
  }
  log(`seg ${index} audio-collect ${elapsed(tAud)} pkts=${audioPackets.length}`);

  if (audioPackets.length > 0) {
    const srcFirst = audioPackets[0].timestamp;
    const srcLast = audioPackets[audioPackets.length - 1];
    const srcEnd = srcLast.timestamp + srcLast.duration;
    const srcDur = srcEnd - srcFirst;
    log(
      `seg ${index} src-audio ts=[${srcFirst.toFixed(4)},${srcEnd.toFixed(4)}] dur=${srcDur.toFixed(4)} pktDur=${audioPackets[0].duration.toFixed(6)}`,
    );
    log(
      `seg ${index} continuity-audio pre startDelta=${(srcFirst - seg.startSec).toFixed(6)} endGap=${(endSec - srcEnd).toFixed(6)}`,
    );
  }

  checkAbort(signal);

  // Stage 3: Transcode audio if needed (slow — ffmpeg.wasm)
  let audioDecoderConfig = config.audioDecoderConfig;
  if (config.doTranscode && transcodeAudioPackets.length > 0) {
    const sampleRate = outputSampleRate;
    const audioStartSec = transcodeAudioPackets[0].timestamp;
    const leadingSilenceSec = index === 0 ? Math.max(0, audioStartSec - seg.startSec) : 0;
    const audioStartDrift = audioOutputStartSec - seg.startSec;
    const audioEndDrift = audioFrameEnd * outputFrameDurationSec - endSec;
    log(
      `seg ${index} transcode-start sourceCodec=${config.sourceCodec ?? 'unknown'} packets=${transcodeAudioPackets.length} sourceDecoderConfig=${config.sourceAudioDecoderConfig ? 'yes' : 'no'} outputDecoderConfig=${config.audioDecoderConfig ? 'yes' : 'no'} frameWindow=[${audioFrameStart},${audioFrameEnd}) frameCount=${targetFrameCount} audioStartDrift=${audioStartDrift.toFixed(6)} audioEndDrift=${audioEndDrift.toFixed(6)}`,
    );
    const transcoded = await config.transcodeAudio(
      {
        packets: transcodeAudioPackets,
        sampleRate,
        audioStartSec,
        outputStartSec: audioOutputStartSec,
        trimStartSec: transcodeTrimStartSec,
        leadingSilenceSec,
        targetDurationSec: seg.durationSec,
        targetFrameCount,
        sourceCodec: config.sourceCodec,
        audioDecoderConfig: config.sourceAudioDecoderConfig ?? config.audioDecoderConfig,
      },
      signal,
    );
    const m = transcoded.metrics;
    const speed = m.ffmpegSpeed !== null ? ` speed=${m.ffmpegSpeed}x` : '';
    log(
      `seg ${index} transcode ${m.totalMs.toFixed(1)}ms base=${audioStartSec.toFixed(6)} planned=${seg.startSec.toFixed(6)} outputStart=${audioOutputStartSec.toFixed(6)} baseDelta=${(audioStartSec - seg.startSec).toFixed(6)} prerollTrim=${transcodeTrimStartSec.toFixed(6)} padStart=${leadingSilenceSec.toFixed(6)} targetDur=${seg.durationSec.toFixed(6)} targetFrames=${targetFrameCount} audio=${m.audioDurationSec.toFixed(2)}s outDur=${m.outputDurationSec.toFixed(2)}s ratio=${m.realtimeRatio.toFixed(4)}x ffmpeg=${m.ffmpegMs.toFixed(1)}ms${speed}`,
    );
    audioPackets = transcoded.packets;
    if (audioPackets.length > 0) {
      const outFirst = audioPackets[0].timestamp;
      const outLast = audioPackets[audioPackets.length - 1];
      const outEnd = outLast.timestamp + outLast.duration;
      const gapToSegEnd = endSec - outEnd;
      log(
        `seg ${index} out-audio sr=${transcoded.decoderConfig.sampleRate} frames=${audioPackets.length} ts=[${outFirst.toFixed(4)},${outEnd.toFixed(4)}] dur=${(outEnd - outFirst).toFixed(4)} gapToSegEnd=${gapToSegEnd.toFixed(4)}`,
      );
      log(
        `seg ${index} continuity-audio transcode startDelta=${(outFirst - seg.startSec).toFixed(6)} endGap=${gapToSegEnd.toFixed(6)}`,
      );
    }
    audioDecoderConfig = transcoded.decoderConfig;
  }

  // Keep encoded audio frames on their natural sample grid.  Safari is strict
  // about fMP4 audio sample durations in trun/tfhd; arbitrary retiming or
  // stretching of AAC frames can make an otherwise continuous fragment fail
  // during SourceBuffer.appendBuffer().
  if (audioPackets.length > 0) {
    const outFirst = audioPackets[0].timestamp;
    const outLast = audioPackets[audioPackets.length - 1];
    const outEnd = outLast.timestamp + outLast.duration;
    log(
      `seg ${index} continuity-audio post startDelta=${(outFirst - seg.startSec).toFixed(6)} endGap=${(endSec - outEnd).toFixed(6)}`,
    );
  }

  checkAbort(signal);

  // Stage 4: Mux to fMP4 (fast)
  const outputAudioCodec = config.doTranscode ? 'aac' : config.audioCodec;
  if (audioPackets.length > 0 && !audioDecoderConfig) {
    throw new Error(
      `Cannot mux audio without decoder config; source codec ${config.sourceCodec ?? config.audioCodec ?? 'unknown'} must be transcoded first.`,
    );
  }
  if (audioPackets.length > 0 && !outputAudioCodec) {
    throw new Error('Cannot mux audio without an output audio codec');
  }
  const tMux = performance.now();
  const muxResult = await muxToFmp4({
    videoPackets,
    audioPackets,
    videoCodec: config.videoCodec,
    audioCodec: outputAudioCodec ?? 'aac',
    videoDecoderConfig: config.videoDecoderConfig,
    audioDecoderConfig,
    fragmentSequenceNumber: index + 1,
  });
  log(`seg ${index} mux ${elapsed(tMux)}`);

  // Concatenate media fragments
  const totalLen = muxResult.media.reduce((s, c) => s + c.byteLength, 0);
  log(
    `seg ${index} mux-parts init=${muxResult.init.byteLength} mediaParts=${muxResult.media.length} mediaBytes=${totalLen}`,
  );
  if (index === 0) {
    log(`seg ${index} fmp4 ${muxResult.debugSummary}`);
  }
  const mediaData = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of muxResult.media) {
    mediaData.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    mediaData,
    initSegment: muxResult.init,
    audioDecoderConfig,
  };
}
