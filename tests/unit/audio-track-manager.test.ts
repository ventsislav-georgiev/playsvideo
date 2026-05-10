/**
 * Audio Track Manager Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioTrackManager, SafariNativeAudioTrackManager } from '../../src/audio-track-manager.js';

describe('AudioTrackManager', () => {
  let manager: AudioTrackManager;
  let mockHls: any;
  let mockVideo: HTMLVideoElement;

  beforeEach(() => {
    manager = new AudioTrackManager({ debug: false });

    // Mock hls.js instance
    mockHls = {
      audioTracks: [
        {
          lang: 'en',
          default: true,
          attrs: { ROLE: 'main', CODECS: 'aac' },
          bitrate: 128000,
          sampleRate: 48000,
          channels: 2,
        },
        {
          lang: 'es',
          default: false,
          attrs: { ROLE: 'dub', CODECS: 'aac' },
          bitrate: 128000,
          sampleRate: 48000,
          channels: 2,
        },
        {
          lang: 'fr',
          default: false,
          attrs: { ROLE: 'dub', CODECS: 'aac' },
          bitrate: 128000,
          sampleRate: 48000,
          channels: 2,
        },
      ],
      audioTrack: 0,
      on: vi.fn(),
      off: vi.fn(),
    };

    mockVideo = document.createElement('video');
  });

  describe('initialization', () => {
    it('should initialize with hls.js and video element', () => {
      expect(() => {
        manager.initialize(mockHls, mockVideo, 'test-content-1');
      }).not.toThrow();
    });

    it('should attach hls.js event listeners', () => {
      manager.initialize(mockHls, mockVideo);
      expect(mockHls.on).toHaveBeenCalled();
    });
  });

  describe('track discovery', () => {
    beforeEach(() => {
      manager.initialize(mockHls, mockVideo);
      // Simulate manifest parsed event
      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }
    });

    it('should discover available audio tracks', () => {
      const tracks = manager.getTracks();
      expect(tracks).toHaveLength(3);
    });

    it('should extract track metadata', () => {
      const tracks = manager.getTracks();
      expect(tracks[0]).toMatchObject({
        index: 0,
        language: 'en',
        label: expect.any(String),
        isDefault: true,
      });
    });

    it('should identify default track', () => {
      const tracks = manager.getTracks();
      expect(tracks[0].isDefault).toBe(true);
      expect(tracks[1].isDefault).toBe(false);
    });

    it('should extract codec information', () => {
      const tracks = manager.getTracks();
      expect(tracks[0].codec).toBe('aac');
    });

    it('should extract bitrate and sample rate', () => {
      const tracks = manager.getTracks();
      expect(tracks[0].bitrate).toBe(128000);
      expect(tracks[0].sampleRate).toBe(48000);
      expect(tracks[0].channels).toBe(2);
    });
  });

  describe('track selection', () => {
    beforeEach(() => {
      manager.initialize(mockHls, mockVideo);
      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }
    });

    it('should select track by index', () => {
      manager.selectTrack(1);
      expect(mockHls.audioTrack).toBe(1);
    });

    it('should select track by language', () => {
      const result = manager.selectTrackByLanguage('es');
      expect(result).toBe(true);
      expect(mockHls.audioTrack).toBe(1);
    });

    it('should return false for unknown language', () => {
      const result = manager.selectTrackByLanguage('de');
      expect(result).toBe(false);
    });

    it('should reject invalid track index', () => {
      const listener = vi.fn();
      manager.on(listener);

      manager.selectTrack(999);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'track-error',
          error: expect.stringContaining('Invalid track index'),
        })
      );
    });
  });

  describe('event handling', () => {
    it('should emit tracks-available event', () => {
      const listener = vi.fn();
      manager.on(listener);
      manager.initialize(mockHls, mockVideo);

      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tracks-available',
          tracks: expect.any(Array),
        })
      );
    });

    it('should allow multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      manager.on(listener1);
      manager.on(listener2);

      manager.initialize(mockHls, mockVideo);
      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('should allow unsubscribing from events', () => {
      const listener = vi.fn();
      const unsubscribe = manager.on(listener);

      manager.initialize(mockHls, mockVideo);
      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }

      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      // Simulate another event
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }

      expect(listener).toHaveBeenCalledTimes(1); // Still 1, not 2
    });
  });

  describe('track availability', () => {
    beforeEach(() => {
      manager.initialize(mockHls, mockVideo);
      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }
    });

    it('should report availability when multiple tracks exist', () => {
      expect(manager.isAvailable()).toBe(true);
    });

    it('should report unavailability with single track', () => {
      mockHls.audioTracks = [mockHls.audioTracks[0]];
      manager.initialize(mockHls, mockVideo);

      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }

      expect(manager.isAvailable()).toBe(false);
    });
  });

  describe('language name mapping', () => {
    it('should map language codes to names', () => {
      manager.initialize(mockHls, mockVideo);
      const manifestParsedCallback = mockHls.on.mock.calls.find(
        (call: any) => call[0] === 'hlsManifestParsed'
      )?.[1];
      if (manifestParsedCallback) {
        manifestParsedCallback();
      }

      const tracks = manager.getTracks();
      expect(tracks[0].label).toContain('English');
      expect(tracks[1].label).toContain('Spanish');
      expect(tracks[2].label).toContain('French');
    });
  });

  describe('static methods', () => {
    it('should detect native HLS support', () => {
      const canPlay = AudioTrackManager.canPlayNativeHls();
      expect(typeof canPlay).toBe('boolean');
    });

    it('should detect HTML audio tracks support', () => {
      const supported = AudioTrackManager.supportsHtmlAudioTracks();
      expect(typeof supported).toBe('boolean');
    });
  });

  describe('cleanup', () => {
    it('should clean up resources on destroy', () => {
      manager.initialize(mockHls, mockVideo);
      manager.destroy();

      // After destroy, should not throw
      expect(() => {
        manager.getTracks();
      }).not.toThrow();
    });
  });
});

describe('SafariNativeAudioTrackManager', () => {
  let manager: SafariNativeAudioTrackManager;
  let mockVideo: HTMLVideoElement;

  beforeEach(() => {
    manager = new SafariNativeAudioTrackManager({ debug: false });

    // Create mock video with audioTracks
    mockVideo = document.createElement('video');
    Object.defineProperty(mockVideo, 'audioTracks', {
      value: {
        length: 2,
        0: {
          language: 'en',
          label: 'English',
          kind: 'main',
          default: true,
          enabled: true,
        },
        1: {
          language: 'es',
          label: 'Spanish',
          kind: 'dub',
          default: false,
          enabled: false,
        },
        addEventListener: vi.fn(),
      },
      writable: true,
    });
  });

  describe('initialization', () => {
    it('should initialize with video element', () => {
      expect(() => {
        manager.initialize(mockVideo, 'test-content-1');
      }).not.toThrow();
    });

    it('should detect support', () => {
      manager.initialize(mockVideo);
      expect(manager.isSupported()).toBe(true);
    });
  });

  describe('track discovery', () => {
    beforeEach(() => {
      manager.initialize(mockVideo);
    });

    it('should discover audio tracks', () => {
      const tracks = manager.getTracks();
      expect(tracks).toHaveLength(2);
    });

    it('should extract track metadata', () => {
      const tracks = manager.getTracks();
      expect(tracks[0]).toMatchObject({
        index: 0,
        language: 'en',
        label: 'English',
      });
    });
  });

  describe('track selection', () => {
    beforeEach(() => {
      manager.initialize(mockVideo);
    });

    it('should select track by index', () => {
      manager.selectTrack(1);
      expect((mockVideo as any).audioTracks![1].enabled).toBe(true);
      expect((mockVideo as any).audioTracks![0].enabled).toBe(false);
    });

    it('should get selected track index', () => {
      manager.selectTrack(1);
      expect(manager.getSelectedTrackIndex()).toBe(1);
    });
  });

  describe('availability', () => {
    beforeEach(() => {
      manager.initialize(mockVideo);
    });

    it('should report availability with multiple tracks', () => {
      expect(manager.isAvailable()).toBe(true);
    });
  });
});
