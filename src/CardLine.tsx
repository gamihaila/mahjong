import type { CardHand } from "./card";

/** A hand printed the way the card prints it: the group tokens in
 *  their slot colors, at reading size. (Rendered as miniature tiles
 *  at first — too small to read on a phone.) Colors match the card
 *  reference page exactly. Shared by the drill room's candidates and
 *  the live game's closest-hand hint. */
const SLOT_COLORS: Record<string, string> = {
  b: "#1e40af",
  g: "#15803d",
  r: "#b91c1c",
};

export function CardLine({ hand }: { hand: CardHand }) {
  return (
    <span className="card-line">
      {hand.groups.map((g, i) => (
        <span
          key={i}
          className="grp"
          style={{ color: SLOT_COLORS[g.color] ?? "inherit" }}
        >
          {g.token}
        </span>
      ))}
    </span>
  );
}
