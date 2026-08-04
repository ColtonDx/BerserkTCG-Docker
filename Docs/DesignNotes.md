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
- Attack a city in the area that you are in. Set cities will flip at this point.

16. If the player starts an attack, we go to the combat step. We can go to the combat step multiple times per turn but only once per area. and we go back to the main step after each combat step.

17. On a players main phase after the open step they have these actions they can perform as much as they want:

- Set a card from their hand to an area
- Activate a card that has a tap ability
- Move an unlocked card (lock it) up to its maximum move distance
- Attack a city in the area that you are in. Set cities will flip at this point.

16. If the player starts an attack, we go to the combat step. We can go to the combat step multiple times per turn but only once per area. and we go back to the main step after each combat step.

# Open Step

1. Turn Player is asked to open a card if they want. However they can only open a card that is already set, and whose level is less than or equal to the number of active (face up) cities
2. If the player has no valid opens, we move to main phase.

# Combat Phase

1. Once the combat phase starts, the player who is NOT the turn player has an option to open a card in that area. They can choose not to.
2. Turn player has an option to open a card in this area.
3. Turn player selects their Vanguard (character that is attacking), and any additional creatures that are joining them in the battle. Those creatures lock.
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
3. the opponent does one of:
   - starts their turn
   - opens a card
   - moves to their Main phase
   - moves to combat
   - declares an attack
   - ends their turn

"The opponent" means whoever did not do the thing, so a defender's combat open
(§11 ②) offers the window to the attacker.

Anything outside that list resolves without asking. This is a deliberate
narrowing of §13 for the sake of the game being playable, not a reading of the
rule — if a card ever needs a window this misses, widen the list here rather
than prompting everywhere.

The window is **not** the full priority stack of §14: there is no stack of
pending effects and no interrupting an interrupt. A Quick opened in a window
resolves at once, and the window stays open so another can follow it.
