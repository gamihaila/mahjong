# American Mahjong (React + PartyKit) — design notes

Started 2026-11-04. Motivation: George and Maria play remotely via The Mahjong App; its UI wastes screen on white space and shrinks the tiles. Build a
tile-first UI instead. George's main interest: the distributed-systems design.
He is new to the game rules.

## Settled direction
- React client; PartyKit (Cloudflare Durable Objects) for shared state and
  messaging. One room per game.
- Tiles as SVG components, layout designed tile-first (fix the tiny-tile
  complaint).

## Core model
- One room = one Durable Object = a single-threaded actor. All moves are
  serialized through it, giving a total order of events by construction
  (single-partition / single-consumer analogy). Partition key = game ID.
- Event-sourced: clients send commands, never state. Server validates each
  command against current state; legal commands append events to the log.
  State = fold over events; server keeps a snapshot + log since snapshot.
  Payoffs: reconnection via fresh snapshot, replay/audit, undo in debugging,
  observability (the log is the game's history).
- Redaction is a server-side projection: full state (wall order, all racks)
  lives only in the actor. Each player gets a computed view: own tiles, other
  players' counts, exposures, discards. Client is a dumb renderer and never
  possesses the secrets.

## The three decisions that matter
1. **Claim window** (a discard can be claimed by anyone: mahjong > pung/kong
   > chow; chow only for the next seat; resolution is by rule priority, not
   arrival order). Candidates considered: barrier (pause until all pass —
   correct but can stall), timer (snappy; latency asymmetry becomes
   gameplay-relevant), until-next-draw.
   - **DECIDED (George, 2026-11-04): until-next-draw, with the drawn-tile
     escrow as the closing mechanism; ratified by George the same day.**
     Refined semantics:
     - A discard stays claimable until the next player draws. Claims are
       registered as intents; pung/kong/chow intents resolve at window close
       by rule priority, then seat distance from the discarder. A mahjong
       claim resolves immediately (nothing outranks it; simultaneous mahjong
       claims break by seat order).
     - Drawn-tile escrow (solves the latency race without leaking
       information): when the next player requests a draw, the tile is drawn
       into escrow, unrevealed, and a short grace period runs (length TBD,
       ~2–3 s). A claim arriving in the grace period preempts; the escrowed
       tile returns to the wall unseen. On expiry, the tile is revealed to
       the drawer and the old discard is dead.
     - Races are settled by the room's total order + versioning (Decision 3):
       the loser of a claim-vs-draw race gets a stale-version reply and a
       fresh redacted view, never a corrupted state.
2. **Charleston**: six simultaneous passes (right/over/left, then
   left/over/right). Server holds each pass in escrow — hidden, unapplied —
   until all four arrive, then applies atomically. Barrier synchronization
   with secret payloads.
   - **DECIDED (George, 2026-11-04):** escrow barrier + wait indefinitely,
     no timeouts. Companions ratified with it: presence-informed waiting
     (UI distinguishes choosing vs disconnected, and for how long);
     unanimous-consent void-the-hand proposal as the escape hatch (social,
     not a clock); passes amendable in escrow until the barrier trips.
   - **Blind pass: IN for v1 (George, 2026-11-04).** Supported in the
     protocol and the UI: on the last pass of each Charleston, a player may
     forward tiles from their incoming escrow without them ever being
     revealed to them.
3. **Idempotency & versioning**: each command carries a client-generated ID
   and the state version the client believes it is acting on. Actor applies
   only on version match (CAS), dedupes by command ID, replies "stale, here
   is your current view" on mismatch. At-least-once delivery, exactly-once
   effect.
   - **DECIDED (George, 2026-11-04): yes.**

## Smaller pieces
- Shuffle integrity: **DECIDED (George, 2026-11-04): trusted shuffler** —
  plain CSPRNG shuffle server-side; no commit/reveal ceremony. (The
  hash-commit audit idea was considered and set aside.)
- Seat tokens: **DECIDED (George, 2026-11-04): yes** — issued at join; a
  reconnecting player reclaims their seat and rack.
- Rules shape only the state machine's transitions, not the skeleton. The
  Charleston and the claim window are the only rules that reach into the
  architecture.
- Copyright resolved: the National Mah Jongg League card is copyrighted and
  reissued yearly; George encodes it by hand from his own copy (see "The
  NMJL card" below), so the app ships no copy of the card itself.

## Bots
- **DECIDED (George, 2026-11-04):** any seats can be filled with bots —
  1, 2, or 3 — so George can also practice solo against three bots.
- **No bot advantage, by construction:** a bot consumes the same redacted
  per-player view and issues the same commands as a human client. It never
  touches full room state; the redaction boundary is the fairness boundary.
- **Skill levels:** bots should not be too smart; multiple difficulty levels
  (level definitions TBD). Difficulty lives in evaluation quality and noise,
  never in information access.
- Bots act through the Charleston barrier and claim windows like everyone
  else, with human-plausible delays so they don't insta-claim inside the
  claim window and defeat the escrow's fairness purpose.

## The NMJL card
- **DECIDED (George, 2026-11-04):** George will obtain a copy of the card
  and encode the hands himself in a text file. The encoded card is data,
  not code, and is versioned by card year (a new card arrives each spring;
  swapping years = swapping the file).
- The encoding powers three things from one source: win checking, bot hand
  evaluation (distance to the nearest completable hand), and potentially a
  "closest hands" hint for the human player.

## Status
- 2026-11-04: all three major decisions settled (claim window = until-next-
  draw with drawn-tile escrow; Charleston = escrow barrier, no timeouts,
  void-by-consent, blind pass in v1; idempotency + versioning yes), plus
  trusted shuffler, seat tokens, bots, and card encoding. No build started.
- Open threads for later: escrow grace length (tune in prototype, ~2–3 s);
  card text format (needs designing when George has the card in hand);
  bot difficulty level definitions.

## Platform note (2026-11-04)

PartyKit's hosted platform shut down on 2026-10-23 and `partykit deploy`
is retired. This project therefore builds on **PartyServer** — the same
Durable Object actor model, deployed with wrangler to our own Cloudflare
account. Every design decision above is unchanged; only the packaging
differs (wrangler.jsonc instead of partykit.json, the `partyserver`
package, storage via the object's own ctx.storage). Read "PartyKit" in
the text above as "PartyServer" from here on.

## Transport note (2026-11-05)

The WebSocket transport was replaced with plain HTTP request/response
plus client polling. Mobile browsers freeze, starve, and sometimes
discard backgrounded pages wholesale, so any design that keeps
connection state in the page eventually strands the player at a
"Disconnected" screen with a manual reload as the only recovery — we
hit exactly that, intermittently and irreproducibly (PR #26 hardened
the socket and treated the symptoms). The game has no real-time
budget to protect — its fastest clock, the 2.5 s escrow grace, runs
server-side — so push notification was buying latency the game does
not need at the price of a failure class it cannot afford.

The protocol was already request/response-shaped (commands with
base-version CAS and idempotency IDs up, versioned redacted views
down); only the delivery changed. Three POST actions on the room URL:
`join` (token reclaims a seat), `command` (the response carries the
requester's fresh view, so your own moves stay instant), and `poll`
(since-version → unchanged, or the fresh view). The client polls
while it is blocked on someone else — fast (~1 s) inside a claim
window, 1.5–3 s otherwise — and barely at all (~10 s safety beat)
when the next change can only come from itself. Every request is
self-contained, so a frozen, killed, or reloaded page recovers with
its next request; presence is derived from last-seen timestamps
rather than connection state, which is also more honest. The room
object is no longer a connection manager at all — it answers
commands and view requests, and bots and timers stay alarm-driven
inside it exactly as before.

## Drill room (2026-11-05)

Solo practice lives entirely in the browser (src/Drills.tsx), linked
from the join screen and the room header. Two drills, both graded by
the game's own machinery: "Call the pass" runs a six-step Charleston
against the good-company bot brain (party/bot.ts imports cleanly
client-side — it depends only on the card and the tiles) and reports
agreement plus the coach's target hands after each pass; "Name the
hand" deals racks and asks which of three card hands is closest,
graded by the evaluator. Client-side is safe here by construction:
the card is public guide data and a drill has no hidden state and no
opponent, so there is nothing to redact and nothing to verify. The
one supporting change in shared code: HandEval now also carries its
best reading's concretized groups, purely so candidates can render
as tiles; the matcher and the bots ignore the field.

## No mid-hand resets (2026-11-05)

A reset used to be the friendly way to abandon a hand: one tap, and
the table went back to the lobby. It ended a real family game when a
player tapped it by accident mid-play — the button sits on every
screen, and the consent guard covered only the Charleston. Rather
than grow a second vote, resets are now simply refused while a hand
is underway (Charleston or play, anyone's tap, solo included), with
the note naming the real ways out: a Charleston can still be voided
by unanimous vote, and any hand can be abandoned by leaving — a room
costs nothing, so start a new one. In the lobby and after a finished
hand, reset still tidies the table.

## Room admin (2026-11-05)

Rooms are Durable Objects, and Durable Objects cannot enumerate
their siblings — there is no "list all rooms" API to build an
admin page on. So the game keeps a registry: a singleton object
that every room reports itself to whenever its summary changes
(phase, seats, humans). The report is hooked into persist() and
gated on the summary actually changing, so a game in progress
costs the registry nothing, and a failed report never breaks a
game. The registry stores summaries only, never game state. The
admin page (public/admin.html, linked nowhere — you have to know
the URL) lists rooms freshest first and can wipe one: the wipe
is an action on the room itself, which erases its storage and
alarm, resets it to a fresh lobby, and removes its registry row.
Listing, forgetting and wiping are gated by the ADMIN_KEY secret
when one is set; without it (local dev) they are open.
