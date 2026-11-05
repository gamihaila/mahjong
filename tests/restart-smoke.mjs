// Restart smoke test: a room must survive the server PROCESS
// being killed and restarted mid-Charleston — state (seats,
// tokens, racks, the barrier) is persisted, the human rejoins
// with their token and reclaims their seat, and play continues.
// This guards the persistence/rejoin seam end to end through the
// real stack, over the same HTTP transport the browser uses.
// It does NOT reproduce production's hibernation timing (the
// dev server keeps one object incarnation per process); the
// incarnation boundary itself is covered, deterministically,
// by tests/incarnation.test.mjs.
//
// Run: npm run test:restart   (spawns wrangler dev on port 8899)

import { spawn } from "node:child_process";

const PORT = 8899;
// A unique room per run: wrangler dev persists DO storage across
// runs, and a fixed room name collides with the last run's
// mid-Charleston leftovers (a fresh join is refused mid-hand).
const ROOM_URL = `http://127.0.0.1:${PORT}/parties/mahjong/restart-smoke-${Date.now()}`;
let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok - ${name}`);
  else {
    failures++;
    console.log(`  FAIL - ${name}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
    detached: true,
  });
  return child;
}
async function waitUp(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) return true;
    } catch {}
    await sleep(750);
  }
  return false;
}
function stopServer(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

async function api(body) {
  const r = await fetch(ROOM_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// A minimal polling client, shaped like the browser's: join once,
// then commands (whose responses carry the fresh view) and polls
// by version.
let idSeq = 0;
async function join(name, savedToken = "") {
  const res = await api({ action: "join", name, token: savedToken });
  if (res.type === "error") throw new Error(`join failed: ${res.error}`);
  return { seat: res.seat, token: res.token, view: res.view };
}
async function cmd(client, type, extra = {}) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await api({
      action: "command",
      token: client.token,
      cmd: {
        id: `s${++idSeq}`,
        baseVersion: client.view?.version ?? 0,
        type,
        ...extra,
      },
    });
    if (res.view) client.view = res.view;
    const kinds = (res.messages ?? []).map((m) => m.type);
    if (kinds.includes("ack")) return true;
    if (kinds.includes("rejected")) return false;
    await sleep(60); // stale base version: sync from the response and retry
  }
  return false;
}
async function poll(client) {
  const res = await api({
    action: "poll",
    token: client.token,
    since: client.view?.version ?? -1,
  });
  if (res.view) client.view = res.view;
}
// Wait for a condition while polling like a real client would.
async function waitFor(client, fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await poll(client);
    await sleep(150);
  }
  return fn();
}

// Phase A: fill the table, deal, everyone passes step 1.
let server = startServer();
if (!(await waitUp())) {
  console.log("server did not come up");
  process.exit(1);
}
const a = await join("Host");
await cmd(a, "addBot");
await cmd(a, "addBot");
await cmd(a, "addBot");
await cmd(a, "start");
await waitFor(a, () => a.view?.phase === "charleston");
await cmd(a, "pass", { tiles: a.view.yourTiles.slice(0, 3), blind: 0 });
check(
  "phase A: bots pass step 1 and the step advances",
  await waitFor(a, () => a.view?.charleston?.step === 1)
);
const savedToken = a.token;
stopServer(server);
await sleep(1500);

// Phase B: fresh process, same persisted state. Rejoining with
// the token reclaims the seat — the polling model's whole story.
server = startServer();
if (!(await waitUp())) {
  console.log("server did not come back up");
  process.exit(1);
}
const b = await join("Host", savedToken);
await waitFor(b, () => b.view?.phase === "charleston");
check("phase B: seat reclaimed by token", b.seat === 0);
check(
  "phase B: room still mid-charleston at step 2",
  b.view?.phase === "charleston" && b.view?.charleston?.step === 1
);
await cmd(b, "pass", { tiles: b.view.yourTiles.slice(0, 3), blind: 0 });
check(
  "phase B: bots pass step 2 after the restart",
  await waitFor(b, () => b.view?.charleston?.step === 2)
);
stopServer(server);
console.log(failures ? `\n${failures} FAILED` : "\nrestart smoke passed");
process.exit(failures ? 1 : 0);
