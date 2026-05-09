import { describe, expect, it } from 'vitest';
import {
  evaluatePlaybackOptions,
  recommendPlaybackOption,
  type PipelinePlaybackProbe,
} from '../../src/playback-selection.js';

const ALL_SUPPORTED_PROBE: PipelinePlaybackProbe = {
  canPlayAudio: () => true,
  canPlayVideo: () => true,
};

describe('playback-selection', () => {
  it('prefers direct playback when both direct and hls are supported', () => {
    const result = evaluatePlaybackOptions({
      options: [
        { mode: 'hls', id: 'hls' },
        { mode: 'direct-bytes', id: 'direct', mimeType: 'video/mp4' },
      ],
      media: {
        sourceVideoCodec: 'avc',
        sourceAudioCodec: 'aac',
        videoCodec: 'avc1.640028',
        audioCodec: 'mp4a.40.2',
      },
      capabilities: {
        canPlayType: () => 'probably',
        hlsSupported: true,
        pipelineProbe: ALL_SUPPORTED_PROBE,
      },
    });

    expect(result.recommended?.option).toEqual({
      mode: 'direct-bytes',
      id: 'direct',
      mimeType: 'video/mp4',
    });
    expect(result.evaluations.find((e) => e.option.id === 'direct')?.selected).toBe(true);
    expect(result.evaluations.find((e) => e.option.id === 'hls')?.selected).toBe(false);
  });

  it('prefers direct URL playback when remote MP4 codecs are supported', () => {
    const result = evaluatePlaybackOptions({
      options: [
        { mode: 'direct-url', id: 'direct', mimeType: 'video/mp4', url: 'https://example.test/video.mp4' },
        { mode: 'hls', id: 'hls' },
      ],
      media: {
        sourceVideoCodec: 'avc',
        sourceAudioCodec: 'aac',
        videoCodec: 'avc1.640028',
        audioCodec: 'mp4a.40.2',
      },
      capabilities: {
        canPlayType: (mimeType) => (mimeType === 'video/mp4; codecs="avc1.640028, mp4a.40.2"' ? 'probably' : ''),
        hlsSupported: true,
        pipelineProbe: ALL_SUPPORTED_PROBE,
      },
    });

    expect(result.recommended?.option).toEqual({
      mode: 'direct-url',
      id: 'direct',
      mimeType: 'video/mp4',
      url: 'https://example.test/video.mp4',
    });
    expect(result.evaluations.find((e) => e.option.id === 'direct')?.status).toBe('supported');
  });

  it('recommends hls when direct playback is unsupported', () => {
    const result = evaluatePlaybackOptions({
      options: [
        { mode: 'direct-url', id: 'direct', mimeType: 'video/x-matroska' },
        { mode: 'hls', id: 'hls' },
      ],
      media: {
        sourceVideoCodec: 'avc',
        sourceAudioCodec: 'aac',
        videoCodec: 'avc1.640028',
        audioCodec: 'mp4a.40.2',
      },
      capabilities: {
        canPlayType: () => '',
        hlsSupported: true,
        pipelineProbe: ALL_SUPPORTED_PROBE,
      },
    });

    expect(result.recommended?.option).toEqual({ mode: 'hls', id: 'hls' });
    expect(result.evaluations.find((e) => e.option.id === 'direct')?.status).toBe('blocked');
    expect(result.evaluations.find((e) => e.option.id === 'hls')?.selected).toBe(true);
  });

  it('keeps hls viable when audio needs transcode', () => {
    const result = evaluatePlaybackOptions({
      options: [{ mode: 'hls', id: 'hls' }],
      media: {
        sourceVideoCodec: 'avc',
        sourceAudioCodec: 'ac3',
        videoCodec: 'avc1.640028',
        audioCodec: 'ac-3',
      },
      capabilities: {
        hlsSupported: true,
        pipelineProbe: {
          canPlayVideo: () => true,
          canPlayAudio: () => false,
        },
      },
    });

    expect(result.recommended?.option).toEqual({ mode: 'hls', id: 'hls' });
    expect(result.evaluations[0].status).toBe('supported');
    expect(result.evaluations[0].pipelineAudioRequiresTranscode).toBe(true);
    expect(result.evaluations[0].diagnostics.map((d) => d.code)).toContain('hls-audio-transcode');
  });

  it('forces hls audio transcode when audio decoder config is missing', () => {
    const result = evaluatePlaybackOptions({
      options: [{ mode: 'hls', id: 'hls' }],
      media: {
        sourceVideoCodec: 'hevc',
        sourceAudioCodec: 'aac',
        videoCodec: 'hev1.1.6.L120.B0',
        audioCodec: null,
        hasAudioDecoderConfig: false,
        hasAudioTrack: true,
      },
      capabilities: {
        hlsSupported: true,
        pipelineProbe: ALL_SUPPORTED_PROBE,
      },
    });

    expect(result.recommended?.option).toEqual({ mode: 'hls', id: 'hls' });
    expect(result.evaluations[0].status).toBe('supported');
    expect(result.evaluations[0].pipelineAudioRequiresTranscode).toBe(true);
    expect(result.evaluations[0].diagnostics.map((d) => d.code)).toContain(
      'hls-audio-missing-decoder-config',
    );
  });

  it('keeps hls viable when an audio track exists but codec metadata is unavailable', () => {
    const result = evaluatePlaybackOptions({
      options: [{ mode: 'hls', id: 'hls' }],
      media: {
        sourceVideoCodec: 'avc',
        sourceAudioCodec: null,
        videoCodec: 'avc1.640028',
        audioCodec: null,
        hasAudioDecoderConfig: false,
        hasAudioTrack: true,
      },
      capabilities: {
        hlsSupported: true,
        pipelineProbe: ALL_SUPPORTED_PROBE,
      },
    });

    expect(result.recommended?.option).toEqual({ mode: 'hls', id: 'hls' });
    expect(result.evaluations[0].status).toBe('supported');
    expect(result.evaluations[0].pipelineAudioRequiresTranscode).toBe(true);
    expect(result.evaluations[0].diagnostics.map((d) => d.code)).toContain(
      'hls-audio-missing-decoder-config',
    );
  });

  it('blocks hls when remuxed video is unsupported', () => {
    const result = evaluatePlaybackOptions({
      options: [{ mode: 'hls', id: 'hls' }],
      media: {
        sourceVideoCodec: 'vp9',
        sourceAudioCodec: 'aac',
        videoCodec: 'vp09.00.10.08',
        audioCodec: 'mp4a.40.2',
      },
      capabilities: {
        hlsSupported: true,
        pipelineProbe: {
          canPlayVideo: () => false,
          canPlayAudio: () => true,
        },
      },
    });

    expect(result.recommended).toBeNull();
    expect(result.evaluations[0].status).toBe('blocked');
    expect(result.evaluations[0].diagnostics.map((d) => d.code)).toContain('hls-video-unsupported');
  });

  it('keeps hls viable when unsupported AV1 video can be transcoded', () => {
    const result = evaluatePlaybackOptions({
      options: [{ mode: 'hls', id: 'hls' }],
      media: {
        sourceVideoCodec: 'av1',
        sourceAudioCodec: 'opus',
        videoCodec: 'av01.0.08M.08',
        audioCodec: 'opus',
      },
      capabilities: {
        hlsSupported: true,
        pipelineProbe: {
          canPlayVideo: () => false,
          canPlayAudio: () => false,
        },
      },
    });

    expect(result.recommended?.option).toEqual({ mode: 'hls', id: 'hls' });
    expect(result.evaluations[0].status).toBe('supported');
    expect(result.evaluations[0].pipelineVideoSupported).toBe(false);
    expect(result.evaluations[0].pipelineVideoRequiresTranscode).toBe(true);
    expect(result.evaluations[0].pipelineAudioRequiresTranscode).toBe(true);
    expect(result.evaluations[0].diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['hls-video-transcode', 'hls-audio-transcode']),
    );
  });

  it('forces AV1 HLS pipeline video transcode even when direct AV1 may be supported', () => {
    const result = evaluatePlaybackOptions({
      options: [
        { mode: 'direct-url', id: 'direct', mimeType: 'video/x-matroska', url: 'https://example.test/video.mkv' },
        { mode: 'hls', id: 'hls' },
      ],
      media: {
        sourceVideoCodec: 'av1',
        sourceAudioCodec: 'opus',
        videoCodec: 'av01.0.08M.08',
        audioCodec: 'opus',
        isAv1Video: true,
      },
      capabilities: {
        canPlayType: () => '',
        hlsSupported: true,
        av1Supported: 'supported',
        pipelineProbe: {
          canPlayVideo: (codec) => codec !== 'av1',
          canPlayAudio: () => false,
        },
      },
    });

    const hls = result.evaluations.find((entry) => entry.option.id === 'hls');
    expect(result.recommended?.option).toEqual({ mode: 'hls', id: 'hls' });
    expect(hls?.status).toBe('supported');
    expect(hls?.pipelineVideoRequiresTranscode).toBe(true);
    expect(hls?.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(['hls-video-transcode', 'hls-audio-transcode']),
    );
  });

  it('returns unknown when required metadata or capabilities are missing', () => {
    const result = evaluatePlaybackOptions({
      options: [
        { mode: 'direct-bytes', id: 'direct', mimeType: null },
        { mode: 'hls', id: 'hls' },
      ],
      media: {
        sourceVideoCodec: null,
        sourceAudioCodec: null,
        videoCodec: null,
        audioCodec: null,
      },
      capabilities: {},
    });

    expect(result.recommended).toBeNull();
    expect(result.evaluations.map((e) => e.status)).toEqual(['unknown', 'unknown']);
  });

  it('exposes a convenience recommendation helper', () => {
    const recommendation = recommendPlaybackOption({
      options: [{ mode: 'hls', id: 'hls' }],
      media: {
        sourceVideoCodec: 'avc',
        sourceAudioCodec: null,
        videoCodec: 'avc1.640028',
        audioCodec: null,
        hasAudioTrack: false,
      },
      capabilities: {
        hlsSupported: true,
        pipelineProbe: ALL_SUPPORTED_PROBE,
      },
    });

    expect(recommendation?.option).toEqual({ mode: 'hls', id: 'hls' });
  });
});
