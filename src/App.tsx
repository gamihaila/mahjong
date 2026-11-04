import { useEffect, useRef, useState } from "react";
import PartySocket from "partysocket";
import { tileFace, tileLabel, type Tile } from "./tiles";

// Slice 1 client: connect to a room, take (or reclaim) a seat, and
// render the redacted view the server sends — your rack large, the
// other seats as counts only. The client holds no game secrets: if it
// isn't in the view, it isn't here.

interface SeatView {
  name: string;
  connected: boolean;
  tileCount: number;
}

interface View {
  type: "view";
  version: number;
  phase: "lobby" | "dealt";
  you: number;
  yourTiles: Tile[];
  seats: SeatView[];
  wallCount: number;
}

const params = new URLSearchParams(window.location.search);
const ROOM = params.get("room") ?? "family";
const NAME = params.get("name") ?? "Player";
const TOKEN_KEY = `mahjong-token-${ROOM}`;

function TileView({ tile }: { tile: Tile }) {
  return (
    <div className="tile" title={tileLabel(tile)}>
      <span className="tile-face">{tileFace(tile)}</span>
      <span className="tile-label">{tileLabel(tile)}</span>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState("connecting…");
  const socketRef = useRef<PartySocket | null>(null);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  useEffect(() => {
    const host =
      window.location.hostname === "localhost"
        ? "localhost:1999"
        : window.location.host;
    const socket = new PartySocket({
      host,
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

  const send = (type: string) => {
    socketRef.current?.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        baseVersion: viewRef.current?.version ?? 0,
        type,
      })
    );
  };

  if (!view) return <main className="app"><p>{status}</p></main>;

  const others = view.seats
    .map((seat, i) => ({ ...seat, idx: i }))
    .filter((seat) => seat.idx !== view.you);

  return (
    <main className="app">
      <header className="topbar">
        <strong>Room “{ROOM}”</strong>
        <span>{view.phase === "lobby" ? "Lobby" : "Dealt"}</span>
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

      <section className="rack">
        {view.yourTiles.map((tile, i) => (
          <TileView key={`${tile}-${i}`} tile={tile} />
        ))}
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
        ) : (
          <button onClick={() => send("reset")}>Back to lobby</button>
        )}
      </footer>
    </main>
  );
}
