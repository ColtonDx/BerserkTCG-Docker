# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A browser-based, Docker-hosted digital implementation of the **Berserk TCG**
(Konami, 2003 — based on Kentaro Miura's _Berserk_).

The goal is a **video game**, not a tabletop simulator. The software enforces
the rules: it tracks turns and phases, validates every move, resolves battles,
applies card effects, and ends the game. Players click a legal option; they
never move a token the engine did not authorize, and they are never trusted to
remember a trigger. If a player can do something the rules forbid, that's a bug.

## The source documents

| File                   | Authority                                                              |
| ---------------------- | ---------------------------------------------------------------------- |
| `Docs/Rules.md`        | How Berserk is played. Governs every rules decision.                   |
| `Docs/DesignNotes.md`  | How the _product_ should behave — rooms, login, decks, UI affordances. |
| `Docs/Deckbuilding.md` | Deck legality limits.                                                  |

- **Do not invent rules.** If neither document covers a case, say so and ask —
  do not guess at a plausible TCG behaviour and implement it.
- Cite the section in the code comment and in `RuleViolation.rule`, so a rules
  change can be traced to code: `'§7'`, `'DesignNotes 5'`.
- Unresolved decisions are marked `RULES:`. Grep for them:
  `grep -rn "RULES:" packages apps`.
- If code and these documents disagree, the documents win — fix the code, don't
  quietly rewrite the document.

### Settled rules decisions

These read ambiguously at first and have since been confirmed. Both documents
were updated to match, so don't re-open them from an older reading.

- **City Level is global, not per-city** — it is the number of face-up cities
  anywhere on the table (`Rules.md` §5, `DesignNotes` "Open Step" 1). Flipping
  any city raises the gate for opening cards in _every_ city.
  `rules.ts:cityLevel` is the single implementation.
- **Mulliganing decides first and pays after.** A mulligan only reshuffles and
  redraws a full seven; it lowers `handTarget` rather than bottoming anything.
  The cards go to the bottom when the player picks _Keep_, so nobody bottoms
  cards from a hand they are about to mulligan away (`DesignNotes` 5).
  Bottoming the last owed card is what settles the keep — see
  `reducer.ts:reduceSetup`.
- **A battle is decided by its participants, not by the city.** Rules.md §12
  reads the result off the characters committed to the fight. A defender who
  commits nobody loses the city, however many of their characters are standing
  in it — declining to fight is a choice, not a way to deny an attack.
  `rules.ts:battleResult` is the single implementation.
- **A city wakes when it is attacked, not when it is settled.** Declaring a
  battle over a city turns it face-up and it stays face-up (`Rules.md` §5);
  opening a character there does nothing to it. City Level therefore only
  climbs, and the board shows it: `Board.tsx` lays a city on its side until
  somebody holds it, and stands it upright when they do.
- **The vanguard is the character that started the attack.** It was on the
  field before the battle was declared and is named in §11 ① — before the
  combat open in ② — so a character opened during the battle may join it but
  can never lead it. `isVanguard` in `abilities.ts` means this one character.
- **A battle never stops on a question with one answer.** A combat open with
  nothing openable in the contested city, or a commitment step with nobody
  left to commit, is answered by the engine — `settleBattle` in `reducer.ts`,
  run from the action dispatch so every route into a step is covered. The
  vanguard and damage steps are always real choices and are always asked.
- **Only the first player skips their draw**, and only on their first turn; the
  second player draws normally on theirs (`Rules.md` §10 ②, `DesignNotes` 6).
- **A card that cannot be legally opened is never offered.** `Rules.md` §7 says
  an over-Level card flips back down with no cost paid, which exists because on
  paper you flip before checking. A digital client knows the level and the hand
  up front, so the engine rejects the attempt rather than consuming the one
  open per turn (`DesignNotes` "Open Step" 1 and 9).

## Architecture

```
packages/engine     Pure rules engine. No I/O, no framework, no network.
packages/protocol   Wire contract shared by server and client.
apps/server         Fastify + Socket.IO. Hosts matches; the only authority.
apps/web            React + Vite. Renders server state; submits intents.
```

Dependency direction is strictly one-way: `engine ← protocol ← {server, web}`.
The engine must never import from the server, the client, or the protocol.

### The engine is pure and deterministic

`packages/engine` is the heart of the project. Given a state and an action, it
produces the next state:

```ts
reduce(ctx, state, actor, action)
  => Result<{ state, events }, RuleViolation>
```

`createEngine(registry)` bundles the card registry so callers don't thread
`ctx` everywhere; it changes nothing about the semantics.

Non-negotiable invariants:

- **No `Math.random()`.** All randomness goes through the seeded RNG in
  `rng.ts`, whose state lives inside `GameState`. A match is reproducible from
  `{ seed, actions[] }` — that is what makes replays, spectating, and bug
  reports possible. Breaking this breaks all three.
- **No I/O, no clock, no network, no database.** If a value depends on the
  outside world, it belongs in the action payload.
- **No mutation of the input state.** `reduce` clones into a draft and returns
  a new state. There is a test enforcing this.
- **Plain JSON state.** No classes, `Map`, `Set`, or `Date` in `GameState`; it
  must survive `structuredClone` and `JSON.stringify`.
- **Rules violations are values, not exceptions.** Return `violation(...)`.
  Throwing is reserved for engine bugs (corrupt state, unknown card id).

### The server is authoritative

`apps/server` owns every `GameState`. Clients send intents and receive
redacted views.

- **Never send `GameState` to a client.** Always `viewFor(state, playerId)`.
  A client that receives an opponent's hand has already leaked it, no matter
  what the UI draws.
- **Hidden information in Berserk**: decks (from everyone), hands (from the
  opponent), Set Cards (from the opponent — you may always check your own), and
  face-down City cards (from everyone, so the Royal Capital's position stays
  secret). `view.ts` handles all of it; any new hidden zone must be added there
  or it leaks the day it is introduced.
- **Never trust the client.** `reduce` re-validates every action even though
  the UI only offers legal ones. **Clients never name themselves**: the socket
  is authenticated at handshake against a signed session token, and the seat's
  `playerId` is the account id the token carries. No wire message accepts a
  `playerId` any more, so there is no claim left to spoof — keep it that way,
  and derive identity from `sessions.get(socket)` in `gateway.ts` rather than
  from anything a payload says.
- **No game logic in the server.** If rules are appearing in `matches.ts` or
  `gateway.ts`, they belong in the engine.

### The client renders, it does not decide

`apps/web` displays the last `PlayerView` the server sent and submits actions.

- **No optimistic application of moves.** The round trip is milliseconds; local
  simulation is a desync waiting to happen. The next `state:update` is truth.
- **`isHidden` is not `faceUp`.** The first says what the server redacted, the
  second says what is face up on the table. Your own Set Cards are not
  redacted — Rules.md §7 lets you check them — so a card in a city must be
  drawn from `faceUp`, or it shows its face to its own controller.
- **Touch is landscape-only, and every hover has a tap.** A phone on its side
  is the shape of the table; portrait is not supported. `useCardDrag` rebuilds
  drag-to-set on pointer events because touch devices never fire HTML5
  drag-and-drop, and it finds its drop area with `elementsFromPoint` — the
  raised hand covers the middle of a short screen, so the topmost element
  there is the hand, not the area under it. Guard hover handlers with
  `pointerType`: a tap is followed by compatibility mouse events, including a
  `mouseleave` that will close whatever the tap just opened.
- **Render from `view.legalActions`.** That list is what makes the game feel
  like a video game: illegal moves are never drawn, so they cannot be attempted
  and never need an error message. Any affordance not backed by a legal action
  will simply be rejected.
- `legalActions()` and `reduce()` must agree — everything offered is accepted,
  everything omitted is rejected. A property test enforces this across several
  turns; keep it passing as the action set grows.

## Commands

```bash
npm install            # once, on the host (or use Docker below)
npm run dev            # server on :3001, web on :5173
npm test               # vitest, all packages
npm run typecheck      # tsc --build across the monorepo
npm run build          # build everything in dependency order
npm run format         # prettier

docker compose up                            # full dev stack + Postgres
docker compose -f docker-compose.prod.yml up --build   # single-container prod
```

Run `npm run typecheck` and `npm test` before declaring work finished. The
strict TypeScript settings (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) catch real bugs — do not loosen them, and do not
reach for `any` or non-null `!` to get past them.

## Conventions

- TypeScript everywhere, ESM only, `.js` extensions in relative imports.
- Ids are branded types (`PlayerId`, `CardInstanceId`, …). Use the `as*`
  helpers at boundaries rather than casting.
- Card _definitions_ (printed cards) are immutable shared data; card
  _instances_ are per-match mutable state. Don't conflate them.
- Costs are stored in the database notation from `DesignNotes` 8 (`1B`, `RGB`,
  `BB`) and parsed with `parseCost`.
- Card behaviour is data in `packages/engine/src/abilities.ts`, keyed by card
  id, never parsed out of rules text. Each entry carries the printed line it
  stands for so a drift between the two is visible in one place. A card with
  no entry does nothing at all rather than something approximate — the
  inspector says "not yet in play" so a player is not misled.
- Tests live beside the code as `*.test.ts`.
- Card art and rules text are Konami's IP.
- Card images live in `art-assets/cards/` as `<SET>-<NUMBER>.jpg` (`BK1-007.jpg`),
  cut from the scans in `art-assets/PDFs/` by `scripts/extract-cards.py`. The
  filename is the printed card number, so it is the key to join image to card
  data. Re-cut with `python3 scripts/extract-cards.py`; it validates each
  volume's count and numbering and reports anything that does not add up.
- `back.jpg` in the same folder is the single back every card shares — that is
  what makes a face-down card hidden. `--backs` cuts it, sampling several
  sheets across all five volumes and refusing to write if they disagree.
- The three City faces (`city.jpg`, `city-capital.jpg`, `city-back.jpg`) come
  from their own scans, cut by `scripts/extract-cities.py`. A face-down city
  may only ever draw `city-back.jpg`, or the Royal Capital's position leaks
  off the board.

## Current state

**The game is playable end to end.** A match can be won by occupying three
cities including the Royal Capital, or by decking an opponent out.

**Implemented.** Match creation and seating, reconnect, deterministic shuffles,
the five-city board, mulligans with bottoming, the five-phase turn structure
(Refresh / Draw / Open / Main / End) with automatic phases, setting cards,
opening cards with City-Level gating and colour cost payment, one open per
turn, Unique enforcement, character movement with locking, hand-limit
discards, city flipping and loss of occupation, the **Battle phase** in full
(§11–12), win by occupation or deck-out, concede, and complete
hidden-information redaction.

A phase that offers nothing but leaving it is skipped: an Open step with
nothing openable, or a Main phase with an empty hand and every character
locked. `reducer.ts:hasNothingToDo` asks "is anything else legal" rather than
listing cases, so a new action counts there for free. `settle` runs after
_every_ action as well as on entry, because a phase usually empties in the
middle of one — taking the turn's single open (§10 ③) is what ends the Open
step, and nobody should have to dismiss a step they have just finished.

**The Battle phase** hangs off `state.battle` rather than the turn's phases,
because battle is declared from inside Main and returns there (§10 ④(4)). It
**overrides priority**: the defender opens, commits and assigns damage
throughout the attacker's turn, so `reduce` lets battle actions past the
priority gate and answers to `battle.waitingOn` instead.

**Accounts, decks and matches.** Sign-in with scrypt-hashed passwords and
signed session tokens (`auth.ts`), a password change that requires the current
one, a chosen badge (a card number, so the art is already there), a
registration switch (`REGISTRATION_ENABLED`),
deck storage owned by the account, and deck selection before a match deals —
the server loads the chosen deck by id and re-checks its legality, so the
client cannot smuggle in an illegal or unsaved deck. **An account is required
to play**: the socket refuses an unauthenticated handshake, and the deck routes
answer 401 without a token.

**The computer opponent.** Femto (`ai.ts`) plays from the printed numbers:
which opening hands are worth keeping, what to give back, which card to set and
where, which Set Card to open and what to spend on it, when to attack, who
leads, who joins, and where damage goes. `chooseAction` is a pure function of
the position, so its judgement is unit-tested; pacing lives in `driveAi`, and
its moves are broadcast as events so the client's feed is not one-sided.
It does not yet march characters toward a city it wants.

**The card database and deckbuilder.** All 448 cards are cut from the scans
(`art-assets/cards/`, `scripts/extract-cards.py`).
`Docs/Berserk_TCG_Cardlist.csv` is the authority for everything printed on a
card — name, cost, Level, Unique, type, Normal/Eternal, Quick, and every
character's Range, Move, Power and HP — and `build-catalogue.py` joins it to
the colour and Mercenary flags measured from the frames. Postgres is
initialised from that data at container start (`db/init/`). The deckbuilder
enforces `Docs/Deckbuilding.md` live, and decks save to the database. See
`Docs/CardData.md` for what is still missing.

**Abilities** (§13) have a registry and a first thirteen cards. Continuous ones
(Griffith's aura, Casca's condition) are read off the board by `powerOf` /
`hpOf` / `moveOf` rather than stored, so they stop the instant their source
moves and there is nothing to undo. Triggered ones — on open, on attack, at
the turn's two edges — fire through `fireAbilities` in `reducer.ts` and write
their result down; "until end of turn" is a counter on the card, swept with
damage in the End phase. `cannotAttack` is asked of the board by
`canVanguard` and `canCommit`. An ability may ask the player to choose a
character: `OPEN_CARD` carries the choice, `legalActions` suggests a legal one
the way it suggests a payment, and the reducer accepts any other legal one.

A face-up character's _current_ numbers travel in the view as
`VisibleCard.current`, because the client cannot work out an ability's effect
from the card database — and the damage step spends the current Power exactly,
so a client reading printed Power could never balance an assignment.

**Quick windows** (§13) let a Quick Set Card be opened out of turn. The game
stops at six moments — `DesignNotes` "When to offer a Quick" — and only when
the other player actually has one set and can pay for it, so silence means
there was nothing to ask. `state.quick` outranks both priority and a running
battle, because that is what an interrupt is; `PASS_PRIORITY` closes it and
play resumes where it froze. It is _not_ §14: no stack, no interrupting an
interrupt.

**Not implemented.** The list of what is left lives in `TODO.md`. 28 of the 41
transcribed BK1 abilities are outstanding, mostly waiting on chosen targets
and on a way for an effect to stop and ask a question. The **priority stack**
(§14) is still unbuilt, and `USE_ABILITY` is still stubbed.
Recovering a _forgotten_ password is not built — that needs a channel the
server does not have. `DesignNotes` 3 (room passwords and a start-game button)
is also outstanding:
a match deals as soon as both seats hold a legal deck.

`data/placeholder-cards.ts` is invented filler that survives _only_ as a
fixture for the engine's own tests. Never build against it, and never serve it.

Matches live in memory and are lost on restart; `Match.actions` is the replay
log a future persistence layer would store.
