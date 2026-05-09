import { WasmFfmpegRunner } from './adapters/wasm-ffmpeg.js';
import {
  type AudioTranscodeExecutor,
  buildTranscodeResultFromAdts,
  createEmptyTranscodeResult,
  createLocalAudioTranscoder,
  isAudioTranscodeInputSupported,
  makeAacDecoderConfig,
  prepareTranscodeInput,
  type TranscodeOptions,
} from './pipeline/audio-transcode.js';
import { audioNeedsTranscode, createBrowserProber } from './pipeline/codec-probe.js';
import type { DemuxResult } from './pipeline/demux.js';
import {
  AbortableUrlSource,
  createSubtitleInput,
  createVideoBoundaryResolver,
  demuxBlob,
  demuxSource,
  getKeyframeIndex,
} from './pipeline/demux.js';
import {
  buildMkvKeyframeIndexFromBlob,
  buildMkvKeyframeIndexFromSource,
  buildMkvKeyframeIndexFromUrl,
} from './pipeline/mkv-keyframe-index.js';
import { generateVodPlaylist } from './pipeline/playlist.js';
import { checkDav1dBridgeAv1Compatibility } from './pipeline/av1-packet-builder.js';
import { createDav1dWebCodecsVideoTranscoder } from './pipeline/dav1d-video-transcode.js';
import { buildSegmentPlan } from './pipeline/segment-plan.js';
import { processSegmentWithAbort } from './pipeline/segment-processor.js';
import { isAbortableSource } from './pipeline/source-signal.js';
import {
  extractSubtitleDataStreaming,
  type SubtitleExtractionProgress,
} from './pipeline/subtitle.js';
import type { KeyframeIndex, PlannedSegment } from './pipeline/types.js';
import type {
  TranscodeJobRequest,
  TranscodeJobResponse,
  TranscodePortMessage,
} from './transcode-protocol.js';
import {
  createLocalVideoTranscoder,
  isVideoTranscodeInputSupported,
  makeVideoTranscodeAudioDecoderConfig,
  VIDEO_TRANSCODE_OUTPUT_AUDIO_CODEC,
  VIDEO_TRANSCODE_OUTPUT_CODEC,
  VIDEO_TRANSCODE_OUTPUT_CODEC_FULL,
} from './pipeline/video-transcode.js';
import {
  H264_WEB_CODECS_CODEC,
  formatWebCodecsTranscodeProbe,
  probeWebCodecsTranscodeSupport,
} from './pipeline/webcodecs-transcode-probe.js';
import type {
  WorkerSegmentPhase,
  WorkerSegmentStateMessage,
  WorkerSubtitleBatchMessage,
  WorkerSubtitleProgressMessage,
} from './worker-protocol.js';

function wlog(msg: string) {
  console.log(`[worker] ${msg}`);
  try {
    self.postMessage({ type: 'worker-log', message: msg });
  } catch {
    // Best-effort diagnostics only.
  }
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

function makeAbortError(): DOMException {
  return new DOMException('Segment aborted', 'AbortError');
}

let paused = false;
let prefetchAbort: AbortController | null = null;

function emitSegmentState(
  index: number,
  phase: WorkerSegmentPhase,
  opts: { sizeBytes?: number; message?: string } = {},
): void {
  const msg: WorkerSegmentStateMessage = {
    type: 'segment-state',
    index,
    phase,
    ...opts,
  };
  self.postMessage(msg);
}

interface TranscodeQueueJob {
  id: number;
  opts: TranscodeOptions;
  startedAt: number;
  concatMs: number;
  inputBytes: number;
  audioDurationSec: number;
  inputData: Uint8Array;
  inputFormat?: string | null;
  inputExtension?: string;
  signal?: AbortSignal;
  settled: boolean;
  reject: (err: Error) => void;
  resolve: (result: Awaited<ReturnType<AudioTranscodeExecutor>>) => void;
  onAbort?: () => void;
}

interface TranscodeWorkerEntry {
  id: number;
  port: MessagePort;
  currentJob: TranscodeQueueJob | null;
}

class TranscodePortPool {
  private workers: TranscodeWorkerEntry[] = [];
  private queue: TranscodeQueueJob[] = [];
  private nextJobId = 0;
  private readonly fallbackTranscode: AudioTranscodeExecutor;

  constructor(fallbackTranscode: AudioTranscodeExecutor) {
    this.fallbackTranscode = fallbackTranscode;
  }

  addPort(id: number, port: MessagePort): void {
    const entry: TranscodeWorkerEntry = { id, port, currentJob: null };
    port.onmessage = (event: MessageEvent<TranscodeJobResponse>) => {
      this.handleWorkerMessage(entry, event.data);
    };
    port.start?.();
    this.workers.push(entry);
    this.dispatch();
  }

  hasWorkers(): boolean {
    return this.workers.length > 0;
  }

  workerCount(): number {
    return this.workers.length;
  }

  readonly transcode: AudioTranscodeExecutor = async (
    opts: TranscodeOptions,
    signal?: AbortSignal,
  ) => {
    if (opts.packets.length === 0) {
      return createEmptyTranscodeResult(opts.sampleRate);
    }
    if (signal?.aborted) {
      throw makeAbortError();
    }
    if (this.workers.length === 0) {
      return this.fallbackTranscode(opts, signal);
    }

    const startedAt = performance.now();
    const tConcat = performance.now();
    const input = await prepareTranscodeInput(opts);
    const concatMs = performance.now() - tConcat;

    return await new Promise((resolve, reject) => {
      const job: TranscodeQueueJob = {
        id: ++this.nextJobId,
        opts,
        startedAt,
        concatMs,
        inputBytes: input.inputBytes,
        audioDurationSec: input.audioDurationSec,
        inputData: input.data,
        inputFormat: input.inputFormat,
        inputExtension: input.inputExtension,
        signal,
        settled: false,
        resolve,
        reject,
      };

      const abort = () => {
        if (job.settled) {
          return;
        }
        job.settled = true;
        this.queue = this.queue.filter((queued) => queued !== job);
        reject(makeAbortError());
        this.dispatch();
      };

      if (signal) {
        job.onAbort = abort;
        signal.addEventListener('abort', abort, { once: true });
      }

      this.queue.push(job);
      this.dispatch();
    });
  };

  private dispatch(): void {
    for (const worker of this.workers) {
      if (worker.currentJob !== null) {
        continue;
      }
      const job = this.queue.shift();
      if (!job) {
        return;
      }
      worker.currentJob = job;
      const transferData = new Uint8Array(job.inputData);
      const buffer = transferData.buffer;
      const msg: TranscodeJobRequest = {
        type: 'transcode-job',
        jobId: job.id,
        inputData: buffer,
        sampleRate: job.opts.sampleRate,
        sourceCodec: job.opts.sourceCodec,
        inputFormat: job.inputFormat,
        inputExtension: job.inputExtension,
      };
      worker.port.postMessage(msg, [buffer]);
    }
  }

  handleWorkerFailure(id: number, reason: string): void {
    const index = this.workers.findIndex((worker) => worker.id === id);
    if (index === -1) {
      return;
    }

    const [worker] = this.workers.splice(index, 1);
    const activeJob = worker.currentJob;
    worker.currentJob = null;

    if (activeJob) {
      void this.recoverJob(activeJob, `Transcode worker ${id} failed: ${reason}`);
    }

    if (this.workers.length === 0 && this.queue.length > 0) {
      const queuedJobs = this.queue.splice(0);
      for (const job of queuedJobs) {
        void this.recoverJob(job, `Transcode workers unavailable: ${reason}`);
      }
      return;
    }

    this.dispatch();
  }

  private handleWorkerMessage(worker: TranscodeWorkerEntry, msg: TranscodeJobResponse): void {
    const job = worker.currentJob;
    worker.currentJob = null;
    if (!job) {
      this.dispatch();
      return;
    }

    if (job.signal && job.onAbort) {
      job.signal.removeEventListener('abort', job.onAbort);
    }

    if (!job.settled) {
      if (msg.type !== 'transcode-result' || msg.jobId !== job.id) {
        job.settled = true;
        job.reject(new Error(`Transcode worker ${worker.id} returned an unexpected job result`));
      } else if (!msg.ok) {
        job.settled = true;
        job.reject(new Error(msg.error));
      } else {
        job.settled = true;
        const aacData = new Uint8Array(msg.outputData);
        const result = buildTranscodeResultFromAdts({
          inputPackets: job.opts.packets.length,
          inputBytes: job.inputBytes,
          audioDurationSec: job.audioDurationSec,
          concatMs: job.concatMs,
          sampleRate: job.opts.sampleRate,
          audioStartSec: job.opts.audioStartSec,
          outputStartSec: job.opts.outputStartSec,
          trimStartSec: job.opts.trimStartSec,
          leadingSilenceSec: job.opts.leadingSilenceSec,
          targetDurationSec: job.opts.targetDurationSec,
          targetFrameCount: job.opts.targetFrameCount,
          aacData,
          ffmpegMetrics: msg.metrics,
          totalMs: performance.now() - job.startedAt,
        });
        job.resolve(result);
      }
    }

    this.dispatch();
  }

  private async recoverJob(job: TranscodeQueueJob, reason: string): Promise<void> {
    if (job.settled) {
      this.dispatch();
      return;
    }
    if (job.signal?.aborted) {
      if (job.signal && job.onAbort) {
        job.signal.removeEventListener('abort', job.onAbort);
      }
      job.settled = true;
      job.reject(makeAbortError());
      this.dispatch();
      return;
    }

    if (this.workers.length > 0) {
      this.queue.unshift(job);
      this.dispatch();
      return;
    }

    try {
      if (job.signal && job.onAbort) {
        job.signal.removeEventListener('abort', job.onAbort);
      }
      const result = await this.fallbackTranscode(job.opts, job.signal);
      if (!job.settled) {
        job.settled = true;
        job.resolve(result);
      }
    } catch (err) {
      if (!job.settled) {
        job.settled = true;
        const fallbackMessage = err instanceof Error ? err.message : String(err);
        job.reject(new Error(`${reason}; fallback transcode failed: ${fallbackMessage}`));
      }
    } finally {
      this.dispatch();
    }
  }
}

const ffmpeg = new WasmFfmpegRunner();
const codecProber = createBrowserProber();
const localAudioTranscoder = createLocalAudioTranscoder(ffmpeg);
const localVideoTranscoder = createLocalVideoTranscoder(ffmpeg);
const transcodePool = new TranscodePortPool(localAudioTranscoder);

let demux: DemuxResult | null = null;
let plan: PlannedSegment[] = [];
let resolveSegmentBoundary: ReturnType<typeof createVideoBoundaryResolver> | null = null;
let doTranscode = false;
let doVideoTranscode = false;
let activeVideoTranscoder = localVideoTranscoder;
let prepareAudioForVideoTranscode = false;
let outputVideoCodecFull = VIDEO_TRANSCODE_OUTPUT_CODEC_FULL;
let videoTranscodeEngine: 'none' | 'ffmpeg' | 'dav1d-webcodecs' = 'none';
let audioDecoderConfig: AudioDecoderConfig | null = null;
let initSegment: Uint8Array | null = null;
let currentBlob: Blob | null = null;
let currentUrl: string | null = null;
let currentSource: AbortableUrlSource | null = null;
const SEGMENT_TIMEOUT_MS = 120_000;
const segmentCache = new Map<number, Uint8Array>();
const segmentTasks = new Map<number, Promise<Uint8Array>>();
const segmentTaskAbortControllers = new Map<number, AbortController>();
const segmentTaskAbortReasons = new Map<number, 'cancel' | 'external' | 'timeout'>();
const prefetchTaskIndexes = new Set<number>();
let targetSegDuration = 4;
const VIDEO_TRANSCODE_PREFETCH_AHEAD_SEGMENTS = 3;

// Keep pipeline setup ordered, but let individual segment work run independently.
let pipelineSetup: Promise<void> = Promise.resolve();

// Per-segment abort controllers for cancellation
const segmentAbortControllers = new Map<number, AbortController>();

// --- Subtitle queue: sequential extraction via dedicated I/O handle ---
// Subtitles use a separate Input instance (subtitleInput) so they never
// contend with segment processing. The queue serialises extractions to
// avoid redundant parallel reads.
let _activeSegmentCount = 0;
let subtitleInProgress = false;
let subtitleAbort: AbortController | null = null;
let subtitleInput: Awaited<ReturnType<typeof createSubtitleInput>> | null = null;
let subtitleInputPending: ReturnType<typeof createSubtitleInput> | null = null;
const subtitleQueue: Array<{
  trackIndex: number;
  requestId: number;
  requestedAtMs?: number;
  seekTimeSec?: number;
  endTimeSec?: number;
}> = [];

function abortSubtitleWork(reason: string): void {
  if (subtitleAbort) {
    subtitleAbort.abort();
    subtitleAbort = null;
  }
  subtitleQueue.length = 0;
  wlog(reason);
}

function disposeSubtitleInput(): void {
  subtitleInputPending = null;
  if (subtitleInput) {
    subtitleInput.dispose();
    subtitleInput = null;
  }
}

async function ensureSubtitleInput(): Promise<Awaited<ReturnType<typeof createSubtitleInput>>> {
  if (subtitleInput) return subtitleInput;
  if (!subtitleInputPending) {
    subtitleInputPending = createSubtitleInput(currentBlob, currentUrl);
  }
  subtitleInput = await subtitleInputPending;
  subtitleInputPending = null;
  return subtitleInput;
}

function enqueueSubtitle(
  trackIndex: number,
  requestId: number,
  requestedAtMs?: number,
  seekTimeSec?: number,
  endTimeSec?: number,
): void {
  for (let i = subtitleQueue.length - 1; i >= 0; i--) {
    if (subtitleQueue[i].trackIndex === trackIndex) {
      subtitleQueue.splice(i, 1);
    }
  }
  subtitleQueue.push({ trackIndex, requestId, requestedAtMs, seekTimeSec, endTimeSec });
  void drainSubtitleQueue();
}

async function drainSubtitleQueue(): Promise<void> {
  if (subtitleInProgress) return;

  const next = subtitleQueue.shift();
  if (!next) return;

  subtitleInProgress = true;
  const queueDelayMs =
    typeof next.requestedAtMs === 'number' ? Math.max(0, Date.now() - next.requestedAtMs) : 0;
  try {
    await handleSubtitle(
      next.trackIndex,
      next.requestId,
      queueDelayMs,
      next.seekTimeSec,
      next.endTimeSec,
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  } finally {
    subtitleInProgress = false;
    void drainSubtitleQueue();
  }
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === 'open') {
    wlog('recv open');
    paused = false;
    prefetchAbort?.abort();
    prefetchAbort = null;
    targetSegDuration = msg.targetSegmentDuration ?? 4;
    currentBlob = msg.file;
    currentUrl = null;
    currentSource = null;
    queuePipelineSetup(() => handleProbe(() => demuxBlob(msg.file)));
  } else if (msg.type === 'open-url') {
    wlog('recv open-url');
    paused = false;
    prefetchAbort?.abort();
    prefetchAbort = null;
    targetSegDuration = msg.targetSegmentDuration ?? 4;
    currentBlob = null;
    currentUrl = msg.url;
    currentSource = new AbortableUrlSource(msg.url);
    queuePipelineSetup(() => handleProbe(() => demuxSource(currentSource!)));
  } else if (msg.type === 'remux-pipeline') {
    wlog('recv remux-pipeline');
    queuePipelineSetup(() => handleRemuxPipeline(msg.keyframeIndex, msg.initialStartTimeSec));
  } else if (msg.type === 'passthrough-pipeline') {
    wlog('recv passthrough-pipeline — subtitle-only mode');
  } else if (msg.type === 'transcode-port') {
    const portMsg = msg as TranscodePortMessage;
    const port = event.ports[0];
    if (port) {
      wlog(`recv transcode-port id=${portMsg.id}`);
      transcodePool.addPort(portMsg.id, port);
    }
  } else if (msg.type === 'transcode-worker-failed') {
    const reason = msg.message || 'Transcode worker crashed';
    wlog(`recv transcode-worker-failed id=${msg.id} reason=${reason}`);
    transcodePool.handleWorkerFailure(msg.id, reason);
  } else if (msg.type === 'refresh-file') {
    wlog('recv refresh-file');
    currentBlob = msg.file;
    queuePipelineSetup(() => handleFileRefresh(msg.file));
  } else if (msg.type === 'segment') {
    wlog(`recv segment idx=${msg.index}`);
    void handleSegmentRequest(msg.index);
  } else if (msg.type === 'cancel') {
    const controller = segmentAbortControllers.get(msg.index);
    if (controller) {
      wlog(`cancel segment idx=${msg.index}`);
      controller.abort();
      segmentAbortControllers.delete(msg.index);
    }
    abortSegmentTask(msg.index, 'cancel');
  } else if (msg.type === 'pause') {
    paused = true;
    if (prefetchAbort) {
      prefetchAbort.abort();
      prefetchAbort = null;
    }
    wlog('recv pause — prefetch suspended, subtitle extraction preserved');
  } else if (msg.type === 'resume') {
    paused = false;
    prefetchAbort = new AbortController();
    wlog('recv resume — prefetch resumed');
  } else if (msg.type === 'subtitle') {
    wlog(
      `recv subtitle trackIndex=${msg.trackIndex} requestId=${msg.requestId} seekTimeSec=${msg.seekTimeSec ?? 'none'} endTimeSec=${msg.endTimeSec ?? 'none'}`,
    );
    enqueueSubtitle(
      msg.trackIndex,
      msg.requestId,
      msg.requestedAtMs,
      msg.seekTimeSec,
      msg.endTimeSec,
    );
  } else if (msg.type === 'subtitle-abort') {
    abortSubtitleWork('recv subtitle-abort — subtitle extraction aborted');
  }
};

function queuePipelineSetup(task: () => Promise<void>): void {
  pipelineSetup = pipelineSetup.then(task).catch((err) => {
    self.postMessage({ type: 'error', message: String(err) });
  });
}

function makeProcessorConfig() {
  if (!demux) {
    throw new Error('No demux — handleProbe must run first');
  }
  return {
    videoSink: demux.videoSink,
    audioSink: demux.audioSink,
    videoCodec: demux.videoCodec,
    audioCodec: demux.audioCodec,
    videoDecoderConfig: demux.videoDecoderConfig,
    sourceAudioDecoderConfig: demux.audioDecoderConfig,
    audioDecoderConfig,
    plan,
    doTranscode,
    transcodeAudio: transcodePool.hasWorkers() ? transcodePool.transcode : localAudioTranscoder,
    sourceCodec: demux.audioCodec ?? undefined,
    videoTranscode: doVideoTranscode,
    transcodeVideo: activeVideoTranscoder,
    prepareAudioForVideoTranscode,
    sourceVideoCodec: demux.videoCodec,
    sourceVideoDecoderConfig: demux.videoDecoderConfig,
    resolveSegmentBoundary: resolveSegmentBoundary ?? undefined,
    log: wlog,
  };
}

function videoTrackRequiresTranscode(demux: DemuxResult): boolean {
  return !codecProber.canPlayVideo(demux.videoCodec, demux.videoDecoderConfig.codec);
}

function requireSupportedAudioCodec(demux: DemuxResult): string | null {
  if (!demux.audioTrack) return null;
  if (!demux.audioCodec) {
    throw new Error(
      `Unsupported audio track codec: ${demux.audioInternalCodecId ?? 'unknown'}; cannot transcode without a recognized source codec`,
    );
  }
  return demux.audioCodec;
}

function audioTrackRequiresTranscode(demux: DemuxResult): boolean {
  const sourceCodec = requireSupportedAudioCodec(demux);
  if (!sourceCodec) return false;
  return (
    demux.audioDecoderConfig === null ||
    audioNeedsTranscode(codecProber, sourceCodec, demux.audioDecoderConfig.codec)
  );
}

function shouldPrefetchSegments(): boolean {
  return doVideoTranscode || (doTranscode && transcodePool.workerCount() > 0);
}

function schedulePrefetch(startIndex: number, stopBeforeIndex?: number): void {
  if (paused || !shouldPrefetchSegments()) {
    return;
  }

  if (!prefetchAbort) prefetchAbort = new AbortController();
  const signal = prefetchAbort.signal;

  const maxInFlight = currentSource ? 1 : transcodePool.workerCount();
  const prefetchStopBeforeIndex = doVideoTranscode
    ? (stopBeforeIndex ?? startIndex + VIDEO_TRANSCODE_PREFETCH_AHEAD_SEGMENTS)
    : plan.length;
  let nextIndex = startIndex;
  while (
    segmentTasks.size < maxInFlight &&
    nextIndex < plan.length &&
    nextIndex < prefetchStopBeforeIndex
  ) {
    if (!segmentCache.has(nextIndex) && !segmentTasks.has(nextIndex)) {
      emitSegmentState(nextIndex, 'prefetching');
      const prefetchIndex = nextIndex;
      prefetchTaskIndexes.add(prefetchIndex);
      const prefetchSignal = doVideoTranscode ? undefined : signal;
      void ensureSegmentTask(nextIndex, prefetchSignal)
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          emitSegmentState(nextIndex, 'error', { message: String(err) });
          self.postMessage({ type: 'error', message: String(err) });
        })
        .finally(() => {
          prefetchTaskIndexes.delete(prefetchIndex);
          if (doVideoTranscode && !paused) {
            schedulePrefetch(prefetchIndex + 1, prefetchStopBeforeIndex);
          }
        });
    }
    nextIndex += 1;
  }
}

function cancelUnrelatedUrlPrefetch(requestedIndex: number): void {
  if (!currentSource || prefetchTaskIndexes.size === 0 || prefetchTaskIndexes.has(requestedIndex)) {
    return;
  }

  wlog(`cancel prefetch for on-demand seg ${requestedIndex}`);
  prefetchAbort?.abort();
  prefetchAbort = null;
}

async function ensureSegmentTask(index: number, signal?: AbortSignal): Promise<Uint8Array> {
  const cached = segmentCache.get(index);
  if (cached) {
    return cached;
  }

  const existing = segmentTasks.get(index);
  if (existing) {
    linkSegmentTaskAbort(index, signal, existing);
    return existing;
  }

  const taskCtrl = new AbortController();
  segmentTaskAbortControllers.set(index, taskCtrl);
  const unlinkExternalAbort = linkAbortSignal(signal, taskCtrl, () => {
    segmentTaskAbortReasons.set(index, 'external');
  });

  const task = (async () => {
    const t0 = performance.now();
    emitSegmentState(index, 'processing');

    // Timeout prevents indefinite hangs (e.g. ffmpeg.wasm stalling)
    const timeoutId = setTimeout(() => {
      segmentTaskAbortReasons.set(index, 'timeout');
      taskCtrl.abort();
    }, SEGMENT_TIMEOUT_MS);

    let result: Awaited<ReturnType<typeof processSegmentWithAbort>>;
    try {
      if (currentSource && isAbortableSource(currentSource)) {
        currentSource.setCurrentSignal(taskCtrl.signal);
      }
      result = await processSegmentWithAbort(makeProcessorConfig(), index, taskCtrl.signal);
    } catch (err) {
      if (taskCtrl.signal.aborted && segmentTaskAbortReasons.get(index) === 'timeout') {
        wlog(`seg ${index} timed out after ${SEGMENT_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      if (currentSource && isAbortableSource(currentSource)) {
        currentSource.setCurrentSignal(null);
      }
      clearTimeout(timeoutId);
      unlinkExternalAbort();
    }

    if (!initSegment && result.initSegment) {
      initSegment = result.initSegment;
      wlog(`init-segment captured size=${initSegment.byteLength}`);
    }

    const mediaData = result.mediaData;
    segmentCache.set(index, mediaData);
    emitSegmentState(index, 'ready', { sizeBytes: mediaData.byteLength });
    wlog(`seg ${index} done ${elapsed(t0)} size=${mediaData.byteLength}`);
    return mediaData;
  })().finally(() => {
    segmentTasks.delete(index);
    segmentTaskAbortControllers.delete(index);
    segmentTaskAbortReasons.delete(index);
  });

  segmentTasks.set(index, task);
  return task;
}

function abortSegmentTask(index: number, reason: 'cancel' | 'external' | 'timeout'): void {
  const controller = segmentTaskAbortControllers.get(index);
  if (!controller || controller.signal.aborted) return;
  segmentTaskAbortReasons.set(index, reason);
  controller.abort();
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
  beforeAbort?: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    beforeAbort?.();
    controller.abort();
    return () => {};
  }

  const abort = () => {
    beforeAbort?.();
    controller.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function linkSegmentTaskAbort(index: number, signal: AbortSignal | undefined, task: Promise<Uint8Array>): void {
  const controller = segmentTaskAbortControllers.get(index);
  if (!controller) return;
  const unlink = linkAbortSignal(signal, controller, () => {
    segmentTaskAbortReasons.set(index, 'external');
  });
  void task.finally(unlink).catch(() => {});
}

async function waitForSegment(index: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) {
    throw makeAbortError();
  }

  const task = ensureSegmentTask(index, signal);
  if (!signal) {
    return task;
  }

  return await new Promise((resolve, reject) => {
    const abort = () => reject(makeAbortError());
    signal.addEventListener('abort', abort, { once: true });
    task
      .then(resolve)
      .catch(reject)
      .finally(() => {
        signal.removeEventListener('abort', abort);
      });
  });
}

/** Phase 1: demux and send codec info to engine for passthrough decision. */
async function handleProbe(demuxFn: () => Promise<DemuxResult>) {
  if (demux) {
    demux.dispose();
  }
  disposeSubtitleInput();

  const tDemux = performance.now();
  demux = await demuxFn();
  wlog(
    `demux done ${elapsed(tDemux)} codec=${demux.videoCodec}/${demux.audioCodec} audioInternal=${demux.audioInternalCodecId ?? 'none'} audioDecoderConfig=${demux.audioDecoderConfig ? 'yes' : 'no'} dur=${demux.duration.toFixed(1)}s`,
  );

  // Send codec info so engine can check canPlayType on the main thread
  self.postMessage({
    type: 'probed',
    sourceVideoCodec: demux.videoCodec,
    sourceAudioCodec: demux.audioCodec,
    audioInternalCodecId: demux.audioInternalCodecId,
    hasAudioTrack: demux.audioTrack !== null,
    videoCodec: demux.videoDecoderConfig.codec,
    audioCodec: demux.audioDecoderConfig?.codec ?? null,
    hasAudioDecoderConfig: demux.audioTrack ? demux.audioDecoderConfig !== null : true,
    durationSec: demux.duration,
    subtitleTracks: demux.subtitleTracks,
  });
}

/** Phase 2: full pipeline — engine told us native playback isn't possible. */
async function handleRemuxPipeline(
  prebuiltKeyframeIndex?: KeyframeIndex,
  initialStartTimeSec?: number,
) {
  if (!demux) throw new Error('No demux — handleProbe must run first');
  const t0 = performance.now();

  let index: KeyframeIndex;
  if (prebuiltKeyframeIndex) {
    index = prebuiltKeyframeIndex;
    wlog(`keyframe-index pre-built keyframes=${index.keyframes.length}`);
  } else {
    const tIndex = performance.now();
    const mkvIndex = currentBlob
      ? await buildMkvKeyframeIndexFromBlob(currentBlob)
      : currentSource
        ? await buildMkvKeyframeIndexFromSource(currentSource)
        : currentUrl
          ? await buildMkvKeyframeIndexFromUrl(currentUrl)
          : null;
    if (mkvIndex) {
      index = mkvIndex;
      wlog(`mkv-cues done ${elapsed(tIndex)} keyframes=${index.keyframes.length}`);
    } else {
      if (currentUrl?.includes('/offline-video/')) {
        index = buildTimedKeyframeIndex(demux.duration, targetSegDuration);
        wlog(`timed-index done ${elapsed(tIndex)} keyframes=${index.keyframes.length}`);
      } else {
        index = await getKeyframeIndex(demux.videoSink, demux.duration);
        wlog(`keyframe-index done ${elapsed(tIndex)} keyframes=${index.keyframes.length}`);
      }
    }
  }

  const tPlan = performance.now();
  plan = buildSegmentPlan({
    keyframeTimestampsSec: index.keyframes.map((k) => k.timestamp),
    durationSec: index.duration,
    targetSegmentDurationSec: targetSegDuration,
  });
  resolveSegmentBoundary = createVideoBoundaryResolver(demux.videoSink, plan, wlog);
  wlog(`segment-plan done ${elapsed(tPlan)} segments=${plan.length}`);

  doVideoTranscode = videoTrackRequiresTranscode(demux);
  if (doVideoTranscode && !isVideoTranscodeInputSupported(demux.videoCodec)) {
    throw new Error(`Unsupported video transcode source codec: ${demux.videoCodec}`);
  }
  if (doVideoTranscode) {
    const webCodecsProbe = await probeWebCodecsTranscodeSupport(demux.videoDecoderConfig);
    wlog(`webcodecs transcode probe ${formatWebCodecsTranscodeProbe(webCodecsProbe)}`);
    const dav1dCompatibility = demux.videoCodec === 'av1'
      ? checkDav1dBridgeAv1Compatibility(demux.videoDecoderConfig.description)
      : { compatible: false, reason: 'non-av1' };
    const canUseDav1dWebCodecs = webCodecsProbe.available
      && webCodecsProbe.h264Encode.supported
      && dav1dCompatibility.compatible;
    if (demux.videoCodec === 'av1' && !dav1dCompatibility.compatible) {
      wlog(`dav1d-webcodecs skipped reason=${dav1dCompatibility.reason ?? 'unknown'}`);
    }
    activeVideoTranscoder = canUseDav1dWebCodecs
      ? createDav1dWebCodecsVideoTranscoder({ h264Codec: webCodecsProbe.h264Codec })
      : localVideoTranscoder;
    prepareAudioForVideoTranscode = canUseDav1dWebCodecs && !!demux.audioTrack && demux.audioCodec !== 'aac';
    outputVideoCodecFull = canUseDav1dWebCodecs ? webCodecsProbe.h264Codec : VIDEO_TRANSCODE_OUTPUT_CODEC_FULL;
    videoTranscodeEngine = canUseDav1dWebCodecs ? 'dav1d-webcodecs' : 'ffmpeg';
    wlog(
      `video transcode enabled source=${demux.videoCodec} output=${VIDEO_TRANSCODE_OUTPUT_CODEC} engine=${videoTranscodeEngine} h264=${outputVideoCodecFull}`,
    );
    if (!canUseDav1dWebCodecs) {
      await ffmpeg.loadForCodec(demux.videoCodec);
    } else if (prepareAudioForVideoTranscode) {
      const sourceAudioCodec = requireSupportedAudioCodec(demux);
      if (!sourceAudioCodec || !isAudioTranscodeInputSupported(sourceAudioCodec)) {
        throw new Error(`Unsupported audio transcode source codec: ${sourceAudioCodec ?? 'unknown'}`);
      }
      if (!transcodePool.hasWorkers()) {
        await ffmpeg.loadForCodec(sourceAudioCodec);
      }
    }
  } else {
    activeVideoTranscoder = localVideoTranscoder;
    prepareAudioForVideoTranscode = false;
    outputVideoCodecFull = VIDEO_TRANSCODE_OUTPUT_CODEC_FULL;
    videoTranscodeEngine = 'none';
  }

  doTranscode = !doVideoTranscode && audioTrackRequiresTranscode(demux);
  if (doTranscode && demux.audioCodec && !isAudioTranscodeInputSupported(demux.audioCodec)) {
    throw new Error(`Unsupported audio transcode source codec: ${demux.audioCodec}`);
  }
  if (doTranscode && demux.audioCodec && !transcodePool.hasWorkers()) {
    await ffmpeg.loadForCodec(demux.audioCodec);
  }
  audioDecoderConfig = doVideoTranscode
    ? (demux.audioTrack ? makeVideoTranscodeAudioDecoderConfig(demux.audioDecoderConfig) : null)
    : doTranscode
      ? makeAacDecoderConfig(demux.audioDecoderConfig)
      : demux.audioDecoderConfig;
  initSegment = null;
  segmentCache.clear();
  segmentTasks.clear();

  const playlist = generateVodPlaylist({
    targetDuration: Math.ceil(Math.max(...plan.map((s) => s.durationSec))),
    mediaSequence: 0,
    mapUri: 'init.mp4',
    entries: plan.map((s) => ({ uri: `seg-${s.sequence}.m4s`, durationSec: s.durationSec })),
    endList: true,
  });

  const tSeg0 = performance.now();
  const seg0Result = await processSegmentWithAbort(makeProcessorConfig(), 0);
  audioDecoderConfig = seg0Result.audioDecoderConfig;
  segmentCache.set(0, seg0Result.mediaData);
  if (seg0Result.initSegment) {
    initSegment = seg0Result.initSegment;
    wlog(`init-segment captured size=${initSegment.byteLength}`);
  }
  wlog(`seg0 preprocess done ${elapsed(tSeg0)}`);

  const initialSegmentIndex = findSegmentIndexForTime(initialStartTimeSec);
  wlog(`pipeline complete ${elapsed(t0)} total`);

  self.postMessage(
    {
      type: 'ready',
      playlist,
      initData: initSegment!.buffer,
      totalSegments: plan.length,
      durationSec: demux.duration,
      sourceVideoCodec: demux.videoCodec,
      sourceVideoCodecFull: demux.videoDecoderConfig.codec,
      sourceAudioCodec: demux.audioCodec,
      sourceAudioCodecFull: demux.audioDecoderConfig?.codec ?? null,
      outputVideoCodec: doVideoTranscode ? VIDEO_TRANSCODE_OUTPUT_CODEC : demux.videoCodec,
      outputVideoCodecFull: doVideoTranscode
        ? outputVideoCodecFull
        : demux.videoDecoderConfig.codec,
      videoTranscodeEngine,
      outputAudioCodec: doVideoTranscode
        ? (demux.audioTrack ? VIDEO_TRANSCODE_OUTPUT_AUDIO_CODEC : null)
        : doTranscode
          ? 'aac'
          : demux.audioCodec,
      outputAudioCodecFull: audioDecoderConfig?.codec ?? null,
      subtitleTracks: demux.subtitleTracks,
    },
    { transfer: [] },
  ); // don't transfer initData — we need to keep it

  if (doVideoTranscode) {
    wlog('video-transcode prefetch deferred until first segment delivery');
  } else {
    schedulePrefetch(initialSegmentIndex !== null && initialSegmentIndex > 0 ? initialSegmentIndex : 1);
  }
}

function findSegmentIndexForTime(timeSec: unknown): number | null {
  if (typeof timeSec !== 'number' || !Number.isFinite(timeSec) || timeSec <= 0) {
    return null;
  }

  const clampedTimeSec = Math.max(0, Math.min(timeSec, demux?.duration ?? timeSec));
  const index = plan.findIndex((segment, segmentIndex) => {
    const next = plan[segmentIndex + 1];
    const endSec = next ? next.startSec : segment.startSec + segment.durationSec;
    return clampedTimeSec >= segment.startSec && clampedTimeSec < endSec;
  });

  return index >= 0 ? index : plan.length - 1;
}

function buildTimedKeyframeIndex(
  durationSec: number,
  targetSegmentDurationSec: number,
): KeyframeIndex {
  const duration = Number(durationSec);
  const targetDuration = Math.max(1, Number(targetSegmentDurationSec) || 4);
  const keyframes = [];
  for (
    let timestamp = 0, sequenceNumber = 0;
    timestamp < duration;
    timestamp += targetDuration, sequenceNumber += 1
  ) {
    keyframes.push({ timestamp, sequenceNumber });
  }
  return { duration, keyframes };
}

/** Re-demux with a fresh File after the old Blob became stale. Keeps the existing plan. */
async function handleFileRefresh(file: Blob): Promise<void> {
  const t0 = performance.now();
  if (demux) {
    demux.dispose();
  }
  disposeSubtitleInput();
  demux = await demuxBlob(file);
  segmentCache.clear();
  segmentTasks.clear();
  initSegment = null;
  wlog(`file-refresh re-demux done ${elapsed(t0)} — plan kept (${plan.length} segments)`);
  self.postMessage({ type: 'file-refreshed' });
}

function isStaleFileError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('network error')
  );
}

async function handleSegmentRequest(index: number) {
  _activeSegmentCount++;
  const controller = new AbortController();
  segmentAbortControllers.set(index, controller);
  emitSegmentState(index, 'queued');

  try {
    await pipelineSetup;
    await handleSegment(index, controller.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      emitSegmentState(index, 'aborted');
      wlog(`seg ${index} aborted`);
      return;
    }
    const stale = isStaleFileError(err);
    emitSegmentState(index, 'error', { message: String(err) });
    self.postMessage({ type: 'segment-error', index, message: String(err), stale });
    if (stale) {
      wlog(`seg ${index} stale file detected — requesting refresh`);
    }
  } finally {
    segmentAbortControllers.delete(index);
    _activeSegmentCount--;
    void drainSubtitleQueue();
  }
}

async function handleSegment(index: number, signal: AbortSignal) {
  if (!demux || index >= plan.length) {
    self.postMessage({ type: 'error', message: `Invalid segment index: ${index}` });
    return;
  }

  // Return cached segment if available (segment 0 is pre-processed during open)
  const cached = segmentCache.get(index);
  if (cached) {
    segmentCache.delete(index);
    emitSegmentState(index, 'cache-hit', { sizeBytes: cached.byteLength });
    wlog(`seg ${index} cache-hit size=${cached.byteLength}`);
    const buffer = cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength);
    self.postMessage({ type: 'segment', index, data: buffer }, { transfer: [buffer] });
    schedulePrefetch(index + 1);
    return;
  }

  try {
    cancelUnrelatedUrlPrefetch(index);
    const mediaData = await waitForSegment(index, signal);
    const buffer = mediaData.buffer.slice(
      mediaData.byteOffset,
      mediaData.byteOffset + mediaData.byteLength,
    );
    self.postMessage({ type: 'segment', index, data: buffer }, { transfer: [buffer] });
    segmentCache.delete(index);
    schedulePrefetch(index + 1);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      emitSegmentState(index, 'aborted');
      wlog(`seg ${index} aborted during processing`);
      return;
    }
    emitSegmentState(index, 'error', { message: String(err) });
    throw err;
  }
}

function emitSubtitleProgress(
  trackIndex: number,
  requestId: number,
  progress: SubtitleExtractionProgress,
  queueDelayMs = 0,
): void {
  if (progress.phase === 'done') {
    return;
  }
  const message: WorkerSubtitleProgressMessage = {
    type: 'subtitle-progress',
    trackIndex,
    requestId,
    phase: progress.phase,
    codec: progress.codec,
    cuesRead: progress.cuesRead,
    elapsedMs: progress.elapsedMs,
    queueDelayMs,
  };
  self.postMessage(message);
}

async function handleSubtitle(
  trackIndex: number,
  requestId: number,
  queueDelayMs = 0,
  seekTimeSec?: number,
  endTimeSec?: number,
) {
  if (!demux) {
    self.postMessage({ type: 'error', message: 'No file open' });
    return;
  }

  subtitleAbort = new AbortController();
  const { signal } = subtitleAbort;

  const t0 = performance.now();
  let hasSentStart = false;
  const subInput = await ensureSubtitleInput();
  const { codec } = await extractSubtitleDataStreaming(subInput, trackIndex, {
    onBatch(cues, done, totalCues, batchCodec) {
      const message: WorkerSubtitleBatchMessage = {
        type: 'subtitle-batch',
        trackIndex,
        requestId,
        codec: batchCodec,
        cues,
        done,
        totalCues,
      };
      self.postMessage(message);
    },
    onProgress(progress) {
      emitSubtitleProgress(trackIndex, requestId, progress, hasSentStart ? 0 : queueDelayMs);
      hasSentStart = true;
    },
    signal,
    startTimeSec: seekTimeSec,
    endTimeSec,
    maxDurationMs: 3000,
  });

  subtitleAbort = null;

  if (signal.aborted) {
    wlog(`subtitle track=${trackIndex} aborted`);
    return;
  }

  wlog(
    `subtitle track=${trackIndex} streaming done codec=${codec} seekFrom=${seekTimeSec ?? 0} endAt=${endTimeSec ?? 'end'} ${elapsed(t0)}`,
  );
}
