import type { Beat } from "./beats";

/** Playback progress a view reports to the shared Office controls. */
export interface OfficeStatus {
  /** 1-based number of the beat on stage, or the last one played (0 before any). */
  step: number;
  /** Beats in this run, including ones that arrived live. */
  total: number;
  /** The beat being acted out, or null between runs. */
  currentId: string | null;
  /** Re-acting earlier events rather than following new ones. */
  replaying: boolean;
  /** Beats waiting to be acted out, including the one on stage. */
  pending: number;
  /** 3D only: the camera follows whoever is speaking. */
  following: boolean;
}

export const IDLE_STATUS: OfficeStatus = {
  step: 0,
  total: 0,
  currentId: null,
  replaying: false,
  pending: 0,
  following: true,
};

/** Commands the Office controls send to the active view. */
export interface OfficeViewHandle {
  /** Restart from the desks and act out these beats in order. */
  replay: (beats: Beat[]) => void;
  setFollow?: (on: boolean) => void;
  resetView?: () => void;
}

/** Speeds the speed pill cycles through (SPEC §5.4). */
export const SPEEDS = [1, 2, 3] as const;
export type Speed = (typeof SPEEDS)[number];

export const nextSpeed = (speed: Speed): Speed =>
  SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length] ?? 1;

export type OfficeMode = "2d" | "3d";

export const OFFICE_MODE_KEY = "jj.officeMode";

/** The remembered 2D/3D choice, or `fallback` when none is stored or storage throws. */
export function readOfficeMode(
  fallback: OfficeMode,
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): OfficeMode {
  try {
    const value = storage?.getItem(OFFICE_MODE_KEY);
    return value === "2d" || value === "3d" ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Remembers the 2D/3D choice. Returns false when storage is unavailable or refuses. */
export function writeOfficeMode(
  mode: OfficeMode,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(OFFICE_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
