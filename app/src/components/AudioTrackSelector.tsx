/**
 * Audio Track Selector Component
 * 
 * Provides UI for selecting audio tracks during playback.
 * Integrates with AudioTrackManager for hls.js playback.
 */

import React, { useEffect, useState, useCallback } from 'react';
import type { AudioTrackInfo, AudioTrackSelectionEvent } from '../../../src/audio-track-manager';
import { AudioTrackManager } from '../../../src/audio-track-manager';

export interface AudioTrackSelectorProps {
  /** Audio track manager instance */
  manager: AudioTrackManager | null;
  /** CSS class name */
  className?: string;
  /** Show label */
  showLabel?: boolean;
}

/**
 * Audio track selector dropdown component
 */
export const AudioTrackSelector: React.FC<AudioTrackSelectorProps> = ({
  manager,
  className = '',
  showLabel = true,
}) => {
  const [tracks, setTracks] = useState<AudioTrackInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [isAvailable, setIsAvailable] = useState(false);

  // Listen for track changes
  useEffect(() => {
    if (!manager) return;

    const handleTrackEvent = (event: AudioTrackSelectionEvent) => {
      if (event.type === 'tracks-available') {
        setTracks(event.tracks || []);
        setSelectedIndex(event.selectedIndex ?? 0);
        setIsAvailable(event.tracks ? event.tracks.length > 1 : false);
      } else if (event.type === 'track-switched') {
        setSelectedIndex(event.selectedIndex ?? 0);
      }
    };

    const unsubscribe = manager.on(handleTrackEvent);
    return () => unsubscribe();
  }, [manager]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const index = parseInt(e.target.value, 10);
      manager?.selectTrack(index);
    },
    [manager]
  );

  // Hide if only one track or not available
  if (!isAvailable || tracks.length <= 1) {
    return null;
  }

  return (
    <div className={`audio-track-selector ${className}`}>
      {showLabel && <label htmlFor="audio-track-select">Audio Track:</label>}
      <select
        id="audio-track-select"
        value={selectedIndex}
        onChange={handleChange}
        className="audio-track-select"
      >
        {tracks.map((track) => (
          <option key={track.index} value={track.index}>
            {track.label}
            {track.isDefault ? ' (Default)' : ''}
            {track.role ? ` - ${track.role}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
};

export default AudioTrackSelector;
