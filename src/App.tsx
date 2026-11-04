import { useEffect, useRef, useState } from "react";
import PartySocket from "partysocket";
import { tileFace, tileLabel, type Tile } from "./tiles";

// Client for slices 1-2: connect to a room, take (or reclaim) a seat,
// and render the redacted view the server sends — your rack large, the
// other seats as counts only. The Charleston is played from the rack:
// tap tiles to compose your pass, submit, and watch the barrier —
// who has submitted, who is still choosing, who has been gone how
// long. The client holds no game secrets: if it isn't in the view,
// it isn't here.

interface SeatView {
  name: string;
  connected: boolean;
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

interface View {
  type: "view";
  version: number;
  phase: "lobby" | "charleston" | "ready";
  you: number;
  yourTiles: Tile[];
  seats: SeatView[];
  wallCount: number;
  charleston: CharlestonView | null;
}

const params = new URLSearchParams(window.location.search);
const ROOM = params.get("room") ?? "family";
const NAME = params.get("name") ?? "Player";
const TOKEN_KEY = `mahjong-token-${ROOM}`;
const BLIND_STEPS = new Set([2, 5]);
const DIR_ARROWS: Record<string, string> = {
  right: "→ right",
  over: "⇅ across",
  left: "→ left",
};

function TileView({
  tile,
  selected,
  onClick,
}: {
  tile: Tile;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={selected ? "tile selected" : "tile"}
      title={tileLabel(tile)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <span className="tile-face">{tileFace(tile)}</span>
      <span className="tile-label">{tileLabel(tile)}</span>
    </div>
  );
}

function elapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export default function App() {
  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [selected, setSelected] = useState<Tile[]>([]);
  const [blind, setBlind] = useState(0);
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef<PartySocket | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  useEffect(() => {
    const host =
      window.location.hostname === "localhost"
        ? "localhost:8787"
        : window.location.host;
    const socket = new PartySocket({
      host,
      party: "mahjong",
      room: ROOM,
      query: {
        name: NAME,
        token: localStorage.getItem(TOKEN_KEY) ?? "",
      },
    });
    socketRef.current = socket;

    socket.addEventListener("open", () => setStatus("connected"));
    socket.addEventListener("close", () => setStatus("disconnected"));
    socket.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "seated") {
        localStorage.setItem(TOKEN_KEY, msg.token);
      } else if (msg.type === "view") {
        setView(msg as View);
      } else if (msg.type === "error") {
        setStatus(`error: ${msg.error}`);
      }
    });
    return () => socket.close();
  }, []);

  // A ticking clock for the waiting display.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Each Charleston step starts with a clean slate, prefilled with
  // whatever you already have in escrow (after a reconnect, say).
  const step = view?.charleston?.step;
  useEffect(() => {
    if (view?.charleston) {
      setSelected(view.charleston.yourPass);
      setBlind(view.charleston.yourBlind);
    } else {
      setSelected([]);
      setBlind(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, view?.phase]);

  const send = (type: string, extra: Record<string, unknown> = {}) => {
    socketRef.current?.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        baseVersion: viewRef.current?.version ?? 0,
        type,
        ...extra,
      })
    );
  };

  if (!view) return <main className="app"><p>{status}</p></main>;

  const c = view.charleston;
  const others = view.seats
    .map((seat, i) => ({ ...seat, idx: i }))
    .filter((seat) => seat.idx !== view.you);

  // During the Charleston your escrowed tiles leave the rack view but
  // stay yours: show them in the same rack, still tappable, so a pass
  // can be amended until the barrier trips.
  const rackTiles = c ? [...view.yourTiles, ...c.yourPass] : view.yourTiles;
  const selectedCount = (t: Tile) => selected.filter((x) => x === t).length;
  const toggle = (tile: Tile, instanceIdx: number) => {
    // instanceIdx counts identical tiles so far: if this instance is
    // among the selected ones, deselect; otherwise select it.
    if (instanceIdx < selectedCount(tile)) {
      const next = [...selected];
      next.splice(next.indexOf(tile), 1);
      setSelected(next);
    } else if (selected.length + blind < 3) {
      setSelected([...selected, tile]);
    }
  };
  const canSubmit = c !== null && selected.length + blind === 3;
  const alreadyIn = c?.submitted[view.you] ?? false;

  const phaseLabel =
    view.phase === "lobby"
      ? "Lobby"
      : view.phase === "charleston"
        ? "Charleston"
        : "Ready to play";

  return (
    <main className="app">
      <header className="topbar">
        <strong>Room “{ROOM}”</strong>
        <span>{phaseLabel}</span>
        <span>Wall: {view.wallCount}</span>
        <span className="status">{status}</span>
      </header>

      <section className="others">
        {others.map((seat) => (
          <div key={seat.idx} className="seat-row">
            <span className={seat.connected ? "dot on" : "dot"} />
            <span className="seat-name">{seat.name}</span>
            <span className="backs" aria-label={`${seat.tileCount} tiles`}>
              {"🀄".repeat(Math.min(seat.tileCount, 14))}
            </span>
            <span className="count">{seat.tileCount}</span>
          </div>
        ))}
      </section>

      {c && (
        <section className="charleston">
          <div className="char-head">
            <strong>
              Pass {c.step + 1} of 6 — {DIR_ARROWS[c.direction] ?? c.direction}
            </strong>
            <span className="waiting-time">
              waiting {elapsed(now - c.stepStartedAt)}
            </span>
          </div>
          <ul className="pass-status">
            {view.seats.map((seat, i) => (
              <li key={i}>
                <span className={seat.connected ? "dot on" : "dot"} />
                {i === view.you ? "You" : seat.name}:{" "}
                {c.submitted[i]
                  ? "passed ✓"
                  : seat.connected
                    ? "choosing…"
                    : "disconnected"}
              </li>
            ))}
          </ul>

          {BLIND_STEPS.has(c.step) && (
            <div className="blind-row">
              <span>
                Blind pass (forward tiles sight-unseen from the pass
                coming to you):
              </span>
              <button
                onClick={() => setBlind(Math.max(0, blind - 1))}
                disabled={blind === 0}
              >
                −
              </button>
              <strong>{blind}</strong>
              <button
                onClick={() =>
                  setBlind(Math.min(3 - selected.length, blind + 1))
                }
                disabled={blind >= 3 - selected.length}
              >
                +
              </button>
            </div>
          )}

          <div className="char-actions">
            <button
              className="primary"
              disabled={!canSubmit}
              onClick={() => send("pass", { tiles: selected, blind })}
            >
              {alreadyIn
                ? `Amend pass (${selected.length + blind}/3)`
                : `Pass ${selected.length + blind}/3 tiles`}
            </button>
            {c.void === null ? (
              <button className="quiet" onClick={() => send("voidPropose")}>
                Propose voiding the hand
              </button>
            ) : (
              <span className="void-box">
                {view.seats[c.void.from].name} proposes voiding the hand —{" "}
                {c.void.agreed.filter(Boolean).length}/{view.seats.length}{" "}
                agreed
                {c.void.from !== view.you && !c.void.agreed[view.you] && (
                  <>
                    {" "}
                    <button onClick={() => send("voidVote", { agree: true })}>
                      Agree
                    </button>{" "}
                    <button onClick={() => send("voidVote", { agree: false })}>
                      Decline
                    </button>
                  </>
                )}
                {c.void.from === view.you && (
                  <>
                    {" "}
                    <button onClick={() => send("voidVote", { agree: false })}>
                      Withdraw
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
          <p className="hint">
            Tap tiles in your rack to compose the pass. Nothing moves
            until everyone has passed — and you can amend until then.
          </p>
        </section>
      )}

      {view.phase === "ready" && (
        <section className="charleston">
          <strong>Charleston complete.</strong>{" "}
          <span>
            Everyone holds the hand they will play. The play loop itself
            arrives in the next slice.
          </span>
        </section>
      )}

      <section className="rack">
        {rackTiles.map((tile, i) => {
          const instanceIdx = rackTiles
            .slice(0, i)
            .filter((t) => t === tile).length;
          const isSel = c !== null && instanceIdx < selectedCount(tile);
          return (
            <TileView
              key={`${tile}-${i}`}
              tile={tile}
              selected={isSel}
              onClick={c ? () => toggle(tile, instanceIdx) : undefined}
            />
          );
        })}
        {view.phase === "lobby" && (
          <p className="hint">
            You are seat {view.you + 1} of {view.seats.length}. Waiting in
            the lobby — start when everyone is in.
          </p>
        )}
      </section>

      <footer className="actions">
        {view.phase === "lobby" ? (
          <button onClick={() => send("start")}>Deal the tiles</button>
        ) : view.phase === "ready" ? (
          <button onClick={() => send("reset")}>Back to lobby</button>
        ) : null}
      </footer>
    </main>
  );
}
