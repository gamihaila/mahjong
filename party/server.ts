/// <reference types="@cloudflare/workers-types" />
import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
} from "partyserver";
import { buildWall, shuffle, sortTiles, type Tile } from "../src/tiles";

// The room actor, on PartyServer (the PartyKit successor: same Durable
// Object actor model, deployed with wrangler to our own Cloudflare
// account). Slices 1-2 of the design in DESIGN.md:
// - One room = one Durable Object = a single-threaded actor. Every
//   command is serialized through onMessage, so the game has a total
//   order of events by construction.
// - Event-sourced: clients send commands, never state. A legal command
//   appends an event to the log; state is the fold of that log (kept
//   materialized, snapshotted into the object's storage).
// - Redaction: the full state (wall, all racks, escrowed passes) never
//   leaves this object. Each connection receives a per-seat view.
// - Commands carry a client-generated id (deduplicated: at-least-once
//   delivery, exactly-once effect) and the state version the client
//   acted on (CAS: a mismatch is answered with "stale" + fresh view).
// - Seats are reclaimed across reconnects with a seat token.
// - The Charleston is an escrow barrier (design decision, 2026-11-04):
//   all passes for a step are held hidden and unapplied until the last
//   one arrives, then applied atomically. No timeouts; the only escape
//   from a stalled Charleston is a unanimous vote to void the hand.
//   Passes are amendable while they sit in escrow.

type Phase = "lobby" | "charleston" | "ready";

interface Seat {
  name: string;
  token: string;
  connected: boolean;
}

interface GameEvent {
  seq: number;
  type: string;
  seat?: number;
  detail?: string;
}

/** One seat's escrowed pass: tiles chosen from their own rack, plus a
 *  count of "blind" tiles to forward sight-unseen from the incoming
 *  pass (only on the last pass of each Charleston). */
interface PassSubmission {
  tiles: Tile[];
  blind: number;
}

interface CharlestonState {
  step: number; // 0..5
  stepStartedAt: number; // epoch ms; drives the waiting display
  passes: (PassSubmission | null)[]; // per seat, escrowed until the barrier trips
  voidFrom: number | null; // seat proposing to void the hand
  voidAgree: boolean[]; // per seat; the proposer counts as agreeing
}

interface GameState {
  phase: Phase;
  seats: Seat[];
  hands: Tile[][];
  wall: Tile[];
  charleston: CharlestonState | null;
  version: number;
  log: GameEvent[];
  processedIds: string[];
}

interface Command {
  id: string;
  baseVersion: number;
  type: string;
  tiles?: Tile[];
  blind?: number;
  agree?: boolean;
}

interface Env {
  Mahjong: DurableObjectNamespace<Mahjong>;
}

type ConnState = { seat: number };
type Conn = Connection<ConnState>;

const MAX_SEATS = 4;
const PROCESSED_CAP = 200;

// Charleston geometry. Seats sit in turn order (0=East, 1=South,
// 2=West, 3=North). A player facing the center has the previous seat
// in turn order on their right (East's right hand points at North),
// so with N seats: right = +(N-1), over = +N/2, left = +1 (mod N).
// Steps: first Charleston right/over/left, second left/over/right.
// "Over" with 2 seats degenerates to the other player; with 3 seats
// there is no true "across", so it lands on the left neighbor — a
// rehearsal-mode compromise until bots fill real tables to four.
const STEP_DIRECTIONS = ["right", "over", "left", "left", "over", "right"] as const;
const BLIND_STEPS = new Set([2, 5]); // last pass of each Charleston

function stepOffset(step: number, n: number): number {
  const dir = STEP_DIRECTIONS[step];
  if (dir === "right") return n - 1;
  if (dir === "over") return Math.floor(n / 2);
  return 1; // left
}

function freshCharleston(n: number): CharlestonState {
  return {
    step: 0,
    stepStartedAt: Date.now(),
    passes: Array(n).fill(null),
    voidFrom: null,
    voidAgree: Array(n).fill(false),
  };
}

function freshState(): GameState {
  return {
    phase: "lobby",
    seats: [],
    hands: [],
    wall: [],
    charleston: null,
    version: 0,
    log: [],
    processedIds: [],
  };
}

/** Multiset helpers: tiles repeat, so rack arithmetic is by counts. */
function counts(tiles: Tile[]): Map<Tile, number> {
  const m = new Map<Tile, number>();
  for (const t of tiles) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function containsAll(haystack: Tile[], needle: Tile[]): boolean {
  const m = counts(haystack);
  for (const t of needle) {
    const left = m.get(t) ?? 0;
    if (left === 0) return false;
    m.set(t, left - 1);
  }
  return true;
}

/** a minus b as multisets. Assumes b is contained in a. */
function subtract(a: Tile[], b: Tile[]): Tile[] {
  const m = counts(b);
  const out: Tile[] = [];
  for (const t of a) {
    const left = m.get(t) ?? 0;
    if (left > 0) m.set(t, left - 1);
    else out.push(t);
  }
  return out;
}

export class Mahjong extends Server<Env> {
  static options = { hibernate: true };

  state: GameState = freshState();

  async onStart() {
    const saved = await this.ctx.storage.get<GameState>("state");
    if (saved) this.state = saved;
  }

  async persist() {
    await this.ctx.storage.put("state", this.state);
  }

  /** The redacted projection for one seat. This is the ONLY game data
   *  a client ever receives: own tiles (minus your own escrowed pass,
   *  which is reported separately), everyone else's counts, and for
   *  the Charleston only whether each seat has submitted — never what
   *  anyone passed. */
  viewFor(seatIdx: number) {
    const s = this.state;
    const c = s.phase === "charleston" ? s.charleston : null;
    const myPass = c && seatIdx >= 0 ? c.passes[seatIdx] : null;
    const rack = seatIdx >= 0 ? s.hands[seatIdx] ?? [] : [];
    return {
      type: "view",
      version: s.version,
      phase: s.phase,
      you: seatIdx,
      yourTiles: sortTiles(myPass ? subtract(rack, myPass.tiles) : rack),
      seats: s.seats.map((seat, i) => ({
        name: seat.name,
        connected: seat.connected,
        tileCount: s.hands[i]?.length ?? 0,
      })),
      wallCount: s.wall.length,
      charleston: c
        ? {
            step: c.step,
            direction: STEP_DIRECTIONS[c.step],
            stepStartedAt: c.stepStartedAt,
            submitted: c.passes.map((p) => p !== null),
            yourPass: myPass ? myPass.tiles : [],
            yourBlind: myPass ? myPass.blind : 0,
            void:
              c.voidFrom === null
                ? null
                : {
                    from: c.voidFrom,
                    agreed: s.seats.map((_, i) => c.voidAgree[i]),
                  },
          }
        : null,
    };
  }

  seatOf(conn: Conn): number {
    return (conn.state as ConnState | null)?.seat ?? -1;
  }

  broadcastViews() {
    for (const conn of this.getConnections<ConnState>()) {
      conn.send(JSON.stringify(this.viewFor(this.seatOf(conn))));
    }
  }

  async onConnect(conn: Conn, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token") ?? "";
    const name = url.searchParams.get("name") ?? "Player";
    const s = this.state;

    let seatIdx = s.seats.findIndex((seat) => seat.token === token);
    if (seatIdx >= 0) {
      // Reconnect: reclaim the seat (and its rack) with the token.
      s.seats[seatIdx].connected = true;
    } else if (s.seats.length < MAX_SEATS) {
      seatIdx = s.seats.length;
      s.seats.push({
        name,
        token: token || crypto.randomUUID(),
        connected: true,
      });
      this.appendEvent("join", seatIdx, name);
      s.version++;
    } else {
      conn.send(JSON.stringify({ type: "error", error: "room-full" }));
      conn.close();
      return;
    }

    conn.setState({ seat: seatIdx });
    conn.send(
      JSON.stringify({
        type: "seated",
        seat: seatIdx,
        token: s.seats[seatIdx].token,
      })
    );
    await this.persist();
    this.broadcastViews();
  }

  async onClose(conn: Conn) {
    const seatIdx = this.seatOf(conn);
    if (seatIdx >= 0 && this.state.seats[seatIdx]) {
      this.state.seats[seatIdx].connected = false;
      await this.persist();
      this.broadcastViews();
    }
  }

  appendEvent(type: string, seat?: number, detail?: string) {
    this.state.log.push({ seq: this.state.log.length + 1, type, seat, detail });
  }

  /** Apply one full round of escrowed passes, atomically.
   *
   *  Each seat's outgoing stack is its chosen tiles plus its blind
   *  tiles, and the blind tiles are the head of the stack it receives
   *  in this same pass — a cyclic definition around the table. It is
   *  resolved by fixed-point iteration: start from the chosen tiles
   *  and keep prepending upstream tiles until every stack is stable.
   *  That resolves every case anchored by at least one chosen tile
   *  along the chain. The one residue — a closed cycle of blind
   *  forwards with too few chosen tiles anywhere around it — is
   *  topped up from the seat's own rack, which keeps tile counts and
   *  conservation exact; no table (physical or digital) can audit
   *  provenance inside such a pile-up anyway. */
  applyBarrier() {
    const s = this.state;
    const c = s.charleston!;
    const n = s.seats.length;
    const off = stepOffset(c.step, n);
    const senderOf = (i: number) => (i - off + n) % n;
    const chosen = c.passes.map((p) => [...p!.tiles]);
    const blind = c.passes.map((p) => p!.blind);

    let outgoing: Tile[][] = chosen.map((t) => [...t]);
    for (let round = 0; round < 8; round++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        const want = [
          ...chosen[i],
          ...outgoing[senderOf(i)].slice(0, blind[i]),
        ];
        if (want.join() !== outgoing[i].join()) {
          outgoing[i] = want;
          changed = true;
        }
      }
      if (!changed) break;
    }
    // Repair residue, and record how much of each outgoing stack came
    // from the seat's own rack (the rest is its blind forward).
    const ownPart: Tile[][] = outgoing.map((stack, i) => {
      const own = [...chosen[i]];
      let j = 0;
      const rackRest = subtract(s.hands[i], chosen[i]);
      while (stack.length < 3 && j < rackRest.length) {
        own.push(rackRest[j]);
        stack.push(rackRest[j]);
        j++;
      }
      return own;
    });

    for (let i = 0; i < n; i++) {
      const incoming = outgoing[senderOf(i)];
      const forwarded = subtract(outgoing[i], ownPart[i]); // blind tiles, a subset of incoming
      const kept = subtract(incoming, forwarded);
      s.hands[i] = [...subtract(s.hands[i], ownPart[i]), ...kept];
    }

    this.appendEvent(
      "charleston-pass",
      undefined,
      `step ${c.step + 1} ${STEP_DIRECTIONS[c.step]}`
    );
    if (c.step === 5) {
      s.phase = "ready";
      s.charleston = null;
      this.appendEvent("charleston-done");
    } else {
      c.step++;
      c.stepStartedAt = Date.now();
      c.passes = Array(n).fill(null);
      c.voidFrom = null;
      c.voidAgree = Array(n).fill(false);
    }
  }

  async onMessage(conn: Conn, message: string | ArrayBuffer) {
    const seatIdx = this.seatOf(conn);
    let cmd: Command;
    try {
      cmd = JSON.parse(message as string) as Command;
    } catch {
      return;
    }
    const s = this.state;

    // Idempotency: a retried command is acknowledged, not re-applied.
    if (s.processedIds.includes(cmd.id)) {
      conn.send(JSON.stringify({ type: "ack", id: cmd.id, version: s.version }));
      conn.send(JSON.stringify(this.viewFor(seatIdx)));
      return;
    }
    // Optimistic concurrency: the client acted on a stale version.
    if (cmd.baseVersion !== s.version) {
      conn.send(JSON.stringify({ type: "stale", id: cmd.id }));
      conn.send(JSON.stringify(this.viewFor(seatIdx)));
      return;
    }

    let applied = false;
    if (cmd.type === "start" && s.phase === "lobby" && s.seats.length > 0) {
      // Trusted shuffle, then a simple sequential deal (the ceremonial
      // 4-4-4-1 wall break is cosmetic; a later slice can add it).
      // The deal opens the Charleston.
      s.wall = shuffle(buildWall());
      s.hands = s.seats.map(() => s.wall.splice(0, 13));
      s.hands[0].push(...s.wall.splice(0, 1)); // East starts with 14
      s.phase = "charleston";
      s.charleston = freshCharleston(s.seats.length);
      this.appendEvent("start", seatIdx, `${s.seats.length} players`);
      applied = true;
    } else if (cmd.type === "pass" && s.phase === "charleston" && s.charleston) {
      const c = s.charleston;
      const tiles = cmd.tiles ?? [];
      const blind = cmd.blind ?? 0;
      const legal =
        seatIdx >= 0 &&
        tiles.length + blind === 3 &&
        blind >= 0 &&
        (blind === 0 || BLIND_STEPS.has(c.step)) &&
        containsAll(s.hands[seatIdx], tiles);
      if (legal) {
        // Escrow: stored hidden, replaces any earlier submission for
        // this step (passes are amendable until the barrier trips),
        // and nothing moves until every seat has submitted.
        c.passes[seatIdx] = { tiles: [...tiles], blind };
        this.appendEvent(
          "pass",
          seatIdx,
          `step ${c.step + 1}${blind ? ` blind ${blind}` : ""}`
        );
        applied = true;
        if (c.passes.every((p) => p !== null)) this.applyBarrier();
      }
    } else if (
      cmd.type === "voidPropose" &&
      s.phase === "charleston" &&
      s.charleston &&
      s.charleston.voidFrom === null &&
      seatIdx >= 0
    ) {
      s.charleston.voidFrom = seatIdx;
      s.charleston.voidAgree = s.seats.map((_, i) => i === seatIdx);
      this.appendEvent("void-propose", seatIdx);
      applied = true;
    } else if (
      cmd.type === "voidVote" &&
      s.phase === "charleston" &&
      s.charleston &&
      s.charleston.voidFrom !== null &&
      seatIdx >= 0
    ) {
      const c = s.charleston;
      if (cmd.agree === false) {
        // A single refusal cancels the proposal.
        c.voidFrom = null;
        c.voidAgree = s.seats.map(() => false);
        this.appendEvent("void-declined", seatIdx);
      } else if (cmd.agree === true) {
        c.voidAgree[seatIdx] = true;
        this.appendEvent("void-agree", seatIdx);
        if (c.voidAgree.every(Boolean)) {
          // Unanimous: the hand is void. Back to the lobby.
          s.phase = "lobby";
          s.hands = [];
          s.wall = [];
          s.charleston = null;
          this.appendEvent("voided");
        }
      }
      applied = true;
    } else if (cmd.type === "reset" && s.phase !== "charleston") {
      // Reset is a lobby convenience. Mid-Charleston it is refused on
      // purpose: the unanimous void vote is the only way out.
      s.phase = "lobby";
      s.hands = [];
      s.wall = [];
      s.charleston = null;
      this.appendEvent("reset", seatIdx);
      applied = true;
    }

    if (applied) {
      s.version++;
      s.processedIds.push(cmd.id);
      if (s.processedIds.length > PROCESSED_CAP) {
        s.processedIds = s.processedIds.slice(-PROCESSED_CAP);
      }
      await this.persist();
      conn.send(JSON.stringify({ type: "ack", id: cmd.id, version: s.version }));
      this.broadcastViews();
    } else {
      conn.send(
        JSON.stringify({ type: "rejected", id: cmd.id, version: s.version })
      );
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
};
