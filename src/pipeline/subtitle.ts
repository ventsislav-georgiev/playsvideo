import type { Input, SubtitleCue } from 'mediabunny';
import { formatCuesToWebVTT } from 'mediabunny';
import type { SubtitleCueEntry, SubtitleData, SubtitleTrackInfo } from './types.js';

export type SubtitleExtractionPhase = 'starting' | 'reading-cues' | 'exporting-text' | 'done';

export interface SubtitleExtractionProgress {
  trackIndex: number;
  codec: string;
  phase: SubtitleExtractionPhase;
  cuesRead: number;
  elapsedMs: number;
}

export interface ExtractSubtitleDataOptions {
  onProgress?: (progress: SubtitleExtractionProgress) => void;
  signal?: AbortSignal;
}

export interface StreamSubtitleOptions {
  onBatch: (batch: SubtitleCueEntry[], done: boolean, totalCues: number, codec: string) => void;
  onProgress?: (progress: SubtitleExtractionProgress) => void;
  signal?: AbortSignal;
  /** Cues per first batch (fast initial display). Default 20. */
  firstBatchSize?: number;
  /** Cues per subsequent batch. Default 200. */
  batchSize?: number;
  /** If set, start reading cues from this timestamp (seconds) using seek-based access. */
  startTimeSec?: number;
  /** If set, stop reading once a cue's start time exceeds this value (seconds). Enables windowed loading. */
  endTimeSec?: number;
}

/** Discover subtitle tracks from a demuxed input. Cheap — reads only metadata, no cue extraction. */
export async function getSubtitleTrackInfos(input: Input): Promise<SubtitleTrackInfo[]> {
  const tracks = await input.getSubtitleTracks();
  return tracks.map((track, i) => {
    const d = track.disposition;
    return {
      index: i,
      codec: track.codec ?? 'unknown',
      language: track.languageCode,
      name: track.name,
      disposition: {
        default: d.default,
        forced: d.forced,
        hearingImpaired: d.hearingImpaired,
      },
    };
  });
}

/** Extract all cues from a subtitle track and return cleaned SubtitleData. */
export async function extractSubtitleData(
  input: Input,
  trackIndex: number,
  options: ExtractSubtitleDataOptions = {},
): Promise<SubtitleData> {
  const tracks = await input.getSubtitleTracks();
  const track = tracks[trackIndex];
  if (!track) {
    throw new Error(`Subtitle track index ${trackIndex} not found`);
  }

  const codec = track.codec ?? 'unknown';
  const rawCues: SubtitleCue[] = [];
  const startedAt = performance.now();
  let lastReportedAt = startedAt;
  let lastReportedCues = 0;

  const reportProgress = (phase: SubtitleExtractionPhase, cuesRead = rawCues.length): void => {
    options.onProgress?.({
      trackIndex,
      codec,
      phase,
      cuesRead,
      elapsedMs: performance.now() - startedAt,
    });
  };

  reportProgress('starting', 0);

  for await (const cue of track.getCues()) {
    if (options.signal?.aborted) break;
    rawCues.push(cue);
    const now = performance.now();
    if (
      rawCues.length === 1 ||
      rawCues.length - lastReportedCues >= 250 ||
      now - lastReportedAt >= 500
    ) {
      reportProgress('reading-cues');
      lastReportedAt = now;
      lastReportedCues = rawCues.length;
    }
  }

  const cues = cleanCues(rawCues, codec);

  // For ASS/SSA, try to get the header from exportToText
  let header: string | undefined;
  if ((codec === 'ass' || codec === 'ssa') && !options.signal?.aborted) {
    reportProgress('exporting-text');
    const exported = await track.exportToText();
    header = extractAssHeader(exported);
  }

  reportProgress('done', cues.length);

  return { cues, codec, header };
}

/**
 * Stream subtitle cues in batches as they are read from the demuxer.
 * First batch is small for fast initial display; subsequent batches are larger.
 */
export async function extractSubtitleDataStreaming(
  input: Input,
  trackIndex: number,
  options: StreamSubtitleOptions,
): Promise<{ codec: string; header?: string }> {
  const tracks = await input.getSubtitleTracks();
  const track = tracks[trackIndex];
  if (!track) {
    throw new Error(`Subtitle track index ${trackIndex} not found`);
  }

  const codec = track.codec ?? 'unknown';
  const firstBatchSize = options.firstBatchSize ?? 20;
  const batchSize = options.batchSize ?? 200;

  const startedAt = performance.now();
  let lastReportedAt = startedAt;
  let lastReportedCues = 0;
  let totalCuesSent = 0;
  let pending: SubtitleCue[] = [];

  const reportProgress = (phase: SubtitleExtractionPhase, cuesRead: number): void => {
    options.onProgress?.({ trackIndex, codec, phase, cuesRead, elapsedMs: performance.now() - startedAt });
  };

  const flushBatch = (done: boolean): void => {
    if (pending.length === 0 && !done) return;
    const cleaned = cleanCues(pending, codec);
    totalCuesSent += cleaned.length;
    options.onBatch(cleaned, done, totalCuesSent, codec);
    pending = [];
  };

  reportProgress('starting', 0);

  const cueIterator = options.startTimeSec != null
    ? track.getCuesFrom(options.startTimeSec)
    : track.getCues();

  let totalRead = 0;
  for await (const cue of cueIterator) {
    if (options.signal?.aborted) break;
    if (options.endTimeSec != null && cue.timestamp > options.endTimeSec) break;
    pending.push(cue);
    totalRead++;

    const now = performance.now();
    if (totalRead - lastReportedCues >= 250 || now - lastReportedAt >= 500 || totalRead === 1) {
      reportProgress('reading-cues', totalRead);
      lastReportedAt = now;
      lastReportedCues = totalRead;
    }

    const threshold = totalCuesSent === 0 ? firstBatchSize : batchSize;
    if (pending.length >= threshold) {
      flushBatch(false);
    }
  }

  flushBatch(true);

  let header: string | undefined;
  if ((codec === 'ass' || codec === 'ssa') && !options.signal?.aborted) {
    reportProgress('exporting-text', totalRead);
    const exported = await track.exportToText();
    header = extractAssHeader(exported);
  }

  reportProgress('done', totalRead);
  return { codec, header };
}

/**
 * Convert SubtitleData to a WebVTT string suitable for a Blob URL.
 * Works for any source codec — ASS override tags are stripped to plain text.
 */
export function subtitleDataToWebVTT(data: SubtitleData): string {
  // If we have clean cues, use mediabunny's formatter
  const mbCues: SubtitleCue[] = data.cues.map((c) => ({
    timestamp: c.startSec,
    duration: c.endSec - c.startSec,
    text: stripAssTags(c.text),
    settings: c.settings,
  }));
  return formatCuesToWebVTT(mbCues);
}

/**
 * Parse a user-imported subtitle file into SubtitleData.
 * Supports .srt, .vtt, .ass/.ssa files.
 */
export function parseSubtitleFile(text: string, filename: string): SubtitleData {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  if (ext === 'vtt') {
    return parseWebVTT(text);
  }
  if (ext === 'srt') {
    return parseSRT(text);
  }
  if (ext === 'ass' || ext === 'ssa') {
    return { cues: [], codec: ext, header: text };
    // For ASS, the full file IS the data — keep it opaque for JASSUB
    // Could also parse into cues for WebVTT fallback
  }

  throw new Error(`Unsupported subtitle format: .${ext}`);
}

// --- Internal helpers ---

/** Strip tx3g 2-byte length prefix and trailing style boxes, filter empty gap cues. */
function cleanCues(raw: SubtitleCue[], codec: string): SubtitleCueEntry[] {
  const cleaned: SubtitleCueEntry[] = [];

  for (const cue of raw) {
    let text = cue.text;

    // tx3g samples: 2-byte big-endian text byte-length, then UTF-8 text, then
    // optional style boxes (styl, hlit, hclr…). mediabunny decodes the entire
    // sample as UTF-8, so we re-encode to recover byte offsets and extract only
    // the text portion.
    if (codec === 'tx3g' && text.length >= 2) {
      text = extractTx3gText(text);
    }

    text = text.trim();
    if (!text || cue.duration <= 0) continue;

    cleaned.push({
      startSec: cue.timestamp,
      endSec: cue.timestamp + cue.duration,
      text,
      settings: cue.settings,
    });
  }

  return cleaned;
}

/**
 * Extract just the text from a tx3g sample that was decoded as UTF-8 by mediabunny.
 * tx3g format: [2-byte big-endian text byte length] [UTF-8 text] [optional style boxes].
 * We re-encode to bytes to correctly interpret the length prefix, then decode
 * only the text portion.
 */
function extractTx3gText(decoded: string): string {
  const bytes = new TextEncoder().encode(decoded);
  if (bytes.length < 2) return decoded;
  const textByteLen = (bytes[0] << 8) | bytes[1];
  const textBytes = bytes.slice(2, 2 + textByteLen);
  return new TextDecoder('utf-8').decode(textBytes);
}

/** Strip ASS/SSA override tags like {\b1}, {\pos(x,y)}, {\an8} → plain text. */
function stripAssTags(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n');
}

/** Extract the ASS header (everything before the first Dialogue: line). */
function extractAssHeader(fullText: string): string | undefined {
  const idx = fullText.indexOf('Dialogue:');
  if (idx === -1) return fullText;
  return fullText.slice(0, idx).trimEnd();
}

function parseWebVTT(text: string): SubtitleData {
  const cues: SubtitleCueEntry[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const timeRegex = /([\d:.]+)\s+-->\s+([\d:.]+)(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const match = timeRegex.exec(lines[i]);
    if (!match) continue;

    const startSec = parseVTTTimestamp(match[1]);
    const endSec = parseVTTTimestamp(match[2]);
    const settings = match[3]?.trim() || undefined;

    const textLines: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim(); j++) {
      textLines.push(lines[j]);
      i = j;
    }

    if (textLines.length > 0) {
      cues.push({ startSec, endSec, text: textLines.join('\n'), settings });
    }
  }

  // Extract preamble as header
  const firstArrow = text.indexOf('-->');
  let header: string | undefined;
  if (firstArrow !== -1) {
    const beforeFirstCue = text.slice(
      0,
      text.lastIndexOf('\n', text.lastIndexOf('\n', firstArrow) - 1),
    );
    if (beforeFirstCue.includes('WEBVTT')) {
      header = beforeFirstCue.trim();
    }
  }

  return { cues, codec: 'webvtt', header };
}

function parseSRT(text: string): SubtitleData {
  const cues: SubtitleCueEntry[] = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n+/);
  const timeRegex = /([\d:,]+)\s+-->\s+([\d:,]+)/;

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timing line (skip sequence number)
    let timingIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (timeRegex.test(lines[i])) {
        timingIdx = i;
        break;
      }
    }

    const match = timeRegex.exec(lines[timingIdx]);
    if (!match) continue;

    const startSec = parseSRTTimestamp(match[1]);
    const endSec = parseSRTTimestamp(match[2]);
    const cueText = lines
      .slice(timingIdx + 1)
      .join('\n')
      .trim();

    if (cueText) {
      cues.push({ startSec, endSec, text: cueText });
    }
  }

  return { cues, codec: 'srt' };
}

function parseVTTTimestamp(ts: string): number {
  const parts = ts.split(':');
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function parseSRTTimestamp(ts: string): number {
  const [time, ms] = ts.split(',');
  const parts = time.split(':');
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(ms) / 1000;
}

// Export helpers for use in subtitle-seeking.ts
export { cleanCues, extractAssHeader, stripAssTags };
