import { CARD_2026_TEXT } from "./card2026";
import type { Tile } from "./tiles";

// The card as data, and the win checker.
//
// The card file (cards/2026.txt) prints each hand as colored groups:
// the ink color is a suit SLOT (same color = same suit, different
// colors = different suits), and D in a color is the dragon of that
// slot's suit. What the printed RANKS mean depends on the section
// and the hand's note: in some sections they are literal (13579,
// 369, the year hands), in others the printed digits are the shape
// of a pattern — one shared rank ("Any Like Numbers"), a run with a
// free starting point ("Any 5 Consecutive Numbers"), a pair rank
// with matching kongs, and so on. rankCandidates() below encodes
// those readings, keying off the section and note text. One known
// leniency: "opposite dragon" is checked as "a dragon that does not
// match the suit" (the slot model gives this for free), not the
// strict bams<->craks pairing.
//
// Matching: for each candidate reading of the ranks and each
// assignment of slots to the three suits, the pattern becomes
// concrete tile multisets. Exposed melds must each coincide with
// one pattern group; the remaining groups are filled from the rack,
// where jokers may substitute only inside a group of 3+ IDENTICAL
// tiles (a pung, kong, quint or sextet — never a pair, a single, a
// run, or a mixed group like 2026). The card data carries tiles
// and suits only — the public guide publishes no points and no
// concealed marks — so matching ignores both by design.

export interface CardHand {
  index: number;
  section: string;
  groups: { color: string; token: string }[];
  note: string;
  display: string; // the groups as printed, colors stripped
}

export interface WinInfo {
  section: string;
  display: string;
}

interface MeldLike {
  tiles: Tile[];
}

// ---------- parsing ----------

export function parseCard(text: string): CardHand[] {
  const hands: CardHand[] = [];
  let section = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      section = trimmed.slice(3).trim();
      continue;
    }
    const m = trimmed.match(/^(.+?)\s*::\s*(.*)$/);
    if (!m) continue;
    const groups = m[1]
      .trim()
      .split(/\s+/)
      .map((g) => ({ color: g[0], token: g.slice(1) }));
    hands.push({
      index: hands.length,
      section,
      groups,
      note: m[2],
      display: groups.map((g) => g.token).join(" "),
    });
  }
  return hands;
}

export const CARD_2026: CardHand[] = parseCard(CARD_2026_TEXT);

// ---------- abstract tiles ----------

type AbstractTile =
  | { t: "suit"; slot: number; rank: number }
  | { t: "dragon"; slot: number }
  | { t: "soap" }
  | { t: "flower" }
  | { t: "wind"; wind: string };

function slotMap(hand: CardHand): Map<string, number> {
  const map = new Map<string, number>();
  for (const g of hand.groups) {
    if (!map.has(g.color)) map.set(g.color, map.size);
  }
  return map;
}

/** Build the abstract groups for a hand under a rank reading.
 *  `rankOf(groupIdx, ch)` gives the actual rank for a digit char;
 *  '0' is always the soap, whatever the reading. */
function buildAbstract(
  hand: CardHand,
  rankOf: (groupIdx: number, ch: string) => number
): AbstractTile[][] {
  const slots = slotMap(hand);
  return hand.groups.map((g, gi) => {
    const slot = slots.get(g.color)!;
    const tiles: AbstractTile[] = [];
    for (const ch of g.token) {
      if (ch >= "1" && ch <= "9") {
        tiles.push({ t: "suit", slot, rank: rankOf(gi, ch) });
      } else if (ch === "0") {
        tiles.push({ t: "soap" });
      } else if (ch === "D") {
        tiles.push({ t: "dragon", slot });
      } else if (ch === "F") {
        tiles.push({ t: "flower" });
      } else {
        tiles.push({ t: "wind", wind: ch }); // N E S W
      }
    }
    return tiles;
  });
}

const isDigit = (ch: string) => ch >= "1" && ch <= "9";

/** A group that is 3+ copies of one digit: a kong-shaped group whose
 *  rank a "like" reading can move as one. */
function isRepeatedGroup(hand: CardHand, gi: number): boolean {
  const token = hand.groups[gi].token;
  return (
    token.length >= 3 &&
    isDigit(token[0]) &&
    [...token].every((ch) => ch === token[0])
  );
}

/** Candidate rank readings for a hand, as abstract group lists.
 *  Usually one; variable hands get one per legal value. */
function rankCandidates(hand: CardHand): AbstractTile[][][] {
  const note = hand.note;
  const literal = () => buildAbstract(hand, (_gi, ch) => Number(ch));

  if (note.includes("These Numbers Only")) return [literal()];

  // A repeated-digit kong group takes rank k as a unit; the rest of
  // the hand is literal. (2468 "2, 4, 6, or 8", the 2026 hand's
  // "Kong 2 or 6".)
  const likeKong = (domain: number[]) =>
    domain.map((k) =>
      buildAbstract(hand, (gi, ch) =>
        isRepeatedGroup(hand, gi) ? k : Number(ch)
      )
    );
  if (note.includes("Kong 2 or 6")) return likeKong([2, 6]);
  if (note.includes("2, 4, 6, or 8")) return likeKong([2, 4, 6, 8]);

  // A pair rank varies over a fixed set; the group containing every
  // rank of the set gains a second copy of the pair rank, and the
  // kongs follow it. (13579 "Pair Any Odd No.", 369 "Pair 3, 6, or 9".)
  const pairVar = (domain: number[]) =>
    domain.map((p) => {
      const slots = slotMap(hand);
      return literal().map((tiles, gi) => {
        const token = hand.groups[gi].token;
        const distinct = new Set([...token].filter(isDigit).map(Number));
        if (
          domain.every((d) => distinct.has(d)) &&
          token.length === domain.length + 1
        ) {
          // The base group: every rank of the set once, plus a
          // second copy of the pair rank.
          const slot = slots.get(hand.groups[gi].color)!;
          return [
            ...domain.map(
              (d): AbstractTile => ({ t: "suit", slot, rank: d })
            ),
            { t: "suit", slot, rank: p } as AbstractTile,
          ];
        }
        if (isRepeatedGroup(hand, gi)) {
          const slot = slots.get(hand.groups[gi].color)!;
          return tiles.map((): AbstractTile => ({ t: "suit", slot, rank: p }));
        }
        return tiles;
      });
    });
  if (hand.section === "13579" && note.includes("Pair Any Odd")) {
    return pairVar([1, 3, 5, 7, 9]);
  }
  if (hand.section === "369" && note.includes("Pair 3, 6, or 9")) {
    return pairVar([3, 6, 9]);
  }

  // Every digit in the hand is one shared rank.
  const sharedVar = (domain: number[]) =>
    domain.map((k) => buildAbstract(hand, () => k));
  if (hand.section === "ANY LIKE NUMBERS") return sharedVar([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  if (note.includes("Any Like Nos")) return sharedVar([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  if (note.includes("Any Like Odd")) return sharedVar([1, 3, 5, 7, 9]);
  if (note.includes("Any Like Even")) return sharedVar([2, 4, 6, 8]);
  if (note.includes("Any Like No")) return sharedVar([1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // Each distinct printed digit is its own free rank. (Quints:
  // "Any 2 Numbers".)
  if (note.includes("Any 2 Numbers")) {
    const digits = [
      ...new Set(hand.groups.flatMap((g) => [...g.token].filter(isDigit))),
    ];
    let combos: Map<string, number>[] = [new Map()];
    for (const d of digits) {
      const next: Map<string, number>[] = [];
      for (const combo of combos) {
        for (let k = 1; k <= 9; k++) {
          next.push(new Map(combo).set(d, k));
        }
      }
      combos = next;
    }
    return combos.map((combo) =>
      buildAbstract(hand, (_gi, ch) => combo.get(ch)!)
    );
  }

  // A run: printed digits shift by a free offset.
  if (
    note.includes("Consecutive") ||
    note.includes("Any Run") ||
    hand.section === "CONSECUTIVE RUN"
  ) {
    const maxDigit = Math.max(
      ...hand.groups.flatMap((g) => [...g.token].filter(isDigit).map(Number))
    );
    const out: AbstractTile[][][] = [];
    for (let o = 0; o + maxDigit <= 9; o++) {
      out.push(buildAbstract(hand, (_gi, ch) => Number(ch) + o));
    }
    return out;
  }

  return [literal()];
}

// ---------- matching ----------

const SUITS: Tile[] = ["b", "t", "c"];
const DRAGON_OF_SUIT: Record<string, Tile> = { b: "DG", t: "DW", c: "DR" };

function concretize(groups: AbstractTile[][], assign: Tile[]): Tile[][] {
  return groups.map((tiles) =>
    tiles.map((t) => {
      switch (t.t) {
        case "suit":
          return `${assign[t.slot]}${t.rank}`;
        case "dragon":
          return DRAGON_OF_SUIT[assign[t.slot]];
        case "soap":
          return "DW";
        case "flower":
          return "F";
        case "wind":
          return t.wind;
      }
    })
  );
}

function countsOf(tiles: Tile[]): Map<Tile, number> {
  const m = new Map<Tile, number>();
  for (const t of tiles) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Can this meld stand as exactly this pattern group? Its natural
 *  tiles must be among the group's; its jokers fill the rest. */
function meldFits(meld: MeldLike, group: Tile[]): boolean {
  if (meld.tiles.length !== group.length) return false;
  const have = countsOf(group);
  for (const t of meld.tiles) {
    if (t === "J") continue;
    const left = have.get(t) ?? 0;
    if (left === 0) return false;
    have.set(t, left - 1);
  }
  return true;
}

/** Fill the remaining pattern groups from the rack, backtracking.
 *  A group's shortfall may be covered by jokers only when the group
 *  is 3+ copies of a single tile (pung/kong/quint/sextet). */
function fillFromRack(groups: Tile[][], rack: Map<Tile, number>): boolean {
  if (groups.length === 0) return true;
  const [group, ...rest] = groups;
  const need = countsOf(group);
  let deficit = 0;
  for (const [tile, n] of need) {
    deficit += Math.max(0, n - (rack.get(tile) ?? 0));
  }
  const identical = group.every((t) => t === group[0]);
  const jokers = rack.get("J") ?? 0;
  if (deficit > 0 && !(identical && group.length >= 3)) return false;
  if (deficit > jokers) return false;
  const next = new Map(rack);
  for (const [tile, n] of need) {
    next.set(tile, (next.get(tile) ?? 0) - Math.min(n, next.get(tile) ?? 0));
  }
  if (deficit > 0) next.set("J", jokers - deficit);
  return fillFromRack(rest, next);
}

function matchGroups(groups: Tile[][], rackTiles: Tile[], melds: MeldLike[]): boolean {
  // Assign each meld to a distinct group it fits.
  const used = new Array(groups.length).fill(false);
  const assignMelds = (mi: number): boolean => {
    if (mi === melds.length) {
      const remaining = groups.filter((_, gi) => !used[gi]);
      // Most-constrained first: identical groups have joker options,
      // the rest are all-or-nothing.
      remaining.sort((a, b) => a.length - b.length);
      return fillFromRack(remaining, countsOf(rackTiles));
    }
    for (let gi = 0; gi < groups.length; gi++) {
      if (used[gi] || !meldFits(melds[mi], groups[gi])) continue;
      used[gi] = true;
      if (assignMelds(mi + 1)) return true;
      used[gi] = false;
    }
    return false;
  };
  return assignMelds(0);
}

function permutations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest, k - 1)) out.push([items[i], ...tail]);
  }
  return out;
}

/** Does this exact set of tiles (rack plus the winning tile, with
 *  any exposed melds) complete this card hand? */
export function handMatches(
  hand: CardHand,
  rackTiles: Tile[],
  melds: MeldLike[]
): boolean {
  const slotCount = slotMap(hand).size;
  const assignments = permutations(SUITS, slotCount);
  for (const candidate of rankCandidates(hand)) {
    for (const assign of assignments) {
      if (matchGroups(concretize(candidate, assign), rackTiles, melds)) {
        return true;
      }
    }
  }
  return false;
}

/** The first hand in card order that a position completes, if any. */
export function findWin(
  card: CardHand[],
  rackTiles: Tile[],
  melds: MeldLike[]
): WinInfo | null {
  for (const hand of card) {
    if (handMatches(hand, rackTiles, melds)) {
      return { section: hand.section, display: hand.display };
    }
  }
  return null;
}

// ---------- evaluation (for the bots) ----------

export interface HandEval {
  hand: CardHand;
  /** Tiles still missing to complete the hand from this position,
   *  counting jokers in the rack as filling eligible groups. */
  missing: number;
  /** The rack tiles that serve the hand under its best reading,
   *  with multiplicity. Jokers always count as kept. */
  keep: Tile[];
  /** The best reading's groups as concrete tiles — the hand as it
   *  would sit on the table. For display; the matcher and bots
   *  ignore it. */
  groups: Tile[][];
}

/** Score a position against one hand: how far it is from done, and
 *  which rack tiles are pulling weight. Mirrors the matcher's
 *  readings exactly (same candidates, same meld rule, same joker
 *  rule), but where the matcher asks "filled or not", this counts
 *  the shortfall group by group. Returns null when the hand is
 *  unreachable from here (a meld fits no group). */
export function evaluateHand(
  hand: CardHand,
  rackTiles: Tile[],
  melds: MeldLike[]
): HandEval | null {
  const slotCount = slotMap(hand).size;
  const assignments = permutations(SUITS, slotCount);
  let best: HandEval | null = null;

  for (const candidate of rankCandidates(hand)) {
    for (const assign of assignments) {
      const groups = concretize(candidate, assign);
      // Assign melds to the groups they fit, scoring each full
      // assignment; melds are few, so plain recursion suffices.
      const used = new Array(groups.length).fill(false);
      const score = (mi: number) => {
        if (mi === melds.length) {
          const rack = countsOf(rackTiles);
          let jokers = rack.get("J") ?? 0;
          const keep: Tile[] = [];
          const deficits: { n: number; eligible: boolean }[] = [];
          groups.forEach((group, gi) => {
            if (used[gi]) return;
            const need = countsOf(group);
            let deficit = 0;
            for (const [tile, n] of need) {
              const have = Math.min(n, rack.get(tile) ?? 0);
              for (let i = 0; i < have; i++) keep.push(tile);
              rack.set(tile, (rack.get(tile) ?? 0) - have);
              deficit += n - have;
            }
            const identical = group.every((t) => t === group[0]);
            deficits.push({ n: deficit, eligible: identical && group.length >= 3 });
          });
          let missing = 0;
          for (const d of deficits) {
            let n = d.n;
            if (n > 0 && d.eligible) {
              const fill = Math.min(n, jokers);
              n -= fill;
              jokers -= fill;
            }
            missing += n;
          }
          for (let i = 0; i < (countsOf(rackTiles).get("J") ?? 0); i++) {
            keep.push("J");
          }
          if (!best || missing < best.missing) best = { hand, missing, keep, groups };
          return;
        }
        for (let gi = 0; gi < groups.length; gi++) {
          if (used[gi] || !meldFits(melds[mi], groups[gi])) continue;
          used[gi] = true;
          score(mi + 1);
          used[gi] = false;
        }
      };
      score(0);
    }
  }
  return best;
}

/** The k closest hands to this position, nearest first. Ties break
 *  toward the hand that keeps more of the rack. */
export function bestHands(
  card: CardHand[],
  rackTiles: Tile[],
  melds: MeldLike[],
  k = 3
): HandEval[] {
  const evals: HandEval[] = [];
  for (const hand of card) {
    const e = evaluateHand(hand, rackTiles, melds);
    if (e) evals.push(e);
  }
  evals.sort(
    (a, b) => a.missing - b.missing || b.keep.length - a.keep.length
  );
  return evals.slice(0, k);
}
