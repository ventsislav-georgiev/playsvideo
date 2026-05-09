import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaysVideoEngine } from '../../src/engine.js';

class FakeVideoElement extends EventTarget {
  currentTime = 0;
  paused = false;
  buffered = { length: 0 };
  textTracks = { length: 0 };
}

function createEngineForHlsStartup() {
  const video = new FakeVideoElement();
  const engine = new PlaysVideoEngine(video as unknown as HTMLVideoElement);
  const hls = { startLoad: vi.fn(), stopLoad: vi.fn() };
  const unsafeEngine = engine as unknown as {
    hls: typeof hls | null;
    _hlsMediaAttached: boolean;
    _hlsManifestParsed: boolean;
    _hlsSourceOpenFired: boolean;
    _hlsLoadStarted: boolean;
    _hlsHasStartedOnce: boolean;
    _onVideoPause(): void;
    _onVideoPlay(): void;
    _onVideoSeeked(): void;
    markInternalHlsSeekTarget(target: number): void;
    setInitialStartTime(value: number | undefined): void;
    tryStartHlsLoad(reason: string): void;
    scheduleHlsSourceOpenFallback(): void;
  };

  unsafeEngine.hls = hls;
  return { video, unsafeEngine, hls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PlaysVideoEngine HLS startup', () => {
  it('waits for media attachment, manifest parsing, and sourceopen before starting at the resume position', () => {
    const { video, unsafeEngine, hls } = createEngineForHlsStartup();
    unsafeEngine.setInitialStartTime(2712.699);

    unsafeEngine.tryStartHlsLoad('initial');
    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0);

    unsafeEngine._hlsMediaAttached = true;
    unsafeEngine._hlsManifestParsed = true;
    unsafeEngine.tryStartHlsLoad('manifest');
    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0);

    unsafeEngine._hlsSourceOpenFired = true;
    unsafeEngine.tryStartHlsLoad('sourceopen');

    expect(video.currentTime).toBeCloseTo(2712.699, 3);
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(hls.startLoad).toHaveBeenCalledWith(2712.699);
    expect(unsafeEngine._hlsLoadStarted).toBe(true);

    unsafeEngine.tryStartHlsLoad('video play');
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
  });

  it('starts from hls.js default position when no resume time is configured', () => {
    const { video, unsafeEngine, hls } = createEngineForHlsStartup();
    unsafeEngine.setInitialStartTime(undefined);
    unsafeEngine._hlsMediaAttached = true;
    unsafeEngine._hlsManifestParsed = true;
    unsafeEngine._hlsSourceOpenFired = true;

    unsafeEngine.tryStartHlsLoad('sourceopen');

    expect(video.currentTime).toBe(0);
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(hls.startLoad).toHaveBeenCalledWith(-1);
  });

  it('starts after a short fallback when Safari misses sourceopen', () => {
    vi.useFakeTimers();
    const { video, unsafeEngine, hls } = createEngineForHlsStartup();
    unsafeEngine.setInitialStartTime(12.5);
    unsafeEngine._hlsMediaAttached = true;
    unsafeEngine._hlsManifestParsed = true;

    unsafeEngine.scheduleHlsSourceOpenFallback();
    unsafeEngine.tryStartHlsLoad('hls MEDIA_ATTACHED');

    expect(hls.startLoad).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(0);

    vi.advanceTimersByTime(499);
    expect(hls.startLoad).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(video.currentTime).toBeCloseTo(12.5, 3);
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(hls.startLoad).toHaveBeenCalledWith(12.5);
    expect(unsafeEngine._hlsSourceOpenFired).toBe(true);
  });

  it('uses paused seek position when Safari reports currentTime 0 before resume', () => {
    const { video, unsafeEngine, hls } = createEngineForHlsStartup();
    unsafeEngine.setInitialStartTime(1707.507);
    unsafeEngine._hlsMediaAttached = true;
    unsafeEngine._hlsManifestParsed = true;
    unsafeEngine._hlsSourceOpenFired = true;

    video.currentTime = 1707.507;
    unsafeEngine.tryStartHlsLoad('initial play');
    expect(hls.startLoad).toHaveBeenCalledWith(1707.507);

    video.paused = true;
    unsafeEngine._onVideoPause();

    video.currentTime = 1704.721;
    unsafeEngine._onVideoSeeked();

    video.currentTime = 0;
    video.paused = false;
    unsafeEngine._onVideoPlay();

    expect(video.currentTime).toBeCloseTo(1704.721, 3);
    expect(hls.startLoad).toHaveBeenCalledTimes(2);
    expect(hls.startLoad).toHaveBeenLastCalledWith(1704.721);
  });

  it('keeps HLS loading active after internal stall recovery nudges currentTime', () => {
    const { video, unsafeEngine, hls } = createEngineForHlsStartup();
    unsafeEngine.setInitialStartTime(40.04);
    unsafeEngine._hlsMediaAttached = true;
    unsafeEngine._hlsManifestParsed = true;
    unsafeEngine._hlsSourceOpenFired = true;

    video.currentTime = 40.04;
    unsafeEngine.tryStartHlsLoad('initial play');

    unsafeEngine.markInternalHlsSeekTarget(40.05);
    video.currentTime = 40.05;
    unsafeEngine._onVideoSeeked();

    expect(hls.stopLoad).not.toHaveBeenCalled();
    expect(hls.startLoad).toHaveBeenCalledTimes(1);
    expect(unsafeEngine._hlsLoadStarted).toBe(true);
  });

  it('defers automatic subtitle extraction until segment startup is delivered', () => {
    vi.useFakeTimers();
    const { unsafeEngine } = createEngineForHlsStartup();
    const postMessage = vi.fn();
    const track = { index: 0, language: 'en', codec: 'srt' };
    const engineWithSubtitles = unsafeEngine as unknown as {
      worker: { postMessage: ReturnType<typeof vi.fn> } | null;
      _phase: string;
      _subtitleTracks: typeof track[];
      _subtitleStartupReady: boolean;
      _deferredSubtitleRequest: { trackIndex: number; select: boolean } | null;
      requestSubtitleExtraction(trackIndex: number, select?: boolean): boolean;
      markSubtitleStartupReady(reason: string): void;
    };

    engineWithSubtitles.worker = { postMessage };
    engineWithSubtitles._phase = 'demuxing';
    engineWithSubtitles._subtitleTracks = [track];

    expect(engineWithSubtitles.requestSubtitleExtraction(0, true)).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    expect(engineWithSubtitles._deferredSubtitleRequest).toEqual({ trackIndex: 0, select: true });

    engineWithSubtitles.markSubtitleStartupReady('segment 0 delivered');
    expect(postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1499);
    expect(postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'subtitle-abort' });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subtitle', trackIndex: 0, seekTimeSec: 0 }),
    );
    expect(engineWithSubtitles._subtitleStartupReady).toBe(true);
  });
});
