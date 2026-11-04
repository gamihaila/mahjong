// Tile model shared by the room actor and the client.
//
// Tile codes:
//   suits:  b1..b9 (bams), t1..t9 (dots), c1..c9 (craks)
//   winds:  N E S W
//   dragons: DG (green, matches bams), DR (red, matches craks),
//            DW (white/soap, matches dots)
//   honors: F (flower), J (joker)

export type Tile = string;

export const SUITS = ["b", "t", "c"] as const;
export const WINDS = ["N", "E", "S", "W"] as const;

/** Build the full 152-tile American mahjong wall, unshuffled. */
export function buildWall(): Tile[] {
  const wall: Tile[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let i = 0; i < 4; i++) wall.push(`${suit}${rank}`);
    }
  }
  for (const wind of WINDS) for (let i = 0; i < 4; i++) wall.push(wind);
  for (const dragon of ["DG", "DR", "DW"]) {
    for (let i = 0; i < 4; i++) wall.push(dragon);
  }
  for (let i = 0; i < 8; i++) wall.push("F");
  for (let i = 0; i < 8; i++) wall.push("J");
  return wall; // 108 + 16 + 12 + 8 + 8 = 152
}

/** Fisher–Yates shuffle. Server-side only: the shuffler is trusted
 *  (design decision, 2026-11-04). */
export function shuffle(tiles: Tile[]): Tile[] {
  const a = [...tiles];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SUIT_NAMES: Record<string, string> = { b: "Bam", t: "Dot", c: "Crak" };
const DRAGON_LABELS: Record<string, string> = {
  DG: "Green",
  DR: "Red",
  DW: "Soap",
};
const WIND_LABELS: Record<string, string> = {
  N: "North",
  E: "East",
  S: "South",
  W: "West",
};

/** Human-readable label for rendering and debugging. */
export function tileLabel(tile: Tile): string {
  if (tile === "F") return "Flower";
  if (tile === "J") return "Joker";
  if (DRAGON_LABELS[tile]) return DRAGON_LABELS[tile];
  if (WIND_LABELS[tile]) return WIND_LABELS[tile];
  return `${tile.slice(1)} ${SUIT_NAMES[tile[0]]}`;
}

/** Short face text for the tile component. */
export function tileFace(tile: Tile): string {
  if (tile === "F") return "🌸";
  if (tile === "J") return "J";
  if (tile === "DG") return "🐉";
  if (tile === "DR") return "🐉";
  if (tile === "DW") return "▢";
  if (WIND_LABELS[tile]) return tile;
  return tile.slice(1);
}

/** Sort key for a tidy rack: suits by rank, then winds, dragons,
 *  flowers, jokers. */
export function tileSortKey(tile: Tile): number {
  const suitOrder: Record<string, number> = { b: 0, t: 1, c: 2 };
  if (tile[0] in suitOrder && tile.length === 2) {
    return suitOrder[tile[0]] * 100 + Number(tile[1]);
  }
  const misc: Record<string, number> = {
    N: 400, E: 401, S: 402, W: 403,
    DG: 410, DR: 411, DW: 412, F: 420, J: 430,
  };
  return misc[tile] ?? 999;
}

export function sortTiles(tiles: Tile[]): Tile[] {
  return [...tiles].sort((x, y) => tileSortKey(x) - tileSortKey(y));
}
