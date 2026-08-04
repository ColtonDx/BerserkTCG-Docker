# Card data

Where the card database comes from, and what is known so far.

## The cards we have

448 images in `art-assets/cards/`, cut from the scans by
`scripts/extract-cards.py` and named by printed card number:

| Set | Cards | Numbering |
| --- | ----- | --------- |
| BK1 | 160   | 001-160   |
| BK2 | 64    | 001-064   |
| BK3 | 64    | 001-064   |
| BK4 | 80    | 001-080   |
| BK5 | 80    | 001-080   |

These counts match the original Konami print runs exactly (Vol. 1 has 160
cards, Vol. 2 and 3 have 64 each, Vol. 4 and 5 have 80 each), so the set is
complete — no card is missing and none is duplicated.

The scans are the "BERSERK TCG Rebuild by MSC" English fan translation
(MASSIVE SWORD), which recreates all 448 cards from the Japanese original.

## Is there a card list online?

Searched: no public machine-readable card database exists.

- The English rebuild is distributed as printable PDFs and a Tabletop
  Simulator mod, not as data.
- `nemesisworks.altervista.org` has a Berserk TCG search form with the right
  fields (name, volume, type, colour, rarity) but the database behind it was
  never populated — it still says "Berserk TCG info will be listed here".
- The Berserk Wiki covers the game's history and rarity scheme, not a checklist.
- No GitHub repository carries Berserk TCG card data, unlike most modern TCGs.

So the card data has to come from the card images themselves.

## What deck legality actually needs

Per `Docs/Deckbuilding.md`, a legal deck is:

1. exactly 45 cards,
2. no more than 3 copies of any one card,
3. at least 10 mercenaries — which are exempt from (2) and unlimited.

Rule 2 keys on the **card number**, not the name: Rules.md §2 spells it out as
"3 copies of any single card (same card number)". Card numbers come from the
filenames, so rules 1 and 2 need no card data at all.

That leaves **the mercenary flag** as the only piece required for legality.
Everything else — name, colour, cost, level, ability text — is needed to
_play_, and to build a good deckbuilder UI (searching, filtering, sorting),
but not to decide whether a deck is legal.

## Fields

The database (`packages/engine/src/data/catalogue.json`) carries one entry per
card with these fields:

| Field                              | Status   | Source                          |
| ---------------------------------- | -------- | ------------------------------- |
| `id`, `set`, `number`, `image`     | **done** | filename = printed card number  |
| `color`                            | **done** | measured from the printed frame |
| `mercenary`                        | **done** | the card named "Mercenary"      |
| `name`                             | **done** | `Berserk_TCG_Cardlist.csv`      |
| `cost`                             | **done** | `Berserk_TCG_Cardlist.csv`      |
| `level`                            | **done** | `Berserk_TCG_Cardlist.csv`      |
| `unique` (yes/no)                  | **done** | `Berserk_TCG_Cardlist.csv`      |
| `character` (yes/no)               | **done** | has a stats panel = a character |
| `power`, `hp`, `range`, `movement` | **done** | `Berserk_TCG_Cardlist.csv`      |
| `type`, `duration`, `quick`        | **done** | `Berserk_TCG_Cardlist.csv`      |
| `subtypes`                         | partial  | 84 of 247 characters            |
| `effect` (rules text)              | partial  | 41 of 448 cards                 |

**Rules text and creature subtypes** are transcribed for the first 41 cards of
BK1. The text is display only; what the engine actually runs lives beside it
in `packages/engine/src/abilities.ts`, and ten of the 41 are built. The
inspector marks a card whose behaviour is not built, so nobody plans around an
ability that will not happen.

Subtypes arrive as separate tokens — the printed `Hawks/Cavalry` becomes
`['hawk', 'cavalry']` — because abilities name one at a time. `NeoHawk` is its
own token and is deliberately **not** a kind of `Hawk`: they are two different
bands, and a Hawk ability that swept up the Neo Band would be wrong in a way
nothing else would catch. Where a line reads as a pair rather than a
faction-and-role (`Spirit Creature`, `Magical Creature`) the split is a guess;
nothing in the set keys off those yet, so it costs nothing today.

Anything not captured is `null`, never a guess. A plausible wrong value is
worse than a missing one: deck legality and play both key off these.

## Unique

`scripts/mark-unique.py` holds the names. Uniqueness is a property of the
_name_, not the card number — Rules.md §8 forbids a second card of the same
name being open, whoever opened the first — so every printing of a name
carries the same flag, and `catalogue.test.ts` fails if one does not.

The list was supplied for the project and then checked against the scans: the
marker is printed at a fixed spot on the type line, so a detector could
shortlist the cards carrying one, and every extra name was confirmed by eye
before being added. Two of them the detector could not see at all — `Julius`
and `Casca` in BK4 — because a long type line runs right up to the marker and
leaves no gap to find it by.

## The colour blocks

Each set is laid out as four equal colour blocks, in white, green, black, red
order:

| Set | Block | White   | Green   | Black   | Red     |
| --- | ----- | ------- | ------- | ------- | ------- |
| BK1 | 40    | 001-040 | 041-080 | 081-120 | 121-160 |
| BK2 | 16    | 001-016 | 017-032 | 033-048 | 049-064 |
| BK3 | 16    | 001-016 | 017-032 | 033-048 | 049-064 |
| BK4 | 20    | 001-020 | 021-040 | 041-060 | 061-080 |
| BK5 | 20    | 001-020 | 021-040 | 041-060 | 061-080 |

This is not assumed from the numbering — `scripts/detect-colours.py` reads the
printed frame colour of all 448 cards and finds exactly 112 of each colour,
agreeing with the block layout on every card.

## Mercenaries

The **card named "Mercenary"** is the first card of each colour block: four
per set, one per colour, twenty in total.

    BK1-001  BK1-041  BK1-081  BK1-121
    BK2-001  BK2-017  BK2-033  BK2-049
    BK3-001  BK3-017  BK3-033  BK3-049
    BK4-001  BK4-021  BK4-041  BK4-061
    BK5-001  BK5-021  BK5-041  BK5-061

These are the cards Deckbuilding.md means: a deck needs at least ten, and may
hold any number of them. The exemption is by **name**, not by the
`Mercenaries` faction — cards like `BK1-002 Bold Siege Squadron`
(`Character - Mercenaries/Infantry`) carry that faction but are ordinary cards
capped at 3 copies.

Found by OCR of every card's title and type line, which flagged exactly these
twenty plus two faction-only cards, and confirmed by eye: the four BK1
Mercenaries are one each in white, green, black and red, all
`Character - Mercenaries`, all Lv0 / Range 0 / Move 1 / 1-1.

## Capturing the rest — where it stands

The numbers (level, range, movement, power, hp) sit at fixed positions in large
type, and their crops are clean: `scripts/cluster-glyphs.py` cuts them out
correctly, verified by eye against a spread of cards. Reading them is what has
not landed yet.

Two approaches were tried and neither is trustworthy:

- **OCR.** The digits are legible but sit inside ornate printed boxes, and
  tesseract keeps reading the box frame as extra digits — a "2" comes back as
  "24" or "273". Isolating the glyph first improves it but not to the point of
  being safe unchecked.
- **Glyph matching.** Every card is printed from one template, so the same
  digit should be pixel-identical everywhere and cluster perfectly. In practice
  each field yields 15-35 clusters instead of ten, with a long tail of
  one-member groups.

Both fail for the same underlying reason: at 703x1008 a digit is only about
30x40 pixels, and JPEG noise over the printed box is a large share of that.

The fix is resolution rather than more parameter tuning. The source PDFs are
300 DPI, and the stat boxes can be re-rendered from them at 600 DPI, which
doubles a digit to roughly 60x80 — enough for either approach to work. That
has not been done yet.

Name and effect text are harder still and may be quicker to transcribe than to
automate.
