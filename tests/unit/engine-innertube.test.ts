import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaysVideoEngine } from '../../src/engine.js';
import type { InnerTubePlaybackInput } from '../../src/innertube-integration.js';

class FakeVideoElement extends EventTarget {
  currentTime = 0;
  paused = false;
  buffered = { length: 0 };
  textTracks: Array<{ mode: TextTrackMode }> = [];
}

function createEngineForInnerTube() {
  const video = new FakeVideoElement();
  const engine = new PlaysVideoEngine(video as unknown as HTMLVideoElement);
  const unsafeEngine = engine as unknown as {
    loadUrl(url: string): void;
    evaluateInitialPlayback(metadata: any): any;
    dispatchPlaybackDecision(metadata: any, evaluation: any): void;
    loadInnerTube(input: InnerTubePlaybackInput): void;
  };

  return { video, unsafeEngine, engine };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('PlaysVideoEngine.loadInnerTube()', () => {
  it('selects HLS URL when available (priority 1)', () => {
    const { unsafeEngine } = createEngineForInnerTube();
    
    const loadUrlSpy = vi.spyOn(unsafeEngine, 'loadUrl').mockImplementation(() => {});
    const evaluateSpy = vi.spyOn(unsafeEngine, 'evaluateInitialPlayback').mockReturnValue({});
    const dispatchSpy = vi.spyOn(unsafeEngine, 'dispatchPlaybackDecision').mockImplementation(() => {});

    const input: InnerTubePlaybackInput = {
      manifest: {
        hlsUrl: 'https://example.com/hls.m3u8',
        dashUrl: 'https://example.com/dash.mpd',
        formats: [{ url: 'https://example.com/video.mp4', itag: 18, mimeType: 'video/mp4' }],
        adaptiveFormats: [],
      },
      contentId: 'test-video-1',
    };

    unsafeEngine.loadInnerTube(input);

    expect(loadUrlSpy).toHaveBeenCalledWith('https://example.com/hls.m3u8');
    expect(evaluateSpy).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it('falls back to DASH URL when HLS is unavailable (priority 2)', () => {
    const { unsafeEngine } = createEngineForInnerTube();
    
    const loadUrlSpy = vi.spyOn(unsafeEngine, 'loadUrl').mockImplementation(() => {});
    const evaluateSpy = vi.spyOn(unsafeEngine, 'evaluateInitialPlayback').mockReturnValue({});
    const dispatchSpy = vi.spyOn(unsafeEngine, 'dispatchPlaybackDecision').mockImplementation(() => {});

    const input: InnerTubePlaybackInput = {
      manifest: {
        hlsUrl: null,
        dashUrl: 'https://example.com/dash.mpd',
        formats: [{ url: 'https://example.com/video.mp4', itag: 18, mimeType: 'video/mp4' }],
        adaptiveFormats: [],
      },
      contentId: 'test-video-2',
    };

    unsafeEngine.loadInnerTube(input);

    expect(loadUrlSpy).toHaveBeenCalledWith('https://example.com/dash.mpd');
    expect(evaluateSpy).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it('falls back to first format URL when HLS and DASH are unavailable (priority 3)', () => {
    const { unsafeEngine } = createEngineForInnerTube();
    
    const loadUrlSpy = vi.spyOn(unsafeEngine, 'loadUrl').mockImplementation(() => {});
    const evaluateSpy = vi.spyOn(unsafeEngine, 'evaluateInitialPlayback').mockReturnValue({});
    const dispatchSpy = vi.spyOn(unsafeEngine, 'dispatchPlaybackDecision').mockImplementation(() => {});

    const input: InnerTubePlaybackInput = {
      manifest: {
        hlsUrl: null,
        dashUrl: null,
        formats: [
          { url: 'https://example.com/video-18.mp4', itag: 18, mimeType: 'video/mp4' },
          { url: 'https://example.com/video-22.mp4', itag: 22, mimeType: 'video/mp4' },
        ],
        adaptiveFormats: [],
      },
      contentId: 'test-video-3',
    };

    unsafeEngine.loadInnerTube(input);

    expect(loadUrlSpy).toHaveBeenCalledWith('https://example.com/video-18.mp4');
    expect(evaluateSpy).toHaveBeenCalled();
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it('throws exact error when no playable URL is available', () => {
    const { unsafeEngine } = createEngineForInnerTube();

    const input: InnerTubePlaybackInput = {
      manifest: {
        hlsUrl: null,
        dashUrl: null,
        formats: [],
        adaptiveFormats: [],
      },
      contentId: 'test-video-no-url',
    };

    expect(() => {
      unsafeEngine.loadInnerTube(input);
    }).toThrow(
      'No playable URL found in InnerTube manifest (no HLS, DASH, or format URLs available)',
    );
  });

  it('propagates playback metadata through dispatchPlaybackDecision', () => {
    const { unsafeEngine } = createEngineForInnerTube();
    
    const mockEvaluation = { selected: true, reason: 'direct-playback' };

    vi.spyOn(unsafeEngine, 'loadUrl').mockImplementation(() => {});
    vi.spyOn(unsafeEngine, 'evaluateInitialPlayback').mockReturnValue(mockEvaluation);
    const dispatchSpy = vi.spyOn(unsafeEngine, 'dispatchPlaybackDecision').mockImplementation(() => {});

    const input: InnerTubePlaybackInput = {
      manifest: {
        hlsUrl: 'https://example.com/hls.m3u8',
        dashUrl: null,
        formats: [],
        adaptiveFormats: [],
      },
      contentId: 'test-video-metadata',
    };

    unsafeEngine.loadInnerTube(input);

    expect(dispatchSpy).toHaveBeenCalled();
    const [, dispatchedEvaluation] = dispatchSpy.mock.calls[0];
    expect(dispatchedEvaluation).toEqual(mockEvaluation);
  });
});
