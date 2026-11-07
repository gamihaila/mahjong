# mahjong

American Mahjong for four players, built to be played from a phone
browser: big readable tiles, no accounts, no install. Name a room,
share the name, and whoever shows up takes a seat — bots fill the
empty ones.


## The game

A complete hand of American Mahjong played on the NMJL 2026 card
(the card is encoded as data in `cards/2026.txt`; the in-game card
reference opens on its own tab):

- The Charleston: six passes (right, over, left, twice), with a
  blind pass if you would rather not give up a tile. Passes are
  held in escrow and exchanged atomically — nobody waits on a
  timer, and the only way out mid-Charleston is a unanimous vote
  to void the hand.
- Claims: a discarded tile can be claimed until the next player
  draws. The drawn tile waits briefly in escrow, so a claim can
  still preempt it; a mahjong claim settles immediately, other
  claims at the close of the window by priority, then seat
  distance. A discarded joker is dead and can never be called.
- Exposures, jokers as substitutes in groups of three or more
  (never in pairs or singles), concealed hands, wall games — the
  card's 72 hands are the law, and a built-in evaluator checks
  every rack against all of them.

## Around the table

- **Bots** (Ada, Bea, Cyd, Dee) fill one to three seats. They play
  through exactly the same redacted view and the same commands as
  a human — no peeking, no special path. They are tuned to be
  good company for learners rather than ruthless.
- **Drill room** for solo practice: *Call the pass* (a coach
  grades your Charleston passes), *Name the hand* (read a rack,
  pick its target hand), and a *Move lab* for the rack itself.
- **Your rack** lives on a 24-slot board (three rows of eight):
  tap a tile, tap where it should go, and the tiles between make
  room. The arrangement is yours alone — the server never sees it.
- **When a hand ends**, everyone sees the final racks face-up and
  a timeline of how the hand went.
- **No mid-hand resets.** If a game goes wrong, abandon the room
  and start a new one; a small admin page (key required) lists
  rooms and can wipe them.

## Design

The interesting part, and the real reason this exists. One room is
one Cloudflare Durable Object (PartyServer): single-threaded,
authoritative, event-sourced. Clients send commands, never state;
the server folds them into the game and answers each seat with a
*redacted projection* — your tiles and everyone else's counts —
so fairness is a property of the protocol rather than a policy.
Transport is plain HTTP with client polling, after WebSockets
proved to be machinery the game never needed: it is turn-based,
its fastest deadline is two and a half seconds, and a locked
phone is a non-event when there is no connection to lose.

The full design — claim escrow, the Charleston barrier,
idempotent commands, seat tokens, and the four production-only
bugs that all lived at the Durable Object hibernation boundary —
is in [DESIGN.md](DESIGN.md). The story is also told as an
article: [Building an American Mahjong Game with Muse:
Adventures in Distributed
Protocols](https://www.linkedin.com/pulse/building-american-mahjong-game-muse-adventures-george-andrei-mihaila-2bnsc).

## Develop

```
npm install
npm run dev:party        # wrangler dev: server + client locally
npm run build            # typecheck and bundle
npm run test:incarnation # Durable Object restart/hibernation tests
npm run test:restart     # cold-start smoke test
```

Pushes to `main` build and deploy automatically (Cloudflare
Workers Builds). Layout: `party/` is the server (room actor,
bots, room registry), `src/` the React client, `cards/` the
card data and its generators, `tests/` the server test suites.
