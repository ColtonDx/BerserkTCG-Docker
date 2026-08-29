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
- **"Remains in the battle" is three things, and the third is easy to lose.**
  §12 counts a character that is a _participant_, still on the field, **and
  still in the contested area**. Destruction is the usual way to leave a
  fight, so the area check reads as redundant until a card effect walks
  somebody out (§13; §14 lets an effect override the rule it contradicts) —
  and then a character standing one city away goes on fighting from there.
  `rules.ts:stillFighting` is the single implementation, and `battleResult`,
  the damage step's "is anyone left to strike" and its "who may be hit" all
  read it. They disagreed once, which is exactly how the bug survived.
- **A city wakes when it is attacked, not when it is settled.** A battle
  commencing over a city turns it face-up and it stays face-up (`Rules.md`
  §5); opening a character there does nothing to it. City Level therefore
  only climbs, and the board shows it: `Board.tsx` lays a city on its side
  until somebody holds it, and stands it upright when they do.
- **A city is spent — and woken — by the vanguard, not by the declaration.**
  §10 ④(4) allows one battle per city per turn, and §11 ① lets the attacker
  name nobody, which ends the phase before anything is locked, opened or
  struck. Both the allowance and the flip happen when a vanguard steps
  forward, so calling an attack off costs nothing and shows nobody the city —
  `designateVanguard` in `reducer.ts` is where `battledCities` grows and
  where `CITY_FLIPPED` is pushed. A declaration called off leaves the board
  exactly as it found it.
- **The vanguard is the character that started the attack.** It was on the
  field before the battle was declared and is named in §11 ① — before the
  combat open in ② — so a character opened during the battle may join it but
  can never lead it. `isVanguard` in `abilities.ts` means this one character.
- **A battle never stops on a question with one answer.** A combat open with
  nothing openable in the contested city, a commitment step with nobody left
  to commit, or a strike with a single enemy to spend its Power on, is
  answered by the engine — `settleBattle` in `reducer.ts`, run from the action
  dispatch so every route into a step is covered. The damage step is a real
  choice only when there are _two or more_ enemy participants standing: §11 ④
  spends the striker's whole Power among them, so one enemy leaves exactly one
  legal split and asking would be offering a single button the player has to
  press before the battle can finish. Two is a genuine decision —
  concentrating kills one, spreading may kill neither — and is always asked.
  The vanguard step is always a real choice.

  This has a consequence outside the engine that is easy to reintroduce: a
  single action can now carry an entire exchange, so its event batch holds
  every strike, every death, the city changing hands and the draws that go
  with it. The **presentation queue** (below) cuts that batch into beats and
  plays them one at a time, holding each death behind the blow that caused
  it — drawing the batch in one frame is what made cards appear to vanish for
  no reason.

- **What is shown is a queue, not a set of overlays.** `planBeats` in the
  protocol cuts an event batch into **beats** — a turn banner, a card held up,
  a band of blows, a city taken — in the order the engine resolved them, and
  `usePresentation` on the client plays them one at a time. Every overlay
  (`Banner`, `Revealed`, `CityTaken`, `BoardFx`) renders the beat on stage
  rather than watching the batch for itself; the prompts (`AssignDamage`,
  `HandFocus`, `QuickPrompt`, `MatchOver`, the battle bar's button) wait until
  nothing is on stage. They each used to start their own timers in the same
  frame, which put the city-taken card over the deaths that took it and a
  Quick prompt over the reveal it was answering. `presentationMs` is the sum,
  and it is the **only** pacing the computer opponent has: `driveAi` holds
  until the human's screen is quiet, then thinks, then moves. There is no
  table of per-action pauses to keep in step with the CSS any more — a new
  beat is a new entry in `planBeats` and Femto waits for it for free. The
  board is part of the telling: each beat says what it **reveals**, and
  `usePresentation` draws the view from _before_ the batch with those cards
  and cities held back until their beat starts (`compose`) — a character
  stays standing until its blow lands, the two cards a city pays arrive as
  the city-taken card says so. The authoritative view is untouched;
  `shown` is a picture of it. The result screen waits for the whole queue,
  so a win is never interrupted by the last of the telling.

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
  or it leaks the day it is introduced. One thing looks into a deck: a search
  that has stopped to ask (§13) reveals to the _searcher_ exactly the cards
  their own card lets them take, and nothing else, so the order of what they
  are about to shuffle stays secret.
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
- **Events ride with the view.** `state:update` carries the batch that
  produced it, so the two land in one render. They were separate messages
  once, and an overlay reading the batch against the view _before_ it looked
  up an opponent's just-opened card in a view that still had it face down — so
  the reveal never showed. Anything drawn from an event should look the card
  up when its beat plays, not when the batch arrives.
- **`isHidden` is not `faceUp`.** The first says what the server redacted, the
  second says what is face up on the table. Your own Set Cards are not
  redacted — Rules.md §7 lets you check them — so a card in a city must be
  drawn from `faceUp`, or it shows its face to its own controller. The one
  exception is a card being pointed at somebody (§13): its controller has
  already chosen it and paid, so it is turned up for the moment the question
  is on screen. That is keyed off `aimSource`, **not** off the `aim` role — a
  character may target itself when it is the only one in its area, and such a
  card is reported as `'target'` so it stays clickable. Reading the role alone
  left exactly that card face-down while asking the player to choose it.
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

## Where it runs

**The dev server is `10.10.100.36`** (`dev-1`), and it is the only deployment.
**Never treat `localhost` as the deployment.** This checkout lives on a
different machine (`10.10.100.99`), so `docker compose up` here builds a
private stack that nobody else can see — it is not a deploy, and verifying
against it proves nothing about `.36`.

| What          | URL                             |
| ------------- | ------------------------------- |
| The game      | http://10.10.100.36:3001        |
| Server health | http://10.10.100.36:3001/health |

One port, because `.36` runs the **prod** stack: a single container serving
the API and the built client same-origin. There is no `:5173` there — that is
the dev stack's Vite port and only exists on a machine running
`docker-compose.yml`.

### Deploying

The deployment is a **file copy at `/home/dxadmin/berserk-tcg`, not a git
checkout**, so there is nothing to `git pull` there. Push first, then rsync
the tree and rebuild:

```bash
rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.env' \
  -e "ssh -i ~/.ssh/dxadmin_id_rsa" \
  ./ dxadmin@10.10.100.36:/home/dxadmin/berserk-tcg/

ssh -i ~/.ssh/dxadmin_id_rsa dxadmin@10.10.100.36 \
  'cd /home/dxadmin/berserk-tcg && docker compose -f docker-compose.prod.yml up -d --build'
```

**Excluding `.env` is not optional.** The one on `.36` holds that box's real
`SESSION_SECRET` and `POSTGRES_PASSWORD`; overwriting it signs out every
account and breaks the database login. It also sets `CORS_ORIGIN` to the host
URL, which the prod stack needs because the browser's `Origin` is
`http://10.10.100.36:3001`.

Prod builds the client into the image, so **every change needs a rebuild** —
there is no hot-reload and no bind mount. Verify against the host afterwards,
never against `localhost`:

```bash
curl -s http://10.10.100.36:3001/health    # uptime near 0 means it restarted
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

It plays for territory rather than for exchanges. **The Royal Capital
outranks everything** once it is face up — §1 makes the game unwinnable
without it, so Femto sets into it however crowded, attacks into it on an even
trade it would decline anywhere else, and keeps feeding characters into
defending it. **An unheld area is worth attacking with anyone**, because §12
reads the result off who was committed and a defender with nobody to commit
loses it — the bar is "can this be won", not "is my stack bigger". **The
combat open (§11 ②) is always taken**: it does not spend the turn's one open
(§10 ③), and §11 ③ keeps committing separate, so a card can come down and
stay out of a fight already lost. **Early turns spread**: two sets a turn for
the first three, preferring Mercenaries — Level 0, ten to a deck — into areas
the opponent is not standing in, because uncontested claims are the cheapest
board presence there is. Going second it sets a Level 1 on turn one rather
than a Level 0, since its first Open step arrives at a City Level the opener
has already raised (§10 ②).

Against the previous version it wins about two games in three. It still does
not march characters toward a city it wants.

**The card database and deckbuilder.** All 448 cards are cut from the scans
(`art-assets/cards/`, `scripts/extract-cards.py`).
`Docs/Berserk_TCG_Cardlist.csv` is the authority for everything printed on a
card — name, cost, Level, Unique, type, Normal/Eternal, Quick, and every
character's Range, Move, Power and HP — and `build-catalogue.py` joins it to
the colour and Mercenary flags measured from the frames. Postgres is
initialised from that data at container start (`db/init/`). The deckbuilder
enforces `Docs/Deckbuilding.md` live, and decks save to the database. See
`Docs/CardData.md` for what is still missing.

**Abilities** (§13) have a registry and 40 cards. Continuous ones
(Griffith's aura, Casca's condition) are read off the board by `powerOf` /
`hpOf` / `moveOf` rather than stored, so they stop the instant their source
moves and there is nothing to undo. Triggered ones — on open, on attack, at
the turn's two edges — fire through `fireAbilities` in `reducer.ts` and write
their result down; "until end of turn" is a counter on the card, swept with
damage in the End phase. `cannotAttack` is asked of the board by
`canVanguard` and `canCommit`. An ability may ask the player to choose a
character: `OPEN_CARD` carries the choice, `legalActions` suggests a legal one
the way it suggests a payment, and the reducer accepts any other legal one.

**Cost-bearing abilities** (§13) are `USE_ABILITY`. The wire names one by its
index on the card (`abilityKey`), because the ability list is static card data.
A cost may lock the card itself — the printed "Tap:", which §6 allows as a cost
— lock a character the player picks, take cards out of hand, or be once per
turn; every part must be payable or the ability is never offered. `canActivate`
in `rules.ts` is the single authority on timing, which is why `reduce` lets
`USE_ABILITY` past the priority gate rather than duplicating the rule. A Quick
ability rides the same windows a Quick card does — `offerQuick` probes the
window it is _about_ to open, since a Quick ability is only usable inside one.

The client offers them from the card's right-click menu, and needs the printed
ability list to do it: `legalActions` names an ability by its index, which is a
number with no label and no price. `/api/catalogue` therefore ships each card's
abilities alongside it — static card data, nothing hidden — and the client
reads them through `abilityOf`. `targets` on that payload is what tells the two
kinds of choice apart: a cost that locks an ally (§6) puts a name in the
action too, and raising the targeting arrow over it would be asking a question
nobody posed.

Effects can scale (`per`, §13's "for each"), soften damage on the way in
(`reduceDamage`, continuous or a `SHIELD` counter for the turn), reach
face-down Set Cards (`Selector.faceDown`), and be aimed by Distance
(`TargetSpec.maxDistance`, §15). One printed line that does two things for one
price is one ability with `then`, never two entries — a second entry would be
a second ability the player could use for free.

A face-up character's _current_ numbers travel in the view as
`VisibleCard.current`, because the client cannot work out an ability's effect
from the card database — and the damage step spends the current Power exactly,
so a client reading printed Power could never balance an assignment. _Who_ is
moving them travels as `VisibleCard.boostedBy` (`rules.ts:boostSources`) for
the same reason: a continuous ability is read off the board and stored nowhere,
so a character standing at +1/+1 would otherwise have no visible cause. The
table shows both — a marker on the card for the shift, a line on hover to the
card causing it.

**Quick windows** (§13) let a Quick Set Card be opened out of turn. The game
stops at seven moments — `DesignNotes` "When to offer a Quick" — and only when
the other player actually has one set, can pay for it, and it would **do
something now** (`rules.ts:quickRelevant`: card advantage anywhere, a
continuous ability anywhere, anything "until end of turn" only inside a
battle, and always reaching somebody), so silence means there was nothing to
ask. A window offers exactly what `quickOpens` lists and `openCard` /
`canActivate` refuse anything else, so the two stay in agreement. The moment
**before damage** is the one every combat Quick is written for; it asks the
attacker and then the defender (`QuickWindow.then`), once, before the first
band. `state.quick` outranks both priority and a running battle, because that
is what an interrupt is; `PASS_PRIORITY` closes it — or hands it to `then` —
and play resumes where it froze — or hands the question on to the stack (§14,
below).

How the question is _put_ is the client's: `QuickPrompt` sits along the bottom
edge over an undimmed board, a hard stop inside a battle and a countdown
outside one, and `state/quickStops.ts` holds the player's own setting for how
often to be stopped. The engine pauses either way; the client passes for them.
An ability that resolves and changes nothing says so — `ABILITY_FIZZLED`
follows its `ABILITY_RESOLVED`, and the reveal reads "nothing for it to
affect" — because a card that came forward and did nothing looked broken.

**Pending choices** (§13) are for the printed lines an effect cannot finish on
its own: "discard 2 cards" and "add 1 Serpico from your deck" both name a
number and leave the player to say _which_. `state.pending` suspends the game
on the question and `CHOOSE_CARD` answers it one card at a time, counting down
until it is paid. It outranks a Quick window and a running battle both — a
window is a question you may decline, this is an effect already half-resolved —
and it is exempt from the priority gate, because the defender's combat open
(§11 ②) can be the very card that asked. A deck search reveals exactly the
cards it may legally take: `rules.ts:searchable` is the one list, read by
`legalActions` and by `view.ts` alike, so the client can never be offered a
card it was not shown or shown one it cannot take. The deck is shuffled when
the last card is named, not before. An asking effect must be the last thing on
its printed line — `resolveEffect` throws rather than quietly dropping a `then`
that follows one, because resuming a half-run line would need a continuation no
card in the set wants.

**Not implemented.** The list of what is left lives in `TODO.md`. Green is
complete; three transcribed lines still want a ruling before they are built.
Recovering a _forgotten_ password is not built — that needs a channel the
server does not have.

**The priority stack** (§14) is built on top of the Quick windows. An opened
card's effect or a used ability's goes on `state.stack` (`stackEffects`,
`useAbility`) and `startRound` asks each player holding a relevant Quick,
turn player first, with a `'response'` window; a Quick played there stacks
on top and resolves first; `PASS_PRIORITY` with nobody left to ask resolves
the top (`resolveTop`), which fizzles if its source or chosen target has
gone. `state.resume` remembers the moment-window a round interrupted and
reopens it when the stack drains. Two narrowings, noted in `DesignNotes`: a
player is not asked about their own pending effect outside a battle, and
triggered abilities resolve at once rather than stacking.

**Rooms.** `DesignNotes` 2 and 3 are built: a match made with a password is
private — listed with a lock, joined only with the word, never handed out as
"an open match" — and nothing deals between people on its own: once both
seats hold a legal deck either player presses **Start game** (`match:start`,
`matches.ts:startMatch`). Against the computer the last deck chosen deals at
once, because there is nobody else to press it.

**Getting back into a game.** A seat survives both a disconnect and a
mid-game leave — `matches.ts:leave` keeps it once a match has dealt, because
walking away is not a vacancy — so the only thing a dropped player ever lacked
was a way to _find_ the match again. `matches:mine` lists the dealt,
unfinished matches an account holds a seat in, and the main menu offers them
above everything else; rejoining is the ordinary `match:join`. The list is
derived from the authenticated session, never from the payload — a client that
could name a player id there would be asking whose games somebody else is in.

**The toss.** §9.2 picks the first player randomly, which `setup.ts` does by
shuffling the seats from the match seed: `seats[0]` goes first. `CoinFlip` is
the reveal and decides nothing — a coin that decided anything in the browser
would be a rule living in the client. It fires off the first view arriving,
which _is_ the deal, and only while the match is still in setup, so a player
rejoining on turn nine is not told the toss all over again.

**The opening ceremony is a sequence, not three overlapping effects.**
`App.tsx`'s `Ceremony` stage runs `burn` → `toss` → `playing`: the menu burns
off the board, the coin lands, and only then is the opening hand asked for
(§9.4). Each stage waits for the previous one to report done rather than for a
timer, so nothing has to guess how long a burn takes. They were independent
booleans set in the same tick once, which played all three at once. Two things
hang off this and are easy to break: the shuffle is heard when the ceremony
clears rather than when the view arrives, because that is when the hand
actually appears; and `OPENING_CEREMONY_MS` in the protocol holds Femto back
through setup, or it settles its hand — shuffle sounds and all — underneath an
animation the human is still watching. Raising `BurnAway.DURATION` or
`CoinFlip`'s spin/hold means raising that constant too.

`data/placeholder-cards.ts` is invented filler that survives _only_ as a
fixture for the engine's own tests. Never build against it, and never serve it.

Matches live in memory and are lost on restart; `Match.actions` is the replay
log a future persistence layer would store.
