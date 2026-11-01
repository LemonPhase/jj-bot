/**
 * Office 2D geometry (SPEC §9): a 160-unit-wide pixel room. Pure functions
 * only, so the layout for any number of bots and the walking routes are
 * unit-tested.
 *
 * Desks sit in a grid of three columns that wraps for any number of bots:
 *   row 0      the back row against the wall (monitor on top, bot in front);
 *   row 1      the front row below the table (designed as free desks);
 *   rows 2+    added below the front row, 30 units apart; the scene grows taller.
 * At least two rows are always drawn, so a small team still sits in the
 * designed room and the remaining desks show as free. Bots fill desks in
 * order, row by row, left to right. There is no special case for any count.
 */

export interface Pt {
  x: number;
  y: number;
}

export const SCENE_WIDTH = 160;
/** Height of the designed room (two desk rows). */
export const BASE_HEIGHT = 104;
export const DESK_COLUMNS = 3;
/** Left edge of each desk column. */
export const DESK_X0: readonly number[] = [58, 88, 118];
export const DESK_WIDTH = 22;
/** Vertical distance between front rows. */
export const ROW_PITCH = 30;
/** Sprites are 12 units square. */
export const SPRITE = 12;

/** The hallway in front of the back desks (SPEC §9.3 walk lane). */
export const LANE_Y = 36;
/** A clear vertical aisle left of every desk and the table. */
export const AISLE_X = 44;
/** Points at or above this y are in front of the back desks (above the table). */
const UPPER_MAX_Y = 44;

export const BOARD_SPOT: Pt = { x: 21, y: 17 };
/** SPEC §9.3 proposal: where a bot reports back to the user. */
export const TERMINAL_SPOT: Pt = { x: 132, y: 44 };
/** Anchor of the user's speech bubble, in scene units (SPEC: left 57%, top 50%). */
export const USER_BUBBLE: Pt = { x: 91.2, y: 52 };

export type DeskRow = "back" | "front";

export interface Desk2D {
  index: number;
  row: number;
  col: number;
  kind: DeskRow;
  /** Left edge of the desk. */
  x0: number;
  /** Top of the desk surface. */
  deskY: number;
  /** Where the desk's bot stands (top-left of its sprite). */
  home: Pt;
}

export interface Layout2D {
  width: number;
  height: number;
  rows: number;
  desks: Desk2D[];
}

/** Top of the desk surface for a row. */
export const deskTop = (row: number): number =>
  row === 0 ? 21 : 88 + ROW_PITCH * (row - 1);

/** The desk grid for `botCount` bots (any count, including 0). */
export function officeLayout2D(botCount: number): Layout2D {
  const rows = Math.max(2, Math.ceil(Math.max(0, botCount) / DESK_COLUMNS));
  const desks: Desk2D[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < DESK_COLUMNS; col += 1) {
      const x0 = DESK_X0[col] ?? 0;
      const deskY = deskTop(row);
      desks.push({
        index: desks.length,
        row,
        col,
        kind: row === 0 ? "back" : "front",
        x0,
        deskY,
        // Back row: in front of the desk (SPEC (x0+5, 29)). Front rows: behind it (proposal (x0+5, 74)).
        home: { x: x0 + 5, y: row === 0 ? deskY + 8 : deskY - 14 },
      });
    }
  }
  return {
    width: SCENE_WIDTH,
    height: BASE_HEIGHT + ROW_PITCH * (rows - 2),
    rows,
    desks,
  };
}

/**
 * Huddle spots around the table, in the order of the bots involved: three
 * above the table (SPEC (66,37), (79,37), (92,37)), then three below it at
 * y 68, clear of the stools, and
 * so on, nudged right on each further pass so nobody stands exactly on
 * someone else.
 */
export function huddleSpot(index: number): Pt {
  const pass = Math.floor(index / 6);
  return {
    x: 66 + 13 * (index % 3) + 4 * pass,
    y: Math.floor(index / 3) % 2 === 0 ? 37 : 68,
  };
}

/**
 * Where a visitor stands to talk to a bot at `target`: beside it, on the side
 * the visitor comes from (SPEC §9.3 proposal: home x ± 13).
 */
export function visitSpot(target: Pt, from: Pt): Pt {
  const side = from.x <= target.x ? -13 : 13;
  const x = target.x + side;
  const clamped =
    x < 0 || x > SCENE_WIDTH - SPRITE ? target.x - side : Math.round(x);
  return { x: clamped, y: target.y };
}

const isUpper = (p: Pt) => p.y <= UPPER_MAX_Y;

/**
 * A Manhattan walking route from `from` to `to`, as waypoints (excluding the
 * start). Above the table everyone uses the hallway, as designed: down to the
 * lane, along it, then to the target. Anything below the table travels along
 * its own row and up or down the aisle, so nobody walks through the table or
 * other desks.
 */
export function route2D(from: Pt, to: Pt): Pt[] {
  let points: Pt[];
  if (from.x === to.x && from.y === to.y) return [];
  if (isUpper(from) && isUpper(to)) {
    points = [
      { x: from.x, y: LANE_Y },
      { x: to.x, y: LANE_Y },
      { x: to.x, y: to.y },
    ];
  } else if (!isUpper(from) && !isUpper(to) && from.y === to.y) {
    points = [{ x: to.x, y: to.y }];
  } else {
    const fromLane = isUpper(from) ? LANE_Y : from.y;
    const toLane = isUpper(to) ? LANE_Y : to.y;
    points = [
      { x: from.x, y: fromLane },
      { x: AISLE_X, y: fromLane },
      { x: AISLE_X, y: toLane },
      { x: to.x, y: toLane },
      { x: to.x, y: to.y },
    ];
  }
  const out: Pt[] = [];
  let last = from;
  for (const p of points) {
    if (p.x === last.x && p.y === last.y) continue;
    out.push(p);
    last = p;
  }
  return out;
}

/** Total length of a route, in scene units. */
export function routeLength(from: Pt, path: readonly Pt[]): number {
  let length = 0;
  let last = from;
  for (const p of path) {
    length += Math.abs(p.x - last.x) + Math.abs(p.y - last.y);
    last = p;
  }
  return length;
}

/**
 * Where the speech bubble goes, as fractions of the scene (SPEC §9.4): at
 * the terminal for the user, under a speaker at the board, otherwise above
 * the speaker, kept inside the scene.
 */
export function bubblePlacement(
  speaker: Pt | "user",
  height: number,
): { left: number; top: number } {
  if (speaker === "user")
    return {
      left: USER_BUBBLE.x / SCENE_WIDTH,
      top: USER_BUBBLE.y / height,
    };
  if (speaker.y < 24) return { left: 0.02, top: (speaker.y + 16) / height };
  return {
    left: Math.min(Math.max((speaker.x - 4) / SCENE_WIDTH, 0.02), 0.62),
    top: Math.max((speaker.y - 21) / height, 0.02),
  };
}
