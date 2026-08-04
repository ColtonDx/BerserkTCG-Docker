#!/usr/bin/env python3
"""
Marks the Unique cards in `Docs/Berserk_TCG_Cardlist.csv`.

Uniqueness is a property of the *name* — the rule is that two cards of the
same name cannot both be open — so this works in names, not card numbers.

`GIVEN` is the list supplied for the project. `FROM_THE_CARDS` is the rest:
names whose cards are printed "Unique" on the type line but which the supplied
list did not cover. Every one of them was read off the scan, not inferred — a
detector shortlisted them from the marker's position on the type line and each
name was then confirmed by eye against the card itself.

Usage:
    python3 scripts/mark-unique.py [--check]
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CSV_PATH = REPO / "Docs" / "Berserk_TCG_Cardlist.csv"

GIVEN = [
    "Guts", "Griffith", "Pippin", "Casca", "Zodd", "Irvine", "Sonia", "Farnese",
    "Locus", "Grunbeld", "Valley of Mist", "Rosine", "Deceased Sun",
    "House of the Wood Spirits", "Puck", "Isidro", "Flora", "Serpico",
    "Schierke", "Rickert", "Judeau", "Corkus",
]

# Printed "Unique", confirmed by eye on the card. Mostly other named
# characters, plus the Eternal effects — an Eternal stays on the table, so
# two of the same would sit there together without this.
#
# The detector that shortlisted these missed two of them, both for the same
# reason: a long type line ("Character - Midland/Dragon Knights/General")
# runs right up to the marker, leaving no gap to find it by.
FROM_THE_CARDS = [
    "Azan", "Berserker Armor", "Borkoff", "Charlotte", "City Demonization",
    "Farewell", "Footsteps of Hell-Fire", "Ganishka", "Hill Of Swords",
    "Julius", "King of Midland", "Mozgus", "Mule", "Mythical Domain", "Rakshas",
    "Revelations of the Reaper", "Rumors of Resistance", "Silat",
    "Skull Knight", "Slan", "Tapasa", "Window of Salvation",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report without writing")
    args = parser.parse_args()

    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())
    if "unique" not in fields:
        fields.insert(fields.index("level"), "unique")

    # The printed names capitalise small words ("Valley Of Mist"), so match on
    # the name rather than on how it happens to be typed.
    given = {n.lower() for n in GIVEN}
    found = {n.lower() for n in FROM_THE_CARDS}
    wanted = given | found

    seen: set[str] = set()
    counts = {"given": 0, "from the cards": 0}
    for row in rows:
        name = row["name"].strip()
        key = name.lower()
        row["unique"] = "yes" if key in wanted else "no"
        if key in wanted:
            seen.add(key)
            counts["given" if key in given else "from the cards"] += 1

    unmatched = sorted(wanted - seen)
    total = counts["given"] + counts["from the cards"]
    print(f"{total} of {len(rows)} cards are Unique, across {len(seen)} names")
    print(f"  {counts['given']:>3} from the supplied list")
    print(f"  {counts['from the cards']:>3} from names read off the cards")
    if unmatched:
        print(f"  names matching no card: {', '.join(unmatched)}")

    if args.check:
        return 1 if unmatched else 0

    with CSV_PATH.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nwrote {CSV_PATH.relative_to(REPO)}")
    return 1 if unmatched else 0


if __name__ == "__main__":
    raise SystemExit(main())
