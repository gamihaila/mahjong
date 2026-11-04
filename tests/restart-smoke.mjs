// Restart smoke test: a room must survive the server PROCESS
// being killed and restarted mid-Charleston — state (seats,
// tokens, racks, the barrier) is persisted, the human reclaims
// their seat by token, and play continues. This guards the
// persistence/rejoin seam end to end through the real stack.
// It does NOT reproduce production's hibernation timing (the
// dev server keeps one object incarnation per process); the
// incarnation boundary itself is covered, deterministically,
// by tests/incarnation.test.mjs.
//
// Run: npm run test:restart   (spawns wrangler dev on port 8899)

import { spawn } from "node:child_process";

const PORT = 8899;
const BASE = `ws://127.0.0.1:${PORT}/parties/mahjong`;
const ROOM = "restart-smoke";
const TOKEN = "restart-smoke-token";
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

let idSeq = 0;
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/${ROOM}?name=${name}&token=${TOKEN}`);
    const client = { ws, view: null, seat: -1, pending: new Map() };
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "seated") {
        client.seat = msg.seat;
        resolve(client);
      } else if (msg.type === "view") client.view = msg;
      else if (msg.id && client.pending.has(msg.id)) {
        client.pending.get(msg.id)(msg.type);
        client.pending.delete(msg.id);
      }
    });
    ws.addEventListener("error", reject);
  });
}
async function cmd(client, type, extra = {}) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = `s${++idSeq}`;
    const result = await new Promise((res) => {
      client.pending.set(id, res);
      client.ws.send(
        JSON.stringify({ id, baseVersion: client.view?.version ?? 0, type, ...extra })
      );
      setTimeout(() => res("timeout"), 4000);
    });
    if (result === "ack") return true;
    if (result === "rejected") return false;
    await sleep(60);
  }
  return false;
}
async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(90);
  }
  return false;
}

// Phase A: fill the table, deal, everyone passes step 1.
let server = startServer();
if (!(await waitUp())) {
  console.log("server did not come up");
  process.exit(1);
}
const a = await connect("Host");
await cmd(a, "addBot");
await cmd(a, "addBot");
await cmd(a, "addBot");
await cmd(a, "start");
await waitFor(() => a.view?.phase === "charleston");
await cmd(a, "pass", { tiles: a.view.yourTiles.slice(0, 3), blind: 0 });
check(
  "phase A: bots pass step 1 and the step advances",
  await waitFor(() => a.view?.charleston?.step === 1)
);
a.ws.close();
stopServer(server);
await sleep(1500);

// Phase B: fresh process, same persisted state.
server = startServer();
if (!(await waitUp())) {
  console.log("server did not come back up");
  process.exit(1);
}
const b = await connect("Host");
await waitFor(() => b.view?.phase === "charleston");
check("phase B: seat reclaimed by token", b.seat === 0);
check(
  "phase B: room still mid-charleston at step 2",
  b.view?.phase === "charleston" && b.view?.charleston?.step === 1
);
await cmd(b, "pass", { tiles: b.view.yourTiles.slice(0, 3), blind: 0 });
check(
  "phase B: bots pass step 2 after the restart",
  await waitFor(() => b.view?.charleston?.step === 2)
);
b.ws.close();
stopServer(server);
console.log(failures ? `\n${failures} FAILED` : "\nrestart smoke passed");
process.exit(failures ? 1 : 0);
