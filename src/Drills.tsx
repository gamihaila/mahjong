import { useState } from "react";
import { CARD_2026, bestHands, type HandEval } from "./card";
import { buildWall, shuffle, sortTiles, tileLabel, type Tile } from "./tiles";
import { TileSvg, TileBackSvg } from "./TileSvg";
import { decideCharlestonPass, type BotView } from "../party/bot";

// The drill room: solo practice, no server, no stakes. Everything
// here runs in the browser off the same machinery the game uses —
// the card evaluator from src/card.ts and, for the Charleston
// coach, the good-company bot brain itself (party/bot.ts has no
// server dependencies: it reads a view and returns a command).
// The coach grades from YOUR rack only, the information you would
// have at a real table; nothing here peeks at hidden tiles,
// because there are none — the wall is local and the only other
// "player" is the evaluator.

function countsOf(tiles: Tile[]): Map<Tile, number> {
  const m = new Map<Tile, number>();
  for (const t of tiles) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Multiset intersection size: how many of a's tiles b also holds. */
function overlapCount(a: Tile[], b: Tile[]): number {
  const m = countsOf(b);
  let n = 0;
  for (const t of a) {
    const left = m.get(t) ?? 0;
    if (left > 0) {
      m.set(t, left - 1);
      n++;
    }
  }
  return n;
}

function subtractTiles(a: Tile[], b: Tile[]): Tile[] {
  const m = countsOf(b);
  const out: Tile[] = [];
  for (const t of a) {
    const left = m.get(t) ?? 0;
    if (left > 0) m.set(t, left - 1);
    else out.push(t);
  }
  return out;
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deal13(): { rack: Tile[]; rest: Tile[] } {
  const wall = shuffle(buildWall());
  return { rack: sortTiles(wall.slice(0, 13)), rest: wall.slice(13) };
}

/** A hand's groups as little tile rows, the way they'd sit exposed. */
function HandGroups({ groups }: { groups: Tile[][] }) {
  return (
    <span className="drill-groups">
      {groups.map((g, gi) => (
        <span key={gi} className="drill-group">
          {g.map((t, ti) => (
            <span key={ti} className="tile mini">
              <TileSvg tile={t} />
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function handTitle(e: HandEval): string {
  return `${e.hand.section} — ${e.hand.display}`;
}

// ---------- Charleston drill ----------

const DIRECTIONS = ["right", "over", "left", "left", "over", "right"];
const BLIND_STEPS = new Set([2, 5]); // last pass of each Charleston

interface PassFeedback {
  coach: Tile[];
  own: Tile[];
  blind: number;
  agreed: number;
  notes: string[];
  targets: HandEval[];
}

function CharlestonDrill() {
  const [rest, setRest] = useState<Tile[]>([]);
  const [rack, setRack] = useState<Tile[]>([]);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [fb, setFb] = useState<PassFeedback | null>(null);
  const [agreeTotal, setAgreeTotal] = useState(0);
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);

  function start() {
    const d = deal13();
    setRest(d.rest);
    setRack(d.rack);
    setStep(0);
    setSelected([]);
    setFb(null);
    setAgreeTotal(0);
    setDone(false);
    setStarted(true);
  }

  const blindStep = BLIND_STEPS.has(step);
  const ownTiles = selected.map((i) => rack[i]).filter(Boolean);
  const blind = blindStep ? 3 - ownTiles.length : 0;

  function toggle(i: number) {
    if (fb) return;
    setSelected((sel) =>
      sel.includes(i)
        ? sel.filter((x) => x !== i)
        : sel.length >= 3
          ? sel
          : [...sel, i]
    );
  }

  function submit() {
    const view: BotView = {
      you: 0,
      phase: "charleston",
      yourTiles: rack,
      seats: [],
      charleston: { step, submitted: [] },
      play: null,
    };
    const coach = decideCharlestonPass(view).tiles ?? [];
    const agreed = overlapCount(ownTiles, coach);
    const best = bestHands(CARD_2026, rack, [], 1)[0];
    const notes: string[] = [];
    if (agreed === 3) {
      notes.push("The coach passes exactly those three.");
    } else if (best) {
      const keep = countsOf(best.keep);
      const passedByCoach = countsOf(coach);
      const seen = new Set<string>();
      for (const t of ownTiles) {
        const cLeft = passedByCoach.get(t) ?? 0;
        if (cLeft > 0) {
          passedByCoach.set(t, cLeft - 1);
          continue;
        }
        if ((keep.get(t) ?? 0) > 0 && !seen.has(t)) {
          seen.add(t);
          notes.push(
            `The coach keeps the ${tileLabel(t)} — it serves ${handTitle(best)}.`
          );
        }
      }
      if (notes.length === 0) {
        notes.push(
          `The coach is aiming at ${best ? handTitle(best) : "—"}, ${best?.missing ?? "?"} tiles away.`
        );
      }
    }
    const targets = bestHands(CARD_2026, subtractTiles(rack, ownTiles), [], 2);
    setAgreeTotal((n) => n + agreed);
    setFb({ coach, own: ownTiles, blind, agreed, notes, targets });
  }

  function next() {
    if (!fb) return;
    if (step === 5) {
      setDone(true);
      return;
    }
    const incoming = rest.slice(0, 3 - fb.blind);
    setRest(rest.slice(3 - fb.blind));
    setRack(sortTiles([...subtractTiles(rack, fb.own), ...incoming]));
    setStep(step + 1);
    setSelected([]);
    setFb(null);
  }

  if (!started) {
    return (
      <div>
        <p>
          Six passes against nobody: at each step, pick the three
          tiles you'd pass, then see what the coach — the same
          good-company bot that fills seats — passes from the same
          rack, and what it's aiming at. On the last pass of each
          Charleston you may pass blind, just like the real game.
        </p>
        <button onClick={start}>Deal a Charleston</button>
      </div>
    );
  }

  if (done) {
    const best = bestHands(CARD_2026, rack, [], 2);
    return (
      <div>
        <h2>Charleston complete</h2>
        <p>
          You and the coach agreed on <strong>{agreeTotal} of 18</strong>{" "}
          passed tiles.
        </p>
        <p>Your final rack:</p>
        <div className="tiles">
          {rack.map((t, i) => (
            <span key={i} className="tile">
              <TileSvg tile={t} />
            </span>
          ))}
        </div>
        {best.length > 0 && (
          <p>
            You'd sit down aiming at{" "}
            {best
              .map((e) => `${handTitle(e)} (${e.missing} away)`)
              .join(" · ")}
          </p>
        )}
        <button onClick={start}>Run it again</button>
      </div>
    );
  }

  return (
    <div>
      <p className="status">
        Pass {step + 1} of 6 — to the {DIRECTIONS[step]}
        {blindStep ? " (blind pass allowed)" : ""} · coach agreement so
        far: {agreeTotal}
      </p>
      <div className="tiles">
        {rack.map((t, i) => (
          <button
            key={`${t}-${i}`}
            className={"tile" + (selected.includes(i) ? " selected" : "")}
            onClick={() => toggle(i)}
          >
            <TileSvg tile={t} />
          </button>
        ))}
        {Array.from({ length: blind }, (_, i) => (
          <span key={`blind-${i}`} className="tile facedown">
            <TileBackSvg />
          </span>
        ))}
      </div>
      {blindStep && !fb && (
        <p className="blind-hint">
          Blind pass: any of the 3 you don't pick from your rack are
          forwarded unseen.
        </p>
      )}
      {!fb ? (
        <p>
          <button
            onClick={submit}
            disabled={blindStep ? false : ownTiles.length !== 3}
          >
            {blindStep
              ? `Pass ${ownTiles.length} of mine + ${blind} blind`
              : "Pass these 3"}
          </button>
        </p>
      ) : (
        <div className="feedback">
          <p>
            The coach passes{" "}
            <span className="drill-group">
              {fb.coach.map((t, i) => (
                <span key={i} className="tile mini">
                  <TileSvg tile={t} />
                </span>
              ))}
            </span>{" "}
            — you agreed on <strong>{fb.agreed} of 3</strong>.
          </p>
          {fb.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
          {fb.targets.length > 0 && (
            <p>
              After this pass the rack points at:{" "}
              {fb.targets
                .map((e) => `${handTitle(e)} (${e.missing} away)`)
                .join(" · ")}
            </p>
          )}
          <button onClick={next}>
            {step === 5 ? "Finish" : "Next pass"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Name-the-hand drill ----------

const TARGET_ROUNDS = 10;

interface TargetRound {
  rack: Tile[];
  options: HandEval[];
  correct: number;
}

function genRound(): TargetRound {
  const { rack } = deal13();
  const evals = bestHands(CARD_2026, rack, [], CARD_2026.length);
  const top = evals[0];
  let pool = evals.slice(1).filter((e) => e.missing >= top.missing + 2);
  if (pool.length < 2)
    pool = evals.slice(1).filter((e) => e.missing >= top.missing + 1);
  if (pool.length < 2) pool = evals.slice(1);
  const poolShuffled = shuffled(pool);
  const options = shuffled([top, poolShuffled[0], poolShuffled[1]]);
  return { rack, options, correct: options.indexOf(top) };
}

function TargetsDrill() {
  const [round, setRound] = useState<TargetRound | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [played, setPlayed] = useState(0);
  const [done, setDone] = useState(false);

  function start() {
    setRound(genRound());
    setPicked(null);
    setScore(0);
    setPlayed(0);
    setDone(false);
  }

  function pick(i: number) {
    if (picked !== null || !round) return;
    setPicked(i);
    if (i === round.correct) setScore((s) => s + 1);
  }

  function next() {
    if (played + 1 >= TARGET_ROUNDS) {
      setDone(true);
      return;
    }
    setPlayed(played + 1);
    setRound(genRound());
    setPicked(null);
  }

  if (!round) {
    return (
      <div>
        <p>
          A rack, three hands from the card: which one is this rack
          actually closest to? Ten rounds. The skill being trained is
          the first one the game demands — looking at thirteen tiles
          and seeing the two or three futures they could become.
        </p>
        <button onClick={start}>Start</button>
      </div>
    );
  }

  if (done) {
    return (
      <div>
        <h2>Done</h2>
        <p>
          You named the closest hand <strong>{score} of {TARGET_ROUNDS}</strong>{" "}
          times.
        </p>
        <button onClick={start}>Another ten</button>
      </div>
    );
  }

  const correctEval = round.options[round.correct];
  const keepLeft = countsOf(correctEval.keep);
  const keepIdx = new Set<number>();
  if (picked !== null) {
    round.rack.forEach((t, i) => {
      const left = keepLeft.get(t) ?? 0;
      if (left > 0) {
        keepLeft.set(t, left - 1);
        keepIdx.add(i);
      }
    });
  }

  return (
    <div>
      <p className="status">
        Round {played + 1} of {TARGET_ROUNDS} · score {score}
      </p>
      <div className="tiles">
        {round.rack.map((t, i) => (
          <span
            key={`${t}-${i}`}
            className={"tile" + (keepIdx.has(i) ? " keep" : "")}
          >
            <TileSvg tile={t} />
          </span>
        ))}
      </div>
      {picked !== null && (
        <p className="status">
          Tiles ringed in green are the ones the closest hand keeps.
        </p>
      )}
      {round.options.map((e, i) => (
        <button
          key={i}
          className={
            "candidate" +
            (picked === null
              ? ""
              : i === round.correct
                ? " right"
                : i === picked
                  ? " wrong"
                  : "")
          }
          onClick={() => pick(i)}
        >
          <span className="cand-head">
            <span>{e.hand.section}</span>
            {picked !== null && <span>{e.missing} away</span>}
          </span>
          <HandGroups groups={e.groups} />
          {picked !== null && e.hand.note && (
            <span className="cand-note">{e.hand.note}</span>
          )}
        </button>
      ))}
      {picked !== null && (
        <div className="feedback">
          <p>
            {picked === round.correct
              ? `Exactly — ${handTitle(correctEval)} is ${correctEval.missing} tiles away.`
              : `Closest is ${handTitle(correctEval)}, ${correctEval.missing} away; your pick is ${round.options[picked].missing} away.`}
          </p>
          <button onClick={next}>
            {played + 1 >= TARGET_ROUNDS ? "Finish" : "Next rack"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- the room ----------

export default function Drills({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<"charleston" | "targets">("charleston");
  return (
    <div>
      <header>
        <h1>Drill room</h1>
        <p className="status">
          Solo practice. The coach sees only your rack — the same
          information you'd have at the table.
        </p>
        <button className="quiet" onClick={onExit}>
          ← Back
        </button>
      </header>
      <div className="drill-tabs">
        <button
          className={tab === "charleston" ? "on" : ""}
          onClick={() => setTab("charleston")}
        >
          Call the pass
        </button>
        <button
          className={tab === "targets" ? "on" : ""}
          onClick={() => setTab("targets")}
        >
          Name the hand
        </button>
      </div>
      {tab === "charleston" ? (
        <CharlestonDrill key="c" />
      ) : (
        <TargetsDrill key="t" />
      )}
    </div>
  );
}
