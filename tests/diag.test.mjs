// The diagnostic-log test: the room's small persistent record of
// the moments a player can get stuck — seats claimed and
// reclaimed, commands refused and why, deals, voids (PR #51).
// Born of a live game that went wrong on 2026-11-11 while the
// room could tell us nothing. Drives the same joinSeat/runCommand
// surface as the incarnation suite, plus the admin-diag request.
//
// Run: npm run test:diag

import { Mahjong } from "./.build/server.mjs";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.log(`  FAIL - ${name} ${extra}`);
  }
}

function makeStorage() {
  const map = new Map();
  return {
    map,
    alarms: [],
    async get(key) {
      const v = map.get(key);
      return v === undefined ? undefined : structuredClone(v);
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async setAlarm(t) {
      this.alarms.push(t);
    },
    async deleteAlarm() {
      this.alarms.push(null);
    },
    async getAlarm() {
      return null;
    },
  };
}
function makeCtx(storage) {
  return {
    storage,
    id: { name: "diag-test" },
    getWebSockets: () => [],
    acceptWebSocket() {},
  };
}

const storage = makeStorage();
const room = new Mahjong(makeCtx(storage), {});
await room.onStart();

const joined = [];
for (const name of ["George", "Syd", "Kristina", "Maria"]) {
  joined.push(await room.joinSeat(name, ""));
}
check(
  "four seat claims logged",
  room.state.diag.filter((e) => e.kind === "join").length === 4,
  JSON.stringify(room.state.diag)
);

const mariaTok = joined[3].token;
const again = await room.joinSeat("Maria", mariaTok);
check("token reclaim returns the same seat", again.seat === 3);
const lastJoin = room.state.diag[room.state.diag.length - 1];
check(
  "reclaim logged with the phase",
  lastJoin.kind === "reclaim" && /lobby/.test(lastJoin.detail),
  JSON.stringify(lastJoin)
);

async function say(seat, type, extra = {}, baseOverride) {
  const view = room.viewFor(seat);
  const id = "t-" + Math.random().toString(36).slice(2);
  return room.runCommand(seat, {
    id,
    baseVersion: baseOverride ?? view.version,
    type,
    ...extra,
  });
}

await say(0, "start");
check(
  "the deal is logged",
  room.state.diag.some((e) => e.kind === "start")
);

// A pass on a stale base: refused, and the log says so.
const staleRes = await say(
  3,
  "pass",
  { tiles: room.viewFor(3).yourTiles.slice(0, 3), blind: 0 },
  0
);
check(
  "stale pass refused as stale",
  staleRes.messages.some((m) => m.type === "stale")
);
check(
  "stale refusal logged with both versions",
  room.state.diag.some(
    (e) => e.kind === "refuse" && e.seat === 3 && /stale base 0/.test(e.detail)
  ),
  JSON.stringify(room.state.diag.slice(-3))
);

// A pass of tiles the player does not hold: rejected, reasoned.
const hands = room.state.hands;
let badTile = null;
for (let s = 0; s < 4 && !badTile; s++) {
  if (s === 3) continue;
  const counts = new Map();
  hands[s].forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
  for (const [t, n] of counts) {
    const held = hands[3].filter((x) => x === t).length;
    if (n >= 2 && held <= 1) {
      badTile = t;
      break;
    }
  }
}
check("found a tile Maria cannot pass", badTile !== null);
const badRes = await say(3, "pass", {
  tiles: [badTile, badTile, badTile],
  blind: 0,
});
check(
  "illegal pass rejected",
  badRes.messages.some((m) => m.type === "rejected")
);
check(
  "illegal refusal logged with its reason",
  room.state.diag.some(
    (e) =>
      e.kind === "refuse" && /not in the player's hand/.test(e.detail)
  ),
  JSON.stringify(room.state.diag.slice(-3))
);

// The cap holds under a flood of refusals.
for (let i = 0; i < 60; i++) {
  await say(3, "pass", { tiles: [], blind: 0 }, 0);
}
check(
  "log capped at 50 entries",
  room.state.diag.length === 50,
  `length=${room.state.diag.length}`
);
check(
  "entries carry time, kind, seat, detail",
  room.state.diag.every(
    (e) =>
      typeof e.at === "number" &&
      typeof e.kind === "string" &&
      typeof e.seat === "number" &&
      typeof e.detail === "string"
  )
);

// The admin read-back returns the same log.
const res = await room.onRequest(
  new Request("http://diag.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "admin-diag", key: "" }),
  })
);
const body = await res.json();
check(
  "admin-diag returns the log",
  body.type === "diag" && body.entries.length === room.state.diag.length,
  JSON.stringify(body).slice(0, 120)
);

console.log(
  failures === 0
    ? `\n${checks}/${checks} checks passed`
    : `\n${failures}/${checks} checks FAILED`
);
process.exit(failures === 0 ? 0 : 1);
