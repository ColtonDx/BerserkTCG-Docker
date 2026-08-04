#!/usr/bin/env python3
"""
Read each card's colour from its frame.

Every card is bordered in its colour — white, green, black or red — so the
frame is a direct, checkable source for the `color` field rather than an
inference. The alternative would be trusting that the sets are laid out in
four equal colour blocks; this measures it instead, and then reports whether
that block structure actually holds.

Usage:
    python3 scripts/detect-colours.py [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from PIL import Image

Image.init()

REPO = Path(__file__).resolve().parent.parent
CARD_DIR = REPO / "art-assets" / "cards"

FILENAME = re.compile(r"^(?P<set>BK\d)-(?P<number>\d{3})\.jpg$")

# Where the printed frame is solid colour, as fractions of the card. The strip
# down the left edge avoids the title bar, the art, and the text box.
FRAME_X = (0.012, 0.045)
FRAME_Y = (0.30, 0.62)


def frame_colour(path: Path) -> tuple[int, int, int]:
    """Average colour of the card's left frame edge."""
    with Image.open(path) as im:
        w, h = im.size
        strip = im.convert("RGB").crop(
            (int(w * FRAME_X[0]), int(h * FRAME_Y[0]), int(w * FRAME_X[1]), int(h * FRAME_Y[1]))
        )
        pixels = list(strip.getdata())
    n = len(pixels)
    return (
        sum(p[0] for p in pixels) // n,
        sum(p[1] for p in pixels) // n,
        sum(p[2] for p in pixels) // n,
    )


def classify(rgb: tuple[int, int, int]) -> str:
    """
    Sort a frame colour into the game's four colours.

    Red and green are told apart by which channel dominates; white and black by
    overall lightness. The frames are strongly saturated, so this needs no
    tuning beyond the obvious thresholds.
    """
    r, g, b = rgb
    brightness = (r + g + b) / 3
    if r > g + 25 and r > b + 25:
        return "red"
    if g > r + 12 and g > b + 12:
        return "green"
    return "white" if brightness > 110 else "black"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, help="write id -> colour as JSON")
    args = parser.parse_args()

    results: dict[str, str] = {}
    samples: dict[str, tuple[int, int, int]] = {}
    for path in sorted(CARD_DIR.glob("*.jpg")):
        if not FILENAME.match(path.name):
            continue
        rgb = frame_colour(path)
        results[path.stem] = classify(rgb)
        samples[path.stem] = rgb

    print(f"{len(results)} cards: {dict(Counter(results.values()))}\n")

    # Does each set really divide into four equal colour blocks?
    by_set: dict[str, list[tuple[int, str]]] = {}
    for card_id, colour in results.items():
        code, number = card_id.split("-")
        by_set.setdefault(code, []).append((int(number), colour))

    all_blocked = True
    for code, cards in sorted(by_set.items()):
        cards.sort()
        size = len(cards)
        block = size // 4
        expected = ["white", "green", "black", "red"]
        odd = [
            (n, c, expected[min(3, (n - 1) // block)])
            for n, c in cards
            if c != expected[min(3, (n - 1) // block)]
        ]
        ranges = " ".join(
            f"{expected[i]} {i * block + 1:03d}-{(i + 1) * block:03d}" for i in range(4)
        )
        if odd:
            all_blocked = False
            print(f"  {code}: blocks of {block} — {len(odd)} card(s) disagree")
            for n, got, want in odd[:8]:
                print(f"      {code}-{n:03d}: frame reads {got}, block says {want} {samples[f'{code}-{n:03d}']}")
        else:
            print(f"  {code}: blocks of {block} confirmed — {ranges}")

    print(
        "\nColour blocks hold for every card."
        if all_blocked
        else "\nColour blocks do NOT hold; use the measured colour, not the card number."
    )

    if args.json:
        args.json.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
