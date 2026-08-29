1. Users will connect to the web URL via a reverse proxy and will be met with a main menu where they can create a game or join a game, after login. (NOTE: registration should be an environment variable in docerk to enable/disable signup)
2. When creating a room, the user can choose to set a room password
3. Once two users join a room, either of them can press the "start game" button.
4. Both players will be asked to choose a deck from the decklist, which will consist of user generated decks or premade precons
5. Once decks are chosen both players will have the option to mulligan or keep their hand (7 cards). A mulligan shuffles the hand back into the deck and draws a fresh 7, and lowers by one the size they must finish on (6, then 5, then 4, etc. — players always keep at least 1 card). They can do this as many times as they need until they are happy with their hand. **The cards only go on the bottom once a hand is kept**, so a player never pays for a hand they are about to throw away; keeping after two mulligans means putting 2 cards on the bottom, and the game does not begin for that player until they have.
6. Once the game starts they will follow standard turn order (only the player going first skips their draw, on their first turn; the second player draws normally on theirs)
7. Players can only set cards on their first turn, there is no chance to "Open" (flip the card face up)
8. Starting on their second turn players will have an "Open" step where they can flip a card by paying its cost. We will track cost of cards in the DB like this: R (red), B (black), W (white), G (green) and a number if there is a generic cost. For example BB costs 2 black, 1B costs 1 generic and 1 black, RGB costs 1 Red, 1 Green, 1 Black. Costs are paid by discarding cards of those colors. All cards have 1 color, any card can pay generic cost.
9. Costs must be payed when the card is flipped, the if the player does not have the ability to pay the cost they cannot even try to flip.
10. On flip the ability on the card will attempt to resolve (if it has one)
11. cards that get used (activated) such as: activated abilities, moving, attacking will become locked (tapped). Tapped will be represented by being turned 45 degrees
12. The table has 5 Columns (Areas), each player has their own side of an area, and in the center of each area is a City. 1 City (random each game) is the capital.
13. The capital has 3 states:

- set (face down)
- unoccupied (face up, sideways)
- occupied (facing whichever player occupies it)

14. cards on the players battlefield have three states:

- set (facedown)
- unlocked (face up, not tapped)
- locked (face up tapped)

15. On a players main phase after the open step they have these actions they can perform as much as they want:

- Set a card from their hand to an area
- Activate a card that has a tap ability
- Move an unlocked card (lock it) up to its maximum move distance
- Attack a city in the area that you are in. The city stays face down until a vanguard is named; until then the attack can be called off.

16. If the player starts an attack, we go to the combat step. We can go to the combat step multiple times per turn but only once per area. and we go back to the main step after each combat step.

17. On a players main phase after the open step they have these actions they can perform as much as they want:

- Set a card from their hand to an area
- Activate a card that has a tap ability
- Move an unlocked card (lock it) up to its maximum move distance
- Attack a city in the area that you are in. The city stays face down until a vanguard is named; until then the attack can be called off.

16. If the player starts an attack, we go to the combat step. We can go to the combat step multiple times per turn but only once per area. and we go back to the main step after each combat step.

# Open Step

1. Turn Player is asked to open a card if they want. However they can only open a card that is already set, and whose level is less than or equal to the number of active (face up) cities
2. If the player has no valid opens, we move to main phase.

# Combat Phase

1. Once the combat phase starts, the player who is NOT the turn player has an option to open a card in that area. They can choose not to.
2. Turn player has an option to open a card in this area.
3. Turn player selects their Vanguard (character that is attacking) — a set city flips face up at this point, and the attack can no longer be called off — and any additional creatures that are joining them in the battle. Those creatures lock.
4. Defending player locks creatures that will defend the city. If the defending player currently occupies the city, all creatures in the area MUST lock and be active in combat.
5. Damage is dealth and combat resolves.
6. Combat results in one of the following:

- Annhiliation - no creatures remain. City is unoccupied.
- Attacker Occupies the City - City is occupied by attacker. Attacker draws 2 cards.
- Defended - Occupation status of the city does not change to what it was before combat.

## When to offer a Quick

Rules.md §13 lets a Quick effect interject at almost any point, and asking
both players "any response?" after every response is how a game turns into a
dialogue box. Prompting is therefore limited to the moments where a Quick
could plausibly matter, and only when it could actually be played:

1. the Quick is already **set** on the table, and
2. its cost **can be paid** from hand, and
3. it would **do something now** (see below), and
4. one of these moments arrives:
   - the opponent starts their turn
   - the opponent opens a card
   - the opponent moves to their Main phase
   - the opponent declares a battle
   - the opponent names a vanguard
   - **damage is about to be dealt** — asked of the attacker first and then
     the defender (§13: the turn player goes first), once, before the first
     Range band resolves
   - the opponent ends their turn

"The opponent" means whoever did not do the thing, so a defender's combat open
(§11 ②) offers the window to the attacker. The moment before damage is the one
that is not about the opponent doing something: it is the last chance to act
before the blows land, and every combat Quick in the set — "+2/+2 until end of
turn", "deal 3 damage to a character in combat" — is written for it.

**Doing something now** is judged by the kind of effect, not by the card
(`rules.ts:quickRelevant`): card advantage — a draw, a search, a discard —
is worth taking at any moment; a continuous ability is a card that will sit
on the table working, and opening it out of turn saves the turn's one open;
anything that lasts "until end of turn" is only worth anything while a battle
is running to spend it in; and in every case the effect has to reach
somebody. A Quick that would do nothing is not offered, so a window opening
means there is a real decision in it — and a card the window did not offer
cannot be opened in it.

The client then decides how to _put_ the question (`state/quickStops.ts`).
Inside a battle it is a hard stop. At the turn's edges and the Main phase it
counts down to a pass, or passes at once, according to the player's own
setting — the engine still stops either way; the client answers for them. The
prompt sits along the bottom edge over an undimmed board, with each card's
printed line beside it, because a Quick is a decision about the board.

Anything outside that list resolves without asking. This is a deliberate
narrowing of §13 for the sake of the game being playable, not a reading of the
rule — if a card ever needs a window this misses, widen the list here rather
than prompting everywhere.

The stack of §14 is built on top of these windows. An opened card's effect,
or a used ability's, goes **pending**: each player who holds a relevant Quick
is asked in turn — turn player first — and may interrupt with one, which goes
pending on top and resolves first; when everyone asked has passed, the most
recent effect resolves. Two narrowings, both for playability: a player is
not asked about their **own** pending effect outside a battle (answering your
own draw with another draw is just two opens), and **triggered** abilities —
at a turn's edges, on attack, on death — resolve at once rather than
stacking, since they arrive in the middle of something else resolving and
§14 has no interrupts mid-resolution. A round that interrupted one of the
moments above returns to it once the stack has drained.

## Tutorial

The guided game is an ordinary singleplayer match with two things fixed: both
players use the tutorial deck (`server/tutorial.ts`), and the seed is the first
one whose deal seats the human first with a hand that has Mercenaries to set
and a Level 1 to open. The engine is deterministic from those, so the coach
knows what the player is holding without the rules changing at all.

The coach (`components/Tutorial.tsx`) reads the view, says what the table is
asking, and rings the thing to click. Its steps are predicates on the view,
not positions in a script: a player who sets three cards or moves before
attacking is met where they are. Lessons run in order — the hand, setting,
ending the turn, the Open step and its cost, declaring battle, the vanguard,
the combat open, committing, damage, taking a city — and finish when the
board shows they happened. Reactions fire the first time something new turns
up: a Quick window, a card asking a question, the Royal Capital, an ability.
After the first city is taken the coach says so and stays quiet except for
reactions. Skip is always available; the match carries on without the coach.
