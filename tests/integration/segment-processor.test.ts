import { EncodedPacket, type EncodedPacketSink } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { createAacSilentAdtsFrame } from '../../src/pipeline/audio-transcode.js';
import { processSegmentWithAbort } from '../../src/pipeline/segment-processor.js';
import { videoTranscodeFfmpegAudioArgs } from '../../src/pipeline/video-transcode.js';

class SinglePacketSink implements Partial<EncodedPacketSink> {
  constructor(private readonly packets: EncodedPacket[] | EncodedPacket) {}

  private get packetList(): EncodedPacket[] {
    return Array.isArray(this.packets) ? this.packets : [this.packets];
  }

  async getKeyPacket(): Promise<EncodedPacket | null> {
    return this.packetList[0] ?? null;
  }

  async getPacket(): Promise<EncodedPacket | null> {
    return this.packetList[0] ?? null;
  }

  async getNextKeyPacket(packet: EncodedPacket): Promise<EncodedPacket | null> {
    return this.next(packet);
  }

  async getNextPacket(packet: EncodedPacket): Promise<EncodedPacket | null> {
    return this.next(packet);
  }

  private next(packet: EncodedPacket): EncodedPacket | null {
    const index = this.packetList.findIndex(
      (item) => item.sequenceNumber === packet.sequenceNumber,
    );
    return index >= 0 ? (this.packetList[index + 1] ?? null) : null;
  }
}

describe('segment processor', () => {
  it('uses source audio decoder config for transcode and AAC config for mux output', async () => {
    const sourceOpusConfig: AudioDecoderConfig = {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 8,
      description: new Uint8Array([
        0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 0x01, 0x08, 0x00, 0x00, 0x80, 0xbb, 0x00,
        0x00, 0x00, 0x00, 0x01, 0x05, 0x03, 0x00, 0x06, 0x01, 0x02, 0x03, 0x04, 0x05, 0x07,
      ]),
    };
    const outputAacConfig: AudioDecoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
    };
    const transcodedConfig: AudioDecoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
    };

    let capturedAudioConfig: AudioDecoderConfig | null | undefined;
    let capturedLeadingSilenceSec: number | undefined;
    let capturedTrimStartSec: number | undefined;
    let capturedOutputStartSec: number | undefined;
    let capturedTargetFrameCount: number | undefined;
    let capturedPacketTimestamps: number[] = [];
    const silentFrame = createAacSilentAdtsFrame(48000, 2);
    expect(silentFrame).not.toBeNull();

    const result = await processSegmentWithAbort(
      {
        videoSink: new SinglePacketSink([
          new EncodedPacket(new Uint8Array([0x12, 0x00, 0x0a]), 'key', 0, 1, 0),
          new EncodedPacket(new Uint8Array([0x12, 0x00, 0x0b]), 'key', 1, 1, 1),
        ]) as EncodedPacketSink,
        audioSink: new SinglePacketSink([
          new EncodedPacket(new Uint8Array([0xf7]), 'key', 0.98, 0.02, 0),
          new EncodedPacket(new Uint8Array([0xf8]), 'key', 1.08, 0.02, 1),
          new EncodedPacket(new Uint8Array([0xf9]), 'key', 2.08, 0.02, 2),
        ]) as EncodedPacketSink,
        videoCodec: 'av1',
        audioCodec: 'opus',
        videoDecoderConfig: {
          codec: 'av01.0.08M.08',
          codedWidth: 16,
          codedHeight: 16,
          description: new Uint8Array([0x81, 0x00, 0x0c, 0x00, 0x0a]),
        },
        sourceAudioDecoderConfig: sourceOpusConfig,
        audioDecoderConfig: outputAacConfig,
        plan: [
          { sequence: 0, uri: 'seg-0.m4s', startSec: 0, durationSec: 1 },
          { sequence: 1, uri: 'seg-1.m4s', startSec: 1, durationSec: 1 },
        ],
        doTranscode: true,
        sourceCodec: 'opus',
        transcodeAudio: async (opts) => {
          capturedAudioConfig = opts.audioDecoderConfig;
          capturedLeadingSilenceSec = opts.leadingSilenceSec;
          capturedTrimStartSec = opts.trimStartSec;
          capturedOutputStartSec = opts.outputStartSec;
          capturedTargetFrameCount = opts.targetFrameCount;
          capturedPacketTimestamps = opts.packets.map((packet) => packet.timestamp);
          return {
            packets: [new EncodedPacket(silentFrame!, 'key', 0, 1024 / 48000)],
            decoderConfig: transcodedConfig,
            metrics: {
              inputPackets: opts.packets.length,
              inputBytes: opts.packets.reduce((sum, packet) => sum + packet.data.byteLength, 0),
              audioDurationSec: 0.02,
              concatMs: 0,
              writeMs: 0,
              ffmpegMs: 0,
              readMs: 0,
              cleanupMs: 0,
              parseMs: 0,
              totalMs: 0,
              outputPackets: 1,
              outputBytes: silentFrame!.byteLength,
              outputDurationSec: 1024 / 48000,
              ffmpegSpeed: null,
              ffmpegTimeMs: null,
              realtimeRatio: 0,
            },
          };
        },
      },
      1,
    );

    expect(capturedAudioConfig).toBe(sourceOpusConfig);
    expect(capturedLeadingSilenceSec).toBe(0);
    expect(capturedTrimStartSec).toBeCloseTo(0.02, 6);
    const frameDurationSec = 1024 / outputAacConfig.sampleRate;
    const expectedStartFrame = Math.round(1 / frameDurationSec);
    const expectedEndFrame = Math.round(2 / frameDurationSec);
    expect(capturedOutputStartSec).toBeCloseTo(expectedStartFrame * frameDurationSec, 10);
    expect(capturedTargetFrameCount).toBe(expectedEndFrame - expectedStartFrame);
    expect(capturedPacketTimestamps).toEqual([0.98, 1.08, 2.08]);
    expect(result.audioDecoderConfig).toBe(transcodedConfig);
    expect(result.mediaData.byteLength).toBeGreaterThan(0);
  });

  it('transcodes TrueHD packets using AAC output config when source decoder config is missing', async () => {
    const outputAacConfig: AudioDecoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
    };
    const silentFrame = createAacSilentAdtsFrame(48000, 2);
    expect(silentFrame).not.toBeNull();

    let capturedSourceCodec: string | undefined;
    let capturedAudioConfig: AudioDecoderConfig | null | undefined;

    const result = await processSegmentWithAbort(
      {
        videoSink: new SinglePacketSink([
          new EncodedPacket(new Uint8Array([0x12, 0x00, 0x0a]), 'key', 0, 1, 0),
        ]) as EncodedPacketSink,
        audioSink: new SinglePacketSink([
          new EncodedPacket(new Uint8Array([0xf8]), 'key', 0, 0.02, 0),
        ]) as EncodedPacketSink,
        videoCodec: 'av1',
        audioCodec: 'truehd',
        videoDecoderConfig: {
          codec: 'av01.0.08M.08',
          codedWidth: 16,
          codedHeight: 16,
          description: new Uint8Array([0x81, 0x00, 0x0c, 0x00, 0x0a]),
        },
        sourceAudioDecoderConfig: null,
        audioDecoderConfig: outputAacConfig,
        plan: [{ sequence: 0, uri: 'seg-0.m4s', startSec: 0, durationSec: 1 }],
        doTranscode: true,
        sourceCodec: 'truehd',
        transcodeAudio: async (opts) => {
          capturedSourceCodec = opts.sourceCodec;
          capturedAudioConfig = opts.audioDecoderConfig;
          return {
            packets: [new EncodedPacket(silentFrame!, 'key', 0, 1024 / 48000)],
            decoderConfig: outputAacConfig,
            metrics: {
              inputPackets: opts.packets.length,
              inputBytes: opts.packets.reduce((sum, packet) => sum + packet.data.byteLength, 0),
              audioDurationSec: 0.02,
              concatMs: 0,
              writeMs: 0,
              ffmpegMs: 0,
              readMs: 0,
              cleanupMs: 0,
              parseMs: 0,
              totalMs: 0,
              outputPackets: 1,
              outputBytes: silentFrame!.byteLength,
              outputDurationSec: 1024 / 48000,
              ffmpegSpeed: null,
              ffmpegTimeMs: null,
              realtimeRatio: 0,
            },
          };
        },
      },
      0,
    );

    expect(capturedSourceCodec).toBe('truehd');
    expect(capturedAudioConfig).toBe(outputAacConfig);
    expect(result.audioDecoderConfig).toBe(outputAacConfig);
    expect(result.mediaData.byteLength).toBeGreaterThan(0);
  });

  it('passes AAC audio directly into AV1 video transcode', async () => {
    const sourceAacConfig: AudioDecoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
      description: new Uint8Array([0x11, 0x90]),
    };
    const captured: {
      sourceAudioCodec?: string | null;
      audioDecoderConfig?: AudioDecoderConfig | null;
      audioPackets?: EncodedPacket[];
    } = {};

    const result = await processSegmentWithAbort(
      {
        videoSink: new SinglePacketSink([
          new EncodedPacket(new Uint8Array([0x12, 0x00, 0x0a]), 'key', 0, 1, 0),
        ]) as EncodedPacketSink,
        audioSink: new SinglePacketSink([
          new EncodedPacket(new Uint8Array([0x21, 0x10]), 'key', 0, 1024 / 48000, 0),
        ]) as EncodedPacketSink,
        videoCodec: 'av1',
        audioCodec: 'aac',
        videoDecoderConfig: {
          codec: 'av01.0.08M.08',
          codedWidth: 16,
          codedHeight: 16,
          description: new Uint8Array([0x81, 0x00, 0x0c, 0x00, 0x0a]),
        },
        sourceAudioDecoderConfig: sourceAacConfig,
        audioDecoderConfig: sourceAacConfig,
        plan: [{ sequence: 0, uri: 'seg-0.m4s', startSec: 0, durationSec: 1 }],
        doTranscode: false,
        sourceCodec: 'aac',
        videoTranscode: true,
        prepareAudioForVideoTranscode: false,
        sourceVideoCodec: 'av1',
        transcodeAudio: async () => {
          throw new Error('AAC audio should not be pre-transcoded for ffmpeg video transcode');
        },
        transcodeVideo: async (opts) => {
          captured.sourceAudioCodec = opts.sourceAudioCodec;
          captured.audioDecoderConfig = opts.audioDecoderConfig;
          captured.audioPackets = opts.audioPackets;
          return {
            initSegment: new Uint8Array([0x01]),
            mediaData: new Uint8Array([0x02]),
            audioDecoderConfig: sourceAacConfig,
            metrics: {
              packageMs: 0,
              writeMs: 0,
              ffmpegMs: 0,
              readMs: 0,
              splitMs: 0,
              cleanupMs: 0,
              totalMs: 0,
              inputBytes: 0,
              outputBytes: 1,
              ffmpegSpeed: null,
              ffmpegTimeMs: null,
            },
          };
        },
      },
      0,
    );

    expect(captured.sourceAudioCodec).toBe('aac');
    expect(captured.audioDecoderConfig).toBe(sourceAacConfig);
    expect(captured.audioPackets).toHaveLength(1);
    expect(result.audioDecoderConfig).toBe(sourceAacConfig);
    expect(result.mediaData).toEqual(new Uint8Array([0x02]));
  });

  it('copies AAC during ffmpeg video transcode instead of decoding it', () => {
    expect(videoTranscodeFfmpegAudioArgs(false, null)).toEqual(['-an']);
    expect(videoTranscodeFfmpegAudioArgs(true, 'aac')).toEqual(['-map', '0:a:0?', '-c:a', 'copy']);
    expect(videoTranscodeFfmpegAudioArgs(true, 'opus')).toEqual([
      '-map',
      '0:a:0?',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-b:a',
      '128k',
    ]);
  });
});
