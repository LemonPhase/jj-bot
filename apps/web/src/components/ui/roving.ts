/**
 * Roving-focus keyboard model shared by Segmented (radio group) and Tabs
 * (tab list): one Tab stop for the whole group, arrows move between enabled
 * items with wrap-around, Home and End jump to the ends.
 */

/** Which arrow keys move: `horizontal` (tabs) or all four (radio groups). */
export type RovingAxis = "horizontal" | "both";

const STEP: Readonly<Record<string, Readonly<Record<RovingAxis, number>>>> = {
  ArrowRight: { horizontal: 1, both: 1 },
  ArrowDown: { horizontal: 0, both: 1 },
  ArrowLeft: { horizontal: -1, both: -1 },
  ArrowUp: { horizontal: 0, both: -1 },
};

/**
 * The index a key moves to from `from`, skipping disabled items, or null when
 * the key does nothing here.
 */
export function rovingTarget(
  disabled: readonly boolean[],
  from: number,
  key: string,
  axis: RovingAxis,
): number | null {
  const enabled = disabled
    .map((isDisabled, index) => (isDisabled ? -1 : index))
    .filter((index) => index >= 0);
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0] ?? null;
  if (key === "End") return enabled[enabled.length - 1] ?? null;
  const step = STEP[key]?.[axis] ?? 0;
  if (step === 0) return null;
  const count = disabled.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((from + step * offset) % count) + count) % count;
    if (!disabled[index]) return index;
  }
  return null;
}

/** The single Tab stop: the active item if it is enabled, else the first enabled one. */
export function rovingTabStop(
  disabled: readonly boolean[],
  activeIndex: number,
): number {
  if (activeIndex >= 0 && !disabled[activeIndex]) return activeIndex;
  return disabled.findIndex((isDisabled) => !isDisabled);
}
