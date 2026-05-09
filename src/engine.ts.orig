import type {
  FragmentLoaderContext,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderStats,
  PlaylistLoaderContext,
} from 'hls.js';
import Hls from 'hls.js/light';
import type { Source } from './source.js';
import { WasmFfmpegRunner } from './adapters/wasm-ffmpeg.js';
import {
  createBrowserPlaybackCapabilities,
  evaluatePlaybackOptions,
  type PlaybackDiagnostic,
  type PlaybackEvaluationResult,
  type PlaybackMediaMetadata,
  type PlaybackMode,
  type PlaybackOption,
  type PlaybackOptionEvaluation,
} from './playback-selection.js';
import { getAv1Fallback, getAv1UnsupportedMessage, getAv1MalformedMessage, detectAv1Support, validateAv1Metadata } from './av1-capability.js';
import {
  createLocalAudioTranscoder,
  isAudioTranscodeInputSupported,
  makeAacDecoderConfig,
} from './pipeline/audio-transcode.js';
import type { DemuxResult, SegmentBoundaryResolver } from './pipeline/demux.js';
import { generateVodPlaylist } from './pipeline/playlist.js';
import { buildSegmentPlan } from './pipeline/segment-plan.js';
import {
  extractSubtitleData,
  parseSubtitleFile,
  subtitleDataToWebVTT,
  type SubtitleExtractionProgress,
} from './pipeline/subtitle.js';
import {
  seekSubtitleInMkv,
  getMkvSeekingMetadata,
  type SeekSubtitleOptions,
  type SeekSubtitleResult,
} from './pipeline/subtitle-seeking.js';
import { processSegmentWithAbort } from './pipeline/segment-processor.js';
import { isAbortableSource } from './pipeline/source-signal.js';
import type {
  FfmpegRunner,
  KeyframeIndex,
  PlannedSegment,
  SubtitleTrackInfo,
  SubtitleCueEntry,
} from './pipeline/types.js';
import type { TranscodeWorkerSnapshot, TranscodeWorkerStateMessage } from './transcode-protocol.js';
import type {
  WorkerSegmentStateMessage,
  WorkerSubtitleProgressMessage,
} from './worker-protocol.js';

export type EnginePhase = 'idle' | 'demuxing' | 'ready' | 'error';

export interface ReadyDetail {
  totalSegments: number;
  durationSec: number;
  subtitleTracks: SubtitleTrackInfo[];
  passthrough?: boolean;
  codecPath: CodecPath;
}

export interface ErrorDetail {
  message: string;
}

export interface LoadingDetail {
  file?: File;
  url?: string;
}

export interface SubtitleStatusDetail {
  message: string;
}

export interface WasmWorkerState extends TranscodeWorkerSnapshot {
  id: number;
}

export interface WorkerStateDetail {
  workers: WasmWorkerState[];
}

export interface PlaybackDecisionDetail {
  media: PlaybackMediaMetadata;
  evaluation: PlaybackEvaluationResult;
  playbackPolicy: PlaybackPolicy;
}

export type PlaybackPolicy = 'auto' | 'force-hls';

export type SegmentPhase =
  | 'requested'
  | 'queued'
  | 'prefetching'
  | 'processing'
  | 'ready'
  | 'cache-hit'
  | 'delivered'
  | 'canceled'
  | 'aborted'
  | 'error';

export interface SegmentTimelineEvent {
  phase: SegmentPhase;
  atMs: number;
  sizeBytes: number | null;
  message: string | null;
}

export interface SegmentState {
  index: number;
  phase: SegmentPhase;
  requestCount: number;
  sizeBytes: number | null;
  latencyMs: number | null;
  error: string | null;
  prefetched: boolean;
  events: SegmentTimelineEvent[];
}

interface BufferedGap {
  start: number;
  end: number;
  gap: number;
}

interface SegmentDeliveryDebug {
  index: number;
  sizeBytes: number;
  deliveredAtMs: number;
  fromCache: boolean;
}

const MEDIA_ERROR_CODES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
};

export interface SegmentStateDetail {
  segments: SegmentState[];
}

export type EmbeddedSubtitlePolicy = 'auto' | 'off';

export interface EngineOptions {
  /**
   * Number of internal audio transcode workers to create for worker-mode playback.
   * Use 0 to disable the pool and keep all transcode work inside the coordinator worker.
   */
  transcodeWorkers?: number;
  embeddedSubtitlePolicy?: EmbeddedSubtitlePolicy;
}

export interface LoadStartOptions {
  /** Initial playback position in seconds. Used to start HLS loading at the resume target. */
  startTimeSec?: number;
}

export interface LoadWithOptionsInput {
  source: Source;
  options: PlaybackOption[];
  ffmpeg?: FfmpegRunner;
  targetSegmentDuration?: number;
  preferenceOrder?: PlaybackMode[];
  playbackPolicy?: PlaybackPolicy;
  startTimeSec?: number;
}

export interface ExternalSubtitleOptions {
  label?: string;
  language?: string;
  kind?: 'subtitles' | 'captions';
}

export interface SubtitleSeekingOptions {
  /** Target time in seconds to seek to */
  targetTimeSec: number;
  /** Subtitle track index to seek within */
  trackIndex: number;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
}

export interface SubtitleSeekingResult {
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

export interface CodecDescriptor {
  short: string | null;
  full: string | null;
}

export interface CodecPath {
  mode: 'passthrough' | 'pipeline';
  sourceVideo: CodecDescriptor;
  sourceAudio: CodecDescriptor;
  outputVideo: CodecDescriptor;
  outputAudio: CodecDescriptor;
}

interface EngineEventMap {
  ready: CustomEvent<ReadyDetail>;
  error: CustomEvent<ErrorDetail>;
  loading: CustomEvent<LoadingDetail>;
  'subtitle-status': CustomEvent<SubtitleStatusDetail>;
  workerstatechange: CustomEvent<WorkerStateDetail>;
  segmentstatechange: CustomEvent<SegmentStateDetail>;
  playbackdecision: CustomEvent<PlaybackDecisionDetail>;
}

interface TranscodeWorkerHandle {
  worker: Worker;
}

interface AttachedSubtitleTrack {
  element: HTMLTrackElement;
  url: string;
  source: 'embedded' | 'external';
  trackIndex?: number;
  /** For incremental cue tracks created via addTextTrack() */
  textTrack?: TextTrack;
}

function normalizeErrorMessage(message: string): string {
  return message.replace(/^Error:\s*/, '').trim();
}

function defaultTranscodeWorkerCount(): number {
  const concurrency =
    typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency
      : 2;
  return Math.max(1, Math.min(2, concurrency - 1));
}

function describeMediaError(error: MediaError | null): string {
  if (!error) return 'none';
  const codeName = MEDIA_ERROR_CODES[error.code] ?? `UNKNOWN_${error.code}`;
  const message = error.message ? ` message=${error.message}` : '';
  return `${codeName}(${error.code})${message}`;
}

export class PlaysVideoEngine extends EventTarget {
  readonly video: HTMLVideoElement;
  readonly options: Required<EngineOptions>;
  private worker: Worker | null = null;
  private transcodeWorkers: TranscodeWorkerHandle[] = [];
  private _transcodeWorkerStates: WasmWorkerState[] = [];
  private _segmentStates = new Map<number, SegmentState>();
  private _lastBufferedGapsBySegment = new Map<number, BufferedGap[]>();
  private _recentSegmentDeliveries: SegmentDeliveryDebug[] = [];
  private hls: Hls | null = null;

  // Pending segment requests from hls.js custom loader
  private pendingSegments = new Map<
    number,
    { resolve: (data: ArrayBuffer) => void; reject: (err: Error) => void }
  >();

  // Cached data from the worker
  private playlist: string | null = null;
  private initData: ArrayBuffer | null = null;
  private pendingInit: {
    resolve: (data: ArrayBuffer) => void;
    reject: (err: Error) => void;
  } | null = null;
  private pendingPlaylist: {
    resolve: (data: string) => void;
    reject: (err: Error) => void;
  } | null = null;

  private segmentRequestTimes = new Map<number, number>();
  private subtitleRequestTimes = new Map<number, number>();

  // Subtitle state
  private attachedSubtitleTracks: AttachedSubtitleTrack[] = [];
  private _subtitleTracks: SubtitleTrackInfo[] = [];
  private subtitleWindowEnd = new Map<number, number>();
  private subtitleWindowLoading = new Set<number>();
  private subtitleRequestedWindowEnd = new Map<number, number>();
  private _selectOnExtract = new Map<number, boolean>();
  private _subtitleRequestSeq = 0;
  private _activeSubtitleRequestIds = new Map<number, number>();

  // Public read-only state
  private _phase: EnginePhase = 'idle';
  private _totalSegments = 0;
  private _durationSec = 0;

  // Passthrough state
  private _passthrough = false;
  private _blobUrl: string | null = null;
  private _pendingFileType: string | null = null;
  private _codecPath: CodecPath = {
    mode: 'pipeline',
    sourceVideo: { short: null, full: null },
    sourceAudio: { short: null, full: null },
    outputVideo: { short: null, full: null },
    outputAudio: { short: null, full: null },
  };

  // Pre-built keyframe index (e.g. from MKV cues) to skip mediabunny scan
  private _keyframeIndex: KeyframeIndex | null = null;

  // Main-thread pipeline state (used by loadSource)
  private _source: Source | null = null;
  private _sourceDemux: DemuxResult | null = null;
  private _sourcePlan: PlannedSegment[] = [];
  private _sourceBoundaryResolver: SegmentBoundaryResolver | null = null;
  private _sourceDoTranscode = false;
  private _sourceAudioDecoderConfig: AudioDecoderConfig | null = null;
  private _sourceInitSegment: Uint8Array | null = null;
  private _sourceFfmpeg: FfmpegRunner | null = null;
  private _sourceTargetSegDuration = 4;
  private _sourceSegmentAbort: AbortController | null = null;
  private _sourcePrefetchCache = new Map<number, ArrayBuffer>();
  private _sourcePrefetchAbort: AbortController | null = null;
  private _sourcePrefetchIndex: number | null = null;
  private _sourcePlaybackOptions: PlaybackOption[] | null = null;
  private _sourcePreferenceOrder: PlaybackMode[] | null = null;
  private _av1Support?: 'supported' | 'unsupported' | 'unknown';
  private _sourcePlaybackPolicy: PlaybackPolicy = 'auto';
  private _lastInternalErrorMessage: string | null = null;
  private _lastInternalErrorAt = 0;
  private _initialStartTimeSec: number | null = null;
  private _hlsLoadStarted = false;
  private _hlsMediaAttached = false;
  private _hlsManifestParsed = false;
  private _hlsSourceOpenFired = false;
  private _deferredHlsStartPosition: number | null = null;

  private _onVideoPause = (): void => {
    if (this.hls) {
      this.hls.stopLoad();
      mlog('video paused → hls.stopLoad');
    }
    this.worker?.postMessage({ type: 'pause' });
    if (this._sourcePrefetchAbort) {
      this._sourcePrefetchAbort.abort();
      this._sourcePrefetchAbort = null;
      this._sourcePrefetchIndex = null;
      mlog('video paused → source prefetch aborted');
    }
  };

  private _onVideoPlay = (): void => {
    if (this.hls) {
      this.tryStartHlsLoad('video play');
    }
    this.worker?.postMessage({ type: 'resume' });
  };

  private applyHlsStartPositionToMedia(startPosition: number, reason: string): void {
    if (!Number.isFinite(startPosition) || startPosition <= 0) return;
    if (Math.abs(this.video.currentTime - startPosition) <= 0.5) return;

    try {
      this.video.currentTime = startPosition;
      mlog(`${reason} → set currentTime=${startPosition.toFixed(3)} for HLS resume`);
    } catch (err) {
      mlog(`${reason} → failed to set currentTime=${startPosition.toFixed(3)}: ${String(err)}`);
    }
  }

  private tryStartHlsLoad(reason: string): void {
    if (!this.hls || this._hlsLoadStarted) return;
    if (!this._hlsMediaAttached || !this._hlsManifestParsed) {
      mlog(
        `${reason} → defer hls.startLoad mediaAttached=${this._hlsMediaAttached} manifestParsed=${this._hlsManifestParsed}`,
      );
      return;
    }

    // Safari-critical: defer seek until sourceopen
    if (!this._hlsSourceOpenFired) {
      mlog(`${reason} → defer hls.startLoad until sourceopen`);
      return;
    }

    const startPosition = this.consumeHlsStartPosition();
    this._deferredHlsStartPosition = startPosition;

    // Apply seek AFTER sourceopen but BEFORE startLoad
    this.applyHlsStartPositionToMedia(startPosition, `${reason} (post-sourceopen)`);

    this.hls.startLoad(startPosition);
    this._hlsLoadStarted = true;
    mlog(`${reason} → hls.startLoad(${startPosition.toFixed(3)}) [sourceopen ready]`);
  }


  private _onVideoSeeked = (): void => {
    const seekTime = this.video.currentTime;
    mlog(`video seeked → t=${seekTime.toFixed(3)}, re-requesting embedded subtitles`);
    this.restartEmbeddedSubtitlesFromPosition(seekTime);
  };

  get phase(): EnginePhase {
    return this._phase;
  }
  get loading(): boolean {
    return this._phase === 'demuxing';
  }
  get totalSegments(): number {
    return this._totalSegments;
  }
  get durationSec(): number {
    return this._durationSec;
  }
  get subtitleTracks(): SubtitleTrackInfo[] {
    return this._subtitleTracks;
  }

  requestSubtitleExtraction(trackIndex: number, select = true): boolean {
    const track = this._subtitleTracks.find((t) => t.index === trackIndex);
    if (!track || !this.worker) return false;
    if (select) {
      this.cancelPendingSubtitleWork();
    }
    const alreadyExtracted = this.attachedSubtitleTracks.some(
      (a) => a.source === 'embedded' && a.trackIndex === trackIndex,
    );
    if (select) {
      this.showOnlyEmbeddedSubtitleTrack(trackIndex);
    }
    if (alreadyExtracted) return true;
    this._selectOnExtract.set(trackIndex, select);
    this.requestEmbeddedSubtitleTrack(track, select ? this.video.currentTime || 0 : undefined);
    return true;
  }

  get passthrough(): boolean {
    return this._passthrough;
  }
  get codecPath(): CodecPath {
    return {
      mode: this._codecPath.mode,
      sourceVideo: { ...this._codecPath.sourceVideo },
      sourceAudio: { ...this._codecPath.sourceAudio },
      outputVideo: { ...this._codecPath.outputVideo },
      outputAudio: { ...this._codecPath.outputAudio },
    };
  }
  get transcodeWorkerStates(): WasmWorkerState[] {
    return this._transcodeWorkerStates.map((worker) => ({ ...worker }));
  }
  get segmentStates(): SegmentState[] {
    return Array.from(this._segmentStates.values())
      .sort((a, b) => a.index - b.index)
      .map((segment) => ({
        ...segment,
        events: segment.events.map((event) => ({ ...event })),
      }));
  }

  constructor(video: HTMLVideoElement, options: EngineOptions = {}) {
    super();
    this.video = video;
    this.options = {
      transcodeWorkers: options.transcodeWorkers ?? defaultTranscodeWorkerCount(),
      embeddedSubtitlePolicy: options.embeddedSubtitlePolicy ?? 'auto',
    };
    this.video.addEventListener('timeupdate', () => this.checkSubtitlePrefetch());
  }

  loadFile(file: File, opts?: { keyframeIndex?: KeyframeIndex } & LoadStartOptions): void {
    this.reset({ file });
    this._pendingFileType = file.type || null;
    this._blobUrl = URL.createObjectURL(file);
    this._keyframeIndex = opts?.keyframeIndex ?? null;
    this.setInitialStartTime(opts?.startTimeSec);
    this.createWorker();
    this.worker!.postMessage({ type: 'open', file });
    mlog(`open file=${file.name} size=${(file.size / 1024 / 1024).toFixed(1)}MB type=${file.type}`);
  }

  /**
   * Re-acquire the file after the Blob became stale. Re-demuxes in the worker
   * without resetting HLS or the segment plan.
   */
  refreshFile(file: File): void {
    if (!this.worker) return;
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
    }
    this._blobUrl = URL.createObjectURL(file);
    this.worker.postMessage({ type: 'refresh-file', file });
    mlog(`refresh file=${file.name} size=${(file.size / 1024 / 1024).toFixed(1)}MB`);
  }

  loadUrl(url: string, opts?: { keyframeIndex?: KeyframeIndex } & LoadStartOptions): void {
    this.reset({ url });
    this._keyframeIndex = opts?.keyframeIndex ?? null;
    this.setInitialStartTime(opts?.startTimeSec);
    const directMimeType = inferDirectUrlMimeType(url);
    this._sourcePlaybackOptions = directMimeType
      ? [
          { mode: 'direct-url', mimeType: directMimeType, url },
          { mode: 'hls' },
        ]
      : null;
    this._sourcePreferenceOrder = null;
    this._sourcePlaybackPolicy = 'auto';
    this.createWorker();
    this.worker!.postMessage({ type: 'open-url', url });
    mlog(`open url=${url}`);
  }

  async loadExternalSubtitle(file: File, options: ExternalSubtitleOptions = {}): Promise<void> {
    if (this._phase !== 'ready') {
      throw new Error('Load a video before adding an external subtitle file');
    }

    const text = await file.text();
    const data = parseSubtitleFile(text, file.name);
    if (data.codec === 'ass' || data.codec === 'ssa') {
      throw new Error('External .ass/.ssa subtitles are not supported yet');
    }

    const webvtt = subtitleDataToWebVTT(data);
    this.clearExternalSubtitles();
    this.addSubtitleTrack({
      webvtt,
      source: 'external',
      label: options.label ?? file.name.replace(/\.[^.]+$/, ''),
      language: options.language ?? 'und',
      kind: options.kind ?? 'subtitles',
      defaultTrack: true,
      selectTrack: true,
    });
  }

  clearExternalSubtitles(): void {
    this.removeSubtitleTracks('external');
    this.restoreDefaultTextTrack();
  }

  /**
   * Load from an external Source (e.g. TorrentSource).
   *
   * Runs the pipeline on the main thread (no worker) because external Sources
   * typically need access to objects on the main thread.
   *
   * If the Source implements AbortableSource, the pipeline will call
   * setCurrentSignal() before each segment so the Source can abort in-flight
   * reads on seek.
   */
  loadSource(
    source: Source,
    opts?: {
      keyframeIndex?: KeyframeIndex;
      ffmpeg?: FfmpegRunner;
      targetSegmentDuration?: number;
      startTimeSec?: number;
    },
  ): void {
    this.reset({});
    this._keyframeIndex = opts?.keyframeIndex ?? null;
    this.setInitialStartTime(opts?.startTimeSec);
    this._sourcePlaybackOptions = null;
    this._sourcePreferenceOrder = null;
    this._sourcePlaybackPolicy = 'auto';
    this._source = source;
    this._sourcePlan = [];
    this._sourceBoundaryResolver = null;
    this._sourceDoTranscode = false;
    this._sourceAudioDecoderConfig = null;
    this._sourceInitSegment = null;
    this._sourceFfmpeg = opts?.ffmpeg ?? null;
    this._sourceTargetSegDuration = opts?.targetSegmentDuration ?? 4;
    this.startSourcePipeline(source);
  }

  loadWithOptions(input: LoadWithOptionsInput): void {
    this.reset({});
    this._keyframeIndex = null;
    this.setInitialStartTime(input.startTimeSec);
    this._source = input.source;
    this._sourcePlan = [];
    this._sourceBoundaryResolver = null;
    this._sourceDoTranscode = false;
    this._sourceAudioDecoderConfig = null;
    this._sourceInitSegment = null;
    this._sourceFfmpeg = input.ffmpeg ?? null;
    this._sourceTargetSegDuration = input.targetSegmentDuration ?? 4;
    this._sourcePlaybackOptions = input.options.length > 0 ? [...input.options] : [{ mode: 'hls' }];
    this._sourcePreferenceOrder = input.preferenceOrder ? [...input.preferenceOrder] : null;
    this._sourcePlaybackPolicy = input.playbackPolicy ?? 'auto';
    this.startSourcePipeline(input.source);
  }

  private reset(detail: LoadingDetail): void {
    this.video.removeEventListener('pause', this._onVideoPause);
    this.video.removeEventListener('play', this._onVideoPlay);
    this.video.removeEventListener('seeked', this._onVideoSeeked);

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.destroyTranscodeWorkers();
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
    if (this._passthrough) {
      this.video.removeAttribute('src');
      this.video.load();
    }

    this.playlist = null;
    this.initData = null;
    this.pendingSegments.clear();
    this.segmentRequestTimes.clear();
    this.subtitleRequestTimes.clear();
    this.subtitleWindowEnd.clear();
    this.subtitleWindowLoading.clear();
    this.subtitleRequestedWindowEnd.clear();
    this._activeSubtitleRequestIds.clear();
    this._selectOnExtract.clear();
    this.removeSubtitleTracks();

    this._phase = 'demuxing';
    this._totalSegments = 0;
    this._durationSec = 0;
    this._subtitleTracks = [];
    this._passthrough = false;
    this._pendingFileType = null;
    this._keyframeIndex = null;
    this._codecPath = {
      mode: 'pipeline',
      sourceVideo: { short: null, full: null },
      sourceAudio: { short: null, full: null },
      outputVideo: { short: null, full: null },
      outputAudio: { short: null, full: null },
    };

    // Source pipeline cleanup
    if (this._sourceSegmentAbort) {
      this._sourceSegmentAbort.abort();
      this._sourceSegmentAbort = null;
    }
    if (this._sourcePrefetchAbort) {
      this._sourcePrefetchAbort.abort();
      this._sourcePrefetchAbort = null;
    }
    this._sourcePrefetchCache.clear();
    this._sourcePrefetchIndex = null;
    if (this._source && isAbortableSource(this._source)) {
      this._source.setCurrentSignal(null);
    }
    this._source?._dispose();
    this._source = null;
    this._sourceDemux?.dispose();
    this._sourceDemux = null;
    this._sourcePlan = [];
    this._sourceBoundaryResolver = null;
    this._sourceDoTranscode = false;
    this._sourceAudioDecoderConfig = null;
    this._sourceInitSegment = null;
    this._sourceFfmpeg = null;
    this._sourcePlaybackOptions = null;
    this._sourcePreferenceOrder = null;
    this._sourcePlaybackPolicy = 'auto';
    this._segmentStates.clear();
    this._lastInternalErrorMessage = null;
    this._lastInternalErrorAt = 0;

    this.dispatchEvent(new CustomEvent('loading', { detail }));
    this.dispatchSegmentStateChange();
  }

  private createWorker(): void {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handleWorkerMessage(e);
    this.worker.onerror = (e) => {
      this.failPlayback(e.message || 'Playback worker crashed');
    };
  }

  private ensureTranscodeWorkers(): void {
    if (!this.worker || this.transcodeWorkers.length > 0 || this.options.transcodeWorkers <= 0) {
      return;
    }

    for (let i = 0; i < this.options.transcodeWorkers; i++) {
      const worker = new Worker(new URL('./transcode-worker.js', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event) => this.handleTranscodeWorkerMessage(i, event);
      worker.onerror = (event) => {
        const message = event.message || 'Transcode worker crashed';
        this.updateTranscodeWorkerState(i, {
          phase: 'error',
          jobId: null,
          lastError: message,
        });
        this.worker?.postMessage({ type: 'transcode-worker-failed', id: i, message });
      };
      const channel = new MessageChannel();
      worker.postMessage({ type: 'connect' }, [channel.port2]);
      this.worker.postMessage({ type: 'transcode-port', id: i }, [channel.port1]);
      this.transcodeWorkers.push({ worker });
      this._transcodeWorkerStates.push({
        id: i,
        phase: 'starting',
        sourceCodec: null,
        jobId: null,
        inputBytes: null,
        outputBytes: null,
        totalMs: null,
        ffmpegMs: null,
        jobsCompleted: 0,
        lastError: null,
      });
    }
    this.dispatchWorkerStateChange();
  }

  private destroyTranscodeWorkers(): void {
    for (const handle of this.transcodeWorkers) {
      handle.worker.terminate();
    }
    this.transcodeWorkers = [];
    this._transcodeWorkerStates = [];
    this.dispatchWorkerStateChange();
  }

  /**
   * Seek to a specific time within a subtitle track.
   * Only works for MKV files with Cues index.
   */
  async seekSubtitle(options: SubtitleSeekingOptions): Promise<SeekSubtitleResult | null> {
    if (!this._sourceDemux) {
      throw new Error('Load a video before seeking subtitles');
    }

    if (options.trackIndex < 0 || options.trackIndex >= this._subtitleTracks.length) {
      throw new Error(`Subtitle track ${options.trackIndex} not found`);
    }

    try {
      const result = await seekSubtitleInMkv(this._sourceDemux.input, options.trackIndex, {
        targetTimeSec: options.targetTimeSec,
        signal: options.signal,
      });
      return result;
    } catch (error) {
      mlog(`Subtitle seeking failed: ${String(error)}`);
      return null;
    }
  }

  /**
   * Get metadata about subtitle seeking capabilities for a track.
   * Returns null if seeking is unavailable (non-MKV, no Cues, etc).
   */
  async getSubtitleSeekingMetadata(trackIndex: number): Promise<{
    hasCuesIndex: boolean;
    cueCount: number;
    estimatedLatencyMs: number;
  } | null> {
    if (!this._sourceDemux) {
      return null;
    }

    if (trackIndex < 0 || trackIndex >= this._subtitleTracks.length) {
      return null;
    }

    try {
      const metadata = await getMkvSeekingMetadata(this._sourceDemux.input);
      if (!metadata) {
        return null;
      }

      return {
        hasCuesIndex: metadata.hasCuesIndex,
        cueCount: metadata.cueCount,
        estimatedLatencyMs: metadata.estimatedSeekLatencyMs,
      };
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.video.removeEventListener('pause', this._onVideoPause);
    this.video.removeEventListener('play', this._onVideoPlay);
    this.video.removeEventListener('seeked', this._onVideoSeeked);

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.destroyTranscodeWorkers();
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
    if (this._passthrough) {
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.removeSubtitleTracks();
    if (this._sourceSegmentAbort) {
      this._sourceSegmentAbort.abort();
      this._sourceSegmentAbort = null;
    }
    if (this._sourcePrefetchAbort) {
      this._sourcePrefetchAbort.abort();
      this._sourcePrefetchAbort = null;
    }
    this._sourcePrefetchCache.clear();
    this._sourcePrefetchIndex = null;
    if (this._source && isAbortableSource(this._source)) {
      this._source.setCurrentSignal(null);
    }
    this._source?._dispose();
    this._source = null;
    this._sourceDemux?.dispose();
    this._sourceDemux = null;
    this.pendingSegments.clear();
    this.segmentRequestTimes.clear();
    this.subtitleRequestTimes.clear();
    this.subtitleWindowEnd.clear();
    this.subtitleWindowLoading.clear();
    this._phase = 'idle';
    this._passthrough = false;
    this._segmentStates.clear();
    this._lastInternalErrorMessage = null;
    this._lastInternalErrorAt = 0;
    this._initialStartTimeSec = null;
    this._hlsLoadStarted = false;
    this.dispatchSegmentStateChange();
  }

  // Typed addEventListener overloads
  addEventListener<K extends keyof EngineEventMap>(
    type: K,
    listener: (ev: EngineEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((ev: CustomEvent) => void),
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject, options);
  }

  private dispatchWorkerStateChange(): void {
    this.dispatchEvent(
      new CustomEvent('workerstatechange', {
        detail: {
          workers: this.transcodeWorkerStates,
        },
      }),
    );
  }

  private dispatchSegmentStateChange(): void {
    this.dispatchEvent(
      new CustomEvent('segmentstatechange', {
        detail: {
          segments: this.segmentStates,
        },
      }),
    );
  }

  private handleTranscodeWorkerMessage(
    id: number,
    event: MessageEvent<TranscodeWorkerStateMessage>,
  ) {
    const msg = event.data;
    if (!msg || msg.type !== 'worker-state') {
      return;
    }
    this.updateTranscodeWorkerState(id, msg.state);
  }

  private updateTranscodeWorkerState(id: number, patch: Partial<TranscodeWorkerSnapshot>): void {
    const index = this._transcodeWorkerStates.findIndex((worker) => worker.id === id);
    if (index === -1) {
      return;
    }
    this._transcodeWorkerStates[index] = {
      ...this._transcodeWorkerStates[index],
      ...patch,
      id,
    };
    if (patch.phase === 'error' && patch.lastError) {
      this.recordInternalError(patch.lastError);
    }
    this.dispatchWorkerStateChange();
  }

  private setInitialStartTime(value: number | undefined): void {
    this._initialStartTimeSec = Number.isFinite(value) && value! > 0 ? Math.max(0, value!) : null;
    this._hlsLoadStarted = false;
    this._hlsMediaAttached = false;
    this._hlsManifestParsed = false;
    this._hlsSourceOpenFired = false;
    this._deferredHlsStartPosition = null;
  }

  private consumeHlsStartPosition(): number {
    if (this._hlsLoadStarted) return -1;
    this._hlsLoadStarted = true;
    const start = this._initialStartTimeSec;
    this._initialStartTimeSec = null;
    return start !== null ? start : -1;
  }

  private noteSegmentState(
    index: number,
    phase: SegmentPhase,
    opts: {
      sizeBytes?: number;
      message?: string;
      latencyMs?: number;
      incrementRequestCount?: boolean;
      prefetched?: boolean;
    } = {},
  ): void {
    const existing = this._segmentStates.get(index);
    const next: SegmentState = existing
      ? {
          ...existing,
          events: [...existing.events],
        }
      : {
          index,
          phase,
          requestCount: 0,
          sizeBytes: null,
          latencyMs: null,
          error: null,
          prefetched: false,
          events: [],
        };

    next.phase = phase;
    if (opts.incrementRequestCount) {
      next.requestCount += 1;
    }
    if (opts.prefetched !== undefined) {
      next.prefetched = opts.prefetched;
    } else if (phase === 'prefetching') {
      next.prefetched = true;
    }
    if (opts.sizeBytes !== undefined) {
      next.sizeBytes = opts.sizeBytes;
    }
    if (opts.latencyMs !== undefined) {
      next.latencyMs = opts.latencyMs;
    }
    next.error = phase === 'error' ? (opts.message ?? next.error) : null;
    next.events.push({
      phase,
      atMs: performance.now(),
      sizeBytes: opts.sizeBytes ?? null,
      message: opts.message ?? null,
    });

    this._segmentStates.set(index, next);
    this.dispatchSegmentStateChange();
  }

  private handleWorkerSegmentState(msg: WorkerSegmentStateMessage): void {
    if (msg.phase === 'error' && msg.message) {
      this.recordInternalError(msg.message);
    }
    this.noteSegmentState(msg.index, msg.phase, {
      sizeBytes: msg.sizeBytes,
      message: msg.message,
    });
  }

  private getSegmentContinuitySnapshot(index: number): string {
    const state = this._segmentStates.get(index);
    if (!state || state.events.length === 0) {
      return 'timeline=unavailable';
    }

    const startedAt = state.events[0]?.atMs ?? null;
    const finishedAt = [...state.events]
      .reverse()
      .find((event) => event.phase === 'delivered' || event.phase === 'ready')?.atMs;
    const totalMs =
      startedAt !== null && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : null;

    const phaseParts: string[] = [];
    const interestingPhases: SegmentPhase[] = [
      'requested',
      'prefetching',
      'processing',
      'ready',
      'cache-hit',
      'delivered',
      'error',
    ];
    for (const phase of interestingPhases) {
      const event = [...state.events].reverse().find((entry) => entry.phase === phase);
      if (event && startedAt !== null) {
        phaseParts.push(`${phase}@+${(event.atMs - startedAt).toFixed(1)}ms`);
      }
    }

    const timeline = phaseParts.length > 0 ? phaseParts.join(' ') : 'timeline=missing';
    const latency =
      state.latencyMs !== null ? `latency=${state.latencyMs.toFixed(1)}ms` : 'latency=?';
    const size = state.sizeBytes !== null ? `size=${state.sizeBytes}` : 'size=?';
    const total = totalMs !== null ? `total=${totalMs.toFixed(1)}ms` : 'total=?';
    return `${latency} ${size} ${total} ${timeline}`;
  }

  private noteSegmentDeliveredForDebug(index: number, sizeBytes: number, fromCache: boolean): void {
    this._recentSegmentDeliveries.push({
      index,
      sizeBytes,
      deliveredAtMs: performance.now(),
      fromCache,
    });
    if (this._recentSegmentDeliveries.length > 12) {
      this._recentSegmentDeliveries.splice(0, this._recentSegmentDeliveries.length - 12);
    }
  }

  private debugPlaybackSnapshot(fragSn?: number | string | null): string {
    const buffered: string[] = [];
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      buffered.push(`[${ranges.start(i).toFixed(3)},${ranges.end(i).toFixed(3)}]`);
    }

    const deliveries = this._recentSegmentDeliveries
      .map((entry) => {
        const ageMs = Math.max(0, performance.now() - entry.deliveredAtMs).toFixed(0);
        return `${entry.index}:${entry.sizeBytes}${entry.fromCache ? ':cache' : ''}@-${ageMs}ms`;
      })
      .join(' ');
    const sn = typeof fragSn === 'number' ? fragSn : Number.NaN;
    const nearby = Number.isFinite(sn)
      ? [sn - 1, sn, sn + 1]
          .filter((idx) => idx >= 0)
          .map((idx) => `seg${idx}{${this.getSegmentContinuitySnapshot(idx)}}`)
          .join(' ')
      : '';

    return [
      `t=${this.video.currentTime.toFixed(3)}`,
      `ready=${this.video.readyState}`,
      `network=${this.video.networkState}`,
      `paused=${this.video.paused}`,
      `buffered=${buffered.join(' ') || 'none'}`,
      `pending=${this.pendingSegments.size}`,
      `prefetch=${this._sourcePrefetchIndex ?? 'none'}`,
      `recent=${deliveries || 'none'}`,
      nearby,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private recordInternalError(message: string): string {
    const normalized = normalizeErrorMessage(message);
    this._lastInternalErrorMessage = normalized;
    this._lastInternalErrorAt = performance.now();
    return normalized;
  }

  private getRecentInternalError(maxAgeMs = 5000): string | null {
    if (!this._lastInternalErrorMessage) {
      return null;
    }
    if (performance.now() - this._lastInternalErrorAt > maxAgeMs) {
      return null;
    }
    return this._lastInternalErrorMessage;
  }

  private failPlayback(message: string): void {
    const normalized = this.recordInternalError(message);
    this._phase = 'error';
    this.dispatchEvent(new CustomEvent('error', { detail: { message: normalized } }));
  }

  private createPlaybackCapabilities(): ReturnType<typeof createBrowserPlaybackCapabilities> {
    const capabilities = createBrowserPlaybackCapabilities(this.video);
    if (FORCE_REMUX) {
      return {
        ...capabilities,
        canPlayType: () => '' as const,
      };
    }
    return capabilities;
  }

  private async populateAv1Metadata(media: PlaybackMediaMetadata, source?: File | Blob | ArrayBuffer): Promise<void> {
    // Detect AV1 support once and cache
    if (!this._av1Support) {
      this._av1Support = await detectAv1Support();
    }

    // Check if video codec is AV1
    const isAv1 = media.sourceVideoCodec === 'av1' || 
                  media.videoCodec?.startsWith('av01');
    media.isAv1Video = isAv1;

    // Validate AV1 metadata if applicable
    if (isAv1 && source) {
      try {
        media.av1MetadataValid = await validateAv1Metadata(source);
      } catch (error) {
        console.warn('[AV1] Metadata validation error:', error);
        media.av1MetadataValid = null;
      }
    }
  }

  private evaluateInitialPlayback(media: PlaybackMediaMetadata): PlaybackEvaluationResult {
    const options = this._blobUrl
      ? [
          { mode: 'direct-bytes', mimeType: this._pendingFileType, url: this._blobUrl } as const,
          { mode: 'hls' } as const,
        ]
      : this._sourcePlaybackOptions
        ? this._sourcePlaybackOptions
      : ([{ mode: 'hls' }] as const);

    return evaluatePlaybackOptions({
      options: [...options],
      media,
      capabilities: this.createPlaybackCapabilities(),
    });
  }

  private evaluateHlsPlayback(media: PlaybackMediaMetadata): PlaybackOptionEvaluation {
    return evaluatePlaybackOptions({
      options: [{ mode: 'hls' }],
      media,
      capabilities: this.createPlaybackCapabilities(),
    }).evaluations[0];
  }

  private evaluateSourcePlayback(media: PlaybackMediaMetadata): PlaybackEvaluationResult {
    return evaluatePlaybackOptions({
      options: this.getSourcePlaybackOptions(),
      media,
      capabilities: this.createPlaybackCapabilities(),
      preferenceOrder: this._sourcePreferenceOrder ?? undefined,
    });
  }

  private getSourcePlaybackOptions(): PlaybackOption[] {
    const baseOptions: PlaybackOption[] = this._sourcePlaybackOptions
      ? [...this._sourcePlaybackOptions]
      : [{ mode: 'hls' }];
    if (this._sourcePlaybackPolicy !== 'force-hls') {
      return baseOptions;
    }
    const hlsOption = baseOptions.find((option) => option.mode === 'hls');
    return hlsOption ? [hlsOption] : [{ mode: 'hls' }];
  }

  private logPlaybackDiagnostics(context: string, evaluation: PlaybackEvaluationResult): void {
    for (const entry of evaluation.evaluations) {
      for (const diagnostic of entry.diagnostics) {
        mlog(`${context}: mode=${entry.option.mode} ${diagnostic.code} ${diagnostic.message}`);
      }
    }
    if (!evaluation.recommended) {
      mlog(`${context}: no-supported-option`);
    }
  }

  private dispatchPlaybackDecision(
    media: PlaybackMediaMetadata,
    evaluation: PlaybackEvaluationResult,
  ): void {
    this.dispatchEvent(
      new CustomEvent('playbackdecision', {
        detail: {
          media,
          evaluation,
          playbackPolicy: this._sourcePlaybackPolicy,
        },
      }),
    );
  }

  private throwPlaybackSelectionError(context: string, diagnostics: PlaybackDiagnostic[]): never {
    const detail =
      diagnostics.length > 0
        ? diagnostics.map((diagnostic) => diagnostic.message).join(' ')
        : 'No supported playback option.';
    throw new Error(`${context}: ${detail}`);
  }

  private failPlaybackSelection(context: string, diagnostics: PlaybackDiagnostic[]): void {
    const detail =
      diagnostics.length > 0
        ? diagnostics.map((diagnostic) => diagnostic.message).join(' ')
        : 'No supported playback option.';
    this.failPlayback(`${context}: ${detail}`);
  }

  private makeCodecPathFromSource(
    media: PlaybackMediaMetadata,
    mode: CodecPath['mode'],
    outputAudio: CodecDescriptor = {
      short: media.sourceAudioCodec,
      full: media.audioCodec,
    },
  ): CodecPath {
    return {
      mode,
      sourceVideo: {
        short: media.sourceVideoCodec,
        full: media.videoCodec,
      },
      sourceAudio: {
        short: media.sourceAudioCodec,
        full: media.audioCodec,
      },
      outputVideo: {
        short: media.sourceVideoCodec,
        full: media.videoCodec,
      },
      outputAudio,
    };
  }

  private startPassthrough(src: string): void {
    this._passthrough = true;
    this._totalSegments = 0;
    if (src.startsWith('blob:')) {
      this._blobUrl = src;
    }

    this.video.src = src;

    const fireReady = () => {
      this._durationSec = this.video.duration;
      this._phase = 'ready';
      mlog(`passthrough ready dur=${this._durationSec.toFixed(1)}s`);
      this.dispatchEvent(
        new CustomEvent('ready', {
          detail: {
            totalSegments: 0,
            durationSec: this._durationSec,
            subtitleTracks: this._subtitleTracks,
            passthrough: true,
            codecPath: this.codecPath,
          },
        }),
      );
    };

    if (this.video.readyState >= 1) {
      fireReady();
    } else {
      this.video.addEventListener('loadedmetadata', fireReady, { once: true });
    }
  }

  private async handleWorkerMessage(event: MessageEvent): Promise<void> {
    const msg = event.data;

    if (msg.type === 'probed') {
      // Worker finished demux — decide passthrough vs pipeline
      const media: PlaybackMediaMetadata = {
        sourceVideoCodec: msg.sourceVideoCodec ?? null,
        sourceAudioCodec: msg.sourceAudioCodec ?? null,
        videoCodec: msg.videoCodec ?? null,
        audioCodec: msg.audioCodec ?? null,
        hasAudioDecoderConfig: msg.hasAudioDecoderConfig !== false,
        hasAudioTrack: msg.hasAudioTrack === true,
      };
      await this.populateAv1Metadata(media);
      const evaluation = this.evaluateInitialPlayback(media);
      this.logPlaybackDiagnostics('playback selection', evaluation);
      this.dispatchPlaybackDecision(media, evaluation);
      this._subtitleTracks = msg.subtitleTracks ?? [];
      const blobUrl = this._blobUrl;
      const selectedOption = evaluation.recommended?.option ?? null;
      const directPassthroughUrl =
        selectedOption?.mode === 'direct-bytes' && blobUrl !== null
          ? blobUrl
          : selectedOption?.mode === 'direct-url' && selectedOption.url
            ? selectedOption.url
            : null;
      const usePassthrough = directPassthroughUrl !== null;
      this._codecPath = this.makeCodecPathFromSource(
        media,
        usePassthrough ? 'passthrough' : 'pipeline',
      );

      if (usePassthrough && directPassthroughUrl) {
        mlog(`passthrough: selected direct playback codecs=${msg.videoCodec}/${msg.audioCodec}`);
        this.startPassthrough(directPassthroughUrl);
        this.worker!.postMessage({ type: 'passthrough-pipeline' });

        if (this._subtitleTracks.length > 0) {
          this.dispatchSubtitleStatus(`${this._subtitleTracks.length} subtitle track(s) available`);
        } else {
          this.dispatchSubtitleStatus('No embedded subtitles');
        }
      } else {
        const hlsEvaluation = evaluation.evaluations.find((entry) => entry.option.mode === 'hls');
        if (evaluation.recommended?.option.mode !== 'hls') {
          this.failPlaybackSelection('Playback selection failed', hlsEvaluation?.diagnostics ?? []);
          return;
        }
        if (this._blobUrl) {
          URL.revokeObjectURL(this._blobUrl);
          this._blobUrl = null;
        }
        mlog('pipeline: selected remux/HLS playback');
        this.ensureTranscodeWorkers();
        const remuxMsg: Record<string, unknown> = { type: 'remux-pipeline' };
        if (this._keyframeIndex) remuxMsg.keyframeIndex = this._keyframeIndex;
        if (this._initialStartTimeSec !== null) remuxMsg.initialStartTimeSec = this._initialStartTimeSec;
        this.worker!.postMessage(remuxMsg);
      }
    } else if (msg.type === 'ready') {
      this.playlist = msg.playlist;
      this.initData = msg.initData;
      this._totalSegments = msg.totalSegments;
      this._durationSec = msg.durationSec;
      this._subtitleTracks = msg.subtitleTracks ?? [];
      this._phase = 'ready';
      this._codecPath = {
        mode: 'pipeline',
        sourceVideo: {
          short: msg.sourceVideoCodec ?? this._codecPath.sourceVideo.short,
          full: msg.sourceVideoCodecFull ?? this._codecPath.sourceVideo.full,
        },
        sourceAudio: {
          short: msg.sourceAudioCodec ?? this._codecPath.sourceAudio.short,
          full: msg.sourceAudioCodecFull ?? this._codecPath.sourceAudio.full,
        },
        outputVideo: {
          short: msg.outputVideoCodec ?? this._codecPath.outputVideo.short,
          full: msg.outputVideoCodecFull ?? this._codecPath.outputVideo.full,
        },
        outputAudio: {
          short: msg.outputAudioCodec ?? this._codecPath.outputAudio.short,
          full: msg.outputAudioCodecFull ?? this._codecPath.outputAudio.full,
        },
      };

      mlog(`ready segments=${msg.totalSegments} dur=${msg.durationSec.toFixed(1)}s`);

      // Resolve any pending requests
      if (this.pendingPlaylist) {
        this.pendingPlaylist.resolve(this.playlist!);
        this.pendingPlaylist = null;
      }
      if (this.pendingInit && this.initData) {
        this.pendingInit.resolve(this.initData);
        this.pendingInit = null;
      }

      // On-demand: advertise availability without extracting
      if (this._subtitleTracks.length > 0) {
        this.dispatchSubtitleStatus(`${this._subtitleTracks.length} subtitle track(s) available`);
      } else {
        this.dispatchSubtitleStatus('No embedded subtitles');
      }

      this.dispatchEvent(
        new CustomEvent('ready', {
          detail: {
            totalSegments: this._totalSegments,
            durationSec: this._durationSec,
            subtitleTracks: this._subtitleTracks,
            codecPath: this.codecPath,
          },
        }),
      );

      this.startHls();
    } else if (msg.type === 'subtitle-batch') {
      this.handleSubtitleBatch(msg);
    } else if (msg.type === 'subtitle-progress') {
      this.handleWorkerSubtitleProgress(msg);
    } else if (msg.type === 'segment-state') {
      this.handleWorkerSegmentState(msg);
    } else if (msg.type === 'segment') {
      const pending = this.pendingSegments.get(msg.index);
      const reqTime = this.segmentRequestTimes.get(msg.index);
      const latencyMs = reqTime ? performance.now() - reqTime : null;
      const latency = latencyMs !== null ? latencyMs.toFixed(1) : '?';
      const size = msg.data?.byteLength ?? 0;
      this.segmentRequestTimes.delete(msg.index);

      if (pending) {
        pending.resolve(msg.data);
        this.pendingSegments.delete(msg.index);
      }

      this.noteSegmentState(msg.index, 'delivered', {
        sizeBytes: size,
        latencyMs: latencyMs ?? undefined,
      });

      mlog(
        `seg ${msg.index} arrived latency=${latency}ms size=${size} pending=${this.pendingSegments.size}`,
      );
    } else if (msg.type === 'segment-error') {
      const pending = this.pendingSegments.get(msg.index);
      mlog(`segment-error: idx=${msg.index} ${msg.message} stale=${msg.stale ?? false}`);
      if (pending) {
        this.noteSegmentState(msg.index, 'error', { message: msg.message });
        pending.reject(new Error(msg.message));
        this.pendingSegments.delete(msg.index);
      }
      if (msg.stale) {
        this.dispatchEvent(new CustomEvent('file-stale'));
      }
    } else if (msg.type === 'file-refreshed') {
      mlog('file refreshed — worker re-demuxed');
    } else if (msg.type === 'error') {
      mlog(`error: ${msg.message} pending=${this.pendingSegments.size}`);
      this.failPlayback(msg.message);

      // Reject all pending requests
      for (const [index, p] of this.pendingSegments) {
        this.noteSegmentState(index, 'error', { message: msg.message });
        p.reject(new Error(msg.message));
      }
      this.pendingSegments.clear();
      this.subtitleRequestTimes.clear();
      this.subtitleWindowEnd.clear();
      this.subtitleWindowLoading.clear();
      if (this.pendingInit) {
        this.pendingInit.reject(new Error(msg.message));
        this.pendingInit = null;
      }
      if (this.pendingPlaylist) {
        this.pendingPlaylist.reject(new Error(msg.message));
        this.pendingPlaylist = null;
      }
    }
  }

  private requestSegment(index: number): Promise<ArrayBuffer> {
    // Race detection: duplicate request for same segment
    if (this.pendingSegments.has(index)) {
      mlog(`WARN duplicate request for seg ${index} (already pending)`);
    }

    const pendingCount = this.pendingSegments.size;
    if (pendingCount > 1) {
      mlog(`WARN ${pendingCount} segments already pending when requesting seg ${index}`);
    }

    mlog(`req seg ${index} pending=${pendingCount}`);
    this.segmentRequestTimes.set(index, performance.now());
    this.noteSegmentState(index, 'requested', { incrementRequestCount: true });

    return new Promise((resolve, reject) => {
      this.pendingSegments.set(index, { resolve, reject });
      this.worker!.postMessage({ type: 'segment', index });
    });
  }

  private cancelSegment(index: number): void {
    const pending = this.pendingSegments.get(index);
    if (pending) {
      mlog(`cancel seg ${index}`);
      this.noteSegmentState(index, 'canceled');
      pending.reject(new DOMException('Segment aborted', 'AbortError'));
      this.pendingSegments.delete(index);
      this.segmentRequestTimes.delete(index);
      this.worker?.postMessage({ type: 'cancel', index });
    }
  }

  private async startSourcePipeline(source: Source): Promise<void> {
    try {
      const { createVideoBoundaryResolver, demuxSource, getKeyframeIndex } = await import(
        './pipeline/demux.js'
      );
      const { buildMkvKeyframeIndexFromSource } = await import('./pipeline/mkv-keyframe-index.js');

      mlog('source pipeline: demuxing');
      this._sourceDemux = await demuxSource(source);
      const demux = this._sourceDemux;

      // Build keyframe index
      let index: KeyframeIndex;
      if (this._keyframeIndex) {
        index = this._keyframeIndex;
        mlog(`source pipeline: pre-built keyframes=${index.keyframes.length}`);
      } else {
        const mkvIndex = await buildMkvKeyframeIndexFromSource(source);
        if (mkvIndex) {
          index = mkvIndex;
          mlog(`source pipeline: mkv-cues keyframes=${index.keyframes.length}`);
        } else {
          index = await getKeyframeIndex(demux.videoSink, demux.duration);
          mlog(`source pipeline: keyframe-index keyframes=${index.keyframes.length}`);
        }
      }

      // Build segment plan
      this._sourcePlan = buildSegmentPlan({
        keyframeTimestampsSec: index.keyframes.map((k) => k.timestamp),
        durationSec: index.duration,
        targetSegmentDurationSec: this._sourceTargetSegDuration,
      });
      this._sourceBoundaryResolver = createVideoBoundaryResolver(
        demux.videoSink,
        this._sourcePlan,
        (msg) => mlog(`source pipeline: ${msg}`),
      );

      const media: PlaybackMediaMetadata = {
        sourceVideoCodec: demux.videoCodec,
        sourceAudioCodec: demux.audioCodec,
        videoCodec: demux.videoDecoderConfig.codec,
        audioCodec: demux.audioDecoderConfig?.codec ?? null,
        hasAudioDecoderConfig: demux.audioTrack ? demux.audioDecoderConfig !== null : true,
        hasAudioTrack: demux.audioTrack !== null,
      };
      await this.populateAv1Metadata(media);
      const evaluation = this.evaluateSourcePlayback(media);
      this.logPlaybackDiagnostics('source playback selection', evaluation);
      this.dispatchPlaybackDecision(media, evaluation);

      const selectedOption = evaluation.recommended?.option ?? null;
      if (!selectedOption) {
        this.throwPlaybackSelectionError(
          'Source playback selection failed',
          evaluation.evaluations.flatMap((entry) => entry.diagnostics),
        );
      }

      if (selectedOption.mode !== 'hls') {
        if (!selectedOption.url) {
          this.throwPlaybackSelectionError(
            'Source playback selection failed',
            evaluation.evaluations.flatMap((entry) => entry.diagnostics),
          );
        }
        this._subtitleTracks = demux.subtitleTracks;
        this._codecPath = this.makeCodecPathFromSource(media, 'passthrough');
        this._sourcePlan = [];
        this._sourceDoTranscode = false;
        this._sourceAudioDecoderConfig = null;
        this._sourceInitSegment = null;
        mlog(`source pipeline: selected ${selectedOption.mode}`);
        this.startPassthrough(selectedOption.url);
        void this.extractEmbeddedSubtitlesFromDemux(demux, { releaseAfterComplete: true });
        return;
      }

      const hlsEvaluation =
        evaluation.evaluations.find((entry) => entry.option.mode === 'hls') ?? null;
      if (!hlsEvaluation || hlsEvaluation.status !== 'supported') {
        this.throwPlaybackSelectionError(
          'Source playback selection failed',
          evaluation.evaluations.flatMap((entry) => entry.diagnostics),
        );
      }
      this._sourceDoTranscode = hlsEvaluation.pipelineAudioRequiresTranscode === true;
      if (demux.audioTrack && !demux.audioCodec) {
        throw new Error(
          `Unsupported audio track codec: ${demux.audioInternalCodecId ?? 'unknown'}; cannot transcode without a recognized source codec`,
        );
      }
      if (
        this._sourceDoTranscode &&
        demux.audioCodec &&
        !isAudioTranscodeInputSupported(demux.audioCodec)
      ) {
        throw new Error(`Unsupported audio transcode source codec: ${demux.audioCodec}`);
      }
      if (this._sourceDoTranscode && demux.audioCodec) {
        if (!this._sourceFfmpeg) {
          this._sourceFfmpeg = new WasmFfmpegRunner();
        }
        await this._sourceFfmpeg.loadForCodec?.(demux.audioCodec);
      }
      this._sourceAudioDecoderConfig = this._sourceDoTranscode
        ? makeAacDecoderConfig(demux.audioDecoderConfig)
        : demux.audioDecoderConfig;
      this._codecPath = this.makeCodecPathFromSource(media, 'pipeline', {
        short: this._sourceDoTranscode ? 'aac' : demux.audioCodec,
        full: this._sourceAudioDecoderConfig?.codec ?? null,
      });

      // Pre-process segment 0
      const seg0Result = await processSegmentWithAbort(this.makeSourceProcessorConfig(), 0);
      this._sourceAudioDecoderConfig = seg0Result.audioDecoderConfig;
      if (seg0Result.initSegment) {
        this._sourceInitSegment = seg0Result.initSegment;
      }

      // Build playlist
      const playlist = generateVodPlaylist({
        targetDuration: Math.ceil(Math.max(...this._sourcePlan.map((s) => s.durationSec))),
        mediaSequence: 0,
        mapUri: 'init.mp4',
        entries: this._sourcePlan.map((s) => ({
          uri: `seg-${s.sequence}.m4s`,
          durationSec: s.durationSec,
        })),
        endList: true,
      });

      this.playlist = playlist;
      this.initData = (this._sourceInitSegment!.buffer as ArrayBuffer).slice(
        this._sourceInitSegment!.byteOffset,
        this._sourceInitSegment!.byteOffset + this._sourceInitSegment!.byteLength,
      );
      this._totalSegments = this._sourcePlan.length;
      this._durationSec = demux.duration;
      this._subtitleTracks = demux.subtitleTracks;
      this._phase = 'ready';

      mlog(
        `source pipeline: ready segments=${this._totalSegments} dur=${this._durationSec.toFixed(1)}s`,
      );

      this.dispatchEvent(
        new CustomEvent('ready', {
          detail: {
            totalSegments: this._totalSegments,
            durationSec: this._durationSec,
            subtitleTracks: this._subtitleTracks,
            codecPath: this.codecPath,
          },
        }),
      );

      this.startHls();
    } catch (err) {
      this.failPlayback(String(err));
    }
  }

  private makeSourceProcessorConfig() {
    if (!this._sourceFfmpeg) {
      this._sourceFfmpeg = new WasmFfmpegRunner();
    }
    const demux = this._sourceDemux!;
    return {
      videoSink: demux.videoSink,
      audioSink: demux.audioSink,
      videoCodec: demux.videoCodec,
      audioCodec: demux.audioCodec,
      videoDecoderConfig: demux.videoDecoderConfig,
      sourceAudioDecoderConfig: demux.audioDecoderConfig,
      audioDecoderConfig: this._sourceAudioDecoderConfig,
      plan: this._sourcePlan,
      doTranscode: this._sourceDoTranscode,
      transcodeAudio: createLocalAudioTranscoder(this._sourceFfmpeg),
      sourceCodec: demux.audioCodec ?? undefined,
      resolveSegmentBoundary: this._sourceBoundaryResolver ?? undefined,
      log: mlog,
    };
  }

  private async requestSourceSegment(index: number): Promise<ArrayBuffer> {
    for (const key of this._sourcePrefetchCache.keys()) {
      if (key < index) this._sourcePrefetchCache.delete(key);
    }

    const cached = this._sourcePrefetchCache.get(index);
    if (cached) {
      this._sourcePrefetchCache.delete(index);
      this.noteSegmentDeliveredForDebug(index, cached.byteLength, true);
      mlog(`source seg ${index} cache-hit size=${cached.byteLength}`);
      this.prefetchNextSourceSegment(index);
      return cached;
    }

    // Cache miss — abort in-flight prefetch so the source is free for on-demand use
    if (this._sourcePrefetchAbort) {
      this._sourcePrefetchAbort.abort();
      this._sourcePrefetchAbort = null;
      this._sourcePrefetchIndex = null;
    }

    if (this._sourceSegmentAbort) {
      this._sourceSegmentAbort.abort();
    }

    const controller = new AbortController();
    this._sourceSegmentAbort = controller;

    if (this._source && isAbortableSource(this._source)) {
      this._source.setCurrentSignal(controller.signal);
    }

    const result = await processSegmentWithAbort(
      this.makeSourceProcessorConfig(),
      index,
      controller.signal,
    );

    this._sourceSegmentAbort = null;

    if (!this._sourceInitSegment && result.initSegment) {
      this._sourceInitSegment = result.initSegment;
    }

    const data = (result.mediaData.buffer as ArrayBuffer).slice(
      result.mediaData.byteOffset,
      result.mediaData.byteOffset + result.mediaData.byteLength,
    );
    this.noteSegmentDeliveredForDebug(index, data.byteLength, false);
    mlog(`source seg ${index} delivered size=${data.byteLength}`);

    this.prefetchNextSourceSegment(index);

    return data;
  }

  private prefetchNextSourceSegment(afterIndex: number): void {
    const next = afterIndex + 1;
    if (next >= this._totalSegments) return;
    if (this.video.paused) return;
    if (this._sourcePrefetchCache.has(next)) return;
    if (this._sourcePrefetchIndex === next) return;

    if (this._sourcePrefetchAbort) {
      this._sourcePrefetchAbort.abort();
    }

    const controller = new AbortController();
    this._sourcePrefetchAbort = controller;
    this._sourcePrefetchIndex = next;

    void (async () => {
      try {
        if (this._source && isAbortableSource(this._source)) {
          this._source.setCurrentSignal(controller.signal);
        }

        const result = await processSegmentWithAbort(
          this.makeSourceProcessorConfig(),
          next,
          controller.signal,
        );

        if (!this._sourceInitSegment && result.initSegment) {
          this._sourceInitSegment = result.initSegment;
        }

        const buf = (result.mediaData.buffer as ArrayBuffer).slice(
          result.mediaData.byteOffset,
          result.mediaData.byteOffset + result.mediaData.byteLength,
        );

        this._sourcePrefetchCache.set(next, buf);
      } catch (e) {
        // Aborted or failed — on-demand path handles it
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          console.warn('[playsvideo] prefetch failed:', e);
        }
      } finally {
        if (this._sourcePrefetchIndex === next) {
          this._sourcePrefetchAbort = null;
          this._sourcePrefetchIndex = null;
        }
      }
    })();
  }

  private startHls(): void {
    if (!Hls.isSupported()) {
      this.failPlayback('hls.js not supported in this browser');
      return;
    }

    // Need to capture `this` for the loader classes
    const engine = this;
    const completeStats = (stats: LoaderStats, byteLength: number): void => {
      const now = performance.now();
      stats.loaded = byteLength;
      stats.total = byteLength;
      stats.loading.first = now;
      stats.loading.end = now;
    };

    class PipelinePlaylistLoader implements Loader<PlaylistLoaderContext> {
      context: PlaylistLoaderContext | null = null;
      stats: LoaderStats = makeStats();

      load(
        context: PlaylistLoaderContext,
        _config: LoaderConfiguration,
        callbacks: LoaderCallbacks<PlaylistLoaderContext>,
      ) {
        this.context = context;
        this.stats = makeStats();
        mlog(`hls loader playlist start url=${context.url}`);

        if (engine.playlist) {
          const data = engine.playlist;
          queueMicrotask(() => {
            completeStats(this.stats, data.length);
            mlog(`hls loader playlist success bytes=${data.length}`);
            callbacks.onProgress?.(this.stats, context, data, null);
            callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
          });
        } else {
          engine.pendingPlaylist = {
            resolve: (data) => {
              completeStats(this.stats, data.length);
              mlog(`hls loader playlist success bytes=${data.length}`);
              callbacks.onProgress?.(this.stats, context, data, null);
              callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
            },
            reject: (err) => {
              mlog(`hls loader playlist error ${normalizeErrorMessage(err.message)}`);
              callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
            },
          };
        }
      }

      abort() {}
      destroy() {}
    }

    class PipelineFragmentLoader implements Loader<FragmentLoaderContext> {
      context: FragmentLoaderContext | null = null;
      stats: LoaderStats = makeStats();
      private currentSegmentIndex: number | null = null;
      private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
      private aborted = false;

      load(
        context: FragmentLoaderContext,
        _config: LoaderConfiguration,
        callbacks: LoaderCallbacks<FragmentLoaderContext>,
      ) {
        this.context = context;
        this.callbacks = callbacks;
        this.stats = makeStats();
        this.aborted = false;
        const url = context.url;

        if (url.includes('init.mp4')) {
          this.loadInit(context, callbacks);
        } else {
          const match = url.match(/seg-(\d+)\.m4s/);
          if (match) {
            this.loadSegment(parseInt(match[1], 10), context, callbacks);
          } else {
            callbacks.onError({ code: 404, text: 'Unknown URL' }, context, null, this.stats);
          }
        }
      }

      private loadInit(
        context: FragmentLoaderContext,
        callbacks: LoaderCallbacks<FragmentLoaderContext>,
      ) {
        mlog('hls loader init start');
        if (engine.initData) {
          const data = engine.initData;
          queueMicrotask(() => {
            completeStats(this.stats, data.byteLength);
            mlog(`hls loader init success bytes=${data.byteLength}`);
            callbacks.onProgress?.(this.stats, context, data, null);
            callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
          });
        } else {
          engine.pendingInit = {
            resolve: (data) => {
              completeStats(this.stats, data.byteLength);
              mlog(`hls loader init success bytes=${data.byteLength}`);
              callbacks.onProgress?.(this.stats, context, data, null);
              callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
            },
            reject: (err) => {
              mlog(`hls loader init error ${normalizeErrorMessage(err.message)}`);
              callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
            },
          };
        }
      }

      private loadSegment(
        index: number,
        context: FragmentLoaderContext,
        callbacks: LoaderCallbacks<FragmentLoaderContext>,
      ) {
        this.currentSegmentIndex = index;
        mlog(`hls loader seg ${index} start`);
        const segmentPromise = engine._source
          ? engine.requestSourceSegment(index)
          : engine.requestSegment(index);
        segmentPromise
          .then((data) => {
            if (this.aborted) {
              return;
            }
            this.currentSegmentIndex = null;
            completeStats(this.stats, data.byteLength);
            mlog(`hls loader seg ${index} success bytes=${data.byteLength}`);
            callbacks.onProgress?.(this.stats, context, data, null);
            callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, null);
          })
          .catch((err) => {
            if (this.aborted) {
              return;
            }
            this.currentSegmentIndex = null;
            if (err instanceof DOMException && err.name === 'AbortError') {
              this.stats.aborted = true;
              mlog(`hls loader seg ${index} abort`);
              callbacks.onAbort?.(this.stats, context, null);
              return;
            }
            mlog(`hls loader seg ${index} error ${normalizeErrorMessage(err.message)}`);
            callbacks.onError({ code: 0, text: err.message }, context, null, this.stats);
          });
      }

      abort() {
        if (this.aborted) {
          return;
        }
        this.aborted = true;
        this.stats.aborted = true;
        let abortedActiveSegment = false;
        if (this.currentSegmentIndex !== null) {
          abortedActiveSegment = true;
          if (engine._source) {
            // Source mode: abort the in-flight main-thread processing
            engine._sourceSegmentAbort?.abort();
            engine._sourcePrefetchAbort?.abort();
          } else {
            // Worker mode: cancel via worker message
            engine.cancelSegment(this.currentSegmentIndex);
          }
          this.currentSegmentIndex = null;
        }
        if (abortedActiveSegment && this.callbacks && this.context) {
          mlog('hls loader abort active segment');
          this.callbacks.onAbort?.(this.stats, this.context, null);
        }
      }

      destroy() {
        this.abort();
        this.callbacks = null;
        this.context = null;
      }
    }

    this.video.disableRemotePlayback = true;

    this.hls = new Hls({
      pLoader: PipelinePlaylistLoader as any,
      fLoader: PipelineFragmentLoader as any,
      enableWorker: false,
      autoStartLoad: false,
      preferManagedMediaSource: false,
      // VOD buffering tuning for slow-generated segments:
      // Increased from 15s to 60s to tolerate segment generation latency.
      maxBufferLength: 60,
      // Increased from 30s to 300s to allow aggressive prefetch without stalling playback.
      maxMaxBufferLength: 300,
      // Cap total buffered data at 100MB to prevent memory bloat on long VODs.
      maxBufferSize: 100 * 1000 * 1000,
      // Increased from default 8s to allow slower segment delivery without triggering stall recovery.
      maxLoadingDelay: 8,
      // Enable progressive loading to start playback sooner without waiting for full buffer.
      progressive: true,
      backBufferLength: 30,
      maxBufferHole: 0.5,
      nudgeOffset: 0.1,
      nudgeMaxRetry: 6,
      highBufferWatchdogPeriod: 1,
    });


    this.video.addEventListener('pause', this._onVideoPause);
    this.video.addEventListener('play', this._onVideoPlay);
    this.video.addEventListener('seeked', this._onVideoSeeked);
    this.video.addEventListener('error', () => {
      mlog(
        `video.error ${describeMediaError(this.video.error)} snapshot=${this.debugPlaybackSnapshot()}`,
      );
    });

    this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      this._hlsMediaAttached = true;
      mlog('hls MEDIA_ATTACHED');
      this.tryStartHlsLoad('hls MEDIA_ATTACHED');
    });

    this.hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      this._hlsManifestParsed = true;
      mlog(`hls MANIFEST_PARSED levels=${data.levels.length}`);
      this.tryStartHlsLoad('hls MANIFEST_PARSED');
      if (this.video.autoplay) {
        this.video.play().catch(() => {});
      }
    });

    this.hls.on(Hls.Events.FRAG_LOADING, (_evt, data) => {
      mlog(`hls FRAG_LOADING sn=${data.frag.sn} url=${data.frag.relurl}`);
    });

    this.hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      mlog(
        `hls FRAG_LOADED sn=${data.frag.sn} bytes=${data.payload.byteLength}`,
      );
    });

    this.hls.on(Hls.Events.FRAG_BUFFERED, (_evt, data) => {
      const sb = this.video.buffered;
      const ranges: string[] = [];
      const gaps: BufferedGap[] = [];
      for (let i = 0; i < sb.length; i++) {
        ranges.push(`[${sb.start(i).toFixed(3)},${sb.end(i).toFixed(3)}]`);
        if (i > 0) {
          const gap = sb.start(i) - sb.end(i - 1);
          if (gap > 0.01) {
            ranges.push(`!!GAP=${gap.toFixed(3)}!!`);
            gaps.push({
              start: sb.end(i - 1),
              end: sb.start(i),
              gap,
            });
          }
        }
      }
      const segmentIndex = Number(data.frag.sn);
      const previous = this._lastBufferedGapsBySegment.get(segmentIndex) ?? [];
      const changed =
        previous.length !== gaps.length ||
        previous.some((prevGap, i) => {
          const nextGap = gaps[i];
          if (!nextGap) return true;
          return (
            Math.abs(prevGap.start - nextGap.start) > 0.001 ||
            Math.abs(prevGap.end - nextGap.end) > 0.001 ||
            Math.abs(prevGap.gap - nextGap.gap) > 0.001
          );
        });
      if (changed) {
        this._lastBufferedGapsBySegment.set(segmentIndex, gaps);
        if (gaps.length === 0 && previous.length > 0) {
          mlog(
            `hls gap-status sn=${segmentIndex} cleared ${this.getSegmentContinuitySnapshot(segmentIndex)}`,
          );
        } else if (gaps.length > 0) {
          const summary = gaps
            .map((gap) => `[${gap.start.toFixed(3)},${gap.end.toFixed(3)})=${gap.gap.toFixed(3)}s`)
            .join(' ');
          mlog(
            `hls gap-status sn=${segmentIndex} gaps=${summary} ${this.getSegmentContinuitySnapshot(segmentIndex)}`,
          );
        }
      }
    });

    this.hls.on(Hls.Events.ERROR, (_evt, data) => {
      const underlyingMessage =
        data.error?.message ?? data.reason ?? data.response?.text ?? data.err?.message ?? null;
      const fragSn = data.frag?.sn ?? null;
      mlog(
        `hls ERROR fatal=${data.fatal} type=${data.type} details=${data.details} sn=${fragSn ?? 'none'}${underlyingMessage ? ` message=${underlyingMessage}` : ''} mediaError=${describeMediaError(this.video.error)} snapshot=${this.debugPlaybackSnapshot(fragSn)}`,
      );
      if (data.fatal) {
        console.error('hls.js fatal error:', data);
        const internalMessage = this.getRecentInternalError();
        const message =
          internalMessage && data.details === 'fragLoadError'
            ? internalMessage
            : underlyingMessage
              ? `${data.details} (${normalizeErrorMessage(underlyingMessage)})`
              : data.details;
        this.failPlayback(message);
      }
    });

    this.hls.attachMedia(this.video);
    this.hls.loadSource('/virtual/playlist.m3u8');

    // Safari-critical: listen for sourceopen to gate HLS startup
    const onSourceOpen = () => {
      this._hlsSourceOpenFired = true;
      mlog('MediaSource sourceopen fired');
      this.tryStartHlsLoad('MediaSource sourceopen');
      // Remove listener after first fire
      const ms = (this.hls?.media as any)?.mediaSource;
      if (ms) {
        ms.removeEventListener('sourceopen', onSourceOpen);
      }
    };
    const ms = (this.hls?.media as any)?.mediaSource;
    if (ms) {
      ms.addEventListener('sourceopen', onSourceOpen);
    }

    for (const evt of ['waiting', 'playing', 'emptied', 'abort'] as const) {
      this.video.addEventListener(evt, () => {
        const t = this.video.currentTime.toFixed(3);
        const sb = this.video.buffered;
        const bufEnd = sb.length > 0 ? sb.end(sb.length - 1).toFixed(3) : 'none';
        const ahead =
          sb.length > 0 ? (sb.end(sb.length - 1) - this.video.currentTime).toFixed(1) : '?';
        const q = this.video.getVideoPlaybackQuality?.();
        const dropped = q ? q.droppedVideoFrames : '?';
        mlog(
          `video.${evt} t=${t} bufEnd=${bufEnd} ahead=${ahead}s dropped=${dropped} readyState=${this.video.readyState} mediaError=${describeMediaError(this.video.error)}`,
        );
      });
    }

    // Active stall recovery: detect when playhead is stuck in a buffer gap
    // and nudge it forward to the next buffered range start.
    let stallCheckTimer: ReturnType<typeof setInterval> | null = null;
    let lastPlaybackTime = -1;
    let stallCount = 0;
    const STALL_CHECK_MS = 250;
    const STALL_THRESHOLD = 3;

    const startStallCheck = () => {
      if (stallCheckTimer) return;
      stallCheckTimer = setInterval(() => {
        if (this.video.paused || this.video.seeking || this.video.ended) {
          stallCount = 0;
          return;
        }
        const ct = this.video.currentTime;
        if (ct === lastPlaybackTime) {
          stallCount++;
          if (stallCount >= STALL_THRESHOLD) {
            const sb = this.video.buffered;
            for (let i = 0; i < sb.length; i++) {
              if (ct < sb.start(i) && sb.start(i) - ct < 1) {
                const target = sb.start(i) + 0.01;
                mlog(
                  `stall-recovery: nudge ${ct.toFixed(3)}->${target.toFixed(3)} (gap=${(sb.start(i) - ct).toFixed(3)})`,
                );
                this.video.currentTime = target;
                stallCount = 0;
                return;
              }
            }
            stallCount = 0;
          }
        } else {
          stallCount = 0;
        }
        lastPlaybackTime = ct;
      }, STALL_CHECK_MS);
    };

    this.video.addEventListener('playing', startStallCheck);
    this.video.addEventListener('pause', () => {
      if (stallCheckTimer) {
        clearInterval(stallCheckTimer);
        stallCheckTimer = null;
      }
      stallCount = 0;
    });

    let prevDropped = 0;
    const healthCheck = () => {
      if (!this.hls || this.video.paused) return;
      const q = this.video.getVideoPlaybackQuality?.();
      if (q) {
        const newDropped = q.droppedVideoFrames - prevDropped;
        prevDropped = q.droppedVideoFrames;
        const sb = this.video.buffered;
        const ahead =
          sb.length > 0 ? (sb.end(sb.length - 1) - this.video.currentTime).toFixed(1) : '?';
        if (newDropped > 0) {
          mlog(
            `health-check dropped=${newDropped} total=${q.totalVideoFrames} ahead=${ahead}s t=${this.video.currentTime.toFixed(3)}`,
          );
        }
      }
    };
    setInterval(healthCheck, 2000);
  }

  private handleSubtitleBatch(msg: {
    trackIndex: number;
    requestId?: number;
    codec: string;
    cues: Array<{ startSec: number; endSec: number; text: string; settings?: string }>;
    done: boolean;
    totalCues: number;
  }): void {
    if (
      msg.requestId !== undefined &&
      this._activeSubtitleRequestIds.get(msg.trackIndex) !== msg.requestId
    ) {
      mlog(`subtitle track ${msg.trackIndex} ignoring stale batch requestId=${msg.requestId}`);
      return;
    }

    let attached = this.attachedSubtitleTracks.find(
      (a) => a.source === 'embedded' && a.trackIndex === msg.trackIndex,
    );

    const shouldSelect = this._selectOnExtract.get(msg.trackIndex) ?? true;

    if (!attached) {
      const info = this._subtitleTracks.find((t) => t.index === msg.trackIndex);
      const kind: TextTrackKind = info?.disposition.hearingImpaired ? 'captions' : 'subtitles';
      const lang = normalizeSubtitleLanguageCode(info?.language ?? 'und');
      const label = languageLabel(info?.language ?? 'und', msg.trackIndex, info?.disposition);
      const blob = new Blob(['WEBVTT\n\n'], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      const track = document.createElement('track');
      track.kind = kind;
      track.src = url;
      track.srclang = lang;
      track.label = label;
      track.default = shouldSelect;
      this.video.appendChild(track);
      const textTrack = track.track;
      if (shouldSelect) {
        for (let i = 0; i < this.video.textTracks.length; i++) {
          this.video.textTracks[i].mode = 'disabled';
        }
        textTrack.mode = 'hidden';
      } else {
        textTrack.mode = 'hidden';
      }

      attached = { element: track, url, source: 'embedded', trackIndex: msg.trackIndex, textTrack };
      this.attachedSubtitleTracks.push(attached);

      mlog(
        `subtitle track ${msg.trackIndex} created incrementally as <track kind=${kind} lang=${lang}>`,
      );
    }

    const tt = attached.textTrack;
    if (!tt) return;

    for (const cue of msg.cues) {
      try {
        if (this.hasMatchingCue(tt, cue)) continue;
        const vttCue = new VTTCue(cue.startSec, cue.endSec, cue.text);
        tt.addCue(vttCue);
      } catch (e) {
        console.warn('[playsvideo] VTTCue creation failed:', cue, e);
      }
    }

    if (shouldSelect) {
      this.showTextTrack(tt);
    }

    const lastCue = msg.cues[msg.cues.length - 1];
    if (lastCue) {
      const prev = this.subtitleWindowEnd.get(msg.trackIndex) ?? 0;
      if (lastCue.endSec > prev) {
        this.subtitleWindowEnd.set(msg.trackIndex, lastCue.endSec);
      }
    }

    if (msg.done) {
      const requestedEnd = this.subtitleRequestedWindowEnd.get(msg.trackIndex);
      if (requestedEnd !== undefined) {
        const prev = this.subtitleWindowEnd.get(msg.trackIndex) ?? 0;
        if (requestedEnd > prev) {
          this.subtitleWindowEnd.set(msg.trackIndex, requestedEnd);
        }
      }
      this.subtitleRequestTimes.delete(msg.trackIndex);
      this.subtitleWindowLoading.delete(msg.trackIndex);
      this.subtitleRequestedWindowEnd.delete(msg.trackIndex);
      this._selectOnExtract.delete(msg.trackIndex);
      if (
        msg.requestId !== undefined &&
        this._activeSubtitleRequestIds.get(msg.trackIndex) === msg.requestId
      ) {
        this._activeSubtitleRequestIds.delete(msg.trackIndex);
      }

      const info = this._subtitleTracks.find((t) => t.index === msg.trackIndex);
      const lang = info?.language ?? '?';
      this.dispatchSubtitleStatus(
        `Subtitle track ${msg.trackIndex}: ${lang} ${msg.codec} ${msg.totalCues} cues (streamed)`,
      );
      mlog(`subtitle track ${msg.trackIndex} complete: ${msg.totalCues} cues`);
    }
  }

  private addSubtitleTrack({
    webvtt,
    source,
    trackIndex,
    label,
    language,
    kind,
    defaultTrack = false,
    selectTrack = false,
  }: {
    webvtt: string;
    source: 'embedded' | 'external';
    trackIndex?: number;
    label?: string;
    language?: string;
    kind?: 'subtitles' | 'captions';
    defaultTrack?: boolean;
    selectTrack?: boolean;
  }): void {
    const blob = new Blob([webvtt], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const info =
      trackIndex === undefined
        ? undefined
        : this._subtitleTracks.find((t) => t.index === trackIndex);
    const track = document.createElement('track');
    track.kind = kind ?? (info?.disposition.hearingImpaired ? 'captions' : 'subtitles');
    track.src = url;
    track.srclang = normalizeSubtitleLanguageCode(language ?? info?.language ?? 'und');
    track.label =
      label ??
      languageLabel(
        info?.language ?? 'und',
        trackIndex ?? this.video.querySelectorAll('track').length,
        info?.disposition,
      );
    track.default = defaultTrack;
    this.video.appendChild(track);
    this.attachedSubtitleTracks.push({ element: track, url, source, trackIndex });
    if (selectTrack) {
      track.addEventListener('load', () => this.showTextTrack(track), { once: true });
      queueMicrotask(() => this.showTextTrack(track));
    } else {
      // Explicitly disable — browsers may auto-enable tracks matching the user's language preference
      track.addEventListener(
        'load',
        () => {
          track.track.mode = 'disabled';
        },
        { once: true },
      );
    }
    mlog(
      `subtitle track ${trackIndex ?? 'external'} attached as <track kind=${track.kind} lang=${track.srclang}>`,
    );
  }

  private removeSubtitleTracks(source?: 'embedded' | 'external'): void {
    const keep: AttachedSubtitleTrack[] = [];
    for (const attached of this.attachedSubtitleTracks) {
      if (source && attached.source !== source) {
        keep.push(attached);
        continue;
      }
      if (attached.textTrack) {
        attached.textTrack.mode = 'disabled';
        this.clearTextTrackCues(attached.textTrack);
      }
      attached.element.remove();
      if (attached.url) URL.revokeObjectURL(attached.url);
    }
    this.attachedSubtitleTracks = keep;
  }

  private restartEmbeddedSubtitlesFromPosition(seekTimeSec: number): void {
    if (!this.worker) return;
    this.cancelPendingSubtitleWork();
    const activeEmbedded = this.attachedSubtitleTracks.filter(
      (a) => a.source === 'embedded' && a.textTrack && a.textTrack.mode !== 'disabled',
    );
    if (activeEmbedded.length === 0) return;

    this.subtitleWindowEnd.clear();
    this.subtitleWindowLoading.clear();

    for (const attached of activeEmbedded) {
      const tt = attached.textTrack!;
      this.clearTextTrackCues(tt);
      const trackIndex = attached.trackIndex;
      if (trackIndex == null) continue;
      const info = this._subtitleTracks.find((t) => t.index === trackIndex);
      if (info) {
        this.requestEmbeddedSubtitleTrack(info, seekTimeSec);
      }
    }
  }

  private checkSubtitlePrefetch(): void {
    if (!this.worker) return;

    if (this.subtitleWindowEnd.size === 0) return;

    // Don't prefetch subtitles when video buffer is low — segments need the demux
    const buffered = this.video.buffered;
    if (buffered.length > 0) {
      const bufferEnd = buffered.end(buffered.length - 1);
      if (bufferEnd - this.video.currentTime < 15) return;
    }

    const currentTime = this.video.currentTime;
    const SUBTITLE_WINDOW_SEC = 180;
    const PREFETCH_AHEAD_SEC = 60;

    for (const [trackIndex, windowEnd] of this.subtitleWindowEnd) {
      if (this.subtitleWindowLoading.has(trackIndex)) continue;
      if (currentTime + PREFETCH_AHEAD_SEC < windowEnd) continue;

      const info = this._subtitleTracks.find((t) => t.index === trackIndex);
      if (!info) continue;

      const attached = this.attachedSubtitleTracks.find(
        (a) =>
          a.source === 'embedded' &&
          a.trackIndex === trackIndex &&
          a.textTrack?.mode !== 'disabled',
      );
      if (!attached) continue;

      this.subtitleWindowLoading.add(trackIndex);
      const startSec = windowEnd;
      const endTimeSec = startSec + SUBTITLE_WINDOW_SEC;
      const requestedAtMs = Date.now();
      this.subtitleRequestTimes.set(trackIndex, requestedAtMs);
      this.subtitleRequestedWindowEnd.set(trackIndex, endTimeSec);
      const requestId = this.nextSubtitleRequestId(trackIndex);
      mlog(`subtitle prefetch track=${trackIndex} window=[${startSec},${endTimeSec}]`);
      this.worker.postMessage({
        type: 'subtitle',
        trackIndex,
        requestId,
        requestedAtMs,
        seekTimeSec: startSec,
        endTimeSec,
      });
    }
  }

  private showOnlyEmbeddedSubtitleTrack(trackIndex: number): void {
    const attached = this.attachedSubtitleTracks.find(
      (a) => a.source === 'embedded' && a.trackIndex === trackIndex && a.textTrack,
    );
    if (attached?.textTrack) {
      this.showTextTrack(attached.textTrack);
      this.subtitleWindowEnd.delete(trackIndex);
      this.subtitleWindowLoading.delete(trackIndex);
      const startSec = this.video.currentTime || 0;
      const info = this._subtitleTracks.find((t) => t.index === trackIndex);
      if (info && attached.textTrack.cues && attached.textTrack.cues.length === 0) {
        this.requestEmbeddedSubtitleTrack(info, startSec);
      }
      return;
    }
    for (let i = 0; i < this.video.textTracks.length; i++) {
      this.video.textTracks[i].mode = 'disabled';
    }
  }

  private showTextTrack(track: HTMLTrackElement | TextTrack): void {
    for (let i = 0; i < this.video.textTracks.length; i++) {
      this.video.textTracks[i].mode = 'disabled';
    }
    const tt = track instanceof HTMLTrackElement ? track.track : track;
    tt.mode = 'showing';
  }

  private dispatchSubtitleStatus(message: string): void {
    mlog(`subtitle-status: ${message}`);
    this.dispatchEvent(new CustomEvent('subtitle-status', { detail: { message } }));
  }

  private requestEmbeddedSubtitleTrack(track: SubtitleTrackInfo, seekTimeSec?: number): void {
    const SUBTITLE_WINDOW_SEC = 180;
    const startSec = seekTimeSec ?? 0;
    const endTimeSec = startSec + SUBTITLE_WINDOW_SEC;
    const requestedAtMs = Date.now();
    const requestId = this.nextSubtitleRequestId(track.index);
    this.subtitleRequestTimes.set(track.index, requestedAtMs);
    this.subtitleRequestedWindowEnd.set(track.index, endTimeSec);
    this.subtitleWindowLoading.add(track.index);
    mlog(
      `requesting subtitle track=${track.index} lang=${track.language} codec=${track.codec} window=[${startSec},${endTimeSec}]`,
    );
    this.dispatchSubtitleStatus(
      `Subtitle track ${track.index}: ${track.language ?? '?'} ${track.codec} queued`,
    );
    this.worker!.postMessage({
      type: 'subtitle',
      trackIndex: track.index,
      requestId,
      requestedAtMs,
      seekTimeSec,
      endTimeSec,
    });
  }

  private nextSubtitleRequestId(trackIndex: number): number {
    const requestId = ++this._subtitleRequestSeq;
    this._activeSubtitleRequestIds.set(trackIndex, requestId);
    return requestId;
  }

  private cancelPendingSubtitleWork(): void {
    this.worker?.postMessage({ type: 'subtitle-abort' });
    this.subtitleWindowLoading.clear();
    this.subtitleRequestTimes.clear();
    this.subtitleRequestedWindowEnd.clear();
    this._activeSubtitleRequestIds.clear();
  }

  private clearTextTrackCues(track: TextTrack): void {
    const cues = Array.from(track.cues ?? []);
    for (const cue of cues) {
      try {
        track.removeCue(cue);
      } catch (e) {
        console.warn('[playsvideo] Failed to remove cue:', e);
      }
    }
  }

  private hasMatchingCue(
    track: TextTrack,
    cue: { startSec: number; endSec: number; text: string },
  ): boolean {
    const cues = track.cues;
    if (!cues) return false;
    for (let i = 0; i < cues.length; i++) {
      const existing = cues[i];
      const existingText = 'text' in existing ? String(existing.text) : null;
      if (
        Math.abs(existing.startTime - cue.startSec) < 0.001 &&
        Math.abs(existing.endTime - cue.endSec) < 0.001 &&
        existingText === cue.text
      ) {
        return true;
      }
    }
    return false;
  }

  private handleWorkerSubtitleProgress(msg: WorkerSubtitleProgressMessage): void {
    if (this._activeSubtitleRequestIds.get(msg.trackIndex) !== msg.requestId) return;
    const info = this._subtitleTracks.find((track) => track.index === msg.trackIndex);
    this.dispatchSubtitleStatus(this.formatSubtitleProgress(info, msg));
  }

  private formatSubtitleProgress(
    info: SubtitleTrackInfo | undefined,
    progress: Pick<
      SubtitleExtractionProgress,
      'trackIndex' | 'codec' | 'phase' | 'cuesRead' | 'elapsedMs'
    > & {
      queueDelayMs?: number;
    },
  ): string {
    const lang = info?.language ?? '?';
    const prefix = `Subtitle track ${progress.trackIndex}: ${lang} ${progress.codec}`;
    const queueDelay =
      typeof progress.queueDelayMs === 'number' && progress.queueDelayMs >= 50
        ? ` after waiting ${formatElapsed(progress.queueDelayMs)}`
        : '';

    if (progress.phase === 'starting') {
      return `${prefix} started${queueDelay}`;
    }
    if (progress.phase === 'reading-cues') {
      return `${prefix} reading cues (${progress.cuesRead} read, ${formatElapsed(progress.elapsedMs)})${queueDelay}`;
    }
    if (progress.phase === 'exporting-text') {
      return `${prefix} exporting text (${progress.cuesRead} cues, ${formatElapsed(progress.elapsedMs)})`;
    }
    return `${prefix} processing (${progress.cuesRead} cues, ${formatElapsed(progress.elapsedMs)})`;
  }

  private async extractEmbeddedSubtitlesFromDemux(
    demux: DemuxResult,
    options: { releaseAfterComplete?: boolean } = {},
  ): Promise<void> {
    const subtitleTracks = demux.subtitleTracks;
    if (subtitleTracks.length === 0) {
      this.dispatchSubtitleStatus('No embedded subtitles');
      if (options.releaseAfterComplete && this._sourceDemux === demux) {
        this._sourceDemux.dispose();
        this._sourceDemux = null;
        this._source = null;
      }
      return;
    }

    this.dispatchSubtitleStatus(`Extracting ${subtitleTracks.length} subtitle track(s)...`);

    try {
      for (const track of subtitleTracks) {
        mlog(
          `extracting subtitle track=${track.index} lang=${track.language} codec=${track.codec}`,
        );
        this.dispatchSubtitleStatus(
          `Subtitle track ${track.index}: ${track.language ?? '?'} ${track.codec} queued`,
        );
        const data = await extractSubtitleData(demux.input, track.index, {
          onProgress: (progress) => {
            if (progress.phase === 'done') {
              return;
            }
            this.dispatchSubtitleStatus(this.formatSubtitleProgress(track, progress));
          },
        });
        const webvtt = subtitleDataToWebVTT(data);
        const cueMatch = webvtt.match(/\d\d:\d\d/g);
        const cueCount = cueMatch ? Math.floor(cueMatch.length / 2) : 0;
        this.dispatchSubtitleStatus(
          `Subtitle track ${track.index}: ${track.language ?? '?'} ${data.codec} ${cueCount} cues, ${webvtt.length} bytes`,
        );
        this.addSubtitleTrack({
          webvtt,
          source: 'embedded',
          trackIndex: track.index,
          defaultTrack: this.shouldAutoSelectEmbeddedSubtitle(track.index),
          selectTrack: this.shouldAutoSelectEmbeddedSubtitle(track.index),
        });
      }
    } catch (error) {
      this.dispatchSubtitleStatus(`Subtitle extraction failed: ${String(error)}`);
    } finally {
      if (options.releaseAfterComplete && this._sourceDemux === demux) {
        this._sourceDemux.dispose();
        this._sourceDemux = null;
        this._source = null;
      }
    }
  }

  private restoreDefaultTextTrack(): void {
    const preferred =
      this.attachedSubtitleTracks.find((attached) => attached.element.default) ??
      this.attachedSubtitleTracks[0];
    if (!preferred) return;
    const target = preferred.textTrack ?? preferred.element;
    queueMicrotask(() => this.showTextTrack(target));
  }

  private shouldAutoSelectEmbeddedSubtitle(trackIndex: number): boolean {
    return this.options.embeddedSubtitlePolicy === 'auto' && trackIndex === 0;
  }
}

/** Set to true to bypass native playback and force the remux pipeline (for testing). */
const FORCE_REMUX = false;

function mlog(msg: string): void {
  console.log(`[engine] ${msg}`);
}

function formatElapsed(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

function inferDirectUrlMimeType(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url, globalThis.location?.href).pathname;
  } catch {
    pathname = url.split(/[?#]/, 1)[0] ?? url;
  }

  const normalizedPath = decodeURIComponent(pathname).toLowerCase();
  if (normalizedPath.endsWith('.mp4') || normalizedPath.endsWith('.m4v')) {
    return 'video/mp4';
  }

  return null;
}

function makeStats(): LoaderStats {
  const now = performance.now();
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: now, first: now, end: now },
    parsing: { start: now, end: now },
    buffering: { start: now, first: now, end: now },
  } as LoaderStats;
}

function iso639_2to1(code: string): string {
  const map: Record<string, string> = {
    eng: 'en',
    spa: 'es',
    fra: 'fr',
    deu: 'de',
    ita: 'it',
    por: 'pt',
    rus: 'ru',
    jpn: 'ja',
    kor: 'ko',
    zho: 'zh',
    ara: 'ar',
    hin: 'hi',
    nld: 'nl',
    swe: 'sv',
    pol: 'pl',
    tur: 'tr',
    vie: 'vi',
    tha: 'th',
    und: '',
  };
  return map[code] ?? code;
}

export function normalizeSubtitleLanguageCode(code: string): string {
  if (code.length === 2) return code;
  return iso639_2to1(code);
}

export function languageLabel(
  langCode: string,
  trackIndex: number,
  disposition?: { hearingImpaired?: boolean; forced?: boolean },
): string {
  const names: Record<string, string> = {
    eng: 'English',
    spa: 'Spanish',
    fra: 'French',
    deu: 'German',
    ita: 'Italian',
    por: 'Portuguese',
    rus: 'Russian',
    jpn: 'Japanese',
    kor: 'Korean',
    zho: 'Chinese',
    ara: 'Arabic',
    hin: 'Hindi',
    nld: 'Dutch',
    swe: 'Swedish',
    pol: 'Polish',
    tur: 'Turkish',
    vie: 'Vietnamese',
    tha: 'Thai',
    bul: 'Bulgarian',
    ces: 'Czech',
    dan: 'Danish',
    fin: 'Finnish',
    ell: 'Greek',
    heb: 'Hebrew',
    hun: 'Hungarian',
    ind: 'Indonesian',
    msa: 'Malay',
    nor: 'Norwegian',
    ron: 'Romanian',
    ukr: 'Ukrainian',
  };
  let base = names[langCode] ?? `Track ${trackIndex + 1}`;
  if (disposition?.hearingImpaired) base += ' (SDH)';
  else if (disposition?.forced) base += ' (Forced)';
  return base;
}
