/// <reference types="@cloudflare/workers-types" />
import { Server, routePartykitRequest } from "partyserver";
import { buildWall, shuffle, sortTiles, type Tile } from "../src/tiles";
import { CARD_2026, findWin, type WinInfo } from "../src/card";
import {
  decideCharlestonPass,
  decideTurn,
  decideWindow,
  type BotCommand,
  type BotView,
} from "./bot";
import { keyOk } from "./registry";
export { RoomRegistry } from "./registry";

// The room actor, on PartyServer (the PartyKit successor: same Durable
// Object actor model, deployed with wrangler to our own Cloudflare
// account). Slices 1-3 of the design in DESIGN.md:
// - One room = one Durable Object = a single-threaded actor. Every
//   command is serialized through onRequest, so the game has a total
//   order of events by construction.
// - Event-sourced: clients send commands, never state. A legal command
//   appends an event to the log; state is the fold of that log (kept
//   materialized, snapshotted into the object's storage).
// - Redaction: the full state (wall, racks, escrowed tiles and passes)
//   never leaves this object. Each client receives a per-seat view
//   computed here: own tiles, everyone else's public information.
// - Transport: plain HTTP request/response — no sockets. Clients
//   POST commands and poll for views by version number. Every
//   request is self-contained (the seat token travels in the body),
//   so a frozen, killed or reloaded page recovers with its next
//   request; there is no connection state to go stale.
// - Commands carry a client-generated id (deduplicated: at-least-once
//   delivery, exactly-once effect) and the state version the client
//   acted on (CAS: a mismatch is answered with "stale" + fresh view).
// - Seats are reclaimed across reconnects with a seat token.
// - The Charleston is an escrow barrier: passes are held hidden until
//   all four arrive, then applied atomically. No timeouts; a unanimous
//   void vote is the only escape. Passes are amendable in escrow.
// - Mahjong, claimed or declared, is verified against the encoded
//   card (src/card.ts): a declaration that doesn't complete a card
//   hand is refused, with a note to the player saying so.
// - Bots (party/bot.ts) fill empty seats. A bot seat is driven by
//   the actor itself: it reads the same redacted viewFor() a human
//   at that seat would get, decides from the card evaluator, and
//   its commands go through the very same dispatch — no privileged
//   path, no sight of other racks. Bot turns are scheduled on the
//   object's alarm (shared with the escrow deadline), at human
//   pace: a bot never answers a window faster than the escrow
//   grace a human gets, and it can preempt an escrowed draw only
//   inside that same grace.
// - The play loop's claim window runs until the next draw (design
//   decision 1): a claim for mahjong resolves immediately; other
//   claims are intents that resolve when the window closes — when
//   everyone else has responded, or when the grace period after an
//   escrowed draw expires. If the next player draws while intents are
//   still open, the drawn tile sits in escrow, unseen by anyone; a
//   winning claim sends it back to the wall, otherwise it is revealed
//   to the drawer when the window closes.

type Phase = "lobby" | "charleston" | "playing" | "over";

interface Seat {
  name: string;
  token: string;
  bot: boolean;
  /** Last request heard from this seat (ms epoch). Presence is
   *  derived from it — see isPresent — rather than tracked by a
   *  connection that may or may not still exist. */
  lastSeen?: number;
}

interface GameEvent {
  seq: number;
  type: string;
  seat?: number;
  detail?: string;
}

/** One seat's escrowed Charleston pass: tiles chosen from their own
 *  rack, plus a count of "blind" tiles to forward sight-unseen from
 *  the incoming pass (last pass of each Charleston only). */
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

type ClaimKind = "pung" | "kong" | "mahjong";

interface Claim {
  seat: number;
  kind: ClaimKind;
  /** Tiles the claimant commits from their rack (the set-aside
   *  tiles for a pung or kong), fixed at claim time. */
  tiles: Tile[];
}

interface Meld {
  kind: "pung" | "kong";
  tiles: Tile[]; // exposed, public; includes the claimed discard
}

interface WindowState {
  tile: Tile; // the live discard, public
  from: number; // discarder
  claims: Claim[]; // at most one per seat
  passed: number[]; // seats that declined
  escrow: { seat: number; tile: Tile; deadline: number } | null;
}

interface PlayState {
  turn: number; // seat to act
  hasDrawn: boolean; // the turn seat holds its extra tile and must discard
  melds: Meld[][]; // per seat, public
  discards: Tile[]; // dead discards, public, in order
  window: WindowState | null;
  winner: number | null;
  winKind: "discard" | "self" | null;
  drawGame: boolean;
  winInfo: WinInfo | null;
}

/** One entry of a hand's replay recording: an applied command
 *  (seat >= 0) or an alarm-driven transition (seat -1). Together
 *  with the deal snapshot this is everything a step-through
 *  replay needs to re-fold the hand later: the commands are the
 *  fold's input, the snapshot its initial state. */
interface ReplayEntry {
  seat: number;
  cmd: Partial<Command> & { type: string };
}

/** One line of the room's diagnostic log: a moment a player can
 *  get stuck or a seat changes hands, kept in the room's own
 *  state and read back through the admin page (admin-diag).
 *  Deliberately boring: when, what kind, which seat, one line of
 *  detail. No tiles, no hands — those stay in the game. */
interface DiagEntry {
  at: number;
  kind: string;
  seat: number;
  detail: string;
}

interface GameState {
  phase: Phase;
  seats: Seat[];
  hands: Tile[][];
  wall: Tile[];
  charleston: CharlestonState | null;
  play: PlayState | null;
  version: number;
  log: GameEvent[];
  processedIds: string[];
  /** The deal that opened the current hand: every seat's rack
   *  and the wall, in order, as dealt. Null outside a hand. */
  deal: { hands: Tile[][]; wall: Tile[] } | null;
  /** Applied commands of the current hand, in order. */
  replay: ReplayEntry[];
  /** The diagnostic log, oldest first, capped at DIAG_CAP. */
  diag: DiagEntry[];
}

interface Command {
  id: string;
  baseVersion: number;
  type: string;
  tiles?: Tile[];
  tile?: Tile;
  blind?: number;
  agree?: boolean;
  kind?: ClaimKind;
  owner?: number;
  meld?: number;
  seat?: number;
}

interface Env {
  Mahjong: DurableObjectNamespace<Mahjong>;
  Registry?: DurableObjectNamespace<import("./registry").RoomRegistry>;
  ADMIN_KEY?: string;
}

const MAX_SEATS = 4;
const PROCESSED_CAP = 200;
const DIAG_CAP = 50;
/** How long an escrowed draw stays hidden while claims can preempt
 *  it. A placeholder value from the design, to tune in play. */
const ESCROW_GRACE_MS = 2500;

// Charleston geometry. Seats sit in turn order (0=East, 1=South,
// 2=West, 3=North). A player facing the center has the previous seat
// in turn order on their right (East's right hand points at North),
// so with N seats: right = +(N-1), over = +N/2, left = +1 (mod N).
// Steps: first Charleston right/over/left, second left/over/right.
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

function freshPlay(n: number): PlayState {
  return {
    turn: 0, // East discards first, holding 14 from the deal
    hasDrawn: true,
    melds: Array.from({ length: n }, () => []),
    discards: [],
    window: null,
    winner: null,
    winKind: null,
    drawGame: false,
    winInfo: null,
  };
}

/** Shape check for state loaded from storage. Rooms persist across
 *  deploys, and an older build's state (say, a slice-1 room in phase
 *  "dealt", with no Charleston or play fields) is unplayable by this
 *  code: no panel renders for it and nobody can act. Such state is
 *  dropped on load so the room heals itself instead of wedging. */
function isValidShape(s: GameState): boolean {
  const phases: Phase[] = ["lobby", "charleston", "playing", "over"];
  return (
    phases.includes(s.phase) &&
    Array.isArray(s.seats) &&
    Array.isArray(s.hands) &&
    Array.isArray(s.wall) &&
    Array.isArray(s.log) &&
    Array.isArray(s.processedIds) &&
    typeof s.version === "number" &&
    (s.phase !== "charleston" || s.charleston != null) &&
    (s.phase !== "playing" && s.phase !== "over" ? true : s.play != null)
  );
}

function freshState(): GameState {
  return {
    phase: "lobby",
    seats: [],
    hands: [],
    wall: [],
    charleston: null,
    play: null,
    version: 0,
    log: [],
    processedIds: [],
    deal: null,
    replay: [],
    diag: [],
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

function countOf(tiles: Tile[], tile: Tile): number {
  return tiles.filter((t) => t === tile).length;
}


export class Mahjong extends Server<Env> {
  static options = { hibernate: true };

  state: GameState = freshState();

  async onStart() {
    const saved = await this.ctx.storage.get<GameState>("state");
    if (saved && isValidShape(saved)) {
      this.state = saved;
    } else if (saved) {
      await this.ctx.storage.delete("state");
    }
    // Rooms persisted before the replay recording have neither
    // field; normalize rather than wedge them.
    if (!Array.isArray(this.state.replay)) this.state.replay = [];
    if (this.state.deal === undefined) this.state.deal = null;
    if (!Array.isArray(this.state.diag)) this.state.diag = [];
    // Restore the bots' pending cues WITH their original due
    // times. The queue used to live only in memory, so every
    // wake re-delayed each cue by a fresh human-pace delay — and
    // a wake arriving at a cue's own deadline (the alarm that
    // woke the object was that cue's) found nothing due, re-armed,
    // and could repeat the cycle indefinitely under hibernation
    // churn: the cue never fired. The escrow deadline was always
    // persisted as an absolute time; the bot queue now is too.
    const savedQueue =
      await this.ctx.storage.get<[number, { key: string; at: number }][]>(
        "botq"
      );
    if (Array.isArray(savedQueue)) {
      this.botQueue = new Map(savedQueue);
    }
    await this.noteRegistry();
    await this.driveBots();
  }

  async persist() {
    await this.ctx.storage.put("state", this.state);
    await this.noteRegistry();
  }

  /** The last room summary reported to the registry, so persist()
   *  can stay silent while nothing it tracks has changed. */
  lastReg = "";

  /** Tell the room registry this room exists and what it looks
   *  like now, so the admin page can list it. Bookkeeping must
   *  never break a game, so every failure — no binding (the test
   *  harness), registry hiccup, whatever — is swallowed, and the
   *  call costs nothing while the summary is unchanged. */
  async noteRegistry() {
    try {
      const reg = this.env.Registry;
      if (!reg) return;
      const s = this.state;
      const humans = s.seats.filter((seat) => !seat.bot).length;
      const summary = `${s.phase}|${s.seats.length}|${humans}`;
      if (summary === this.lastReg) return;
      this.lastReg = summary;
      const stub = reg.get(reg.idFromName("registry"));
      await stub.fetch("https://registry/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "register",
          room: this.ctx.id.name ?? "unknown",
          seats: s.seats.length,
          humans,
          phase: s.phase,
        }),
      });
    } catch {
      /* the registry is bookkeeping; never break a game for it */
    }
  }

  /** The admin page's big red button: erase this room completely
   *  — saved state, pending bot cues, the alarm — and take it off
   *  the registry's list. Key-gated in onRequest; no undo. */
  async wipeRoom() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.state = freshState();
    this.botQueue = new Map();
    this.botAttempts = new Map();
    this.lastReg = "";
    try {
      const reg = this.env.Registry;
      if (reg) {
        const stub = reg.get(reg.idFromName("registry"));
        await stub.fetch("https://registry/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "forget",
            room: this.ctx.id.name ?? "unknown",
            key: this.env.ADMIN_KEY,
          }),
        });
      }
    } catch {
      /* a stale registry row is cosmetic, not a failed wipe */
    }
  }

  /** The redacted projection for one seat. This is the ONLY game data
   *  a client ever receives: own tiles (minus your own escrowed
   *  Charleston pass, reported separately), public table state
   *  (melds, discards, the live discard, claim intents), and everyone
   *  else's tile counts. Another seat's rack, the wall's order, an
   *  escrowed draw, and escrowed passes are never in any view. */
  viewFor(seatIdx: number) {
    const s = this.state;
    // Post-hand, secrecy ends: the view carries every seat's final
    // rack and the hand's own slice of the event log (from its
    // deal onward), so the table can review how the hand went.
    // Mid-hand, neither exists in any view — the recording (deal
    // snapshot + applied commands) stays server-side too, kept
    // for a future step-through replay.
    const over = s.phase === "over";
    const logCut = over ? s.log.map((e) => e.type).lastIndexOf("start") : -1;
    const c = s.phase === "charleston" ? s.charleston : null;
    const p = s.play;
    const myPass = c && seatIdx >= 0 ? c.passes[seatIdx] : null;
    const rack = seatIdx >= 0 ? s.hands[seatIdx] ?? [] : [];
    const w = p?.window ?? null;
    return {
      type: "view",
      version: s.version,
      phase: s.phase,
      you: seatIdx,
      yourTiles: sortTiles(myPass ? subtract(rack, myPass.tiles) : rack),
      seats: s.seats.map((seat, i) => ({
        name: seat.name,
        connected: this.isPresent(seat),
        bot: seat.bot,
        tileCount: s.hands[i]?.length ?? 0,
      })),
      wallCount: s.wall.length,
      charleston: c
        ? {
            step: c.step,
            direction: STEP_DIRECTIONS[c.step],
            stepStartedAt: c.stepStartedAt,
            submitted: c.passes.map((pp) => pp !== null),
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
      play: p
        ? {
            turn: p.turn,
            hasDrawn: p.hasDrawn,
            melds: p.melds,
            discards: p.discards,
            window: w
              ? {
                  tile: w.tile,
                  from: w.from,
                  claims: w.claims.map((cl) => ({ seat: cl.seat, kind: cl.kind })),
                  passed: w.passed,
                  escrowSeat: w.escrow ? w.escrow.seat : null,
                  escrowDeadline: w.escrow ? w.escrow.deadline : null,
                  youEscrowed: seatIdx >= 0 && w.escrow?.seat === seatIdx,
                }
              : null,
            winner: p.winner,
            winKind: p.winKind,
            drawGame: p.drawGame,
            winInfo: p.winInfo,
          }
        : null,
      finalHands: over ? s.hands.map((h) => sortTiles(h)) : undefined,
      history: over ? (logCut >= 0 ? s.log.slice(logCut) : s.log) : undefined,
    };
  }

  /** Presence, polling-style: a seat counts as present if a
   *  request arrived from it recently. This is more honest than
   *  the socket version \u2014 a connection object claims presence
   *  even when the phone that owns it is asleep in a pocket,
   *  while a last-seen timestamp is exactly as stale as it says.
   *  It also feeds game rules: a seat absent past this window is
   *  one whose exposed jokers may be exchanged with and whose
   *  lobby seat may be removed. */
  isPresent(seat: Seat, windowMs = 15000): boolean {
    return seat.bot || Date.now() - (seat.lastSeen ?? 0) < windowMs;
  }

  /** A cheap fingerprint of who is currently present, folded into
   *  the poll cursor: going absent bumps no version, so without it
   *  other clients' polls would answer "unchanged" forever and the
   *  presence badge would never flip until a game event landed. */
  presenceSig(): string {
    return this.state.seats.map((s) => (this.isPresent(s) ? "1" : "0")).join("");
  }

  seatByToken(token: string): number {
    if (!token) return -1;
    return this.state.seats.findIndex((seat) => seat.token === token);
  }

  touchPresence(seatIdx: number) {
    const seat = this.state.seats[seatIdx];
    if (seat) {
      seat.lastSeen = Date.now();
    }
  }

  /** Seat assignment, shared by the HTTP join endpoint and the
   *  tests. A known token reclaims its seat (and its rack) at any
   *  time; a new seat is dealt only in the lobby. */
  async joinSeat(
    name: string,
    token: string
  ): Promise<{ seat: number; token: string } | { error: string }> {
    const s = this.state;
    const cleanName = (name || "Player").slice(0, 24);
    let seatIdx = s.seats.findIndex(
      (seat) => token !== "" && seat.token === token
    );
    if (seatIdx >= 0) {
      this.touchPresence(seatIdx);
      this.noteDiag(
        "reclaim",
        seatIdx,
        `${s.seats[seatIdx].name} reclaimed their seat during ${s.phase}`
      );
      await this.persist();
      return { seat: seatIdx, token: s.seats[seatIdx].token };
    }
    if (s.phase !== "lobby") {
      // A hand is in progress. A brand-new seat would have no rack
      // and no place in the Charleston barrier, so it is refused;
      // token rejoins (above) are always welcome.
      return { error: "hand-in-progress" };
    }
    if (s.seats.length >= MAX_SEATS) return { error: "room-full" };
    seatIdx = s.seats.length;
    // Adopt the client's proposed token when it is well-formed:
    // the client persists it BEFORE the first join, so a join
    // whose response is lost (or a double-tapped button) retries
    // into the SAME seat instead of minting an orphan.
    const fresh = /^[A-Za-z0-9-]{16,64}$/.test(token)
      ? token
      : crypto.randomUUID();
    s.seats.push({
      name: cleanName,
      token: fresh,
      bot: false,
      lastSeen: Date.now(),
    });
    this.appendEvent("join", seatIdx, cleanName);
    this.noteDiag("join", seatIdx, `${cleanName} claimed a seat`);
    s.version++;
    await this.persist();
    return { seat: seatIdx, token: fresh };
  }

  /** One command through dispatchCommand with its direct replies
   *  (ack / rejected / stale / note) captured, plus the bot driver
   *  run the socket handler used to trigger. The response always
   *  carries the requester's fresh view, so a command round-trip
   *  is also a sync. */
  async runCommand(
    seatIdx: number,
    cmd: Command
  ): Promise<{ messages: object[]; view: object }> {
    const messages: object[] = [];
    await this.dispatchCommand(seatIdx, cmd, (obj) => {
      if ((obj as { type?: string }).type !== "view") messages.push(obj);
    });
    await this.driveBots();
    return { messages, view: this.viewFor(seatIdx) };
  }

  /** The whole client API: three POST actions on the room URL.
   *  join {name, token?} \u2192 seated + view (or error)
   *  command {token, cmd} \u2192 direct replies + fresh view
   *  poll {token, since} \u2192 {unchanged} at the same version, else
   *  the fresh view. Polls are pure reads plus a presence touch:
   *  the bot scheduler stays alarm-driven and is not poked here,
   *  so a poll costs no storage writes. */
  async onRequest(req: Request): Promise<Response> {
    let body: {
      action?: string;
      name?: string;
      token?: string;
      cmd?: Command;
      since?: number;
      sig?: string;
      key?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json(
        { type: "error", error: "bad-request" },
        { status: 400 }
      );
    }
    if (body.action === "admin-wipe") {
      // Not a game action: no seat token, and it must work on a
      // room in any phase — that is rather the point of it.
      if (!keyOk(this.env, body.key)) {
        return Response.json(
          { type: "error", error: "bad-key" },
          { status: 403 }
        );
      }
      await this.wipeRoom();
      return Response.json({ type: "wiped" });
    }
    if (body.action === "admin-diag") {
      // The room's diagnostic log, for the admin page. Same key
      // as the wipe; read-only, works in any phase.
      if (!keyOk(this.env, body.key)) {
        return Response.json(
          { type: "error", error: "bad-key" },
          { status: 403 }
        );
      }
      return Response.json({ type: "diag", entries: this.state.diag ?? [] });
    }
    if (body.action === "join") {
      const res = await this.joinSeat(body.name ?? "Player", body.token ?? "");
      if ("error" in res) {
        return Response.json({ type: "error", error: res.error });
      }
      return Response.json({
        type: "seated",
        seat: res.seat,
        token: res.token,
        view: this.viewFor(res.seat),
      });
    }
    const seatIdx = this.seatByToken(body.token ?? "");
    if (seatIdx < 0) {
      return Response.json({ type: "error", error: "unknown-seat" });
    }
    this.touchPresence(seatIdx);
    if (body.action === "command" && body.cmd) {
      const { messages, view } = await this.runCommand(seatIdx, body.cmd);
      return Response.json({ messages, view });
    }
    if (body.action === "poll") {
      if (
        typeof body.since === "number" &&
        body.since === this.state.version &&
        (body.sig === undefined || body.sig === this.presenceSig())
      ) {
        return Response.json({
          type: "unchanged",
          version: this.state.version,
        });
      }
      return Response.json({ view: this.viewFor(seatIdx) });
    }
    return Response.json(
      { type: "error", error: "bad-request" },
      { status: 400 }
    );
  }

  /** Append one line to the room's diagnostic log, dropping the
   *  oldest past the cap. Born of 2026-11-11: a live game went
   *  wrong (a player silently unable to pass, a seat's owner
   *  wandering in mid-hand) and the room itself could tell us
   *  nothing — no log, no history, only "it's broken". This is
   *  the small, persistent answer: enough to reconstruct who
   *  claimed what and which commands were refused and why. */
  noteDiag(kind: string, seat: number, detail: string) {
    const s = this.state;
    if (!Array.isArray(s.diag)) s.diag = [];
    s.diag.push({ at: Date.now(), kind, seat, detail });
    if (s.diag.length > DIAG_CAP) s.diag = s.diag.slice(-DIAG_CAP);
  }

  /** Why a command fell through unapplied, as best as can be
   *  re-derived at the refusal point. Diagnostic only: the line
   *  is for a human reconstructing a stuck game, so a plain
   *  reason beats a precise one. */
  refusalReason(cmd: Command, seatIdx: number): string {
    const s = this.state;
    if (cmd.type === "pass") {
      if (s.phase !== "charleston" || !s.charleston)
        return "pass outside the Charleston";
      const tiles = cmd.tiles ?? [];
      const blind = cmd.blind ?? 0;
      if (tiles.length + blind !== 3)
        return `pass of ${tiles.length} tiles + ${blind} blind is not 3`;
      if (blind > 0 && !BLIND_STEPS.has(s.charleston.step))
        return "blind pass on a step that does not allow it";
      if (!containsAll(s.hands[seatIdx] ?? [], tiles))
        return "pass tiles are not in the player's hand";
      return "pass refused";
    }
    if (cmd.type === "start") return "start outside the lobby";
    if (cmd.type === "reset") return `reset refused during ${s.phase}`;
    return `${cmd.type} not applicable during ${s.phase}`;
  }

  appendEvent(type: string, seat?: number, detail?: string) {
    this.state.log.push({ seq: this.state.log.length + 1, type, seat, detail });
  }

  /** Apply one full round of escrowed Charleston passes, atomically.
   *  Each seat's outgoing stack is its chosen tiles plus its blind
   *  tiles, and the blind tiles are the head of the stack it receives
   *  in this same pass — a cyclic definition around the table,
   *  resolved by fixed-point iteration. The one residue — a closed
   *  cycle of blind forwards with too few chosen tiles anywhere
   *  around it — is topped up from the seat's own rack, which keeps
   *  tile counts and conservation exact. */
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
      const forwarded = subtract(outgoing[i], ownPart[i]);
      const kept = subtract(incoming, forwarded);
      s.hands[i] = [...subtract(s.hands[i], ownPart[i]), ...kept];
    }

    this.appendEvent(
      "charleston-pass",
      undefined,
      `step ${c.step + 1} ${STEP_DIRECTIONS[c.step]}`
    );
    if (c.step === 5) {
      s.phase = "playing";
      s.charleston = null;
      s.play = freshPlay(n);
      this.appendEvent("charleston-done");
    } else {
      c.step++;
      c.stepStartedAt = Date.now();
      c.passes = Array(n).fill(null);
      c.voidFrom = null;
      c.voidAgree = Array(n).fill(false);
    }
  }

  /** Every seat except the discarder has claimed or passed. */
  allResponded(): boolean {
    const s = this.state;
    const w = s.play?.window;
    if (!w) return false;
    const n = s.seats.length;
    for (let i = 0; i < n; i++) {
      if (i === w.from) continue;
      const claimed = w.claims.some((cl) => cl.seat === i);
      if (!claimed && !w.passed.includes(i)) return false;
    }
    return true;
  }

  endHand(
    winner: number | null,
    winKind: PlayState["winKind"],
    drawGame: boolean,
    winInfo: WinInfo | null = null
  ) {
    const s = this.state;
    const p = s.play!;
    p.winner = winner;
    p.winKind = winKind;
    p.drawGame = drawGame;
    p.winInfo = winInfo;
    p.window = null;
    s.phase = "over";
    this.appendEvent(
      drawGame ? "wall-game" : "mahjong",
      winner ?? undefined,
      winKind ?? undefined
    );
  }

  /** Close the claim window and apply its outcome. Called when
   *  everyone has responded, or when the escrow grace expires. */
  async resolveWindow() {
    const s = this.state;
    const p = s.play;
    const w = p?.window;
    if (!p || !w || s.phase !== "playing") return;
    const n = s.seats.length;
    const next = (w.from + 1) % n;

    // Winning claim: mahjong never reaches here (it resolves on
    // arrival). All other claims rank alike; ties go to the seat
    // closest to the discarder in turn order.
    const dist = (seat: number) => (seat - w.from + n) % n;
    const winner = [...w.claims].sort(
      (a, b) => dist(a.seat) - dist(b.seat)
    )[0];

    if (w.escrow) {
      // The escrowed draw returns to the wall unseen if a claim won;
      // otherwise it is revealed to the drawer as their draw.
      if (winner) {
        s.wall.unshift(w.escrow.tile);
      } else {
        s.hands[w.escrow.seat].push(w.escrow.tile);
        p.turn = w.escrow.seat;
        p.hasDrawn = true;
      }
    }

    if (winner) {
      const seat = winner.seat;
      s.hands[seat] = subtract(s.hands[seat], winner.tiles);
      p.melds[seat].push({
        kind: winner.kind as Meld["kind"],
        tiles: [w.tile, ...winner.tiles],
      });
      this.appendEvent("claim", seat, `${winner.kind} on ${w.tile}`);
      p.turn = seat;
      p.hasDrawn = true;
      if (winner.kind === "kong") {
        // A kong draws a replacement from the back of the wall.
        const replacement = s.wall.pop();
        if (replacement === undefined) {
          this.endHand(null, null, true);
        } else {
          s.hands[seat].push(replacement);
        }
      }
    } else if (!w.escrow) {
      // Nobody claimed and nobody drew: the discard dies and the
      // turn passes to the next seat, which still has to draw.
      p.discards.push(w.tile);
      p.turn = next;
      p.hasDrawn = false;
    } else {
      // Escrow revealed above; the unclaimed discard dies.
      p.discards.push(w.tile);
    }
    p.window = null;
    s.version++;
    await this.persist();
  }

  /** The alarm is shared: the escrow grace expiring (claims, if
   *  any, preempt the draw) and bot actions falling due. */
  async onAlarm() {
    const w = this.state.play?.window;
    if (w?.escrow && Date.now() >= w.escrow.deadline) {
      // An alarm-driven transition: record it, or a replay fold
      // would wait forever for a command that never comes.
      if (this.state.deal) {
        this.state.replay.push({
          seat: -1,
          cmd: { type: "__escrow-expired" },
        });
      }
      await this.resolveWindow();
    }
    await this.runDueBots();
    await this.driveBots();
  }

  /** One command through the full pipeline — idempotency, version
   *  CAS, the dispatch itself and persistence. Human commands
   *  arrive via runCommand; bot commands are issued by the
   *  actor itself with a fresh id and the current version. `send`
   *  delivers this command's own replies (ack / rejected / stale /
   *  notes); for bots it is a no-op sink, since a bot reads the
   *  world from its view like everyone else. Returns whether the
   *  command applied. */
  async dispatchCommand(
    seatIdx: number,
    cmd: Command,
    send: (obj: object) => void
  ): Promise<boolean> {
    const s = this.state;

    // Idempotency: a retried command is acknowledged, not re-applied.
    if (s.processedIds.includes(cmd.id)) {
      send({ type: "ack", id: cmd.id, version: s.version });
      send(this.viewFor(seatIdx));
      return true;
    }
    // Optimistic concurrency: the client acted on a stale version.
    if (cmd.baseVersion !== s.version) {
      if (seatIdx >= 0 && !s.seats[seatIdx]?.bot) {
        this.noteDiag(
          "refuse",
          seatIdx,
          `${cmd.type}: stale base ${cmd.baseVersion}, room at ${s.version}`
        );
        await this.persist();
      }
      send({ type: "stale", id: cmd.id });
      send(this.viewFor(seatIdx));
      return false;
    }

    let applied = false;
    if (
      cmd.type === "addBot" &&
      s.phase === "lobby" &&
      seatIdx >= 0 &&
      !s.seats[seatIdx].bot &&
      s.seats.length < MAX_SEATS
    ) {
      // A bot seat: driven by the actor itself, never by a
      // connection. Its token is a random UUID that is never sent
      // anywhere, so the seat can never be claimed from outside.
      const names = ["Ada", "Bea", "Cyd", "Dee"];
      const name =
        names.find((nm) => !s.seats.some((seat) => seat.name === nm)) ??
        `Bot ${s.seats.length + 1}`;
      s.seats.push({
        name,
        token: `bot-${crypto.randomUUID()}`,
          bot: true,
        lastSeen: Date.now(),
      });
      this.appendEvent("add-bot", s.seats.length - 1, name);
      applied = true;
    } else if (
      (cmd.type === "removeBot" || cmd.type === "removeSeat") &&
      s.phase === "lobby" &&
      cmd.seat !== undefined &&
      cmd.seat !== seatIdx
    ) {
      // removeBot takes out a bot; removeSeat takes out any seat
      // that cannot object — a bot, or a human who has disconnected
      // (their browser closed and the seat would otherwise squat in
      // the room forever, blocking the deal).
      const target = s.seats[cmd.seat];
      const removable =
        target &&
        (cmd.type === "removeBot"
          ? target.bot === true
          : target.bot === true || !this.isPresent(target, 60000));
      if (removable) {
        const [gone] = s.seats.splice(cmd.seat, 1);
        // Seats are addressed by token on every request, so the
        // seats behind the removed one simply shift down an index;
        // the removed seat's token stops resolving at once.
        this.appendEvent("remove-seat", cmd.seat, gone.name);
        applied = true;
      }
    } else if (cmd.type === "start" && s.phase === "lobby" && s.seats.length > 0) {
      // Trusted shuffle, then a simple sequential deal (the ceremonial
      // 4-4-4-1 wall break is cosmetic; a later slice can add it).
      // The deal opens the Charleston.
      s.wall = shuffle(buildWall());
      s.hands = s.seats.map(() => s.wall.splice(0, 13));
      s.hands[0].push(...s.wall.splice(0, 1)); // East starts with 14
      s.phase = "charleston";
      s.charleston = freshCharleston(s.seats.length);
      s.play = null;
      // Open the hand's replay recording with its initial state.
      s.deal = { hands: s.hands.map((h) => [...h]), wall: [...s.wall] };
      s.replay = [];
      this.appendEvent("start", seatIdx, `${s.seats.length} players`);
      this.noteDiag("start", seatIdx, `dealt a hand, ${s.seats.length} players`);
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
      this.noteDiag("void", seatIdx, "proposed voiding the hand");
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
        c.voidFrom = null;
        c.voidAgree = s.seats.map(() => false);
        this.appendEvent("void-declined", seatIdx);
        this.noteDiag("void", seatIdx, "void declined");
      } else if (cmd.agree === true) {
        c.voidAgree[seatIdx] = true;
        this.appendEvent("void-agree", seatIdx);
        if (c.voidAgree.every(Boolean)) {
          s.phase = "lobby";
          s.hands = [];
          s.wall = [];
          s.charleston = null;
          this.appendEvent("voided");
          this.noteDiag("void", seatIdx, "hand voided, back to the lobby");
        }
      }
      applied = true;
    } else if (cmd.type === "discard" && s.phase === "playing" && s.play) {
      const p = s.play;
      const tile = cmd.tile;
      if (
        seatIdx === p.turn &&
        p.hasDrawn &&
        p.window === null &&
        tile !== undefined &&
        s.hands[seatIdx].includes(tile)
      ) {
        s.hands[seatIdx] = subtract(s.hands[seatIdx], [tile]);
        p.window = {
          tile,
          from: seatIdx,
          claims: [],
          passed: [],
          escrow: null,
        };
        p.hasDrawn = false;
        this.appendEvent("discard", seatIdx, tile);
        applied = true;
      }
    } else if (cmd.type === "draw" && s.phase === "playing" && s.play) {
      const p = s.play;
      const n = s.seats.length;
      if (p.window === null && seatIdx === p.turn && !p.hasDrawn) {
        // A plain draw on your turn.
        const tile = s.wall.shift();
        if (tile === undefined) {
          this.endHand(null, null, true);
        } else {
          s.hands[seatIdx].push(tile);
          p.hasDrawn = true;
          this.appendEvent("draw", seatIdx);
        }
        applied = true;
      } else if (
        p.window !== null &&
        seatIdx === (p.window.from + 1) % n &&
        p.window.escrow === null
      ) {
        // Drawing while the claim window is open. If everyone else
        // has passed and nobody claimed, the draw is safe and lands
        // at once; otherwise the tile goes into escrow, hidden from
        // everyone including the drawer, until the window closes.
        const w = p.window!; // branch guard: window is open
        const othersDone = s.seats.every(
          (_, i) =>
            i === w.from ||
            i === seatIdx ||
            w.passed.includes(i) ||
            w.claims.some((cl) => cl.seat === i)
        );
        const tile = s.wall.shift();
        if (tile === undefined) {
          this.endHand(null, null, true);
          applied = true;
        } else if (othersDone && w.claims.length === 0) {
          p.discards.push(w.tile);
          p.window = null;
          s.hands[seatIdx].push(tile);
          p.turn = seatIdx;
          p.hasDrawn = true;
          this.appendEvent("draw", seatIdx, "uncontested");
          applied = true;
        } else {
          w.escrow = {
            seat: seatIdx,
            tile,
            deadline: Date.now() + ESCROW_GRACE_MS,
          };
          this.appendEvent("draw", seatIdx, "escrow");
          applied = true;
        }
      }
    } else if (cmd.type === "claim" && s.phase === "playing" && s.play?.window) {
      const p = s.play;
      const w = p.window!; // branch guard: window is open
      const kind = cmd.kind;
      const n = s.seats.length;
      if (
        seatIdx >= 0 &&
        seatIdx !== w.from &&
        kind !== undefined &&
        w.tile !== "J" // a discarded joker is dead: it can never be called
      ) {
        if (kind === "mahjong") {
          // A mahjong claim resolves the moment it arrives, ahead of
          // everything else in the window — but only if the claimed
          // tile really completes a hand on the card.
          const win = findWin(
            CARD_2026,
            [...s.hands[seatIdx], w.tile],
            s.play.melds[seatIdx]
          );
          if (win) {
            s.hands[seatIdx].push(w.tile);
            if (w.escrow) s.wall.unshift(w.escrow.tile);
            this.appendEvent("claim", seatIdx, `mahjong on ${w.tile}`);
            this.endHand(seatIdx, "discard", false, win);
            applied = true;
          } else {
            send({
              type: "note",
              note: "That tile doesn't complete a hand on the card.",
            });
          }
        } else {
          // Compose the tiles the claimant commits from their rack.
          const rack = s.hands[seatIdx];
          let tiles: Tile[] | null = null;
          if (kind === "pung" || kind === "kong") {
            const need = kind === "pung" ? 2 : 3;
            const naturals = Math.min(countOf(rack, w.tile), need);
            // When the called tile is itself a joker the two counts
            // are the same pool; never count it twice. (Unreachable
            // while joker discards are uncallable, but keep the
            // arithmetic honest.)
            const jokers =
              w.tile === "J"
                ? 0
                : Math.min(countOf(rack, "J"), need - naturals);
            if (naturals + jokers === need) {
              tiles = [
                ...Array(naturals).fill(w.tile),
                ...Array(jokers).fill("J"),
              ];
            }
          }
          if (tiles !== null) {
            w.claims = [
              ...w.claims.filter((cl) => cl.seat !== seatIdx),
              { seat: seatIdx, kind, tiles },
            ];
            w.passed = w.passed.filter((x) => x !== seatIdx);
            this.appendEvent("claim-intent", seatIdx, kind);
            applied = true;
            if (this.allResponded()) {
              await this.resolveWindow();
              // resolveWindow persists and broadcasts itself, and it
              // has already bumped the version; the shared path below
              // would double-count, so answer here and return.
              s.processedIds.push(cmd.id);
              if (s.processedIds.length > PROCESSED_CAP) {
                s.processedIds = s.processedIds.slice(-PROCESSED_CAP);
              }
              await this.persist();
              send({ type: "ack", id: cmd.id, version: s.version });
              return true;
            }
          }
        }
      }
    } else if (cmd.type === "pass" && s.phase === "playing" && s.play?.window) {
      // Declining the live discard. (In the Charleston phase the same
      // command word submits a pass of tiles; the phase decides.)
      const w = s.play.window;
      if (seatIdx >= 0 && seatIdx !== w.from) {
        w.claims = w.claims.filter((cl) => cl.seat !== seatIdx);
        if (!w.passed.includes(seatIdx)) w.passed.push(seatIdx);
        this.appendEvent("no-claim", seatIdx);
        applied = true;
        if (this.allResponded()) {
          await this.resolveWindow();
          s.processedIds.push(cmd.id);
          if (s.processedIds.length > PROCESSED_CAP) {
            s.processedIds = s.processedIds.slice(-PROCESSED_CAP);
          }
          await this.persist();
          send({ type: "ack", id: cmd.id, version: s.version });
          return true;
        }
      }
    } else if (cmd.type === "exchange" && s.phase === "playing" && s.play) {
      // Joker exchange: on your turn, trade the natural tile from
      // your rack for a joker exposed in any meld (yours or another
      // seat's). Only pung and kong melds can hold jokers.
      const p = s.play;
      const owner = cmd.owner;
      const meldIdx = cmd.meld;
      const tile = cmd.tile;
      if (
        seatIdx === p.turn &&
        p.hasDrawn &&
        p.window === null &&
        owner !== undefined &&
        meldIdx !== undefined &&
        tile !== undefined &&
        p.melds[owner]?.[meldIdx]?.tiles.includes("J") &&
        s.hands[seatIdx].includes(tile) &&
        p.melds[owner][meldIdx].tiles.find((t) => t !== "J") === tile
      ) {
        const meld = p.melds[owner][meldIdx];
        meld.tiles = [tile, ...subtract(meld.tiles, ["J"])];
        s.hands[seatIdx] = [...subtract(s.hands[seatIdx], [tile]), "J"];
        this.appendEvent("exchange", seatIdx, `${tile} for joker`);
        applied = true;
      }
    } else if (
      cmd.type === "declareMahjong" &&
      s.phase === "playing" &&
      s.play
    ) {
      const p = s.play;
      if (seatIdx === p.turn && p.hasDrawn && p.window === null) {
        const win = findWin(CARD_2026, s.hands[seatIdx], p.melds[seatIdx]);
        if (win) {
          this.appendEvent("declare", seatIdx, "self-drawn mahjong");
          this.endHand(seatIdx, "self", false, win);
          applied = true;
        } else {
          send({
            type: "note",
            note: "That isn't a hand on the card yet.",
          });
        }
      }
    } else if (cmd.type === "reset") {
      // There are no mid-hand resets — for anyone, ever. Reset used
      // to be the friendly way to abandon a hand, until one stray
      // tap on it vaporized a family game in progress (2026-11-05):
      // the button sits on every screen, and a hand other people
      // are invested in should not be one tap away from gone. So
      // while a hand is underway the reset is refused, and the note
      // names the real ways out: a Charleston can still be voided
      // by unanimous vote, and any hand can be abandoned by
      // leaving — a room costs nothing, so start a new one. In the
      // lobby and after a finished hand, reset just tidies up.
      if (s.phase === "charleston") {
        send({
          type: "note",
          note: "No resets while a hand is underway — propose voiding the Charleston, or leave and start a new room.",
        });
      } else if (s.phase === "playing") {
        send({
          type: "note",
          note: "No resets while a hand is underway — to abandon it, leave and start a new room.",
        });
      } else {
        s.phase = "lobby";
        s.hands = [];
        s.wall = [];
        s.charleston = null;
        s.play = null;
        s.deal = null;
        s.replay = [];
        this.appendEvent("reset", seatIdx);
        applied = true;
      }
    }

    if (applied) {
      // The hand's replay recording: every applied command of the
      // hand, in order, minus the delivery plumbing (id, base
      // version). Lobby bookkeeping before the deal is not part
      // of the hand; the start command itself opens the stream
      // (its branch just reset it), and a reset closes it by
      // clearing the snapshot, so it is never recorded.
      if (s.deal && cmd.type !== "reset") {
        const core: Partial<Command> & { type: string } = { type: cmd.type };
        if (cmd.tiles) core.tiles = [...cmd.tiles];
        if (cmd.tile) core.tile = cmd.tile;
        if (cmd.blind !== undefined) core.blind = cmd.blind;
        if (cmd.agree !== undefined) core.agree = cmd.agree;
        if (cmd.kind) core.kind = cmd.kind;
        if (cmd.owner !== undefined) core.owner = cmd.owner;
        if (cmd.meld !== undefined) core.meld = cmd.meld;
        if (cmd.seat !== undefined) core.seat = cmd.seat;
        s.replay.push({ seat: seatIdx, cmd: core });
      }
      s.version++;
      s.processedIds.push(cmd.id);
      if (s.processedIds.length > PROCESSED_CAP) {
        s.processedIds = s.processedIds.slice(-PROCESSED_CAP);
      }
      await this.persist();
      send({ type: "ack", id: cmd.id, version: s.version });
    } else {
      if (seatIdx >= 0 && !s.seats[seatIdx]?.bot) {
        this.noteDiag(
          "refuse",
          seatIdx,
          `${cmd.type}: ${this.refusalReason(cmd, seatIdx)}`
        );
        await this.persist();
      }
      send({ type: "rejected", id: cmd.id, version: s.version });
    }
    return applied;
  }

  // ---------- bot driving ----------

  botQueue = new Map<number, { key: string; at: number }>();
  botAttempts = new Map<string, { version: number; count: number }>();

  /** What a bot seat currently owes the game, if anything: a
   *  Charleston pass, a window response, a draw, a turn action, or
   *  a void agreement — the last only once every human has agreed,
   *  so a bot never blocks a void the humans want and never starts
   *  one. Bots never draw into an open window; they claim or pass,
   *  which keeps the escrow path a purely human affordance. */
  botObligation(seat: number): string | null {
    const s = this.state;
    if (!s.seats[seat]?.bot) return null;
    if (s.phase === "charleston" && s.charleston) {
      const c = s.charleston;
      if (c.voidFrom !== null && !c.voidAgree[seat]) {
        const humansAgreed = s.seats.every(
          (st, i) => st.bot || c.voidAgree[i]
        );
        if (humansAgreed) return "void";
      }
      return c.passes[seat] === null ? "charleston" : null;
    }
    if (s.phase === "playing" && s.play) {
      const p = s.play;
      if (p.window) {
        const w = p.window;
        const responded =
          w.passed.includes(seat) ||
          w.claims.some((cl) => cl.seat === seat);
        return seat !== w.from && !responded ? "window" : null;
      }
      if (p.turn === seat) return p.hasDrawn ? "act" : "draw";
    }
    return null;
  }

  /** (Re)compute every bot seat's pending action and arm the alarm
   *  for the earliest thing due — a bot action or the escrow
   *  deadline. Called after every state change; cheap and
   *  idempotent. Delays are human-paced, and a window response
   *  always lands inside the escrow grace. The arming is awaited
   *  by every caller: a fire-and-forget setAlarm can be lost when
   *  the object hibernates the instant the handler returns (this
   *  bit live: both humans agreed to a void, the bots' cue was
   *  queued, and the room then sat silent and idle — the alarm
   *  never landed, so the bots never voted). */
  async driveBots() {
    const s = this.state;
    for (let seat = 0; seat < s.seats.length; seat++) {
      const key = s.seats[seat].bot ? this.botObligation(seat) : null;
      if (!key) {
        this.botQueue.delete(seat);
        continue;
      }
      const blocked = this.botAttempts.get(`${seat}:${key}`);
      if (blocked && blocked.version === s.version && blocked.count >= 3) {
        this.botQueue.delete(seat);
        continue;
      }
      const existing = this.botQueue.get(seat);
      if (!existing || existing.key !== key) {
        const delay =
          key === "charleston"
            ? 900 + Math.random() * 1100
            : key === "window"
              ? 600 + Math.random() * 800
              : key === "draw"
                ? 500 + Math.random() * 600
                : key === "void"
                  ? 500 + Math.random() * 400
                  : 800 + Math.random() * 800;
        // Integer due time, rounded UP: the random delays are
        // fractional, and a cue due at T.6 is "not due" when its
        // alarm fires at T — the handler then executes nothing and
        // re-arms for T.6, an immediate re-arm the platform may
        // deliver tens of seconds late (measured: 7-59s stalls).
        const at = Math.ceil(Date.now() + delay);
        this.botQueue.set(seat, { key, at });
      }
    }
    await this.armAlarm();
  }

  async armAlarm() {
    const times: number[] = [];
    const w = this.state.play?.window;
    if (w?.escrow) times.push(w.escrow.deadline);
    for (const e of this.botQueue.values()) times.push(e.at);
    // Persist the queue alongside the arming (see onStart): due
    // times are absolute and must survive the object sleeping.
    try {
      await this.ctx.storage.put("botq", [...this.botQueue.entries()]);
    } catch {
      // A lost queue snapshot only costs a re-derivation on the
      // next wake; never let it break the arming itself.
    }
    try {
      if (times.length > 0) {
        await this.ctx.storage.setAlarm(Math.min(...times));
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch {
      // The alarm is a wake-up mechanism, not state; the next
      // message or alarm re-drives everything anyway.
    }
  }

  /** Execute the bot actions that have fallen due. Each decision
   *  is made fresh, from the seat's current redacted view, and is
   *  issued through the same dispatch as a human command. */
  async runDueBots() {
    const now = Date.now();
    for (const [seat, entry] of [...this.botQueue.entries()]) {
      // 2ms tolerance: never leave a wake with nothing executed
      // over a boundary hair — an unexecuted overdue cue means an
      // immediate re-arm, whose delivery latency is unbounded.
      if (entry.at > now + 2) continue;
      this.botQueue.delete(seat);
      if (this.botObligation(seat) !== entry.key) continue;
      const view = this.viewFor(seat) as unknown as BotView;
      let cmd: BotCommand | null = null;
      if (entry.key === "charleston") cmd = decideCharlestonPass(view);
      else if (entry.key === "window") cmd = decideWindow(view);
      else if (entry.key === "void") cmd = { type: "voidVote", agree: true };
      else cmd = decideTurn(view);
      const sig = `${seat}:${entry.key}`;
      if (!cmd) {
        this.noteBotFailure(sig);
        continue;
      }
      const applied = await this.dispatchCommand(
        seat,
        {
          // Unique per dispatch, across object incarnations: a
          // per-instance counter restarts at zero whenever the
          // object wakes fresh, and its recycled ids collide with
          // the persisted processedIds — the duplicate check then
          // silently swallows the bot's move (seen live: after the
          // room's first bot pass, every later bot action in a new
          // incarnation was treated as a retry and dropped).
          id: `bot-${crypto.randomUUID()}`,
          baseVersion: this.state.version,
          ...cmd,
        },
        () => {}
      );
      if (!applied) {
        console.log(
          `bot command refused: seat ${seat}, ${entry.key}, ${cmd.type}`
        );
        this.noteBotFailure(sig);
      } else {
        this.botAttempts.delete(sig);
      }
    }
  }

  /** A bot whose decision the server refuses three times at the
   *  same state version stops retrying until the state moves: a
   *  brain/server disagreement should stall loudly, not spin. */
  noteBotFailure(sig: string) {
    const cur = this.botAttempts.get(sig);
    if (cur && cur.version === this.state.version) {
      cur.count++;
    } else {
      this.botAttempts.set(sig, { version: this.state.version, count: 1 });
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
