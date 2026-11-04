// The incarnation test: a regression net for the class of bug
// that only exists because a Durable Object is put to sleep and
// woken as a FRESH instance over PERSISTED state. Anything kept
// in instance memory is reborn at zero on every wake; anything in
// storage is remembered forever. Code that mixes the two (an
// in-memory id counter judged by a persisted idempotency log —
// PR #17) works in every ordinary test and stalls in production.
//
// This test builds the room twice over one shared storage stub:
// incarnation A seats a human and three bots and plays two
// Charleston steps; incarnation B is then constructed over the
// same storage and must, in its very first alarm cycle, land all
// three bots' passes for the next step. On the pre-#17 code B's
// dispatches are numbered bot-1, bot-2, bot-3 into a log that
// already contains them, every one is swallowed as a "duplicate",
// and the step never completes — deterministically.
//
// Run: npm run test:incarnation

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Storage stub: Map-backed, with structured-clone semantics
// on the way in AND out, so no object identity leaks across the
// incarnation boundary (a real DO serializes). Alarm calls are
// recorded in a shared log.
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
    id: { name: "incarnation-test" },
    getWebSockets: () => [],
    acceptWebSocket() {},
  };
}

// --- A fake connection: just what the room's handlers touch.
function fakeConn() {
  return {
    id: `fake-${Math.random().toString(36).slice(2)}`,
    state: null,
    inbox: [],
    setState(patch) {
      this.state = { ...(this.state ?? {}), ...patch };
    },
    send(str) {
      this.inbox.push(JSON.parse(str));
    },
    close() {},
    lastView() {
      for (let i = this.inbox.length - 1; i >= 0; i--) {
        if (this.inbox[i].type === "view") return this.inbox[i];
      }
      return null;
    },
  };
}

async function hostSay(room, conn, type, extra = {}) {
  const view = conn.lastView() ?? room.viewFor(0);
  const id = `host-${Math.random().toString(36).slice(2)}`;
  await room.onMessage(
    conn,
    JSON.stringify({ id, baseVersion: view?.version ?? 0, type, ...extra })
  );
}

// Deliver alarms on this incarnation until the Charleston step
// advances past `step`, or give up.
async function driveUntilStep(room, step, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((room.state.charleston?.step ?? -1) > step) return true;
    await sleep(2300);
    await room.onAlarm();
  }
  return (room.state.charleston?.step ?? -1) > step;
}

const storage = makeStorage();

// ---------- Incarnation A ----------
const roomA = new Mahjong(makeCtx(storage), {});
await roomA.onStart();
const hostA = fakeConn();
await roomA.onConnect(hostA, {
  request: new Request(
    "https://test/parties/mahjong/it?token=host-token&name=Host"
  ),
});
check("A: host seated", hostA.state?.seat === 0);
await hostSay(roomA, hostA, "addBot");
await hostSay(roomA, hostA, "addBot");
await hostSay(roomA, hostA, "addBot");
check("A: full table", roomA.state.seats.length === 4);
await hostSay(roomA, hostA, "start");
check("A: charleston began", roomA.state.phase === "charleston");

for (const step of [0, 1]) {
  const view = roomA.viewFor(0);
  await hostSay(roomA, hostA, "pass", {
    tiles: view.yourTiles.slice(0, 3),
    blind: 0,
  });
  check(
    `A: bots complete step ${step + 1}`,
    await driveUntilStep(roomA, step),
    `step=${roomA.state.charleston?.step}`
  );
}
const botIdsA = roomA.state.processedIds.filter((x) => x.startsWith("bot-"));
check(
  "A: bot dispatches recorded in the persisted log",
  botIdsA.length >= 6,
  `found ${botIdsA.length}`
);

// ---------- The boundary: A is discarded entirely. ----------
const roomB = new Mahjong(makeCtx(storage), {});
await roomB.onStart();
check(
  "B: state reloaded at the next charleston step",
  roomB.state.phase === "charleston" && roomB.state.charleston?.step === 2,
  `phase=${roomB.state.phase} step=${roomB.state.charleston?.step}`
);

// The host's browser reconnects after the nap and reclaims its seat.
const hostB = fakeConn();
await roomB.onConnect(hostB, {
  request: new Request(
    "https://test/parties/mahjong/it?token=host-token&name=Host"
  ),
});
check("B: host reclaims seat 0 by token", hostB.state?.seat === 0);

const viewB = roomB.viewFor(0);
await hostSay(roomB, hostB, "pass", {
  tiles: viewB.yourTiles.slice(0, 3),
  blind: 0,
});

// One alarm cycle, after every bot delay has lapsed. This is the
// assertion the bug fails: a fresh incarnation's first bot moves
// must APPLY, not be read as retries of a previous life.
await sleep(2300);
await roomB.onAlarm();
check(
  "B: all three bots' passes land in B's first alarm cycle",
  roomB.state.charleston?.step === 3,
  `step=${roomB.state.charleston?.step} passes=${JSON.stringify(
    roomB.state.charleston?.passes.map((p) => p !== null)
  )}`
);

const totalTiles =
  roomB.state.hands.reduce((n, h) => n + h.length, 0) + roomB.state.wall.length;
check("B: tile conservation across the boundary", totalTiles === 152, `=${totalTiles}`);

// ---------- Part 2: the overdue wake ----------
// A bot cue falls due while the object sleeps. The alarm that
// wakes it IS that cue's deadline: the fresh incarnation must
// execute the cue, not hand the bot a fresh delay. (When the
// queue lived only in memory, every wake re-delayed every cue,
// and under hibernation churn a routine bot move could be
// postponed for minutes — the family4 stall.)
const storage2 = makeStorage();
const roomA2 = new Mahjong(makeCtx(storage2), {});
await roomA2.onStart();
const hostA2 = fakeConn();
await roomA2.onConnect(hostA2, {
  request: new Request(
    "https://test/parties/mahjong/it2?token=host2-token&name=Host"
  ),
});
await hostSay(roomA2, hostA2, "addBot");
await hostSay(roomA2, hostA2, "addBot");
await hostSay(roomA2, hostA2, "addBot");
await hostSay(roomA2, hostA2, "start");
const viewA2 = roomA2.viewFor(0);
await hostSay(roomA2, hostA2, "pass", {
  tiles: viewA2.yourTiles.slice(0, 3),
  blind: 0,
});
const dueTimes = [...roomA2.botQueue.values()].map((e) => e.at);
check(
  "A2: cue due times are integers (a fractional due time can read as not-due when its own alarm fires)",
  dueTimes.every((x) => Number.isInteger(x)),
  JSON.stringify(dueTimes)
);
check(
  "A2: three bot cues are pending",
  dueTimes.length === 3,
  `found ${dueTimes.length}`
);
// Let every cue fall overdue, then wake a fresh incarnation and
// deliver its alarm immediately — the production sequence.
await sleep(Math.max(...dueTimes) - Date.now() + 300);
const roomB2 = new Mahjong(makeCtx(storage2), {});
await roomB2.onStart();
await roomB2.onAlarm();
check(
  "B2: the overdue cues execute on the wake, not re-delayed",
  roomB2.state.charleston?.step === 1,
  `step=${roomB2.state.charleston?.step}`
);

console.log(
  `\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`
);
process.exit(failures ? 1 : 0);
