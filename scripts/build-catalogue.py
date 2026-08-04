#!/usr/bin/env python3
"""
Build the card database from the extracted card images.

Produces `packages/engine/src/data/catalogue.json`: one entry per card, keyed
by its printed number, carrying every field the game needs.

What is filled in, and how:

* `id`, `set`, `number`, `image` — from the filename, which is the printed
  card number.
* `color` — measured from the card's printed frame by `detect-colours.py`.
  Every set turns out to be four equal colour blocks in white/green/black/red
  order, and the measurement agrees with that on all 448 cards, so either
  route gives the same answer.
* `mercenary` — the card named "Mercenary", which is the first card of each
  colour block, four per set. Per Docs/Deckbuilding.md these are the cards a
  deck needs ten of and may hold any number of; it is the *name*, not the
  `Mercenaries` faction, that matters.

`name`, `cost`, `unique`, `level`, and the combat numbers come from
`Docs/Berserk_TCG_Cardlist.csv`, which is the transcription of what is printed
on the cards and the authority for all of it. The scans are still what supply
colour and the Mercenary block, because those were measured from the frames.

Everything else — type, unique,
effect — is left null. Those are printed on the cards but not derivable from
the filename, and guessing them would produce a database that looks complete
and is wrong. See Docs/CardData.md.

Usage:
    python3 scripts/build-catalogue.py
"""

from __future__ import annotations

import csv
import json
import re
import subprocess
import tempfile
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CARD_DIR = REPO / "art-assets" / "cards"
CARDLIST = REPO / "Docs" / "Berserk_TCG_Cardlist.csv"
OUT = REPO / "packages" / "engine" / "src" / "data" / "catalogue.json"

FILENAME = re.compile(r"^(?P<set>BK\d)-(?P<number>\d{3})\.jpg$")

# Colour order within every set. Verified against the printed frames.
COLOUR_ORDER = ["white", "green", "black", "red"]


def colours() -> dict[str, str]:
    """Frame colour per card, measured by detect-colours.py."""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as handle:
        path = Path(handle.name)
    try:
        subprocess.run(
            [sys.executable, str(REPO / "scripts" / "detect-colours.py"), "--json", str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(path.read_text(encoding="utf-8"))
    finally:
        path.unlink(missing_ok=True)


def card_stats() -> dict[str, dict[str, int | None]]:
    """
    Numbers read off the cards by `read-card-numbers.py`, if it has been run.

    Missing values stay missing: a field that could not be read confidently is
    null, never a guess.
    """
    path = REPO / "scripts" / "card-stats.json"
    if not path.exists():
        print("  (no card-stats.json — run scripts/read-card-numbers.py to fill the numbers)")
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def duration_of(row: dict[str, str]) -> str | None:
    """Normal or Eternal, for an Effect. Characters have neither."""
    value = row.get("subtype", "").strip().lower()
    return value if value in ("normal", "eternal") else None


def subtypes_of(row: dict[str, str]) -> list[str]:
    """A character's factions and roles, as separate tokens.

    Printed as one line — `Hawks/Cavalry` — and transcribed with spaces, so
    the tokens are split back apart here: card abilities name one of them at a
    time ("other Hawk characters"), never the whole line.

    NeoHawk is deliberately its own token rather than a kind of Hawk. They are
    two different bands, and a Hawk ability that swept up the Neo Band would
    be wrong in a way nothing would catch.
    """
    if row.get("type", "").strip().lower() != "character":
        return []
    raw = row.get("subtype", "").replace("/", " ")
    return [word.lower() for word in raw.split()]


def cardlist() -> dict[str, dict[str, object]]:
    """The printed values, keyed by card id, from the transcribed card list."""
    rows: dict[str, dict[str, object]] = {}
    with CARDLIST.open() as handle:
        for row in csv.DictReader(handle):
            cid = f"{row['set']}-{int(row['number']):03d}"
            number = lambda key: int(row[key]) if row[key].strip() else None  # noqa: E731
            rows[cid] = {
                "name": row["name"].strip() or None,
                "cost": row["cost"].strip() or None,
                "unique": row.get("unique", "").strip().lower() == "yes",
                "quick": row.get("quick", "").strip().lower() == "yes",
                # `character`, or an Effect and which kind of one.
                "kind": row.get("type", "").strip().lower() or None,
                # One column, two meanings, because that is what the type line
                # does: an Effect's reads `Effect - Normal`, a character's
                # reads `Character - Hawks/Leader`.
                "duration": duration_of(row),
                "subtypes": subtypes_of(row),
                "text": row.get("effect", "").strip() or None,
                "level": number("level"),
                "range": number("range"),
                "movement": number("movement"),
                "power": number("power"),
                "hp": number("hp"),
            }
    return rows


def main() -> int:
    measured = colours()
    printed = cardlist()

    cards: list[dict[str, object]] = []
    for path in sorted(CARD_DIR.glob("*.jpg")):
        match = FILENAME.match(path.name)
        if not match:
            # The shared backs and the City cards live here too and are not
            # deck cards, so they are expected rather than a problem.
            if path.stem not in ("back", "city", "city-capital", "city-back"):
                print(f"skipping unrecognised filename: {path.name}")
            continue
        read = printed.get(path.stem, {})
        combat = {field: read.get(field) for field in ("power", "hp", "range", "movement")}
        # The card list says outright what each card is, so this is read
        # rather than inferred from whether a stats panel was found.
        kind = read.get("kind")
        is_character = kind == "character"

        cards.append(
            {
                "id": path.stem,
                "set": match.group("set"),
                "number": int(match.group("number")),
                "image": f"cards/{path.name}",
                "color": measured.get(path.stem),
                "level": read.get("level"),
                "character": is_character,
                "type": kind,
                "duration": read.get("duration"),
                "quick": read.get("quick", False),
                **combat,
                "name": read.get("name"),
                "cost": read.get("cost"),
                "unique": read.get("unique"),
                "subtypes": read.get("subtypes") or [],
                # Rules text as printed, for display. Behaviour lives in the
                # ability registry keyed by card id, never parsed from this.
                "effect": read.get("text"),
                "mercenary": False,
            }
        )

    # The Mercenary card is the first of each colour block, four per set.
    by_set: dict[str, list[dict[str, object]]] = {}
    for card in cards:
        by_set.setdefault(str(card["set"]), []).append(card)

    mercenaries: list[str] = []
    for code, group in sorted(by_set.items()):
        group.sort(key=lambda c: c["number"])  # type: ignore[arg-type,return-value]
        block = len(group) // 4
        for i in range(4):
            card = group[i * block]
            card["mercenary"] = True
            mercenaries.append(str(card["id"]))
        counts = {c: sum(1 for x in group if x["color"] == c) for c in COLOUR_ORDER}
        print(f"  {code}: {len(group):>3} cards, blocks of {block}, colours {counts}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(cards, indent=2) + "\n", encoding="utf-8")

    # The block positions were worked out from the scans; the card list names
    # them outright. If the two ever disagree, the names win and this is a bug.
    named = {str(c["id"]) for c in cards if c["name"] == "Mercenary"}
    if named != set(mercenaries):
        print(f"  MISMATCH: block positions {sorted(set(mercenaries) - named)} "
              f"vs names {sorted(named - set(mercenaries))}")
    print(f"\n  mercenaries: {len(mercenaries)} by block, {len(named)} by name")
    total = len(cards)
    characters = sum(1 for c in cards if c["character"])
    print(f"  populated of {total} cards:")
    import collections as _c
    print(f"  unique cards: {sum(1 for c in cards if c['unique'])}")
    print(f"  quick cards:  {sum(1 for c in cards if c['quick'])}")
    print("  kinds:", dict(_c.Counter((c["type"], c["duration"]) for c in cards)))
    for field in ("color", "name", "cost", "level", "character", "power", "hp", "range", "movement"):
        known = sum(1 for c in cards if c[field] is not None)
        scope = f" (of {characters} characters)" if field in {"power", "hp", "range", "movement"} else ""
        print(f"    {field:<10} {known:>3}{scope}")
    print(f"\nwrote {len(cards)} cards to {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
