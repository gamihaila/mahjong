/// <reference types="@cloudflare/workers-types" />
import { Server } from "partyserver";

// The room registry: a singleton object that knows which rooms
// exist, so the admin page can list them and clean up the dead
// ones. Durable Objects cannot enumerate their siblings, so each
// room reports itself here on the events that matter — a seat
// joins, a hand starts, a hand ends, the room wakes (see
// noteRegistry in server.ts). Entries are summaries only: name,
// seat counts, phase, and when the room last reported. The
// registry never sees game state.
//
// Housekeeping actions (list, forget) and the rooms' own admin
// wipe are gated by a shared key when the ADMIN_KEY secret is
// set; without the secret (local dev) they are open.

export interface RoomEntry {
  name: string;
  seats: number;
  humans: number;
  phase: string;
  updatedAt: number;
}

interface Env {
  Registry: DurableObjectNamespace<RoomRegistry>;
  ADMIN_KEY?: string;
}

export function keyOk(env: { ADMIN_KEY?: string }, given: unknown): boolean {
  if (!env.ADMIN_KEY) return true; // no secret configured: dev mode
  return typeof given === "string" && given === env.ADMIN_KEY;
}

export class RoomRegistry extends Server<Env> {
  async onRequest(req: Request): Promise<Response> {
    let body: {
      action?: string;
      room?: string;
      seats?: number;
      humans?: number;
      phase?: string;
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
    if (body.action === "register" && body.room) {
      // Rooms identify themselves; a forged entry costs nothing
      // but a phantom row on the admin page, so this one is open.
      const entry: RoomEntry = {
        name: body.room,
        seats: body.seats ?? 0,
        humans: body.humans ?? 0,
        phase: body.phase ?? "lobby",
        updatedAt: Date.now(),
      };
      await this.ctx.storage.put(`room:${entry.name}`, entry);
      return Response.json({ type: "ok" });
    }
    if (body.action === "forget" && body.room) {
      if (!keyOk(this.env, body.key)) {
        return Response.json(
          { type: "error", error: "bad-key" },
          { status: 403 }
        );
      }
      await this.ctx.storage.delete(`room:${body.room}`);
      return Response.json({ type: "ok" });
    }
    if (body.action === "list") {
      if (!keyOk(this.env, body.key)) {
        return Response.json(
          { type: "error", error: "bad-key" },
          { status: 403 }
        );
      }
      const map = await this.ctx.storage.list<RoomEntry>({
        prefix: "room:",
      });
      const rooms = [...map.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt
      );
      return Response.json({ type: "rooms", rooms });
    }
    return Response.json(
      { type: "error", error: "unknown-action" },
      { status: 400 }
    );
  }
}
