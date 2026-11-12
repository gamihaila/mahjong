// The seeded fuzz suite: command storms against the room actor,
// checked against the invariants the design actually promises.
//
// Why this exists (2026-11-11): an evening of corner cases — a
// Charleston pass silently dying on a stale version, a room
// named "Mihaila%20" that the admin page could not wipe — raised
// George's question of how correctness could ever be verified.
// Not exhaustively; but the server state machine has sharp
// invariants, and a Durable Object serializes every command into
// a total order, so a "race" here is just a permutation of a
// sequence: reorder commands, duplicate them, send them stale,
// send them in the wrong phase, and a seeded run can replay any
// of it exactly. The seed is printed on failure; a failure that
// cannot be reproduced is an anecdote, not a bug report.
//
// The storm plays four human seats (bots traverse the same
// runCommand dispatch, so command-path coverage is the same) and
// mixes state-aware legal moves with adversarial ones: stale
// base versions, duplicated command ids, wrong-phase commands,
// passes naming tiles the seat does not hold, claims on one's
// own discard, resets mid-hand. After EVERY command it checks:
//
//   conservation — while a hand is dealt, the 152 tiles are all
//     accounted for exactly once across wall, hands, melds,
//     discards, the live window tile and an escrowed draw. (The
//     invariant that caught the 153rd tile in November 2026's
//     first week.)
//   protocol — a stale command and a duplicated (already
//     applied) command change nothing at all: same version, same
//     canonical state. Version never decreases.
//   structure — a claim window's tile sits in no hand, its
//     escrow belongs to the seat after the discarder, claims and
//     passes never overlap; a Charleston submission is always
//     3 tiles counting blind, blind only on the blind steps.
//   redaction — no seat's view contains more of any tile than
//     that seat's own rack plus the public tiles (melds,
//     discards, the live discard) can explain. Checked
//     periodically; secrecy ends at phase "over" by design.
//   lobby hygiene — in the lobby there is no dealt hand: no
//     tiles, no play or Charleston state, no deal snapshot.
//   restarts — every so often the room is rebuilt over the same
//     storage (a new incarnation) and must come back with the
//     identical canonical state.
//
// The escrow grace expiry is driven by hand (deadline forced
// into the past, then onAlarm), because the suite has no 2.5
// seconds to spare per window. Determinism is checked too: the
// first seed's storm runs twice and must end in the identical
// canonical state — Math.random is patched with the seeded PRNG
// for the duration, so the shuffle is part of the seed.
//
// Run: npm run test:fuzz
// Knobs: FUZZ_SEEDS (default 4, seeds 1..n), FUZZ_STEPS
// (commands per storm, default 1500 — a randomly played hand
// runs long, and the endgame paths are the point). A failure prints the seed,
// the step and the offending command, and exits non-zero.

import { Mahjong } from "./.build/server.mjs";

// ---------- seeded PRNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- harness (same stubs as the other suites) ----------
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
    id: { name: "fuzz-test" },
    getWebSockets: () => [],
    acceptWebSocket() {},
  };
}

// ---------- the canonical 152 ----------
const CANON = (() => {
  const counts = new Map();
  const add = (t, n) => counts.set(t, (counts.get(t) ?? 0) + n);
  for (const suit of ["b", "t", "c"])
    for (let r = 1; r <= 9; r++) add(`${suit}${r}`, 4);
  for (const w of ["N", "E", "S", "W"]) add(w, 4);
  for (const d of ["DG", "DR", "DW"]) add(d, 4);
  add("F", 8);
  add("J", 8);
  return counts;
})();
const CODES = [...CANON.keys()];

// ---------- canonical state (for no-mutation / restart /
// determinism comparisons): the game, minus the fields that are
// clocks, secrets or the diagnostic log. ----------
function canonical(state) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "diag" || k === "lastSeen" || k === "token") continue;
        if (k === "stepStartedAt" || k === "deadline") continue;
        out[k] = strip(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(strip(structuredClone(state)));
}

function countTiles(state) {
  const counts = new Map();
  const add = (t) => counts.set(t, (counts.get(t) ?? 0) + 1);
  state.wall.forEach(add);
  state.hands.forEach((h) => h.forEach(add));
  if (state.play) {
    state.play.melds.forEach((ms) => ms.forEach((m) => m.tiles.forEach(add)));
    state.play.discards.forEach(add);
    if (state.play.window) {
      add(state.play.window.tile);
      if (state.play.window.escrow) add(state.play.window.escrow.tile);
    }
  }
  return counts;
}

// ---------- failure bookkeeping ----------
let failures = 0;
let invariantChecks = 0;
function fail(seed, step, where, detail, cmd) {
  failures++;
  console.log(`  FAIL - seed ${seed} step ${step} [${where}] ${detail}`);
  if (cmd) console.log(`    command: ${JSON.stringify(cmd)}`);
  console.log(`    reproduce: FUZZ_SEEDS=${seed} npm run test:fuzz`);
}

// ---------- the storm ----------
async function storm(seed, steps, rng) {
  const storage = makeStorage();
  let room = new Mahjong(makeCtx(storage), {});
  await room.onStart();
  const counters = {
    applied: 0, rejected: 0, stale: 0, dup: 0, hands: 0, voids: 0,
    wallGames: 0, wins: 0, claims: 0, escrows: 0, expiries: 0,
    exchanges: 0, restarts: 0,
  };
  const st = () => room.state;

  // Seat four fuzz players with adoptable proposed tokens; a
  // token reclaim must return the same seat, and a fifth join
  // must not create a fifth seat.
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    const tok = `fuzztoken-seed${seed}-p${i}`; // >= 16 chars: adoptable
    const res = await room.joinSeat(`Fuzz${i}`, tok);
    if ("error" in res || res.seat !== i) {
      fail(seed, -1, "join", `seat ${i} join failed: ${JSON.stringify(res)}`);
      return { counters, finalHash: "" };
    }
    tokens.push(tok);
  }
  const re = await room.joinSeat("Fuzz0", tokens[0]);
  if ("error" in re || re.seat !== 0)
    fail(seed, -1, "join", "token reclaim did not return seat 0");
  const fifth = await room.joinSeat("Extra", `fuzztoken-seed${seed}-p9`);
  if (!("error" in fifth) && st().seats.length !== 4)
    fail(seed, -1, "join", "a fifth seat appeared");

  let lastApplied = null; // {seat, cmd} for duplicate generation
  let wasOver = false;
  let wasCharleston = false;

  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const chance = (p) => rng() < p;

  function baseVersion(seat) {
    if (chance(0.08)) return Math.max(0, st().version - 1 - Math.floor(rng() * 2));
    return room.viewFor(seat).version;
  }

  function genCommand(step) {
    const s = st();
    const phase = s.phase;
    let seat = Math.floor(rng() * s.seats.length);
    let type;
    let extra = {};

    if (phase === "lobby") {
      const r = rng();
      if (r < 0.6) type = "start";
      else if (r < 0.7) type = "reset";
      else if (r < 0.8) {
        type = "removeSeat";
        extra = { seat: Math.floor(rng() * s.seats.length) };
      } else if (r < 0.9) type = "discard";
      else type = "draw";
    } else if (phase === "charleston" && s.charleston) {
      const c = s.charleston;
      if (c.voidFrom !== null && chance(0.75)) {
        type = "voidVote";
        extra = { agree: chance(0.75) };
      } else if (chance(0.08)) {
        type = "voidPropose";
      } else if (chance(0.03)) {
        type = "reset";
      } else {
        // A pass: mostly legal, sometimes not.
        type = "pass";
        const pending = c.passes
          .map((p, i) => (p === null ? i : -1))
          .filter((i) => i >= 0);
        if (pending.length) seat = pick(pending);
        const hand = s.hands[seat] ?? [];
        const blindStep = c.step === 2 || c.step === 5;
        const glitch = rng();
        if (glitch < 0.06) {
          // Tiles some other seat holds (or nonsense): illegal.
          const other = s.hands[(seat + 1) % s.seats.length] ?? [];
          extra = { tiles: other.slice(0, 3), blind: 0 };
        } else if (glitch < 0.1) {
          extra = { tiles: hand.slice(0, 2), blind: 0 }; // too few
        } else if (glitch < 0.14 && !blindStep) {
          extra = { tiles: hand.slice(0, 2), blind: 1 }; // blind, wrong step
        } else {
          const blind = blindStep ? Math.floor(rng() * 4) : 0;
          extra = { tiles: hand.slice(0, 3 - blind), blind };
        }
      }
    } else if (phase === "playing" && s.play) {
      const p = s.play;
      const n = s.seats.length;
      if (p.window) {
        const w = p.window;
        const responders = [];
        for (let i = 0; i < n; i++) {
          if (i === w.from) continue;
          if (!w.passed.includes(i) && !w.claims.some((cl) => cl.seat === i))
            responders.push(i);
        }
        const r = rng();
        if (r < 0.34 && responders.length) {
          seat = pick(responders);
          type = "pass";
        } else if (r < 0.62 && responders.length) {
          seat = pick(responders);
          // Claim what the rack can actually compose (the server's
          // own arithmetic), so claims resolve into melds instead
          // of mostly bouncing off; a few wild claims stay in the
          // mix for the refusal path.
          const hand = s.hands[seat] ?? [];
          const nat = hand.filter((t) => t === w.tile).length;
          const jok = hand.filter((t) => t === "J").length;
          const can = (need) =>
            Math.min(nat, need) + Math.min(jok, need - Math.min(nat, need)) === need;
          type = "claim";
          if (chance(0.12)) extra = { kind: "mahjong" };
          else if (can(3) && chance(0.4)) extra = { kind: "kong" };
          else if (can(2)) extra = { kind: "pung" };
          else extra = { kind: pick(["pung", "kong"]) };
        } else if (r < 0.8) {
          seat = (w.from + 1) % n; // the escrow draw
          type = "draw";
        } else if (r < 0.88) {
          seat = w.from; // the discarder may not answer their own tile
          type = pick(["pass", "claim"]);
          if (type === "claim") extra = { kind: "pung" };
        } else {
          type = pick(["discard", "draw", "reset"]);
          if (type === "discard") extra = { tile: pick(s.hands[seat] ?? ["F"]) };
        }
      } else {
        seat = p.turn;
        const hand = s.hands[seat] ?? [];
        if (!p.hasDrawn) {
          const r = rng();
          if (r < 0.72) type = "draw";
          else if (r < 0.8) type = "declareMahjong";
          else if (r < 0.9) {
            type = "discard"; // before drawing: refused
            extra = { tile: pick(hand) };
          } else type = "reset";
        } else {
          const r = rng();
          // A joker exchange, when the table offers one.
          let exchange = null;
          p.melds.forEach((ms, owner) =>
            ms.forEach((m, meld) => {
              if (exchange || !m.tiles.includes("J")) return;
              const natural = m.tiles.find((t) => t !== "J");
              if (natural && hand.includes(natural))
                exchange = { owner, meld, tile: natural };
            })
          );
          if (r < 0.62) {
            type = "discard";
            extra = { tile: pick(hand) };
          } else if (r < 0.7) type = "declareMahjong";
          else if (r < 0.8 && exchange) {
            type = "exchange";
            extra = exchange;
          } else if (r < 0.88) {
            type = "discard";
            extra = { tile: "ZZ" }; // a tile nobody holds
          } else if (r < 0.94) type = "draw"; // twice: refused
          else type = "start"; // wrong phase
        }
      }
    } else {
      // phase "over"
      const r = rng();
      if (r < 0.72) type = "reset";
      else if (r < 0.85) type = "start";
      else type = pick(["discard", "draw", "pass"]);
      if (type === "discard") extra = { tile: "F" };
      if (type === "pass") extra = { tiles: [], blind: 0 };
    }

    // Seasoning: the protocol-level attacks ride on any command.
    let forceStale = false;
    let cmd;
    if (lastApplied && chance(0.04)) {
      // An exact duplicate of an applied command: must ack and
      // change nothing.
      cmd = { ...lastApplied.cmd };
      seat = lastApplied.seat;
      counters.dup++;
      return { seat, cmd, expectFrozen: true };
    }
    if (chance(0.08) && st().version > 0) forceStale = true;
    cmd = {
      id: `fz${seed}-${step}`,
      baseVersion: forceStale
        ? Math.max(0, st().version - 1)
        : baseVersion(seat),
      type,
      ...extra,
    };
    if (forceStale) counters.stale++;
    return { seat, cmd, expectFrozen: forceStale };
  }

  function checkInvariants(step, cmd) {
    const s = st();
    invariantChecks++;
    // Conservation / lobby hygiene.
    if (s.phase === "charleston" || s.phase === "playing" || s.phase === "over") {
      const counts = countTiles(s);
      for (const [code, n] of CANON) {
        if ((counts.get(code) ?? 0) !== n) {
          fail(seed, step, "conservation",
            `tile ${code}: accounted ${counts.get(code) ?? 0}, expected ${n} (phase ${s.phase})`, cmd);
          break;
        }
      }
      for (const code of counts.keys()) {
        if (!CANON.has(code)) {
          fail(seed, step, "conservation", `unknown tile code ${code} in state`, cmd);
          break;
        }
      }
    } else {
      if (s.hands.length !== 0 || s.wall.length !== 0 || s.play !== null ||
          s.charleston !== null || s.deal !== null) {
        fail(seed, step, "lobby-hygiene",
          `lobby holds hand debris: hands=${s.hands.length} wall=${s.wall.length} play=${!!s.play} charleston=${!!s.charleston} deal=${!!s.deal}`, cmd);
      }
    }
    // Window structure.
    const w = s.play?.window;
    if (w) {
      const n = s.seats.length;
      // (The live tile may share its code with copies in racks —
      // four of each exist. Duplication of the physical tile is
      // conservation's job, checked above as a multiset.)
      if (w.escrow && w.escrow.seat !== (w.from + 1) % n)
        fail(seed, step, "window", `escrow held by seat ${w.escrow.seat}, expected ${(w.from + 1) % n}`, cmd);
      const claimSeats = w.claims.map((cl) => cl.seat);
      if (new Set(claimSeats).size !== claimSeats.length)
        fail(seed, step, "window", "a seat holds two claims", cmd);
      if (claimSeats.includes(w.from))
        fail(seed, step, "window", "the discarder claimed their own tile", cmd);
      if (w.passed.includes(w.from))
        fail(seed, step, "window", "the discarder passed on their own tile", cmd);
      if (claimSeats.some((x) => w.passed.includes(x)))
        fail(seed, step, "window", "a seat both claimed and passed", cmd);
    }
    // Charleston structure.
    const c = s.charleston;
    if (c) {
      if (c.step < 0 || c.step > 5)
        fail(seed, step, "charleston", `step ${c.step} out of range`, cmd);
      c.passes.forEach((p, i) => {
        if (!p) return;
        if (p.tiles.length + p.blind !== 3)
          fail(seed, step, "charleston", `seat ${i} submission totals ${p.tiles.length + p.blind}, not 3`, cmd);
        if (p.blind > 0 && !(c.step === 2 || c.step === 5))
          fail(seed, step, "charleston", `seat ${i} blind pass on step ${c.step}`, cmd);
      });
    }
    // Redaction, periodically.
    if (step % 10 === 0 && (s.phase === "charleston" || s.phase === "playing")) {
      for (let a = 0; a < s.seats.length; a++) {
        const allowed = new Map();
        const allow = (t) => allowed.set(t, (allowed.get(t) ?? 0) + 1);
        (s.hands[a] ?? []).forEach(allow);
        if (s.play) {
          s.play.melds.forEach((ms) => ms.forEach((m) => m.tiles.forEach(allow)));
          s.play.discards.forEach(allow);
          if (s.play.window) allow(s.play.window.tile);
        }
        const json = JSON.stringify(room.viewFor(a));
        for (const code of CODES) {
          const seen = json.split(`"${code}"`).length - 1;
          if (seen > (allowed.get(code) ?? 0)) {
            fail(seed, step, "redaction",
              `seat ${a}'s view shows ${seen} of ${code}; own rack + public tiles explain ${allowed.get(code) ?? 0}`, cmd);
            break;
          }
        }
      }
    }
  }

  for (let step = 0; step < steps; step++) {
    // Hand-boundary bookkeeping for the coverage summary.
    if (st().phase === "over" && !wasOver) {
      counters.hands++;
      if (st().play?.drawGame) counters.wallGames++;
      if (st().play?.winner !== null && st().play?.winner !== undefined)
        counters.wins++;
    }
    wasOver = st().phase === "over";
    if (st().phase === "lobby" && wasCharleston) counters.voids++;
    wasCharleston = st().phase === "charleston" || (st().phase === "playing");

    const { seat, cmd, expectFrozen } = genCommand(step);
    const beforeVersion = st().version;
    const beforeHash = expectFrozen ? canonical(st()) : null;
    let res;
    try {
      res = await room.runCommand(seat, cmd);
    } catch (e) {
      fail(seed, step, "exception", String(e?.stack ?? e).slice(0, 400), cmd);
      break;
    }
    const types = (res?.messages ?? []).map((m) => m.type);
    if (types.includes("ack")) {
      counters.applied++;
      lastApplied = { seat, cmd };
      if (cmd.type === "claim") counters.claims++;
      if (cmd.type === "exchange") counters.exchanges++;
    } else if (types.includes("stale")) {
      // counted at generation when forced; a natural stale (the
      // version moved under a fresh command) is fine too.
    } else if (types.includes("rejected")) {
      counters.rejected++;
    }
    if (st().play?.window?.escrow) counters.escrows++;

    if (expectFrozen) {
      invariantChecks++;
      if (st().version !== beforeVersion || canonical(st()) !== beforeHash) {
        fail(seed, step, "protocol",
          `${cmd.type} (id ${cmd.id}) was ${cmd.baseVersion !== beforeVersion ? "stale" : "a duplicate"} but the state moved`, cmd);
      }
    } else if (st().version < beforeVersion) {
      fail(seed, step, "protocol", `version decreased ${beforeVersion} -> ${st().version}`, cmd);
    }

    checkInvariants(step, cmd);
    if (failures > 6) break;

    // Escrow grace expiry, driven by hand.
    if (st().play?.window?.escrow && chance(0.35)) {
      st().play.window.escrow.deadline = 0;
      try {
        await room.onAlarm();
        counters.expiries++;
      } catch (e) {
        fail(seed, step, "exception", `onAlarm: ${String(e?.stack ?? e).slice(0, 300)}`, cmd);
        break;
      }
      checkInvariants(step, cmd);
    }

    // A restart: a new incarnation over the same storage must
    // come back with the identical canonical state.
    if (step % 97 === 96) {
      const hashBefore = canonical(st());
      room = new Mahjong(makeCtx(storage), {});
      await room.onStart();
      counters.restarts++;
      invariantChecks++;
      if (canonical(st()) !== hashBefore)
        fail(seed, step, "restart", "state changed across a reconstruction", cmd);
      checkInvariants(step, cmd);
    }
    if (failures > 6) break;
  }

  return { counters, finalHash: canonical(st()) };
}

// ---------- run ----------
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 4);
const STEPS = Number(process.env.FUZZ_STEPS ?? 1500);
const realRandom = Math.random;

for (let seed = 1; seed <= SEEDS; seed++) {
  const rng = mulberry32(seed);
  Math.random = rng;
  try {
    const { counters } = await storm(seed, STEPS, rng);
    console.log(
      `seed ${seed}: ${counters.applied} applied, ${counters.rejected} rejected, ` +
      `${counters.stale} forced-stale, ${counters.dup} duplicates, ${counters.hands} hands ` +
      `(${counters.wallGames} wall games, ${counters.wins} wins, ${counters.voids} voids), ` +
      `${counters.claims} claims, ${counters.escrows} escrow sightings, ${counters.expiries} expiries, ` +
      `${counters.exchanges} exchanges, ${counters.restarts} restarts`
    );
  } finally {
    Math.random = realRandom;
  }
  if (failures > 6) break;
}

// Determinism: the same seed, run twice, lands identically.
{
  const rngA = mulberry32(1);
  Math.random = rngA;
  let a;
  try {
    a = await storm(1, Math.min(STEPS, 400), rngA);
  } finally {
    Math.random = realRandom;
  }
  const rngB = mulberry32(1);
  Math.random = rngB;
  let b;
  try {
    b = await storm(1, Math.min(STEPS, 400), rngB);
  } finally {
    Math.random = realRandom;
  }
  invariantChecks++;
  if (a.finalHash !== b.finalHash)
    fail(1, -2, "determinism", "two runs of seed 1 ended in different states");
  else console.log("determinism: seed 1 run twice, identical final state");
}

console.log(
  failures === 0
    ? `\nfuzz clean: ${invariantChecks} invariant checks across ${SEEDS} seeds x ${STEPS} steps`
    : `\n${failures} FAILURE(S) — see above; each names its seed and step`
);
process.exit(failures === 0 ? 0 : 1);
