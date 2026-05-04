export type WorkerSegmentPhase =
  | 'queued'
  | 'prefetching'
  | 'processing'
  | 'ready'
  | 'cache-hit'
  | 'aborted'
  | 'error';

export interface WorkerSegmentStateMessage {
  type: 'segment-state';
  index: number;
  phase: WorkerSegmentPhase;
  sizeBytes?: number;
  message?: string;
}

export type WorkerSubtitlePhase = 'starting' | 'reading-cues' | 'exporting-text';

export interface WorkerSubtitleProgressMessage {
  type: 'subtitle-progress';
  trackIndex: number;
  requestId: number;
  phase: WorkerSubtitlePhase;
  codec: string;
  cuesRead: number;
  elapsedMs: number;
  queueDelayMs?: number;
}

/** Incremental batch of cleaned subtitle cues sent from worker → main thread. */
export interface WorkerSubtitleBatchMessage {
  type: 'subtitle-batch';
  trackIndex: number;
  requestId: number;
  codec: string;
  cues: Array<{ startSec: number; endSec: number; text: string; settings?: string }>;
  done: boolean;
  totalCues: number;
}
