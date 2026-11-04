import type * as Party from "partykit/server";
import { buildWall, shuffle, sortTiles, type Tile } from "../src/tiles";

// Slice 1 of the design in DESIGN.md:
// - One room = one Durable Object = a single-threaded actor. Every
//   command is serialized through onMessage, so the game has a total
//   order of events by construction.
// - Event-sourced: clients send commands, never state. A legal command
//   appends an event to the log; state is the fold of that log (here
//   kept materialized, with a snapshot in room storage).
// - Redaction: the full state (wall, all racks) never leaves this
//   object. Each connection receives a per-seat view computed here.
// - Commands carry a client-generated id (deduplicated: at-least-once
//   delivery, exactly-once effect) and the state version the client
//   acted on (CAS: a mismatch is answered with "stale" + fresh view).
// - Seats are reclaimed across reconnects with a seat token.

type Phase = "lobby" | "dealt";

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

interface GameState {
  phase: Phase;
  seats: Seat[];
  hands: Tile[][];
  wall: Tile[];
  version: number;
  log: GameEvent[];
  processedIds: string[];
}

interface Command {
  id: string;
  baseVersion: number;
  type: string;
}

const MAX_SEATS = 4;
const PROCESSED_CAP = 200;

function freshState(): GameState {
  return {
    phase: "lobby",
    seats: [],
    hands: [],
    wall: [],
    version: 0,
    log: [],
    processedIds: [],
  };
}

export default class MahjongServer implements Party.Server {
  state: GameState = freshState();

  constructor(readonly room: Party.Room) {}

  async onStart() {
    const saved = await this.room.storage.get<GameState>("state");
    if (saved) this.state = saved;
  }

  async persist() {
    await this.room.storage.put("state", this.state);
  }

  /** The redacted projection for one seat. This is the ONLY game data
   *  a client ever receives: own tiles, everyone else's counts. */
  viewFor(seatIdx: number) {
    const s = this.state;
    return {
      type: "view",
      version: s.version,
      phase: s.phase,
      you: seatIdx,
      yourTiles: seatIdx >= 0 ? sortTiles(s.hands[seatIdx] ?? []) : [],
      seats: s.seats.map((seat, i) => ({
        name: seat.name,
        connected: seat.connected,
        tileCount: s.hands[i]?.length ?? 0,
      })),
      wallCount: s.wall.length,
    };
  }

  broadcastViews() {
    for (const conn of this.room.getConnections()) {
      const seat = (conn.state as { seat?: number } | null)?.seat ?? -1;
      conn.send(JSON.stringify(this.viewFor(seat)));
    }
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
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
      JSON.stringify({ type: "seated", seat: seatIdx, token: s.seats[seatIdx].token })
    );
    await this.persist();
    this.broadcastViews();
  }

  async onClose(conn: Party.Connection) {
    const seatIdx = (conn.state as { seat?: number } | null)?.seat;
    if (seatIdx !== undefined && this.state.seats[seatIdx]) {
      this.state.seats[seatIdx].connected = false;
      await this.persist();
      this.broadcastViews();
    }
  }

  appendEvent(type: string, seat?: number, detail?: string) {
    this.state.log.push({ seq: this.state.log.length + 1, type, seat, detail });
  }

  async onMessage(message: string, sender: Party.Connection) {
    const seatIdx = (sender.state as { seat?: number } | null)?.seat ?? -1;
    let cmd: Command;
    try {
      cmd = JSON.parse(message as string) as Command;
    } catch {
      return;
    }
    const s = this.state;

    // Idempotency: a retried command is acknowledged, not re-applied.
    if (s.processedIds.includes(cmd.id)) {
      sender.send(JSON.stringify({ type: "ack", id: cmd.id, version: s.version }));
      sender.send(JSON.stringify(this.viewFor(seatIdx)));
      return;
    }
    // Optimistic concurrency: the client acted on a stale version.
    if (cmd.baseVersion !== s.version) {
      sender.send(JSON.stringify({ type: "stale", id: cmd.id }));
      sender.send(JSON.stringify(this.viewFor(seatIdx)));
      return;
    }

    let applied = false;
    if (cmd.type === "start" && s.phase === "lobby" && s.seats.length > 0) {
      // Trusted shuffle, then a simple sequential deal (the ceremonial
      // 4-4-4-1 wall break is cosmetic; slice 2 can add it).
      s.wall = shuffle(buildWall());
      s.hands = s.seats.map(() => s.wall.splice(0, 13));
      s.hands[0].push(...s.wall.splice(0, 1)); // East starts with 14
      s.phase = "dealt";
      this.appendEvent("start", seatIdx, `${s.seats.length} players`);
      applied = true;
    } else if (cmd.type === "reset") {
      s.phase = "lobby";
      s.hands = [];
      s.wall = [];
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
      sender.send(JSON.stringify({ type: "ack", id: cmd.id, version: s.version }));
      this.broadcastViews();
    } else {
      sender.send(
        JSON.stringify({ type: "rejected", id: cmd.id, version: s.version })
      );
    }
  }
}

MahjongServer satisfies Party.Worker;
