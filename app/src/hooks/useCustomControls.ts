import type { RefObject } from 'react';
import { useEffect } from 'react';
import type { CustomControlsOptions } from '../../../src/custom-controls.js';
import { createCustomControls } from '../../../src/custom-controls.js';

export interface UseCustomControlsOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  container: HTMLElement | null;
  enabled: boolean;
  // Phase 2c: Subtitle seeking
  onSubtitleSeek?: (trackIndex: number, targetTimeSec: number) => Promise<void>;
  subtitleSeekingCapability?: CustomControlsOptions['subtitleSeekingCapability'];
  subtitleSeekingStatus?: string;
}

export function useCustomControls({
  videoRef,
  container,
  enabled,
  onSubtitleSeek,
  subtitleSeekingCapability,
  subtitleSeekingStatus,
}: UseCustomControlsOptions) {
  useEffect(() => {
    if (!enabled || !videoRef.current || !container) return;
    const handle = createCustomControls({
      video: videoRef.current,
      container,
      // Phase 2c: Pass seeking options
      onSubtitleSeek,
      subtitleSeekingCapability,
      subtitleSeekingStatus,
    });
    return () => handle.destroy();
  }, [enabled, videoRef, container, onSubtitleSeek, subtitleSeekingCapability, subtitleSeekingStatus]);
}
