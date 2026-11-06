import {
  CARD_2026,
  bestHands,
  findWin,
  type HandEval,
} from "../src/card";
import type { Tile } from "../src/tiles";

// The bot brain. A bot is not a cheat seat: everything it decides
// comes from the same redacted view a human at its seat receives
// (its own tiles, the public melds and discards, the live discard),
// and it plays by sending the same commands a human sends. What it
// knows about the game is the card: the evaluator in src/card.ts
// says how many tiles each hand is missing from here and which rack
// tiles serve it, and the bot simply walks downhill — keep what
// serves the nearest hands, shed the rest, call a discard when
// calling brings a hand closer.
//
// One competent level, deliberately: no difficulty noise, no
// defense (it does not yet track what opponents are collecting
// from the discard pool), no Charleston gamesmanship. Levels can
// layer on later by degrading the evaluation; the interface a bot
// plays through will not change.

export interface BotCommand {
  type: string;
  tile?: Tile;
  tiles?: Tile[];
  blind?: number;
  kind?: "pung" | "kong" | "mahjong";
  owner?: number;
  meld?: number;
  agree?: boolean;
}

/** The slice of the per-seat view the brain reads. Structurally the
 *  server's viewFor() output; the bot never sees more than this. */
export interface BotView {
  you: number;
  phase: string;
  yourTiles: Tile[];
  seats: { name: string; tileCount: number; bot: boolean }[];
  charleston: {
    step: number;
    submitted: boolean[];
  } | null;
  play: {
    turn: number;
    hasDrawn: boolean;
    melds: { kind: string; tiles: Tile[] }[][];
    window: {
      tile: Tile;
      from: number;
      claims: { seat: number; kind: string }[];
      passed: number[];
    } | null;
  } | null;
}

function countsOf(tiles: Tile[]): Map<Tile, number> {
  const m = new Map<Tile, number>();
  for (const t of tiles) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function subtract(a: Tile[], b: Tile[]): Tile[] {
  const m = countsOf(b);
  const out: Tile[] = [];
  for (const t of a) {
    const left = m.get(t) ?? 0;
    if (left > 0) m.set(t, left - 1);
    else out.push(t);
  }
  return out;
}

const SUIT_OF = (t: Tile) =>
  "btc".includes(t[0]) && t.length === 2 ? t[0] : null;
const RANK_OF = (t: Tile) => Number(t.slice(1));
const isHonor = (t: Tile) => SUIT_OF(t) === null && t !== "J" && t !== "F";

/** How many copies of each tile the bot's nearest hands want kept:
 *  the max keep multiplicity across the top few evaluations. */
function keepCounts(rack: Tile[], melds: { tiles: Tile[] }[]): Map<Tile, number> {
  const evals = bestHands(CARD_2026, rack, melds, 3);
  const want = new Map<Tile, number>();
  for (const e of evals) {
    for (const [t, n] of countsOf(e.keep)) {
      want.set(t, Math.max(want.get(t) ?? 0, n));
    }
  }
  return want;
}

/** Rack tiles ordered most disposable first. A tile is disposable
 *  when the nearest hands don't need another copy of it; among
 *  those, shed singletons before pairs, honors before suit tiles
 *  (no run potential), terminals before simples, and isolated
 *  tiles before connected ones. A joker is never disposable while
 *  anything else remains. */
function rankDisposable(rack: Tile[], melds: { tiles: Tile[] }[]): Tile[] {
  const want = keepCounts(rack, melds);
  const have = countsOf(rack);
  const spare = (t: Tile) => (have.get(t) ?? 0) - (want.get(t) ?? 0);
  const distinct = [...have.keys()].filter((t) => t !== "J");
  const score = (t: Tile): number => {
    let s = 0;
    if (spare(t) <= 0) s += 100; // a needed tile: only as a last resort
    s += Math.max(0, 3 - (have.get(t) ?? 0)) * 4; // singletons first
    if (isHonor(t)) s -= 3; // honors can't run: shed earlier
    const suit = SUIT_OF(t);
    if (suit) {
      const r = RANK_OF(t);
      if (r === 1 || r === 9) s -= 1; // terminals before simples
      const connected = rack.some(
        (o) =>
          o !== t &&
          SUIT_OF(o) === suit &&
          Math.abs(RANK_OF(o) - r) <= 2
      );
      if (!connected) s -= 2; // isolated before connected
    }
    return s;
  };
  const ordered = distinct.sort((a, b) => score(a) - score(b));
  const out: Tile[] = [];
  // Spare instances first, in tile order...
  for (const t of ordered) {
    for (let i = 0; i < spare(t); i++) out.push(t);
  }
  // ...then the wanted instances, as last-resort material.
  for (const t of ordered) {
    const wanted = Math.min(have.get(t) ?? 0, want.get(t) ?? 0);
    for (let i = 0; i < wanted; i++) out.push(t);
  }
  return out;
}

function bestMissing(rack: Tile[], melds: { tiles: Tile[] }[]): number {
  const evals: HandEval[] = bestHands(CARD_2026, rack, melds, 1);
  return evals.length > 0 ? evals[0].missing : 99;
}

/** Charleston: pass the three most disposable tiles. Bots never
 *  blind-pass in this version — passing your own three worst tiles
 *  is always legal and nearly always right. */
export function decideCharlestonPass(view: BotView): BotCommand {
  const tiles = rankDisposable(view.yourTiles, []).slice(0, 3);
  return { type: "pass", tiles, blind: 0 };
}

/** The live discard: take it when it completes the hand, or when a
 *  pung or kong with it brings the nearest hand closer.
 *  Otherwise decline. */
export function decideWindow(view: BotView): BotCommand | null {
  const p = view.play;
  if (!p || !p.window) return null;
  const w = p.window;
  const you = view.you;
  if (w.from === you) return null;
  if (w.passed.includes(you) || w.claims.some((c) => c.seat === you)) {
    return null;
  }
  const rack = view.yourTiles;
  const melds = p.melds[you] ?? [];
  if (w.tile === "J") return { type: "pass" }; // a joker discard is dead

  if (findWin(CARD_2026, [...rack, w.tile], melds)) {
    return { type: "claim", kind: "mahjong" };
  }
  const base = bestMissing(rack, melds);

  // Pung or kong: the server composes the set-aside tiles from the
  // rack (naturals first, then jokers); simulate exactly that.
  for (const kind of ["kong", "pung"] as const) {
    const need = kind === "kong" ? 3 : 2;
    const naturals = Math.min(
      rack.filter((t) => t === w.tile).length,
      need
    );
    const jokers = Math.min(
      rack.filter((t) => t === "J").length,
      need - naturals
    );
    if (naturals + jokers !== need) continue;
    const used: Tile[] = [
      ...Array(naturals).fill(w.tile),
      ...Array(jokers).fill("J"),
    ];
    const after = bestMissing(subtract(rack, used), [
      ...melds,
      { tiles: [w.tile, ...used] },
    ]);
    if (after < base) return { type: "claim", kind };
  }

  return { type: "pass" };
}

/** The bot's own turn: draw, then (with the extra tile) declare a
 *  win, swap for an exposed joker when the natural is spare, or
 *  discard the most disposable tile. The driver calls this once per
 *  obligation, so an exchange is followed — after a fresh look — by
 *  the discard. */
export function decideTurn(view: BotView): BotCommand | null {
  const p = view.play;
  if (!p || p.window || p.turn !== view.you) return null;
  const rack = view.yourTiles;
  const melds = p.melds[view.you] ?? [];
  if (!p.hasDrawn) return { type: "draw" };

  if (findWin(CARD_2026, rack, melds)) return { type: "declareMahjong" };

  // Joker exchange: trade a spare natural for an exposed joker.
  const have = countsOf(rack);
  const want = keepCounts(rack, melds);
  for (let owner = 0; owner < p.melds.length; owner++) {
    const seatMelds = p.melds[owner];
    for (let mi = 0; mi < seatMelds.length; mi++) {
      const meld = seatMelds[mi];
      if (!meld.tiles.includes("J")) continue;
      const natural = meld.tiles.find((t) => t !== "J");
      if (!natural) continue;
      if ((have.get(natural) ?? 0) > (want.get(natural) ?? 0)) {
        return { type: "exchange", owner, meld: mi, tile: natural };
      }
    }
  }

  const disposable = rankDisposable(rack, melds);
  if (disposable.length === 0) return null;
  return { type: "discard", tile: disposable[0] };
}
