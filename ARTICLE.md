# Building an American Mahjong Game with Muse: Adventures in Distributed Protocols

My oldest daughter is a mathematics PhD student at Vanderbilt. This fall we started playing American Mahjong together, her in Nashville, me in California, using a commercial app. The game was fine. The app was not: screens mostly white space, tiles too small to read comfortably. I am new to mahjong. Distributed systems, less so — that is my day job. So we built our own, her as the intended user and toughest critic, me directing, and Muse implementing. Two days and thirty pull requests later, we have a game that fits a phone screen and survives the phone being locked, pocketed, or killed. What I did not expect was how good a distributed-systems teacher a card game turned out to be.

## The design in one paragraph

One room is one actor — a Cloudflare Durable Object, single-threaded, holding the entire game. Clients never send state; they send commands (draw, discard, claim, pass), and the state is a fold over the event log. The important decision is what the server sends back: not the state, but a projection of it. You receive your own tiles and everyone else's *counts*. Nobody's client ever holds another player's rack, so there is nothing to leak and nothing to cheat with. Even the bots play through the same redacted view and the same command path as the humans. Fairness is not a policy we enforce; it is a property of the protocol.

One more decision is worth naming: when a tile is discarded, it can be claimed until the next player draws — and the drawn tile waits briefly in escrow, so a claim can still preempt it. A mahjong claim is a small distributed transaction wearing a tile's clothes.

## Four bugs, one boundary

Every serious bug we hit lived at the same seam: the actor sleeps. Durable Objects hibernate between events and wake with their memory wiped. In local development the object never sleeps, so all four bugs were production-only. Each taught the same lesson from a different side.

**1. The promise nobody awaited.** The bots were scheduled by arming an alarm without awaiting the call. Hibernation dropped the un-awaited promise, and the bots silently stopped moving. Work you don't await is work you haven't done.

**2. The counter that forgot.** Bot commands carried IDs from an in-memory counter: bot-1, bot-2, ... After a restart the counter reset, the new IDs collided with the persisted idempotency log, and the server quite correctly ignored the "duplicate" commands. Anything that meets durable storage must be unique across incarnations. The IDs are UUIDs now.

**3. Relative time.** Bot pacing was a queue of delays kept in memory — act in 900 milliseconds. Every wake re-applied the delay, so an overdue action could be postponed wake after wake, indefinitely. Pending work is now persisted with absolute due times, checked against the server's clocks. The client's clock never gets a vote.

**4. The fractional millisecond.** This one is my favorite. The due times included fractional delays — act at 1413.7 milliseconds. The alarm fired on the integer millisecond, the cue read as "not due" by a fraction, and the handler re-armed for an instant already past — and those immediate re-arms were delivered 7 to 59 *seconds* late. Due times are integers now. After the fix, 33 consecutive bot actions executed 0 to 19 milliseconds after they were due. As I wrote to Muse at the time: oh, it's snappy now.

If there is one sentence to take from our game to your system, it is this: *anything an actor keeps only in memory is a lie it tells itself between naps.*

## The socket we didn't need

The game began, as multiplayer games do, with a WebSocket. It worked, except when a player stepped away: the phone slept, the socket died quietly, and coming back meant a reload.

Then I asked a simpler question: what does this game actually need? It is turn-based. Its fastest deadline is two and a half seconds. Nothing in it is real-time except the feeling. So we deleted the socket and went to plain HTTP with client polling — the poll interval chosen by what the player is *blocked on*, brisk when a claim might need you, leisurely when it can't. A locked phone is now a non-event: there is no connection to lose, so there is nothing to reconnect. The mental model got simpler than the bug list it replaced, which is usually the sign you have found the right protocol.

Before merging, we had Claude review the rewrite. It raised five concerns — about claim timing, racing responses, presence, idempotency. All five were real. We fixed all five on the branch. I have written before that I don't see humans and AI as competing: we always had more ideas than time to implement them, and now the implementation capacity exists while we shape the work. This project was that, twice over — one AI implementing, another reviewing, a human deciding. Cooperating, not competing.

## The small print

For honesty's sake: the two most humbling bugs had nothing to do with distributed protocols. A 500-millisecond timer that existed to update a countdown was re-rendering the entire table twice a second, so tapping a tile could wait three quarters of a second for its highlight. And the finished, correct, thoroughly tested board was, on my phone, cropped at the right edge — because iOS Safari zooms into any text field smaller than 16 points and forgets to zoom back out. Our login field was 14. The grand distributed system, defeated by a font size. The pinch gesture that fixed it also diagnosed it.

The game now does what it was supposed to do: disappear. What remains is a father in California and a daughter in Nashville, a wall of tiles between us, and me still trying to memorize the card. It turns out the card has low entropy — seventy-two hands, a small grammar underneath. I am told this makes it learnable. My daughter is patient.
