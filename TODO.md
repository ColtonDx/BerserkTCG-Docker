# TODO

What still needs building. Newest items go at the bottom of their section.
Finished work is not listed — the code and `CLAUDE.md` describe what exists.

## Next

1. **Replace the placeholder precons.** Two mono-colour decks (white and green)
   ship so a match can start without building a deck. The real Black Swordsman
   and Hawks Soldiers lists are not published anywhere machine-readable. Now
   that every card has its printed name, a list given as names can be mapped
   straight onto the database — swap `scripts/build-precons.py` when it
   arrives.

## Rules still to build

1. **Abilities** (`Rules.md` §13). The registry exists (`abilities.ts`) and
   thirteen BK1 cards are built and tested, including targeting: an ability
   can ask the player to choose a character, `OPEN_CARD` carries the choice,
   and the payment overlay asks for it. Rules text and creature subtypes are
   captured for the first 41 cards and shown in the inspector, which marks a
   card whose behaviour is not built yet. The remaining 28 need, in rough
   order of how much machinery each adds:
   - **More target shapes.** The machinery is built and only takes one
     character in one area; cards that target a Set Card, an area, or a
     character with a Level cap need `TargetSpec` widening. Nine cards.
   - **A pending choice.** Searching a deck, or looking at the top N and
     picking some: the engine has to stop mid-effect and wait for an answer,
     which is a new step in the reducer and a new overlay in the client.
     Eight cards.
   - **Quick timing.** The window exists now, so these four are only waiting
     on their own effects being written — not on §14.
   - **New verbs** — unlock-a-whole-area, "cannot battle this turn", moving an
     enemy, and one replacement effect (BK1-027). Seven cards.

   Three transcribed lines are ambiguous and want a ruling before they are
   built: BK1-038 "unlock all Hawk characters" (both sides, or yours?),
   BK1-035 and BK1-037's "cannot participate in battle" (does it stop
   defending too?), and BK1-154's "characters that are not in this area"
   (both sides again).

2. **The priority stack** (`Rules.md` §14). Quick _windows_ are built — the
   six moments in `DesignNotes` "When to offer a Quick" — and a Quick set on
   the table can be opened out of turn at each of them. What is missing is
   §14 proper: a stack of pending effects, interrupting an interrupt, and a
   Quick resolving _before_ the thing it answered. Today a Quick opened in a
   window resolves at once and the window stays open for another.
3. **Creature subtypes** for the rest of the set. 84 characters have them;
   the other 163 have an empty column. `build-catalogue.py` splits the line
   into tokens, and `NeoHawk` is deliberately not a kind of `Hawk`.

## Presentation

1. **Sound** for battle and occupation. Draw, shuffle and the page turn are
   done and synthesised rather than recorded (`net/sound.ts`). The battle
   events exist, so these only need writing.
2. **Animation** for dying and battling. `CHARACTER_DESTROYED` and
   `DAMAGE_DEALT` are emitted and reach the client; nothing draws them.
   Locking, drawing, and cards crossing zones are animated.
3. **Character voices.** Sounds from the show for unique characters.

## Notes

- `Docs/Berserk_TCG_Cardlist.csv` is the authority for everything printed on a
  card. Complete except rules text and creature subtypes, which are done for
  the first 41 cards of BK1.
- A Quick window (`state.quick`) freezes the game and names one player. It
  outranks a battle and priority both, because that is what an interrupt is.
  Femto answers one in `ai.ts`; missing that hangs the match.
- Card behaviour lives in `packages/engine/src/abilities.ts` as data, keyed by
  card id, with the printed line beside each entry. Nothing parses the text.
  A card with no entry does nothing at all, which is why the inspector says so.
- Matches live in memory and are lost on restart. `Match.actions` is the replay
  log a persistence layer would store.
- Operators (`ADMIN_USERS`, or the `is_admin` column) reset a locked-out
  player's password from Settings. There is no recovery email and no plan for
  one; the operator routes answer 404 to everyone else so they cannot even be
  used to find out who the operators are.
- Settings (`components/Settings.tsx`) covers sound, the badge and the
  password. It is an overlay rather than a screen so it can be opened from
  inside a match. Sound is per-browser (`localStorage`); the badge and
  password belong to the account.
- A player's badge is a **card number**, not an uploaded image: the game
  already ships 448 pieces of art and serves them, so the picker offers the
  named Unique characters and the disc crops to the face.
- Touch is supported in **landscape**, which is the same shape as the table.
  Three things were mouse- or keyboard-only and each needed its own answer:
  the hand rose on hover (a tap raises it now), setting a card was HTML5
  drag-and-drop which touch never fires (`useCardDrag` rebuilds the gesture on
  pointer events), and the counts were held-Control (your own badge is the
  switch). Anything hover-driven must check `pointerType` — a tap is followed
  by compatibility mouse events, and a phantom `mouseleave` will undo it.
- The deploy replaces the remote source tree outright, because a file deleted
  locally otherwise lives on remotely until it breaks a build. It must leave
  `db/` alone: the database container bind-mounts `db/init`, and deleting the
  directory leaves the mount pointing at nothing.
