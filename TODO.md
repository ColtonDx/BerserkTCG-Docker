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
   40 BK1 cards are built and tested, including targeting: an ability can ask
   the player to choose a character, `OPEN_CARD` carries the choice, and the
   payment overlay asks for it. Rules text and creature subtypes are captured
   for the first 41 cards and shown in the inspector, which marks a card whose
   behaviour is not built yet.

   **Green is 27 of its 35 printed lines.** What the set gained along the way,
   and now works for any colour: `per` ("for each") scaling on buffs and
   draws, damage reduction both continuous and until-end-of-turn (`SHIELD`),
   selectors that reach face-down Set Cards, targeting by Distance, and
   cost-bearing abilities — `USE_ABILITY` is built, with "Tap:" costs, costs
   paid from hand, once-per-turn, locking an ally to pay, and Quick timing
   that rides the same windows a Quick card does.

   A **pending choice** is now built: `GameState.pending` suspends the game on
   a question an effect cannot answer for itself, `CHOOSE_CARD` answers it one
   card at a time, and it outranks both priority and a running battle the way a
   Quick window does. It covers "discard N of your own choosing" (BK1-047) and
   the deck search (BK1-050, 057, 069) — the search reveals only the cards it
   may legally take (`rules.ts:searchable`, read by `legalActions` and `view.ts`
   alike) and shuffles once the last card is named. An asking effect must be the
   last thing on its printed line; `resolveEffect` throws rather than silently
   dropping a `then` that follows one.

   **Green is 35 of its 35 printed lines.** The last eight brought: a
   resumable effect chain (`Continuation` — an asking effect no longer has
   to be the last thing on its line), searches that send what they find to
   the Trash or face down into an area and may stop short ("up to",
   `ANSWER`), a reveal on the way to hand, gates ("this card can only be
   opened if …", `Ability.gate`), areas chosen on their own or against a
   condition (`AreaKind`), "you may" decisions, a skipped Draw phase paid
   back at the end of the turn, and attachments (`CardInstance.attachedTo`)
   with Range finally modifiable (`rules.ts:rangeOf`). BK1-061's "set and
   immediately open" is read as free and outside the City Level gate —
   marked `RULES:` in `abilities.ts` and worth confirming.

   Three transcribed lines are ambiguous and want a ruling before they are
   built: BK1-038 "unlock all Hawk characters" (both sides, or yours?),
   BK1-035 and BK1-037's "cannot participate in battle" (does it stop
   defending too?), and BK1-154's "characters that are not in this area"
   (both sides again).

   **Black is complete, and red is 39 of its 41 transcribed lines** — BK1 as
   a whole is 120 of the 140 cards that carry printed text.

   Black's last nine brought: milling the top of a deck to the Trash
   (`mill`), `lock` as an effect with an owed-Refresh counter that survives to
   a future turn (`SKIP_REFRESH`), destroying the source to pay for its own
   ability (`ActivationCost.destroySelf`), a capture paying less than §12's
   two cards (`captureDraw`), a search that sets _and opens_ what it finds
   (`to: 'setOpen'`), a choice made by the player losing the cards
   (`theyDestroy` and the `field` pending kind), an either/or continuation for
   a declined decision (`PendingChoice.orElse`), and `occupier` as an effect's
   player.

   Red brought: pointing at a face-down Set Card rather than a character
   (`TargetSpec.faceDown`), sweeping standing Effect cards by duration
   (`Selector.effectCards`), `cannotAttack` written onto a card for the turn
   (`NO_BATTLE`) so a Normal Effect can impose it and leave, a reveal that
   persists in `GameState.revealed` rather than flashing once, a City Level
   shifted for one player without touching §5's count
   (`rules.ts:openLevelFor`, the single implementation both gate sites now
   call), a search reaching the Trash (`includeTrash`, safe because §14 makes
   it public), turning cards off the deck until a character appears
   (`revealUntilCharacter`), a move that brings its own source along
   (`moveTo.withSource`), and an `arrival` trigger fired from all four ways a
   character reaches a city. `captureDraw` now raises as well as lowers, and
   reads cards standing in the city as well as the attackers. Cost-bearing
   abilities can finally ask for an area — BK1-131 is the first that does, and
   `useAbility` validates it rather than refusing.

   **Twenty BK1 lines are still unbuilt**, and most want a ruling first:

   - **"Area level"** (BK1-028, BK1-033) is not a term `Rules.md` defines.
     City Level is global (§5), so an "area level" is either a synonym for it
     or something per-city the rules do not have.
   - **"Cannot participate in battle"** (BK1-035, BK1-037) — does it stop
     defending too, or only attacking? `NO_BATTLE` currently reads as
     `cannotAttack`, which is the narrow half.
   - **BK1-038** "unlock all Hawk characters" — both sides, or yours?
   - **BK1-154** "characters that are not in this area" — both sides again.
   - **BK1-147** "target any number of characters" needs several targets for
     one ability; the wire carries one target per _ability_, and
     `legalActions` offers one action per legal target, so "any number" would
     be a cross-product. It wants a different shape of choice, probably a
     pending one answered card by card.
   - **BK1-151** "negate all abilities of normal effects within 1 distance"
     needs negation checked at every ability lookup — seventeen sites across
     `rules.ts` and `reducer.ts`. Anything less is silently wrong in the
     places it was not applied.
   - **BK1-022** "reveal the capital to yourself" needs the Royal Capital's
     identity revealed to one player without leaking it in `view.ts`, which
     currently hides face-down cities from everyone.
   - **BK1-157**, **BK1-158**, **BK1-027**, **BK1-029**, **BK1-030**,
     **BK1-031**, **BK1-034**, **BK1-036** each want one new primitive:
     a per-character attack restriction tied to an area, a trigger on the
     _opponent_ capturing, redirected damage, a conditional "while defending"
     buff, opening another Set Card as an effect, barring a Set Card from
     being opened, "target attacking character", and unlocking specifically
     what arrived this turn.
   - **BK1-023**, **BK1-155**, **BK1-159** are deck manipulation — look at
     the top _n_ and choose, set them anywhere, or reorder without shuffling.

2. **The priority stack** (`Rules.md` §14) is built for what a player does —
   an open, an ability used — with two narrowings noted in `DesignNotes`
   "When to offer a Quick": a player is not asked about their own pending
   effect outside a battle, and triggered abilities resolve at once. Stacking
   triggers too would need `settle` to stop and resume around the End phase
   without running it twice.
3. **Creature subtypes** for the rest of the set. 84 characters have them;
   the other 163 have an empty column. `build-catalogue.py` splits the line
   into tokens, and `NeoHawk` is deliberately not a kind of `Hawk`.

## Presentation

1. **Character voices.** Sounds from the show for unique characters. Every
   other sound is synthesised in `net/sound.ts` and lands on a beat of the
   presentation queue; a voice would be the first recorded asset.

## Notes

- `Docs/Berserk_TCG_Cardlist.csv` is the authority for everything printed on a
  card. Complete except rules text and creature subtypes, which are done for
  the first 41 cards of BK1.
- A Quick window (`state.quick`) freezes the game and names one player. It
  outranks a battle and priority both, because that is what an interrupt is.
  Femto answers one in `ai.ts`; missing that hangs the match. A window only
  opens for a Quick that would do something at that moment
  (`rules.ts:quickRelevant`), and the moment before damage asks the attacker
  and then the defender (`QuickWindow.then`).
- Everything the client _shows_ goes through one queue: `planBeats` in the
  protocol cuts a batch into beats and `usePresentation` plays them one at a
  time; overlays render the beat on stage and prompts wait for the stage to
  clear. `presentationMs` is the sum, and it is the only pacing Femto has —
  there is no per-action pause table to keep in step with the CSS. A new
  kind of moment is a new beat there, and both sides pick it up.
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
- Anything the game is **asking you for** lives along the bottom edge: the
  battle step (`.battlebar`), the target picker (`.aim-bar`), and what a city
  changing hands paid out. The top edge reads as a status line — something
  being noted rather than something wanted from you — and the phase rail on
  the left already shows where the turn is at all times.
- The banner walks every phase an advance passed through, one at a time, with
  a sweep of air each (`sound.ts:playPhase`). Refresh and Draw resolve with no
  input and an empty phase is skipped (`Rules.md` §10), so one click can cross
  three of them; without the walk the turn appears to jump. Its length is
  `BEAT_MS.TURN_BANNER` in the protocol, beside the `TURN` beat the server
  waits for — the banner drifts out over the difference.
- A step whose click cannot be taken back offers a way to read the card first.
  Bottoming and discarding both commit on a single click, so each card carries
  a magnifier; a right click and a press-and-hold do the same thing, but a
  touchscreen has neither.
- The payment dialog shows both piles: the card being opened on the left, the
  cards leaving your hand on the right, each clickable to put back.
- **The table never grows a scrollbar.** A transform contributes its _rotated_
  bounding box to an ancestor's overflow, so the 45° tilt on a locked card
  (`Rules.md` §6) pushed a city lane into scrolling the moment somebody locked
  a character to attack. The lanes are `overflow: visible` and the page itself
  is `overflow: hidden` while a match is up; any full-screen overlay that
  paints past the viewport — the targeting arrow, the boost lines — clips
  itself rather than being allowed to extend the page.
- A number that is not printed on the card is written on the card: damage in
  one bottom corner, an ability's shift in the other (`card__boost`, `§13`).
  The glow says something is happening to this character; the marker says
  what, because the art still shows the printed numbers and nothing else on
  the table does. Both are read off `VisibleCard.current` against the
  catalogue — the client cannot compute an ability's effect.
- Hovering a character draws a line to every card lifting it and to everything
  it is lifting (`BoostLinks`, `VisibleCard.boostedBy`). A continuous ability
  is stored nowhere — `powerOf`/`hpOf`/`moveOf` read it off the board — so
  without this a character stands at +1/+1 with no visible reason. Mouse only:
  a finger has no hover, and the compatibility events after a tap would leave
  the lines drawn with nothing under the pointer.
