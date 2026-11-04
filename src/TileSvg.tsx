import type { Tile } from "./tiles";

// SVG tile faces, drawn to a 60x84 viewBox that matches the tile
// proportions in styles.css (62x88 rack tiles, minis and the big
// window tile all scale from the same artwork). Suits use pip
// layouts on a 3x3 grid; honors and dragons use characters; the
// white dragon (soap) is the traditional empty frame.

const XS = [15, 30, 45];
const YS = [18, 42, 66];
const TL = 0, TC = 1, TR = 2, ML = 3, C = 4, MR = 5, BL = 6, BC = 7, BR = 8;
const LAYOUTS: Record<number, number[]> = {
  1: [C],
  2: [TC, BC],
  3: [TL, C, BR],
  4: [TL, TR, BL, BR],
  5: [TL, TR, C, BL, BR],
  6: [TL, TR, ML, MR, BL, BR],
  7: [TL, TR, ML, MR, BL, BR, TC],
  8: [TL, TC, TR, ML, MR, BL, BC, BR],
  9: [TL, TC, TR, ML, C, MR, BL, BC, BR],
};
const pos = (i: number): [number, number] => [XS[i % 3], YS[Math.floor(i / 3)]];

const DOT_COLORS = ["#1d4ed8", "#16a34a", "#dc2626"];

function DotPip({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={6.8} fill={color} />
      <circle cx={x} cy={y} r={4.3} fill="#fffdf5" />
      <circle cx={x} cy={y} r={2.2} fill={color} />
    </g>
  );
}

function BamPip({ x, y, accent }: { x: number; y: number; accent: boolean }) {
  const fill = accent ? "#dc2626" : "#16a34a";
  const node = accent ? "#7f1d1d" : "#14532d";
  return (
    <g>
      <rect x={x - 3.4} y={y - 9.5} width={6.8} height={8.6} rx={3.2} fill={fill} />
      <rect x={x - 3.4} y={y + 0.9} width={6.8} height={8.6} rx={3.2} fill={fill} />
      <line x1={x - 3.4} y1={y - 0.4} x2={x + 3.4} y2={y - 0.4} stroke={node} strokeWidth={1.1} />
    </g>
  );
}

/** The 1 Bam: a bamboo shoot with leaves, in place of the
 *  traditional bird. */
function OneBam() {
  return (
    <g>
      <path d="M30 34 C 19 30, 12 21, 13 10 C 22 14, 28 21, 30 28 Z" fill="#22c55e" />
      <path d="M30 34 C 41 30, 48 21, 47 10 C 38 14, 32 21, 30 28 Z" fill="#16a34a" />
      <path d="M27 52 C 18 50, 13 44, 13 37 C 20 39, 25 44, 27 48 Z" fill="#22c55e" />
      <rect x={25.6} y={30} width={8.8} height={13} rx={4} fill="#16a34a" />
      <rect x={25.6} y={45.5} width={8.8} height={13} rx={4} fill="#22c55e" />
      <rect x={25.6} y={61} width={8.8} height={13} rx={4} fill="#dc2626" />
    </g>
  );
}

function SuitPips({ tile }: { tile: Tile }) {
  const suit = tile[0];
  const rank = Number(tile.slice(1));
  if (suit === "b" && rank === 1) return <OneBam />;
  if (suit === "t" && rank === 1) {
    return (
      <g>
        <circle cx={30} cy={42} r={17} fill="#1d4ed8" />
        <circle cx={30} cy={42} r={12.5} fill="#fffdf5" />
        <circle cx={30} cy={42} r={9} fill="#dc2626" />
        <circle cx={30} cy={42} r={5} fill="#fffdf5" />
        <circle cx={30} cy={42} r={2.6} fill="#16a34a" />
      </g>
    );
  }
  return (
    <g>
      {LAYOUTS[rank].map((cell, i) => {
        const [x, y] = pos(cell);
        return suit === "t" ? (
          <DotPip key={i} x={x} y={y} color={DOT_COLORS[i % 3]} />
        ) : (
          <BamPip key={i} x={x} y={y} accent={rank === 5 && cell === C} />
        );
      })}
    </g>
  );
}

function Crak({ rank }: { rank: number }) {
  return (
    <g fontFamily="serif" textAnchor="middle">
      <text x={30} y={27} fontSize={19} fontWeight={700} fill="#1e3a8a">
        {rank}
      </text>
      <text x={30} y={66} fontSize={31} fill="#dc2626">
        萬
      </text>
    </g>
  );
}

const WIND_CHARS: Record<string, string> = { N: "北", E: "東", S: "南", W: "西" };

function Wind({ tile }: { tile: Tile }) {
  return (
    <g fontFamily="serif" textAnchor="middle">
      <text x={30} y={50} fontSize={34} fill="#1c1917">
        {WIND_CHARS[tile]}
      </text>
      <text x={30} y={69} fontSize={11} fill="#78716c">
        {tile}
      </text>
    </g>
  );
}

function Dragon({ tile }: { tile: Tile }) {
  if (tile === "DW") {
    // Soap: the white dragon is drawn as an empty frame.
    return (
      <g fill="none" stroke="#1d4ed8">
        <rect x={14} y={15} width={32} height={54} rx={4} strokeWidth={3.2} />
        <rect x={21.5} y={22.5} width={17} height={39} rx={2} strokeWidth={1.6} />
      </g>
    );
  }
  const [ch, fill, size] =
    tile === "DR" ? ["中", "#dc2626", 38] : ["發", "#16a34a", 33];
  return (
    <text
      x={30}
      y={56}
      fontSize={size}
      fill={fill}
      fontFamily="serif"
      textAnchor="middle"
    >
      {ch}
    </text>
  );
}

function Flower() {
  return (
    <g>
      {[0, 72, 144, 216, 288].map((deg) => (
        <ellipse
          key={deg}
          cx={30}
          cy={31}
          rx={7}
          ry={11.5}
          fill="#f472b6"
          stroke="#db2777"
          strokeWidth={0.8}
          transform={`rotate(${deg} 30 42)`}
        />
      ))}
      <circle cx={30} cy={42} r={5.2} fill="#facc15" stroke="#ca8a04" strokeWidth={0.8} />
    </g>
  );
}

function Star({ x, y, r }: { x: number; y: number; r: number }) {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.45;
    return `${(x + rad * Math.cos(ang)).toFixed(1)},${(y + rad * Math.sin(ang)).toFixed(1)}`;
  }).join(" ");
  return <polygon points={pts} fill="#facc15" stroke="#ca8a04" strokeWidth={0.6} />;
}

function Joker() {
  return (
    <g textAnchor="middle">
      <Star x={13} y={17} r={5.5} />
      <Star x={47} y={17} r={5.5} />
      <text x={30} y={55} fontSize={38} fontWeight={800} fill="#7c3aed">
        J
      </text>
      <text x={30} y={71} fontSize={8.5} letterSpacing={1.5} fill="#7c3aed">
        JOKER
      </text>
    </g>
  );
}

export function TileSvg({ tile }: { tile: Tile }) {
  return (
    <svg viewBox="0 0 60 84" role="img" aria-label={tile} preserveAspectRatio="xMidYMid meet">
      {"btc".includes(tile[0]) && tile.length === 2 ? (
        tile[0] === "c" ? (
          <Crak rank={Number(tile.slice(1))} />
        ) : (
          <SuitPips tile={tile} />
        )
      ) : WIND_CHARS[tile] ? (
        <Wind tile={tile} />
      ) : tile.startsWith("D") ? (
        <Dragon tile={tile} />
      ) : tile === "F" ? (
        <Flower />
      ) : (
        <Joker />
      )}
    </svg>
  );
}

/** The face-down side: green with a lattice, for escrowed draws. */
export function TileBackSvg() {
  return (
    <svg viewBox="0 0 60 84" preserveAspectRatio="xMidYMid meet" aria-hidden>
      <rect x={0} y={0} width={60} height={84} fill="#15803d" />
      <g stroke="#bbf7d0" strokeWidth={1} opacity={0.4}>
        {[-42, -21, 0, 21, 42, 63, 84].map((o) => (
          <g key={o}>
            <line x1={o} y1={0} x2={o + 42} y2={84} />
            <line x1={o + 42} y1={0} x2={o} y2={84} />
          </g>
        ))}
      </g>
      <rect x={4.5} y={4.5} width={51} height={75} rx={5} fill="none" stroke="#bbf7d0" strokeWidth={1.6} />
    </svg>
  );
}
