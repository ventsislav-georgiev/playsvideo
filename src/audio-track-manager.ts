/**
 * Audio Track Manager for PlaysVideoEngine
 * 
 * Handles audio track selection across:
 * - hls.js (MSE playback)
 * - Shaka Player (MSE fallback)
 * - Safari native HLS (limited support)
 * 
 * Provides:
 * - Track discovery and metadata
 * - User selection persistence
 * - Event-driven UI updates
 * - Capability detection
 */

import Hls from 'hls.js';

export interface AudioTrackInfo {
  /** Unique track index */
  index: number;
  /** Language code (e.g., 'en', 'es', 'ja') */
  language: string;
  /** Human-readable label (e.g., 'English', 'Spanish (Spain)') */
  label: string;
  /** Track role/purpose (e.g., 'main', 'alternate', 'commentary', 'dub') */
  role?: string;
  /** Whether this is the default track */
  isDefault: boolean;
  /** Whether this track is currently selected */
  isSelected: boolean;
  /** Codec information */
  codec?: string;
  /** Bitrate in bps (if available) */
  bitrate?: number;
  /** Sample rate in Hz (if available) */
  sampleRate?: number;
  /** Number of channels */
  channels?: number;
}

export interface AudioTrackManagerConfig {
  /** Storage key prefix for persisted selection */
  storageKeyPrefix?: string;
  /** Enable debug logging */
  debug?: boolean;
}

export interface AudioTrackSelectionEvent {
  type: 'tracks-available' | 'track-switched' | 'track-error';
  tracks?: AudioTrackInfo[];
  selectedIndex?: number;
  selectedTrack?: AudioTrackInfo;
  error?: string;
}

type AudioTrackEventListener = (event: AudioTrackSelectionEvent) => void;

/**
 * Manages audio track selection for hls.js playback
 */
export class AudioTrackManager {
  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private currentTracks: AudioTrackInfo[] = [];
  private selectedTrackIndex: number | null = null;
  private listeners: Set<AudioTrackEventListener> = new Set();
  private config: Required<AudioTrackManagerConfig>;
  private contentId: string | null = null;

  constructor(config: AudioTrackManagerConfig = {}) {
    this.config = {
      storageKeyPrefix: 'bookplay_audio_track',
      debug: false,
      ...config,
    };
  }

  /**
   * Initialize the audio track manager with hls.js instance and video element
   */
  initialize(hls: Hls, video: HTMLVideoElement, contentId?: string): void {
    this.hls = hls;
    this.video = video;
    this.contentId = contentId || null;

    this.attachHlsListeners();
    this.log('AudioTrackManager initialized');
  }

  /**
   * Attach listeners to hls.js events
   */
  private attachHlsListeners(): void {
    if (!this.hls) return;

    // When manifest is parsed, discover available audio tracks
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.discoverTracks();
    });

    // When audio track is switched
    this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHING, () => {
      this.onTrackSwitching();
    });

    // When audio track is switched (completed)
    this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => {
      this.onTrackSwitched();
    });
  }

  /**
   * Discover available audio tracks from hls.js
   */
  private discoverTracks(): void {
    if (!this.hls) return;

    const hlsTracks = this.hls.audioTracks || [];
    this.currentTracks = hlsTracks.map((track, index) => ({
      index,
      language: track.lang || 'unknown',
      label: this.buildTrackLabel(track),
      role: track.attrs?.['ROLE'] || undefined,
      isDefault: track.default || false,
      isSelected: index === this.hls!.audioTrack,
      codec: track.attrs?.['CODECS'] || undefined,
      bitrate: track.bitrate || undefined,
      sampleRate: (track as any).sampleRate || undefined,
      channels: typeof track.channels === 'number' ? track.channels : undefined,
    }));

    this.log(`Discovered ${this.currentTracks.length} audio tracks`);

    // Try to restore user's previous selection
    this.restoreUserSelection();

    // Notify listeners
    this.emit({ type: 'tracks-available', tracks: this.currentTracks, selectedIndex: this.selectedTrackIndex ?? this.hls!.audioTrack });
  }

  /**
   * Build human-readable label for a track
   */
  private buildTrackLabel(track: any): string {
    const parts: string[] = [];

    // Language name
    if (track.lang) {
      const langName = this.getLanguageName(track.lang);
      parts.push(langName);
    }

    // Role/purpose
    const role = track.attrs?.['ROLE'];
    if (role && role !== 'main') {
      parts.push(`(${role})`);
    }

    // Fallback
    if (parts.length === 0) {
      parts.push(`Track ${track.index || 'unknown'}`);
    }

    return parts.join(' ');
  }

  /**
   * Get human-readable language name from language code
   */
  private getLanguageName(code: string): string {
    const names: Record<string, string> = {
      en: 'English',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
      it: 'Italian',
      pt: 'Portuguese',
      ru: 'Russian',
      ja: 'Japanese',
      zh: 'Chinese',
      ko: 'Korean',
      ar: 'Arabic',
      hi: 'Hindi',
      th: 'Thai',
      vi: 'Vietnamese',
      pl: 'Polish',
      tr: 'Turkish',
      nl: 'Dutch',
      sv: 'Swedish',
      no: 'Norwegian',
      da: 'Danish',
      fi: 'Finnish',
      el: 'Greek',
      he: 'Hebrew',
      hu: 'Hungarian',
      cs: 'Czech',
      ro: 'Romanian',
      uk: 'Ukrainian',
    };

    return names[code] || code.toUpperCase();
  }

  /**
   * Select an audio track by index
   */
  selectTrack(index: number): void {
    if (!this.hls) {
      this.log(`Cannot select track: hls.js not initialized`);
      return;
    }

    if (index < 0 || index >= this.currentTracks.length) {
      this.emit({
        type: 'track-error',
        error: `Invalid track index: ${index}`,
      });
      return;
    }

    this.log(`Selecting audio track ${index}`);
    this.hls.audioTrack = index;
    this.selectedTrackIndex = index;

    // Persist selection
    this.persistUserSelection(index);
  }

  /**
   * Select an audio track by language code
   */
  selectTrackByLanguage(languageCode: string): boolean {
    const track = this.currentTracks.find(
      (t) => t.language.toLowerCase() === languageCode.toLowerCase()
    );

    if (!track) {
      this.log(`No track found for language: ${languageCode}`);
      return false;
    }

    this.selectTrack(track.index);
    return true;
  }

  /**
   * Get all available audio tracks
   */
  getTracks(): AudioTrackInfo[] {
    return [...this.currentTracks];
  }

  /**
   * Get currently selected track
   */
  getSelectedTrack(): AudioTrackInfo | null {
    if (this.selectedTrackIndex === null) return null;
    return this.currentTracks[this.selectedTrackIndex] || null;
  }

  /**
   * Get currently selected track index
   */
  getSelectedTrackIndex(): number {
    return this.selectedTrackIndex ?? (this.hls?.audioTrack ?? 0);
  }

  /**
   * Check if audio track selection is available
   */
  isAvailable(): boolean {
    return this.currentTracks.length > 1;
  }

  /**
   * Listen for audio track changes
   */
  on(listener: AudioTrackEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: AudioTrackSelectionEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in audio track listener:', error);
      }
    });
  }

  /**
   * Handle track switching start
   */
  private onTrackSwitching(): void {
    this.log('Audio track switching...');
  }

  /**
   * Handle track switched completion
   */
  private onTrackSwitched(): void {
    if (!this.hls) return;

    const newIndex = this.hls.audioTrack;
    this.selectedTrackIndex = newIndex;

    this.log(`Audio track switched to ${newIndex}`);

    this.emit({
      type: 'track-switched',
      selectedIndex: newIndex,
      tracks: this.currentTracks,
    });
  }

  /**
   * Persist user's track selection to localStorage
   */
  private persistUserSelection(index: number): void {
    if (!this.contentId) return;

    try {
      const key = `${this.config.storageKeyPrefix}_${this.contentId}`;
      localStorage.setItem(key, String(index));
      this.log(`Persisted track selection: ${key} = ${index}`);
    } catch (error) {
      this.log(`Failed to persist track selection: ${error}`);
    }
  }

  /**
   * Restore user's previous track selection from localStorage
   */
  private restoreUserSelection(): void {
    if (!this.contentId || !this.hls) return;

    try {
      const key = `${this.config.storageKeyPrefix}_${this.contentId}`;
      const stored = localStorage.getItem(key);

      if (stored !== null) {
        const index = parseInt(stored, 10);
        if (index >= 0 && index < this.currentTracks.length) {
          this.log(`Restoring track selection: ${key} = ${index}`);
          this.hls.audioTrack = index;
          this.selectedTrackIndex = index;
        }
      }
    } catch (error) {
      this.log(`Failed to restore track selection: ${error}`);
    }
  }

  /**
   * Detect Safari native HLS support
   */
  static canPlayNativeHls(): boolean {
    const video = document.createElement('video');
    return (
      video.canPlayType('application/vnd.apple.mpegurl') === 'probably' ||
      video.canPlayType('application/vnd.apple.mpegurl') === 'maybe'
    );
  }

  /**
   * Detect if browser supports audio track selection via HTMLMediaElement
   */
  static supportsHtmlAudioTracks(): boolean {
    const video = document.createElement('video');
    return 'audioTracks' in video && (video as any).audioTracks !== undefined;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.listeners.clear();
    this.hls = null;
    this.video = null;
    this.currentTracks = [];
    this.selectedTrackIndex = null;
  }

  /**
   * Debug logging
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[AudioTrackManager] ${message}`);
    }
  }
}

/**
 * Safari native HLS audio track manager
 * 
 * Limited support: Safari native HLS playback has constraints on audio track selection.
 * This manager provides best-effort support via HTMLMediaElement.audioTracks API.
 */
export class SafariNativeAudioTrackManager {
  private video: HTMLVideoElement | null = null;
  private listeners: Set<AudioTrackEventListener> = new Set();
  private config: Required<AudioTrackManagerConfig>;
  private contentId: string | null = null;

  constructor(config: AudioTrackManagerConfig = {}) {
    this.config = {
      storageKeyPrefix: 'bookplay_audio_track',
      debug: false,
      ...config,
    };
  }

  /**
   * Initialize with video element
   */
  initialize(video: HTMLVideoElement, contentId?: string): void {
    this.video = video;
    this.contentId = contentId || null;

    if (!this.isSupported()) {
      this.log('HTMLMediaElement.audioTracks not supported');
      return;
    }

    this.attachVideoListeners();
    this.log('SafariNativeAudioTrackManager initialized');
  }

  /**
   * Check if HTMLMediaElement.audioTracks is supported
   */
  isSupported(): boolean {
    return this.video !== null && 'audioTracks' in (this.video as any) && (this.video as any).audioTracks !== undefined;
  }

  /**
   * Attach listeners to video element
   */
  private attachVideoListeners(): void {
    if (!(this.video as any)?.audioTracks) return;

    // Listen for audio track changes
    (this.video as any).audioTracks.addEventListener('change', () => {
      this.onTracksChanged();
    });

    // Initial discovery
    this.discoverTracks();
  }

  /**
   * Discover available audio tracks
   */
  private discoverTracks(): void {
    if (!(this.video as any)?.audioTracks) return;

    const tracks: AudioTrackInfo[] = [];
    for (let i = 0; i < (this.video as any).audioTracks.length; i++) {
      const track = (this.video as any).audioTracks[i];
      tracks.push({
        index: i,
        language: track.language || 'unknown',
        label: track.label || `Track ${i + 1}`,
        role: track.kind || undefined,
        isDefault: track.default || false,
        isSelected: track.enabled,
      });
    }

    this.log(`Discovered ${tracks.length} audio tracks`);

    // Restore user selection
    this.restoreUserSelection();

    this.emit({
      type: 'tracks-available',
      tracks,
      selectedIndex: this.getSelectedTrackIndex(),
    });
  }

  /**
   * Select an audio track by index
   */
  selectTrack(index: number): void {
    if (!(this.video as any)?.audioTracks) {
      this.log('audioTracks not available');
      return;
    }

    if (index < 0 || index >= (this.video as any).audioTracks.length) {
      this.emit({
        type: 'track-error',
        error: `Invalid track index: ${index}`,
      });
      return;
    }

    // Disable all tracks
    for (let i = 0; i < (this.video as any).audioTracks.length; i++) {
      (this.video as any).audioTracks[i].enabled = false;
    }

    // Enable selected track
    (this.video as any).audioTracks[index].enabled = true;
    this.persistUserSelection(index);

    this.log(`Selected audio track ${index}`);
  }

  /**
   * Get all available audio tracks
   */
  getTracks(): AudioTrackInfo[] {
    if (!(this.video as any)?.audioTracks) return [];

    const tracks: AudioTrackInfo[] = [];
    for (let i = 0; i < (this.video as any).audioTracks.length; i++) {
      const track = (this.video as any).audioTracks[i];
      tracks.push({
        index: i,
        language: track.language || 'unknown',
        label: track.label || `Track ${i + 1}`,
        role: track.kind || undefined,
        isDefault: track.default || false,
        isSelected: track.enabled,
      });
    }
    return tracks;
  }

  /**
   * Get currently selected track index
   */
  getSelectedTrackIndex(): number {
    if (!(this.video as any)?.audioTracks) return 0;

    for (let i = 0; i < (this.video as any).audioTracks.length; i++) {
      if ((this.video as any).audioTracks[i].enabled) {
        return i;
      }
    }
    return 0;
  }

  /**
   * Check if audio track selection is available
   */
  isAvailable(): boolean {
    return ((this.video as any)?.audioTracks?.length ?? 0) > 1;
  }

  /**
   * Listen for audio track changes
   */
  on(listener: AudioTrackEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Emit event to all listeners
   */
  private emit(event: AudioTrackSelectionEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in audio track listener:', error);
      }
    });
  }

  /**
   * Handle audio track change
   */
  private onTracksChanged(): void {
    this.log('Audio tracks changed');
    this.emit({
      type: 'track-switched',
      selectedIndex: this.getSelectedTrackIndex(),
      tracks: this.getTracks(),
    });
  }

  /**
   * Persist user's track selection
   */
  private persistUserSelection(index: number): void {
    if (!this.contentId) return;

    try {
      const key = `${this.config.storageKeyPrefix}_${this.contentId}`;
      localStorage.setItem(key, String(index));
      this.log(`Persisted track selection: ${key} = ${index}`);
    } catch (error) {
      this.log(`Failed to persist track selection: ${error}`);
    }
  }

  /**
   * Restore user's previous track selection
   */
  private restoreUserSelection(): void {
    if (!this.contentId) return;

    try {
      const key = `${this.config.storageKeyPrefix}_${this.contentId}`;
      const stored = localStorage.getItem(key);

      if (stored !== null) {
        const index = parseInt(stored, 10);
        if (index >= 0 && index < ((this.video as any)?.audioTracks?.length ?? 0)) {
          this.log(`Restoring track selection: ${key} = ${index}`);
          this.selectTrack(index);
        }
      }
    } catch (error) {
      this.log(`Failed to restore track selection: ${error}`);
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.listeners.clear();
    this.video = null;
  }

  /**
   * Debug logging
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[SafariNativeAudioTrackManager] ${message}`);
    }
  }
}
