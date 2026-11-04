import type { Tile } from "./tiles";

// SVG tile faces, drawn to a 60x84 viewBox that matches the tile
// proportions in styles.css (62x88 rack tiles, minis and the big
// window tile all scale from the same artwork).
//
// The artwork follows the classic American set George photographed
// (2026-11-04): dots are four-petal "wheel" pips in green, black
// and red in that set's arrangements; bams are green bead-chain
// sticks (red and navy accents where the set has them), with the
// bird for the 1 Bam and the W/M zigzags for the 8; craks pair the
// black Chinese numeral with the red 萬; winds carry a red corner
// letter; the dragons are drawn figures, the soap an ornate frame;
// the joker is the word over a green swirl medallion. Suited tiles
// carry the red corner index at the top right, as the set does.

const GREEN = "#15803d";
const GREEN_DARK = "#14532d";
const RED = "#c81e1e";
const RED_DARK = "#7f1d1d";
const BLACK = "#292524";
const NAVY = "#1e3a8a";

function WheelPip({
  x,
  y,
  color,
  r = 7,
}: {
  x: number;
  y: number;
  color: string;
  r?: number;
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={color} />
      {[0, 90, 180, 270].map((deg) => (
        <ellipse
          key={deg}
          cx={x}
          cy={y - r * 0.42}
          rx={r * 0.30}
          ry={r * 0.46}
          fill="#fffdf5"
          transform={`rotate(${deg} ${x} ${y})`}
        />
      ))}
      <circle cx={x} cy={y} r={r * 0.17} fill="#fffdf5" />
    </g>
  );
}

/** The 1 Dot: a green medallion with a petal ring and a red wheel
 *  at its heart. */
function OneDot() {
  return (
    <g>
      <circle cx={30} cy={44} r={19} fill={GREEN} />
      <circle cx={30} cy={44} r={19} fill="none" stroke={GREEN_DARK} strokeWidth={1.4} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (Math.PI / 6) * i;
        return (
          <ellipse
            key={i}
            cx={30 + 13.4 * Math.cos(a)}
            cy={44 + 13.4 * Math.sin(a)}
            rx={2.5}
            ry={3.9}
            fill="#fffdf5"
            transform={`rotate(${(a * 180) / Math.PI + 90} ${30 + 13.4 * Math.cos(a)} ${44 + 13.4 * Math.sin(a)})`}
          />
        );
      })}
      <circle cx={30} cy={44} r={8.6} fill="#fffdf5" />
      <WheelPip x={30} y={44} color={RED} r={7.6} />
    </g>
  );
}

type PipSpec = [number, number, string];
const DOT_LAYOUTS: Record<number, PipSpec[]> = {
  2: [
    [30, 25, BLACK],
    [30, 59, GREEN],
  ],
  3: [
    [19, 21, BLACK],
    [30, 42, RED],
    [41, 63, GREEN],
  ],
  4: [
    [20, 25, GREEN],
    [40, 25, BLACK],
    [20, 59, BLACK],
    [40, 59, GREEN],
  ],
  5: [
    [20, 24, GREEN],
    [40, 24, BLACK],
    [30, 42, RED],
    [20, 60, BLACK],
    [40, 60, GREEN],
  ],
  6: [
    [20, 19, GREEN],
    [40, 19, GREEN],
    [20, 42, RED],
    [40, 42, RED],
    [20, 65, RED],
    [40, 65, RED],
  ],
  7: [
    [16, 15, GREEN],
    [28, 23, GREEN],
    [40, 31, GREEN],
    [20, 53, RED],
    [40, 53, RED],
    [20, 69, RED],
    [40, 69, RED],
  ],
  8: [
    [20, 16, BLACK],
    [40, 16, BLACK],
    [20, 32, BLACK],
    [40, 32, BLACK],
    [20, 48, BLACK],
    [40, 48, BLACK],
    [20, 64, BLACK],
    [40, 64, BLACK],
  ],
  9: [
    [16, 20, BLACK],
    [30, 20, BLACK],
    [44, 20, BLACK],
    [16, 42, RED],
    [30, 42, RED],
    [44, 42, RED],
    [16, 64, GREEN],
    [30, 64, GREEN],
    [44, 64, GREEN],
  ],
};

function Dots({ rank }: { rank: number }) {
  if (rank === 1) return <OneDot />;
  const r = rank >= 7 ? 5.9 : 7;
  return (
    <g>
      {DOT_LAYOUTS[rank].map(([x, y, color], i) => (
        <WheelPip key={i} x={x} y={y} color={color} r={r} />
      ))}
    </g>
  );
}

/** One bamboo stick: a chain of beads, as the set engraves them. */
function BamStick({
  x,
  y,
  color = GREEN,
  dark = GREEN_DARK,
  h = 17,
}: {
  x: number;
  y: number;
  color?: string;
  dark?: string;
  h?: number;
}) {
  const beads = 4;
  return (
    <g fill={color} stroke={dark} strokeWidth={0.7}>
      {Array.from({ length: beads }, (_, i) => (
        <ellipse
          key={i}
          cx={x}
          cy={y - h / 2 + 2.6 + (i * (h - 5.2)) / (beads - 1)}
          rx={3.5}
          ry={2.9}
        />
      ))}
    </g>
  );
}

/** The 1 Bam is a bird on a branch — the famous "birdie bam":
 *  plump red body in profile, swept crest, long tail feathers. */
function OneBam() {
  return (
    <g>
      {/* branch */}
      <path d="M8 66 C 20 59, 36 54, 50 51" fill="none" stroke={GREEN} strokeWidth={2.6} strokeLinecap="round" />
      <ellipse cx={16} cy={60} rx={4.6} ry={2.2} fill={GREEN} transform="rotate(-24 16 60)" />
      <ellipse cx={31} cy={54} rx={4.6} ry={2.2} fill={GREEN} transform="rotate(-24 31 54)" />
      <ellipse cx={43} cy={49} rx={4.2} ry={2} fill={GREEN} transform="rotate(-24 43 49)" />
      {/* tail feathers, flowing from the body down to the right */}
      <path d="M33 42 C 40 50, 44 57, 44 66" fill="none" stroke={RED} strokeWidth={2.3} strokeLinecap="round" />
      <path d="M29 45 C 34 53, 36 60, 34 68" fill="none" stroke={RED} strokeWidth={2.3} strokeLinecap="round" />
      {/* body, leaning into the perch */}
      <ellipse cx={26} cy={33} rx={8.6} ry={12.5} fill={RED} transform="rotate(28 26 33)" />
      <path d="M20 25 C 17 32, 17 39, 20 46" fill="none" stroke={RED_DARK} strokeWidth={1.3} />
      <path d="M24 23 C 21 31, 21 39, 24 47" fill="none" stroke={RED_DARK} strokeWidth={1.3} />
      {/* feet on the branch */}
      <path d="M27 47 L26 53 M31 46 L31 52" stroke={RED_DARK} strokeWidth={1.4} strokeLinecap="round" />
      {/* head with a swept-back crest */}
      <circle cx={17} cy={18} r={6.9} fill={RED} />
      <path d="M14 12 C 11 7, 7 5, 3 6" fill="none" stroke={RED} strokeWidth={2.1} strokeLinecap="round" />
      <path d="M11.5 19 L3 22 L11.5 25.5 Z" fill={RED_DARK} />
      <circle cx={15.5} cy={17} r={1.8} fill="#fffdf5" />
      <circle cx={15.5} cy={17} r={1} fill={BLACK} />
    </g>
  );
}

/** Beads threaded along a polyline — the 8 Bam's W and M. */
function BeadPath({ points }: { points: [number, number][] }) {
  const beads: [number, number][] = [];
  for (let s = 0; s < points.length - 1; s++) {
    const [x1, y1] = points[s];
    const [x2, y2] = points[s + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(2, Math.round(len / 4.4));
    for (let i = 0; i < n; i++) {
      beads.push([x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
    }
  }
  beads.push(points[points.length - 1]);
  return (
    <g fill={GREEN} stroke={GREEN_DARK} strokeWidth={0.6}>
      {beads.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={2.55} />
      ))}
    </g>
  );
}

function EightBam() {
  return (
    <g>
      <BeadPath
        points={[
          [11, 22],
          [20, 38],
          [29, 22],
          [38, 38],
          [47, 22],
        ]}
      />
      <BeadPath
        points={[
          [11, 68],
          [20, 52],
          [29, 68],
          [38, 52],
          [47, 68],
        ]}
      />
    </g>
  );
}

type StickSpec = [number, number, string?, string?];
const BAM_LAYOUTS: Record<number, StickSpec[]> = {
  2: [
    [30, 24],
    [30, 60],
  ],
  3: [
    [30, 20],
    [19, 60],
    [41, 60],
  ],
  4: [
    [19, 24],
    [41, 24],
    [19, 60],
    [41, 60],
  ],
  5: [
    [19, 22],
    [41, 22],
    [30, 42, RED, RED_DARK],
    [19, 62],
    [41, 62],
  ],
  6: [
    [16, 23],
    [30, 23],
    [44, 23],
    [16, 61],
    [30, 61],
    [44, 61],
  ],
  7: [
    [23, 14, RED, RED_DARK],
    [16, 40],
    [30, 40, NAVY, "#172554"],
    [44, 40],
    [16, 66],
    [30, 66],
    [44, 66],
  ],
  9: [
    [16, 19],
    [30, 19, RED, RED_DARK],
    [44, 19],
    [16, 42],
    [30, 42, RED, RED_DARK],
    [44, 42],
    [16, 65],
    [30, 65, RED, RED_DARK],
    [44, 65],
  ],
};

function Bams({ rank }: { rank: number }) {
  if (rank === 1) return <OneBam />;
  if (rank === 8) return <EightBam />;
  return (
    <g>
      {BAM_LAYOUTS[rank].map(([x, y, color, dark], i) => (
        <BamStick key={i} x={x} y={y} color={color} dark={dark} />
      ))}
    </g>
  );
}

const CRAK_NUMERALS = ["", "一", "二", "三", "四", "伍", "六", "七", "八", "九"];

function Crak({ rank }: { rank: number }) {
  return (
    <g fontFamily="serif" textAnchor="middle">
      <text x={28} y={31} fontSize={21} fontWeight={700} fill={BLACK}>
        {CRAK_NUMERALS[rank]}
      </text>
      <text x={30} y={70} fontSize={30} fill={RED}>
        萬
      </text>
    </g>
  );
}

const WIND_CHARS: Record<string, string> = { N: "北", E: "東", S: "南", W: "西" };

function Wind({ tile }: { tile: Tile }) {
  return (
    <g fontFamily="serif" textAnchor="middle">
      <text x={29} y={56} fontSize={37} fill={BLACK}>
        {WIND_CHARS[tile]}
      </text>
      <text x={52} y={13.5} fontSize={10.5} fontWeight={700} fill={RED}>
        {tile}
      </text>
    </g>
  );
}

/** A drawn dragon figure, in the set's upright pose: a crested
 *  head with an open snout at the top, a thick segmented body
 *  twisting down, two clawed arms, and a flame tail. */
function DragonFigure({ color }: { color: string }) {
  return (
    <g fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
      {/* body spine, thick */}
      <path
        d="M28 17 C 38 20, 40 28, 32 34 C 24 40, 25 48, 33 52 C 40 56, 38 64, 30 68"
        strokeWidth={7}
      />
      {/* segmented belly */}
      <path d="M26 33 C 29 35.5, 33 35.5, 36 33" strokeWidth={2} />
      <path d="M24 46 C 27 48.5, 31 48.5, 34 46" strokeWidth={2} />
      <path d="M28 60 C 31 62, 35 61.5, 37 59" strokeWidth={2} />
      {/* dorsal ridge */}
      <path
        d="M34 20 C 40 24, 40 28, 36 33 M32 42 C 28 45, 28 48, 31 51 M36 55 C 40 58, 39 62, 35 65"
        strokeWidth={1.8}
      />
      {/* head: upper jaw, lower jaw, horn, ear fin, whiskers, eye */}
      <path d="M27 10 L12 13.5 L26 17" strokeWidth={3.2} />
      <path d="M14 18.5 C 18 21.5, 23 21.5, 27 18.5" strokeWidth={2.2} />
      <path d="M29 9 C 33 3.5, 38 2, 43 4.5" strokeWidth={2.4} />
      <path d="M30 13 L38 10 L33 18" strokeWidth={1.8} />
      <path d="M12 15.5 C 8 17.5, 6 20.5, 6 24.5 M14 19 C 11 21, 9.5 23.5, 9.5 27" strokeWidth={1.4} />
      <circle cx={22} cy={13} r={1.9} fill={color} stroke="none" />
      {/* arms with claws */}
      <path d="M33 40 L45 44 L47 51" strokeWidth={2.8} />
      <path d="M47 51 L43 53.5 M47 51 L48 55.5 M47 51 L51 53" strokeWidth={1.5} />
      <path d="M27 54 L16 59 L14 66" strokeWidth={2.8} />
      <path d="M14 66 L10 67.5 M14 66 L13 70.5 M14 66 L17.5 69" strokeWidth={1.5} />
      {/* flame tail */}
      <path d="M30 68 C 26 72, 25 75.5, 28 79 M30 68 C 34 71, 35 74.5, 33 78" strokeWidth={2.1} />
    </g>
  );
}

function Dragon({ tile }: { tile: Tile }) {
  if (tile === "DW") {
    // Soap: the set's ornate double frame with its center mark.
    return (
      <g>
        <rect x={13} y={12} width={34} height={60} fill="none" stroke={BLACK} strokeWidth={2.8} />
        <rect x={19.5} y={18.5} width={21} height={47} fill="none" stroke={BLACK} strokeWidth={1.3} />
        <g stroke={BLACK} strokeWidth={1.6}>
          <line x1={13} y1={24} x2={19.5} y2={24} />
          <line x1={13} y1={60} x2={19.5} y2={60} />
          <line x1={40.5} y1={24} x2={47} y2={24} />
          <line x1={40.5} y1={60} x2={47} y2={60} />
          <line x1={24} y1={12} x2={24} y2={18.5} />
          <line x1={36} y1={12} x2={36} y2={18.5} />
          <line x1={24} y1={65.5} x2={24} y2={72} />
          <line x1={36} y1={65.5} x2={36} y2={72} />
        </g>
        <text
          x={30}
          y={50}
          fontSize={15}
          fontWeight={700}
          fill={RED_DARK}
          fontFamily="serif"
          textAnchor="middle"
        >
          B
        </text>
      </g>
    );
  }
  return <DragonFigure color={tile === "DR" ? RED : GREEN} />;
}

/** A flower spray: curving green stems, leaves, red blossoms —
 *  after the set's season tiles. */
function Flower() {
  return (
    <g fill="none" strokeLinecap="round">
      <path d="M30 76 C 29 58, 26 44, 18 32" stroke={GREEN} strokeWidth={2.1} />
      <path d="M30 76 C 30 56, 31 40, 30 24" stroke={GREEN} strokeWidth={2.1} />
      <path d="M30 76 C 32 58, 36 44, 43 33" stroke={GREEN} strokeWidth={2.1} />
      <g fill={GREEN} stroke="none">
        <ellipse cx={23} cy={52} rx={4.8} ry={2.2} transform="rotate(-48 23 52)" />
        <ellipse cx={36} cy={54} rx={4.8} ry={2.2} transform="rotate(48 36 54)" />
        <ellipse cx={27} cy={64} rx={4.8} ry={2.2} transform="rotate(-40 27 64)" />
        <ellipse cx={34} cy={66} rx={4.8} ry={2.2} transform="rotate(40 34 66)" />
      </g>
      {[
        [17, 27],
        [30, 18],
        [44, 28],
      ].map(([x, y], i) => (
        <g key={i}>
          {[0, 72, 144, 216, 288].map((deg) => (
            <ellipse
              key={deg}
              cx={x}
              cy={y - 3.4}
              rx={2.5}
              ry={3.8}
              fill={RED}
              transform={`rotate(${deg} ${x} ${y})`}
            />
          ))}
          <circle cx={x} cy={y} r={1.9} fill="#fbbf24" />
        </g>
      ))}
    </g>
  );
}

/** The joker: the word over the set's green swirl medallion. */
function Joker() {
  return (
    <g textAnchor="middle">
      <text x={30} y={16} fontSize={10.5} fontWeight={800} letterSpacing={1.2} fill={RED}>
        JOKER
      </text>
      <circle cx={30} cy={51} r={19.5} fill="none" stroke={BLACK} strokeWidth={1.8} />
      <path
        d="M30 37 a14 14 0 1 1 -14 14 a10.5 10.5 0 1 0 10.5 -10.5 a7 7 0 1 1 -7 7"
        fill="none"
        stroke={GREEN}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <circle cx={30} cy={51} r={1.8} fill={GREEN} />
    </g>
  );
}

export function TileSvg({ tile }: { tile: Tile }) {
  const suited = "btc".includes(tile[0]) && tile.length === 2;
  const rank = suited ? Number(tile.slice(1)) : 0;
  return (
    <svg viewBox="0 0 60 84" role="img" aria-label={tile} preserveAspectRatio="xMidYMid meet">
      {suited ? (
        tile[0] === "c" ? (
          <Crak rank={rank} />
        ) : tile[0] === "t" ? (
          <Dots rank={rank} />
        ) : (
          <Bams rank={rank} />
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
      {suited && (
        <text
          x={52}
          y={13.5}
          fontSize={9.5}
          fontWeight={700}
          fill={RED}
          textAnchor="middle"
        >
          {rank}
        </text>
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
