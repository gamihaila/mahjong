import type { Tile } from "./tiles";

// The rack is a slot board: 24 fixed positions in three rows of
// eight, shared by the live game (App.tsx) and the drill room's
// Move lab (Drills.tsx). A tile occupies a slot; an empty slot is
// a space between groups — a position the player chose to leave,
// not a decoration. Everything in this file is presentation
// logic: pure functions over slot arrays. No game state, no
// storage, nothing sent anywhere.

export const SLOT_COUNT = 24;

/** Move slots[s] so it lands at slots[t], George's rule: the
 *  tiles from t on shift one slot right into the nearest empty
 *  slot to make room (if there is no empty slot to the right,
 *  the tiles shift left into the nearest one on that side
 *  instead). Tapping an empty t is a plain move. Anything else —
 *  same slot, empty source — returns the rack unchanged. */
export function clickMove<T>(
  slots: (T | null)[],
  s: number,
  t: number
): (T | null)[] {
  if (s === t || s < 0 || t < 0 || s >= slots.length || t >= slots.length)
    return slots;
  const held = slots[s];
  if (held === null) return slots;
  const next = [...slots];
  next[s] = null;
  if (slots[t] === null) {
    next[t] = held;
    return next;
  }
  for (let e = t + 1; e < next.length; e++) {
    if (next[e] === null) {
      for (let i = e; i > t; i--) next[i] = next[i - 1];
      next[t] = held;
      return next;
    }
  }
  for (let l = t - 1; l >= 0; l--) {
    if (next[l] === null) {
      for (let i = l; i < t; i++) next[i] = next[i + 1];
      next[t] = held;
      return next;
    }
  }
  return slots;
}

/** Close every gap, preserving the tiles' order. Deliberately
 *  not a sort: the player's grouping may be strategic, and
 *  compacting must never second-guess it. */
export function compactSlots<T>(slots: (T | null)[]): (T | null)[] {
  const kept = slots.filter((x) => x !== null);
  return Array.from({ length: slots.length }, (_, i) => kept[i] ?? null);
}

export interface RackSlot {
  id: number;
  tile: Tile;
}

export type RackSlots = (RackSlot | null)[];

/** Fold the slot board into the rack the server reports. A slot
 *  keeps its tile while the tile is still in the rack (tiles of a
 *  kind are fungible, so the match is by count); a tile that
 *  leaves empties its slot, and the tiles around it do not move.
 *  A tile that arrives is placed in the first empty slot past
 *  your last tile — never inside a group you spaced out — falling
 *  back to the first empty slot anywhere if the tail is full. */
export function foldSlots(
  prev: RackSlots,
  base: Tile[],
  mint: () => number
): RackSlots {
  const counts = new Map<Tile, number>();
  base.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
  const out: RackSlots = Array.from({ length: SLOT_COUNT }, (_, i) => {
    const entry = prev[i] ?? null;
    if (!entry) return null;
    const n = counts.get(entry.tile) ?? 0;
    if (n > 0) {
      counts.set(entry.tile, n - 1);
      return entry;
    }
    return null;
  });
  const place = (tile: Tile) => {
    let last = -1;
    out.forEach((e, i) => {
      if (e) last = i;
    });
    let target = -1;
    for (let i = last + 1; i < out.length; i++)
      if (!out[i]) {
        target = i;
        break;
      }
    if (target < 0)
      for (let i = 0; i < out.length; i++)
        if (!out[i]) {
          target = i;
          break;
        }
    if (target >= 0) out[target] = { id: mint(), tile };
  };
  base.forEach((t) => {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      counts.set(t, n - 1);
      place(t);
    }
  });
  return out;
}

export type RackCell =
  | { kind: "tile"; id: number; tile: Tile; baseIdx: number }
  | { kind: "empty" }
  | { kind: "facedown" };

/** Produce the 24 display cells for the current view: board
 *  order, each tile annotated with its index in the server's rack
 *  order (baseIdx), so selection state keeps speaking in server
 *  indices. A fresh view can arrive a beat before the fold runs,
 *  so a base tile not yet placed is shown in the first empty slot
 *  rather than vanishing for a frame, and a slot whose tile just
 *  left shows empty until the fold catches up. Face-down extras
 *  (your escrowed draw, blind-pass tiles) sit just past your last
 *  tile. */
export function displaySlots(
  slots: RackSlots,
  base: Tile[],
  facedown = 0
): RackCell[] {
  const queues = new Map<Tile, number[]>();
  base.forEach((t, i) => {
    const q = queues.get(t);
    if (q) q.push(i);
    else queues.set(t, [i]);
  });
  const used = new Set<number>();
  const cells: RackCell[] = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    const entry = slots[s] ?? null;
    const q = entry ? queues.get(entry.tile) : undefined;
    if (entry && q && q.length > 0) {
      const baseIdx = q.shift()!;
      used.add(baseIdx);
      cells.push({ kind: "tile", id: entry.id, tile: entry.tile, baseIdx });
    } else {
      cells.push({ kind: "empty" });
    }
  }
  base.forEach((t, i) => {
    if (used.has(i)) return;
    const at = cells.findIndex((c) => c.kind === "empty");
    if (at >= 0)
      cells[at] = { kind: "tile", id: -1 - i, tile: t, baseIdx: i };
  });
  let remaining = facedown;
  if (remaining > 0) {
    let lastTile = -1;
    cells.forEach((c, i) => {
      if (c.kind === "tile") lastTile = i;
    });
    for (let i = lastTile + 1; i < cells.length && remaining > 0; i++) {
      if (cells[i].kind === "empty") {
        cells[i] = { kind: "facedown" };
        remaining--;
      }
    }
    for (let i = 0; i < cells.length && remaining > 0; i++) {
      if (cells[i].kind === "empty") {
        cells[i] = { kind: "facedown" };
        remaining--;
      }
    }
  }
  return cells;
}
