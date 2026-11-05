import { useEffect, useRef, useState } from "react";
import PartySocket from "partysocket";
import { tileLabel, type Tile } from "./tiles";
import { TileSvg, TileBackSvg } from "./TileSvg";

// Client for slices 1-3: connect to a room, take (or reclaim) a seat,
// and render the redacted view the server sends — your rack large,
// the other seats as counts plus their public melds. The Charleston
// is played from the rack; the play loop shows the discard pool, the
// live discard with its claim window, and your escrowed draw as a
// face-down tile until the window closes. The client holds no game
// secrets: if it isn't in the view, it isn't here.

interface SeatView {
  name: string;
  connected: boolean;
  bot: boolean;
  tileCount: number;
}

interface CharlestonView {
  step: number;
  direction: string;
  stepStartedAt: number;
  submitted: boolean[];
  yourPass: Tile[];
  yourBlind: number;
  void: { from: number; agreed: boolean[] } | null;
}

interface MeldView {
  kind: "pung" | "kong" | "chow";
  tiles: Tile[];
}

interface WindowView {
  tile: Tile;
  from: number;
  claims: { seat: number; kind: string }[];
  passed: number[];
  escrowSeat: number | null;
  escrowDeadline: number | null;
  youEscrowed: boolean;
}

interface PlayView {
  turn: number;
  hasDrawn: boolean;
  melds: MeldView[][];
  discards: Tile[];
  window: WindowView | null;
  winner: number | null;
  winKind: "discard" | "self" | null;
  drawGame: boolean;
  winInfo: {
    section: string;
    points: number;
    display: string;
    concealed: boolean;
  } | null;
}

interface View {
  type: "view";
  version: number;
  phase: "lobby" | "charleston" | "playing" | "over";
  you: number;
  yourTiles: Tile[];
  seats: SeatView[];
  wallCount: number;
  charleston: CharlestonView | null;
  play: PlayView | null;
}

const WINDS = ["East", "South", "West", "North"];

function useNow(active: boolean, ms = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

function ago(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function countIn(tiles: Tile[], t: Tile) {
  return tiles.filter((x) => x === t).length;
}

const SUIT_OF = (t: Tile) =>
  "btc".includes(t[0]) && t.length === 2 ? t[0] : null;

/** Pairs of rack tiles that complete a sequence with the given tile. */
function chowOptions(rack: Tile[], tile: Tile): Tile[][] {
  const suit = SUIT_OF(tile);
  if (!suit) return [];
  const rank = Number(tile.slice(1));
  const have = (r: number) => rack.includes(`${suit}${r}` as Tile);
  const out: Tile[][] = [];
  for (const [a, b] of [
    [rank - 2, rank - 1],
    [rank - 1, rank + 1],
    [rank + 1, rank + 2],
  ]) {
    if (a >= 1 && b <= 9 && have(a) && have(b)) {
      out.push([`${suit}${a}` as Tile, `${suit}${b}` as Tile]);
    }
  }
  return out;
}

export default function App() {
  const [room, setRoom] = useState(
    () => new URLSearchParams(location.search).get("room") ?? "family"
  );
  const [name, setName] = useState(() => localStorage.getItem("mj-name") ?? "");
  const [joined, setJoined] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState("Not connected");
  const [idCounter] = useState(() => ({ n: 0 }));

  // Charleston pass composition: indices into the combined rack
  // (hand tiles followed by the escrowed pass), plus a blind count
  // on the last pass of each Charleston.
  const [selected, setSelected] = useState<number[]>([]);
  const [blind, setBlind] = useState(0);
  const [touched, setTouched] = useState(false);
  // Play loop: the rack index selected to discard.
  const [discardIdx, setDiscardIdx] = useState<number | null>(null);

  const socketRef = useRef<PartySocket | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  const c = view?.charleston ?? null;
  const p = view?.play ?? null;
  const you = view?.you ?? -1;
  const step = c?.step ?? -1;
  const isBlindStep = step === 2 || step === 5;

  // New Charleston step: reset the composition. Within a step, keep
  // the escrowed pass pre-selected until the player touches the rack.
  useEffect(() => {
    setSelected([]);
    setBlind(0);
    setTouched(false);
  }, [step, view?.phase]);
  useEffect(() => {
    if (c && !touched && c.yourPass.length > 0 && view) {
      const base = view.yourTiles.length;
      setSelected(c.yourPass.map((_, i) => base + i));
      setBlind(c.yourBlind);
    }
  }, [c?.yourPass, touched]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setDiscardIdx(null), [view?.version]);

  const waiting =
    (view?.phase === "charleston" && !!c && !c.submitted[you]) ||
    p?.window?.escrowDeadline != null;
  const now = useNow(waiting, 500);

  function connect() {
    localStorage.setItem("mj-name", name);
    const tokenKey = `mj-token-${room}`;
    const token = localStorage.getItem(tokenKey) ?? "";
    const socket = new PartySocket({
      host: location.host,
      party: "mahjong",
      room,
      query: { name: name || "Player", token },
    });
    socketRef.current = socket;
    socket.addEventListener("open", () => setStatus("Connected"));
    socket.addEventListener("close", () => setStatus("Disconnected"));
    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "seated") {
        localStorage.setItem(tokenKey, msg.token);
        setJoined(true);
      } else if (msg.type === "note") {
        setStatus(msg.note);
      } else if (msg.type === "error") {
        setStatus(`Couldn't join: ${msg.error}`);
      } else if (msg.type === "view") {
        setView(msg as View);
      }
    });
  }

  function send(type: string, extra: Record<string, unknown> = {}) {
    const v = viewRef.current;
    if (!v || !socketRef.current) return;
    idCounter.n += 1;
    socketRef.current.send(
      JSON.stringify({
        id: `${Date.now()}-${idCounter.n}`,
        baseVersion: v.version,
        type,
        ...extra,
      })
    );
  }

  if (!joined) {
    return (
      <div className="app">
        <h1>Mahjong</h1>
        <p>
          <a href="/card.html" target="_blank" rel="noreferrer">
            2026 card reference ↗
          </a>
        </p>
        <div className="join">
          <label>
            Room
            <input value={room} onChange={(e) => setRoom(e.target.value)} />
          </label>
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button onClick={connect} disabled={!name.trim()}>
            Join room
          </button>
        </div>
        <p className="status">{status}</p>
      </div>
    );
  }

  const yourPass = c?.yourPass ?? [];
  const submitted = !!c?.submitted[you];
  // Combined rack for the Charleston UI: tiles in hand followed by
  // the tiles sitting in your escrowed pass.
  const rackTiles = view ? [...view.yourTiles, ...yourPass] : [];
  const selectedTiles = selected
    .map((i) => rackTiles[i])
    .filter((t): t is Tile => t !== undefined);

  function toggleTile(i: number) {
    if (view?.phase !== "charleston") return;
    setTouched(true);
    setSelected((sel) => {
      if (sel.includes(i)) return sel.filter((x) => x !== i);
      if (sel.length >= 3 - (isBlindStep ? blind : 0)) return sel;
      return [...sel, i];
    });
  }

  function submitPass() {
    if (selectedTiles.length + (isBlindStep ? blind : 0) !== 3) return;
    send("pass", { tiles: selectedTiles, blind: isBlindStep ? blind : 0 });
  }

  // ---- play-loop state ----
  const w = p?.window ?? null;
  const myTurn = !!p && p.turn === you && view?.phase === "playing";
  const mustDiscard = myTurn && !!p?.hasDrawn && !w;
  const myRack = view?.yourTiles ?? [];
  const windowTile = w?.tile;
  const myCopies = windowTile ? countIn(myRack, windowTile) : 0;
  const myJokers = countIn(myRack, "J");
  const canPung = !!w && myCopies + myJokers >= 2;
  const canKong = !!w && myCopies + myJokers >= 3;
  const chows = w ? chowOptions(myRack, w.tile) : [];
  const iAmNext = !!w && !!view && you === (w.from + 1) % view.seats.length;
  const myClaim = w?.claims.find((cl) => cl.seat === you);
  const iPassed = !!w && w.passed.includes(you);

  // Joker exchanges available to me right now: melds holding a joker
  // whose natural tile I hold.
  const exchanges: { owner: number; meld: number; tile: Tile }[] = [];
  if (p && mustDiscard) {
    p.melds.forEach((melds, owner) =>
      melds.forEach((meld, mi) => {
        const natural = meld.tiles.find((t) => t !== "J");
        if (meld.tiles.includes("J") && natural && myRack.includes(natural)) {
          exchanges.push({ owner, meld: mi, tile: natural });
        }
      })
    );
  }

  const escrowSecs =
    w?.escrowDeadline != null
      ? Math.max(0, Math.ceil((w.escrowDeadline - now) / 1000))
      : null;

  return (
    <div className="app">
      <header>
        <h1>Mahjong — room “{room}”</h1>
        <p className="status">
          {status} · you are seat {you} ({WINDS[you] ?? "?"})
          {view ? ` · wall: ${view.wallCount}` : ""} ·{" "}
          <a href="/card.html" target="_blank" rel="noreferrer">
            2026 card ↗
          </a>
        </p>
        <button className="quiet" onClick={() => send("reset")}>
          Reset room
        </button>
      </header>

      <section className="seats">
        {view?.seats.map((s, i) => (
          <div key={i} className={i === you ? "seat you" : "seat"}>
            <div className="seat-head">
              <strong>
                {WINDS[i]} · {s.bot ? "🤖 " : ""}
                {s.name}
                {i === you ? " (you)" : ""}
              </strong>
              <span className={s.connected ? "dot on" : "dot off"} />
            </div>
            {i === you ? null : (
              <div className="backs" aria-label={`${s.tileCount} tiles`}>
                {Array.from({ length: s.tileCount }, (_, j) => (
                  <span key={j} className="back" />
                ))}
              </div>
            )}
            <span className="count">{s.tileCount} tiles</span>
            {p && p.melds[i]?.length > 0 && (
              <div className="melds">
                {p.melds[i].map((m, mi) => (
                  <span key={mi} className="meld" title={m.kind}>
                    {m.tiles.map((t, ti) => (
                      <span key={ti} className="tile mini">
                        <TileSvg tile={t} />
                      </span>
                    ))}
                  </span>
                ))}
              </div>
            )}
            {c && (
              <span className="pass-state">
                {c.submitted[i] ? "passed ✓" : s.connected ? "choosing…" : "away"}
              </span>
            )}
            {p && p.turn === i && view.phase === "playing" && !p.window && (
              <span className="turn-tag">to act</span>
            )}
            {p && p.window && i !== p.window.from && (
              <span className="pass-state">
                {(() => {
                  const cl = p.window.claims.find((x) => x.seat === i);
                  if (cl)
                    return cl.kind === "mahjong"
                      ? "called Mahjong!"
                      : `called ${cl.kind}!`;
                  if (p.window.passed.includes(i)) return "passed";
                  if (p.window.escrowSeat !== null) return "tile hidden…";
                  return s.connected || s.bot ? "thinking…" : "away";
                })()}
              </span>
            )}
          </div>
        ))}
      </section>

      {view?.phase === "lobby" && (
        <section className="panel">
          <p>
            {view.seats.length} player{view.seats.length === 1 ? "" : "s"} in
            the room. Anyone can deal when you're ready.
          </p>
          <div className="row">
            <button onClick={() => send("start")}>Deal the tiles</button>
            {view.seats.length < 4 && (
              <button className="quiet" onClick={() => send("addBot")}>
                Add a bot
              </button>
            )}
          </div>
          {view.seats.some((s) => s.bot) && (
            <div className="row">
              {view.seats.map((s, i) =>
                s.bot ? (
                  <button
                    key={i}
                    className="quiet"
                    onClick={() => send("removeBot", { seat: i })}
                  >
                    Remove 🤖 {s.name}
                  </button>
                ) : null
              )}
            </div>
          )}
          {view.seats.some((s, i) => !s.bot && !s.connected && i !== view.you) && (
            <div className="row">
              {view.seats.map((s, i) =>
                !s.bot && !s.connected && i !== view.you ? (
                  <button
                    key={i}
                    className="quiet"
                    onClick={() => send("removeSeat", { seat: i })}
                  >
                    Remove {s.name} (away)
                  </button>
                ) : null
              )}
            </div>
          )}
        </section>
      )}

      {view?.phase === "charleston" && c && (
        <section className="panel">
          <h2>
            Charleston — pass {c.step + 1} of 6: {c.direction}
            {isBlindStep ? " (blind pass allowed)" : ""}
          </h2>
          <p className="waiting">
            Step started {ago(now - c.stepStartedAt)} ago ·{" "}
            {c.submitted.filter(Boolean).length} of {view.seats.length} passes
            in
          </p>
          {c.void ? (
            <div className="void-banner">
              <p>
                {view.seats[c.void.from]?.name} proposes voiding this hand.
                Agreed:{" "}
                {c.void.agreed
                  .map((a, i) => (a ? view.seats[i]?.name : null))
                  .filter(Boolean)
                  .join(", ") || "—"}
              </p>
              {c.void.from !== you && !c.void.agreed[you] && (
                <>
                  <button onClick={() => send("voidVote", { agree: true })}>
                    Agree to void
                  </button>
                  <button onClick={() => send("voidVote", { agree: false })}>
                    Decline
                  </button>
                </>
              )}
              {c.void.from === you && (
                <button onClick={() => send("voidVote", { agree: false })}>
                  Withdraw proposal
                </button>
              )}
            </div>
          ) : (
            <button className="quiet" onClick={() => send("voidPropose")}>
              Propose voiding the hand (needs everyone)
            </button>
          )}
          <p className="hint">
            {submitted
              ? "Your pass is in escrow — change the selection and resubmit to amend it."
              : "Tap tiles to choose your pass, then submit."}
          </p>
        </section>
      )}

      {view?.phase === "playing" && p && (
        <section className="panel">
          <h2>
            {w
              ? `${view.seats[w.from]?.name} discarded ${tileLabel(w.tile)}`
              : myTurn
                ? p.hasDrawn
                  ? "Your turn — discard"
                  : "Your turn — draw"
                : `${view.seats[p.turn]?.name} to act`}
          </h2>

          {w && (
            <div className="window-box">
              <span className="tile big"><TileSvg tile={w.tile} /></span>
              <div className="window-info">
                {w.escrowSeat !== null ? (
                  <p>
                    {view.seats[w.escrowSeat]?.name} drew a tile — hidden
                    {escrowSecs !== null ? ` for ${escrowSecs}s` : ""} while
                    claims can preempt it.
                    {w.youEscrowed ? " It's yours if nobody claims." : ""}
                  </p>
                ) : (
                  <p>The claim window is open until the next draw.</p>
                )}
                <p className="claims-line">
                  {w.claims.length === 0 && w.passed.length === 0
                    ? "No responses yet."
                    : [
                        ...w.claims.map(
                          (cl) => `${view.seats[cl.seat]?.name}: ${cl.kind}`
                        ),
                        ...w.passed.map(
                          (s2) => `${view.seats[s2]?.name}: pass`
                        ),
                      ].join(" · ")}
                </p>
                {you !== w.from ? (
                  <div className="claim-actions">
                    {myClaim ? (
                      <span>
                        You claimed {myClaim.kind} — waiting for the window
                        to close.
                      </span>
                    ) : iPassed ? (
                      <span>You passed on this tile.</span>
                    ) : (
                      <>
                        <button onClick={() => send("pass")}>Pass</button>
                        {windowTile === "J" && (
                          <span>A discarded joker is dead — it can't be called.</span>
                        )}
                        {windowTile !== "J" && canPung && (
                          <button
                            onClick={() => send("claim", { kind: "pung" })}
                          >
                            Pung
                          </button>
                        )}
                        {windowTile !== "J" && canKong && (
                          <button
                            onClick={() => send("claim", { kind: "kong" })}
                          >
                            Kong
                          </button>
                        )}
                        {windowTile !== "J" &&
                          iAmNext &&
                          chows.map((pair, ci) => (
                            <button
                              key={ci}
                              onClick={() =>
                                send("claim", { kind: "chow", tiles: pair })
                              }
                            >
                              Chow {pair.map(tileLabel).join(" ")}
                            </button>
                          ))}
                        {windowTile !== "J" && (
                          <button
                            onClick={() => send("claim", { kind: "mahjong" })}
                          >
                            Mahjong
                          </button>
                        )}
                      </>
                    )}
                    {iAmNext && (
                      <button onClick={() => send("draw")}>Draw</button>
                    )}
                  </div>
                ) : (
                  <p>Waiting for claims…</p>
                )}
              </div>
            </div>
          )}

          {!w && myTurn && !p.hasDrawn && (
            <button onClick={() => send("draw")}>Draw a tile</button>
          )}
          {mustDiscard && (
            <div className="discard-actions">
              <button
                disabled={discardIdx === null}
                onClick={() =>
                  discardIdx !== null &&
                  send("discard", { tile: myRack[discardIdx] })
                }
              >
                Discard
                {discardIdx !== null ? ` ${tileLabel(myRack[discardIdx])}` : ""}
              </button>
              <button onClick={() => send("declareMahjong")}>
                Declare mahjong
              </button>
              {exchanges.map((ex, ei) => (
                <button
                  key={ei}
                  onClick={() =>
                    send("exchange", {
                      owner: ex.owner,
                      meld: ex.meld,
                      tile: ex.tile,
                    })
                  }
                >
                  Exchange {tileLabel(ex.tile)} for{" "}
                  {view.seats[ex.owner]?.name}'s joker
                </button>
              ))}
            </div>
          )}

          {p.discards.length > 0 && (
            <div className="discard-pool">
              <span className="pool-label">Discards:</span>
              {p.discards.map((t, i) => (
                <span key={i} className="tile mini">
                  <TileSvg tile={t} />
                </span>
              ))}
            </div>
          )}
          <button className="quiet" onClick={() => send("reset")}>
            Abandon hand (back to lobby)
          </button>
        </section>
      )}

      {view?.phase === "over" && p && (
        <section className="panel">
          <h2>
            {p.drawGame
              ? "Wall game — nobody won this hand."
              : `${view.seats[p.winner ?? -1]?.name} has mahjong${
                  p.winKind === "self" ? " (self-drawn)" : ""
                }!`}
          </h2>
          {p.winInfo && (
            <p>
              {p.winInfo.section} · {p.winInfo.display} ·{" "}
              {p.winInfo.points} points
              {p.winInfo.concealed ? " · concealed" : ""}
            </p>
          )}
          <button onClick={() => send("reset")}>Back to the lobby</button>
        </section>
      )}

      {view && view.phase !== "lobby" && (
        <section className="rack">
          <h2>Your tiles</h2>
          <div className="tiles">
            {(view.phase === "charleston" ? rackTiles : view.yourTiles).map(
              (t, i) => {
                const inPass =
                  view.phase === "charleston" && i >= view.yourTiles.length;
                return (
                  <button
                    key={`${t}-${i}`}
                    className={
                      "tile" +
                      (inPass ? " passed" : "") +
                      (selected.includes(i) || discardIdx === i
                        ? " selected"
                        : "")
                    }
                    disabled={
                      view.phase === "charleston"
                        ? false
                        : !mustDiscard
                    }
                    onClick={() => {
                      if (view.phase === "charleston") toggleTile(i);
                      else if (mustDiscard)
                        setDiscardIdx(discardIdx === i ? null : i);
                    }}
                  >
                    <TileSvg tile={t} />
                  </button>
                );
              }
            )}
            {w?.youEscrowed && <span className="tile facedown"><TileBackSvg /></span>}
            {view.phase === "charleston" &&
              Array.from({ length: blind }, (_, i) => (
                <span key={`blind-${i}`} className="tile facedown"><TileBackSvg /></span>
              ))}
          </div>
          {view.phase === "charleston" && c && (
            <div className="passbar">
              {isBlindStep && (
                <label>
                  Blind (forward unseen):{" "}
                  <input
                    type="number"
                    min={0}
                    max={3 - selectedTiles.length}
                    value={blind}
                    onChange={(e) =>
                      setBlind(
                        Math.max(
                          0,
                          Math.min(
                            3 - selectedTiles.length,
                            Number(e.target.value) || 0
                          )
                        )
                      )
                    }
                  />
                </label>
              )}
              <button
                disabled={selectedTiles.length + blind !== 3}
                onClick={submitPass}
              >
                {submitted ? "Amend pass" : "Submit pass"} (
                {selectedTiles.length + blind}/3)
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
