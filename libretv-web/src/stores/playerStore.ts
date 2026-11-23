// Libre — player UI state. Minimal on purpose: UI components own their own
// transient state; this store only holds what multiple components need to share.

import { create } from "zustand";

export interface PlayerSource {
  type: "hls" | "mp4";
  url: string;
}

interface PlayerState {
  activeSource: PlayerSource | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
}

type PlayerActions = {
  setActiveSource: (source: PlayerSource | null) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
};

export const usePlayerStore = create<PlayerState & PlayerActions>()((set) => ({
  activeSource: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  setActiveSource: (activeSource) => set({ activeSource }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
}));