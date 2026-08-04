#!/usr/bin/env python3
"""
Fills the printed numbers into `Docs/Berserk_TCG_Cardlist.csv`.

The list arrives with `name` and `cost` — the two things that could not be
read off the scans reliably — and the rest blank. Everything else was already
measured from the card images by `read-card-numbers.py` and lives in the
catalogue, so this joins the two on the printed card number.

Only characters carry Range / Move / Power / HP; an Effect card has no such
panel, and those cells are left empty rather than filled with a zero that
would read as a real value.

`CORRECTIONS` holds cards checked by eye against the scan where the automatic
read came back wrong or empty. Each one was confirmed from the card's own
stats panel, not inferred.

Usage:
    python3 scripts/fill-cardlist.py [--check]
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CSV_PATH = REPO / "Docs" / "Berserk_TCG_Cardlist.csv"
CATALOGUE = REPO / "packages" / "engine" / "src" / "data" / "catalogue.json"

STATS = ("range", "movement", "power", "hp")

# Read off the scans by eye. The automatic pass missed the level on all of
# these — the badge is a gold shield on dark cards and a circle on light ones —
# and returned nothing for several Pow/HP panels.
CORRECTIONS: dict[str, dict[str, int]] = {
    # level only: these are Effect cards, which have no stats panel.
    "BK1-160": {"level": 3},
    "BK2-064": {"level": 2},
    "BK3-030": {"level": 5},
    "BK4-079": {"level": 2},
    "BK4-080": {"level": 3},
    "BK5-080": {"level": 3},
    # characters
    "BK1-130": {"level": 5, "range": 0, "movement": 2, "power": 8, "hp": 8},
    "BK3-025": {"level": 5, "range": 0, "movement": 3, "power": 7, "hp": 9},
    "BK3-053": {"level": 5, "range": 0, "movement": 2, "power": 8, "hp": 8},
    "BK4-003": {"level": 2},
    "BK4-023": {"level": 3},
    "BK4-029": {"level": 5, "range": 0, "movement": 2, "power": 7, "hp": 9},
    "BK4-051": {"level": 3},
    "BK4-063": {"level": 4},
    "BK5-005": {"level": 1},
    "BK5-023": {"level": 3},
    "BK5-048": {"level": 3},
    "BK5-066": {"level": 4, "range": 0, "movement": 1, "power": 6, "hp": 4},
    "BK5-073": {"level": 1},
    # Characters the automatic pass did not recognise as such, so their
    # panels were only partly read. All six checked against the scan.
    "BK3-054": {"range": 0, "movement": 1, "power": 6, "hp": 8},
    "BK3-056": {"range": 2, "movement": 1, "power": 7, "hp": 3},
    "BK5-047": {"range": 0, "movement": 1, "power": 3, "hp": 4},
    "BK5-063": {"range": 0, "movement": 1, "power": 2, "hp": 4},
    "BK5-072": {"range": 0, "movement": 1, "power": 0, "hp": 1},
    "BK5-074": {"range": 0, "movement": 1, "power": 0, "hp": 2},
}

# Cards whose type line reads "Character" but which the automatic pass did not
# flag as one. Checked by eye; they have a stats panel, so their numbers count.
MISFLAGGED_CHARACTERS = {
    "BK1-130", "BK3-025", "BK3-053", "BK3-054", "BK3-056",
    "BK4-029", "BK5-047", "BK5-063", "BK5-066", "BK5-072", "BK5-074",
}


def card_id(row: dict[str, str]) -> str:
    return f"{row['set']}-{int(row['number']):03d}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report without writing")
    args = parser.parse_args()

    catalogue = {c["id"]: c for c in json.loads(CATALOGUE.read_text())}
    rows = list(csv.DictReader(CSV_PATH.open()))
    fields = list(rows[0].keys())

    gaps: dict[str, list[str]] = {field: [] for field in ("level", *STATS)}
    filled = 0

    for row in rows:
        cid = card_id(row)
        card = catalogue.get(cid)
        if card is None:
            raise SystemExit(f"{cid} is in the list but not in the catalogue")

        fix = CORRECTIONS.get(cid, {})
        is_character = bool(card.get("character")) or cid in MISFLAGGED_CHARACTERS

        level = fix.get("level", card.get("level"))
        row["level"] = "" if level is None else str(level)
        if level is None:
            gaps["level"].append(cid)
        else:
            filled += 1

        for field in STATS:
            # An Effect card has no Range/Move/Pow/HP at all: blank is the
            # honest value, not zero.
            if not is_character:
                row[field] = ""
                continue
            value = fix.get(field, card.get(field))
            row[field] = "" if value is None else str(value)
            if value is None:
                gaps[field].append(cid)
            else:
                filled += 1

    characters = sum(1 for r in rows if r["range"] != "")
    print(f"{len(rows)} cards, {filled} values filled")
    print(f"  characters with a full stats panel: {characters}")
    for field, missing in gaps.items():
        state = "complete" if not missing else f"{len(missing)} missing: {', '.join(missing[:8])}"
        print(f"  {field:9} {state}")

    if args.check:
        return 0

    with CSV_PATH.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nwrote {CSV_PATH.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
