import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, NodeFfmpegRunner } from '../../src/adapters/node-ffmpeg.js';
import { NodeFfprobeRunner } from '../../src/adapters/node-ffprobe.js';
import { parseAdtsFrames } from '../../src/pipeline/adts-parse.js';
import {
  buildTranscodeResultFromAdts,
  createAacSilentAdtsFrame,
  transcodeAudioSegment,
} from '../../src/pipeline/audio-transcode.js';
import { audioNeedsTranscode, createNodeProber } from '../../src/pipeline/codec-probe.js';
import { collectPacketsInRange, demuxFile } from '../../src/pipeline/demux.js';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');
let ffmpeg: NodeFfmpegRunner;
const ffprobe = new NodeFfprobeRunner();

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 100 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || String(error)));
      } else {
        resolve();
      }
    });
  });
}

describe('audio-transcode', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('builds decodable AAC ADTS silent frames for segment padding', () => {
    const frame = createAacSilentAdtsFrame(48000, 2);

    expect(frame).not.toBeNull();
    const frames = parseAdtsFrames(frame!);
    expect(frames).toHaveLength(1);
    expect(frames[0].sampleRate).toBe(48000);
    expect(frames[0].channels).toBe(2);
    expect(frames[0].data.byteLength).toBe(frame!.byteLength);
    expect(createAacSilentAdtsFrame(12345, 2)).toBeNull();
  });

  it('identifies codecs that need transcode', () => {
    const prober = createNodeProber();
    expect(audioNeedsTranscode(prober, 'ac3')).toBe(true);
    expect(audioNeedsTranscode(prober, 'eac3')).toBe(true);
    expect(audioNeedsTranscode(prober, 'flac')).toBe(true);
    expect(audioNeedsTranscode(prober, 'aac')).toBe(false);
    expect(audioNeedsTranscode(prober, 'mp3')).toBe(true);
  });

  it('transcodes AC3 packets to AAC', async () => {
    const demux = await demuxFile(join(FIXTURES_DIR, 'test-h264-ac3.mkv'));
    dispose = demux.dispose;

    expect(demux.audioCodec).toBe('ac3');
    const ac3Packets = await collectPacketsInRange(demux.audioSink!, 0, 3);
    expect(ac3Packets.length).toBeGreaterThan(0);

    const tempDir = await makeTempDir();
    ffmpeg = new NodeFfmpegRunner(tempDir);
    const result = await transcodeAudioSegment({
      packets: ac3Packets,
      sampleRate: 48000,
      audioStartSec: 0,
      ffmpeg,
      sourceCodec: demux.audioCodec ?? undefined,
    });

    expect(result.packets.length).toBeGreaterThan(0);

    // AAC frames: 1024 samples at 48kHz = ~21.3ms per frame
    // 3 seconds = ~140 frames
    expect(result.packets.length).toBeGreaterThan(100);
    expect(result.packets.length).toBeLessThan(200);

    // Timestamps should be monotonically increasing from 0
    for (let i = 1; i < result.packets.length; i++) {
      expect(result.packets[i].timestamp).toBeGreaterThan(result.packets[i - 1].timestamp);
    }

    // All packets should be keyframes (AAC)
    for (const pkt of result.packets) {
      expect(pkt.type).toBe('key');
      expect(pkt.data.byteLength).toBeGreaterThan(0);
    }

    // Verify the AAC output is decodable by writing to ADTS file
    const totalSize = result.packets.reduce((s, p) => s + p.data.byteLength, 0);
    const aacData = new Uint8Array(totalSize);
    let offset = 0;
    for (const pkt of result.packets) {
      aacData.set(pkt.data, offset);
      offset += pkt.data.byteLength;
    }
    const aacPath = join(tempDir, 'verify.aac');
    await writeFile(aacPath, aacData);

    const decodable = await ffprobe.verifyDecodable(aacPath);
    expect(decodable.ok, `AAC not decodable: ${decodable.stderr}`).toBe(true);

    // Verify transcode metrics are populated
    const m = result.metrics;
    expect(m.inputPackets).toBeGreaterThan(0);
    expect(m.inputBytes).toBeGreaterThan(0);
    expect(m.audioDurationSec).toBeGreaterThan(0);
    expect(m.totalMs).toBeGreaterThan(0);
    expect(m.ffmpegMs).toBeGreaterThan(0);
    expect(m.outputPackets).toBeGreaterThan(0);
    expect(m.outputBytes).toBeGreaterThan(0);
    expect(m.outputDurationSec).toBeGreaterThan(0);
    expect(m.realtimeRatio).toBeGreaterThan(0);
    // Phase timings should be non-negative
    expect(m.concatMs).toBeGreaterThanOrEqual(0);
    expect(m.writeMs).toBeGreaterThanOrEqual(0);
    expect(m.readMs).toBeGreaterThanOrEqual(0);
    expect(m.parseMs).toBeGreaterThanOrEqual(0);
    expect(m.cleanupMs).toBeGreaterThanOrEqual(0);
  });

  it('pads transcoded audio to cover a requested segment range', async () => {
    const demux = await demuxFile(join(FIXTURES_DIR, 'test-h264-ac3.mkv'));
    dispose = demux.dispose;

    const segmentStartSec = 0;
    const segmentDurationSec = 3;
    const audioStartSec = 0.08;
    const ac3Packets = await collectPacketsInRange(
      demux.audioSink!,
      audioStartSec,
      segmentDurationSec,
    );
    expect(ac3Packets.length).toBeGreaterThan(0);

    const tempDir = await makeTempDir();
    ffmpeg = new NodeFfmpegRunner(tempDir);
    const result = await transcodeAudioSegment({
      packets: ac3Packets,
      sampleRate: 48000,
      audioStartSec: ac3Packets[0].timestamp,
      outputStartSec: segmentStartSec,
      leadingSilenceSec: Math.max(0, ac3Packets[0].timestamp - segmentStartSec),
      targetDurationSec: segmentDurationSec,
      ffmpeg,
      sourceCodec: demux.audioCodec ?? undefined,
    });

    expect(result.packets.length).toBeGreaterThan(0);
    const first = result.packets[0];
    const last = result.packets[result.packets.length - 1];
    const endSec = last.timestamp + last.duration;
    const frameDurationSec = first.duration;

    expect(first.timestamp).toBeCloseTo(segmentStartSec, 6);
    expect(endSec).toBeGreaterThanOrEqual(segmentStartSec + segmentDurationSec);
    expect(endSec).toBeLessThanOrEqual(segmentStartSec + segmentDurationSec + frameDurationSec);
  });

  it('snaps requested output starts to the AAC sample grid', async () => {
    const demux = await demuxFile(join(FIXTURES_DIR, 'test-h264-ac3.mkv'));
    dispose = demux.dispose;

    const segmentStartSec = 61.311;
    const segmentDurationSec = 10.219;
    const ac3Packets = await collectPacketsInRange(
      demux.audioSink!,
      0,
      Math.min(3, segmentDurationSec),
    );
    expect(ac3Packets.length).toBeGreaterThan(0);

    const tempDir = await makeTempDir();
    ffmpeg = new NodeFfmpegRunner(tempDir);
    const result = await transcodeAudioSegment({
      packets: ac3Packets,
      sampleRate: 48000,
      audioStartSec: ac3Packets[0].timestamp,
      outputStartSec: segmentStartSec,
      leadingSilenceSec: 0.09,
      targetDurationSec: segmentDurationSec,
      ffmpeg,
      sourceCodec: demux.audioCodec ?? undefined,
    });

    expect(result.packets.length).toBeGreaterThan(0);
    const first = result.packets[0];
    const firstSample = Math.round(first.timestamp * result.decoderConfig.sampleRate);
    expect(first.timestamp).toBeCloseTo(firstSample / result.decoderConfig.sampleRate, 10);
  });

  it('drops preroll AAC frames before assigning segment timestamps', () => {
    const silentFrame = createAacSilentAdtsFrame(48000, 2);
    expect(silentFrame).not.toBeNull();

    const frameCount = 8;
    const aacData = new Uint8Array(silentFrame!.byteLength * frameCount);
    for (let i = 0; i < frameCount; i++) {
      aacData.set(silentFrame!, i * silentFrame!.byteLength);
    }

    const frameDurationSec = 1024 / 48000;
    const result = buildTranscodeResultFromAdts({
      inputPackets: 8,
      inputBytes: aacData.byteLength,
      audioDurationSec: frameCount * frameDurationSec,
      concatMs: 0,
      sampleRate: 48000,
      audioStartSec: 9.9,
      outputStartSec: 10,
      trimStartSec: frameDurationSec * 2,
      targetDurationSec: frameDurationSec * 3,
      aacData,
      ffmpegMetrics: {
        writeMs: 0,
        ffmpegMs: 0,
        readMs: 0,
        cleanupMs: 0,
        ffmpegSpeed: null,
        ffmpegTimeMs: null,
      },
      totalMs: 1,
    });

    expect(result.packets).toHaveLength(3);
    expect(result.packets[0].timestamp).toBeCloseTo(10, 6);
    expect(result.packets[1].timestamp).toBeCloseTo(10 + frameDurationSec, 6);
  });

  it('emits adjacent AAC frame windows without overlap or gap', () => {
    const silentFrame = createAacSilentAdtsFrame(48000, 2);
    expect(silentFrame).not.toBeNull();

    const frameDurationSec = 1024 / 48000;
    const segmentDurationSec = 10.01;
    const firstSegmentStartSec = 100;
    const firstSegmentEndSec = firstSegmentStartSec + segmentDurationSec;
    const secondSegmentEndSec = firstSegmentEndSec + segmentDurationSec;
    const firstStartFrame = Math.round(firstSegmentStartSec / frameDurationSec);
    const firstEndFrame = Math.round(firstSegmentEndSec / frameDurationSec);
    const secondStartFrame = firstEndFrame;
    const secondEndFrame = Math.round(secondSegmentEndSec / frameDurationSec);
    const firstTargetFrameCount = firstEndFrame - firstStartFrame;
    const secondTargetFrameCount = secondEndFrame - secondStartFrame;
    const frameCount = Math.max(firstTargetFrameCount, secondTargetFrameCount) + 2;
    const aacData = new Uint8Array(silentFrame!.byteLength * frameCount);
    for (let i = 0; i < frameCount; i++) {
      aacData.set(silentFrame!, i * silentFrame!.byteLength);
    }

    const first = buildTranscodeResultFromAdts({
      inputPackets: frameCount,
      inputBytes: aacData.byteLength,
      audioDurationSec: frameCount * frameDurationSec,
      concatMs: 0,
      sampleRate: 48000,
      audioStartSec: firstSegmentStartSec,
      outputStartSec: firstStartFrame * frameDurationSec,
      targetFrameCount: firstTargetFrameCount,
      aacData,
      ffmpegMetrics: {
        writeMs: 0,
        ffmpegMs: 0,
        readMs: 0,
        cleanupMs: 0,
        ffmpegSpeed: null,
        ffmpegTimeMs: null,
      },
      totalMs: 1,
    });
    const second = buildTranscodeResultFromAdts({
      inputPackets: frameCount,
      inputBytes: aacData.byteLength,
      audioDurationSec: frameCount * frameDurationSec,
      concatMs: 0,
      sampleRate: 48000,
      audioStartSec: firstSegmentEndSec,
      outputStartSec: secondStartFrame * frameDurationSec,
      targetFrameCount: secondTargetFrameCount,
      aacData,
      ffmpegMetrics: {
        writeMs: 0,
        ffmpegMs: 0,
        readMs: 0,
        cleanupMs: 0,
        ffmpegSpeed: null,
        ffmpegTimeMs: null,
      },
      totalMs: 1,
    });

    expect(first.packets).toHaveLength(firstTargetFrameCount);
    expect(second.packets).toHaveLength(secondTargetFrameCount);
    expect(first.metrics.targetFrameCount).toBe(firstTargetFrameCount);
    expect(second.metrics.targetFrameCount).toBe(secondTargetFrameCount);

    const firstLast = first.packets[first.packets.length - 1];
    const firstEndSec = firstLast.timestamp + firstLast.duration;
    const secondStartSec = second.packets[0].timestamp;
    expect(firstEndSec).toBeCloseTo(secondStartSec, 10);
    expect(Math.abs(firstEndSec - firstSegmentEndSec)).toBeLessThan(frameDurationSec / 2);
  });

  it('wraps packetized Opus from MKV into Ogg before transcoding to AAC', async () => {
    const tempDir = await makeTempDir();
    const fixturePath = join(tempDir, 'opus-in-mkv.mkv');
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=16x16:rate=10:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'libopus',
      '-f',
      'matroska',
      '-y',
      fixturePath,
    ]);

    const demux = await demuxFile(fixturePath);
    dispose = demux.dispose;

    expect(demux.audioCodec).toBe('opus');
    expect(demux.audioDecoderConfig).not.toBeNull();
    const opusPackets = await collectPacketsInRange(demux.audioSink!, 0, 2);
    expect(opusPackets.length).toBeGreaterThan(0);

    ffmpeg = new NodeFfmpegRunner(tempDir);
    const decoderConfigWithoutDescription = demux.audioDecoderConfig
      ? { ...demux.audioDecoderConfig, description: undefined }
      : null;
    const result = await transcodeAudioSegment({
      packets: opusPackets,
      sampleRate: demux.audioDecoderConfig?.sampleRate ?? 48000,
      audioStartSec: 0,
      ffmpeg,
      sourceCodec: 'opus',
      audioDecoderConfig: decoderConfigWithoutDescription,
    });

    expect(result.packets.length).toBeGreaterThan(0);
    expect(result.decoderConfig.codec).toBe('mp4a.40.2');
    expect(result.metrics.inputPackets).toBe(opusPackets.length);
    expect(result.metrics.inputBytes).toBeGreaterThan(0);
  });
});
