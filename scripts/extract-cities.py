#!/usr/bin/env python3
"""Cuts the three City card faces out of their scans.

The City cards are not in the volume PDFs that `extract-cards.py` reads — they
came in separately, one scan per face, each a card lying on a pale scanner bed
with a neighbour sometimes clipping the edge.

So the job is to find the *printed* rectangle in each scan. Not the card: the
card has a white paper edge where the cut ran shallow, and leaving that on
would put a white hairline round three cities and nothing round the rest of the
art. The print is what every other card in `art-assets/cards/` is trimmed to.

Finding it by darkness is what makes that work. Every line through the print
crosses something dark — the black frame at top and foot, the art — while paper
and scanner bed have nothing dark in them at all, so they fall away without
having to be recognised. A neighbour's sliver in the same scan is dark too, but
it is narrow, and the widest run wins.

Output matches the rest of the art: 703x1008 JPEG, named for what the game asks
for rather than for the scan it came from.

    python3 scripts/extract-cities.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "art-assets" / "cards"

# scan -> the name the client asks for. Rules.md §5: the back must be the same
# for every city, or the Royal Capital's position leaks from the board.
SOURCES = {
    "City.png": "city.jpg",
    "Capital.png": "city-capital.jpg",
    "AreaCardBack-HD.png": "city-back.jpg",
}

SIZE = (703, 1008)
# Darker than this is ink. Well below the scanner bed (~200) and the card's
# own white edge (~245), and well above the blacks in the frame.
INK = 120
# A line belongs to the print once this much of it is ink. Low, because a line
# through the middle of a bright sky is mostly not ink — but it is never zero,
# which is what paper and bed are.
COVERAGE = 0.08
# A Berserk card is 5:7. Anything outside this found the wrong rectangle.
RATIO = (0.68, 0.75)


def runs(flags: list[bool]) -> list[tuple[int, int]]:
    """Every maximal run of True, as [start, end) pairs."""
    out: list[tuple[int, int]] = []
    start: int | None = None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            out.append((start, index))
            start = None
    if start is not None:
        out.append((start, len(flags)))
    return out


def widest(flags: list[bool]) -> tuple[int, int]:
    """The print, as the longest unbroken run of inked lines.

    Runs are taken as they fall, with no merging across gaps: the gap between
    this card and a neighbour's sliver in the same scan is only a pixel or
    two, so anything generous enough to close a gap inside the card would
    swallow the neighbour as well.
    """
    found = runs(flags)
    if not found:
        raise SystemExit("no printed area found in the scan")
    return max(found, key=lambda pair: pair[1] - pair[0])


def print_box(image: Image.Image) -> tuple[int, int, int, int]:
    gray = image.convert("L")
    width, height = gray.size
    pixels = gray.load()

    # Sample rather than read every pixel; the scan is thousands wide and the
    # edge only has to be found to within a pixel or two.
    step = max(1, width // 400)
    down = list(range(0, height, step))
    across = list(range(0, width, step))

    inked = lambda value: value < INK  # noqa: E731
    columns = [sum(1 for y in down if inked(pixels[x, y])) / len(down) for x in range(width)]
    rows = [sum(1 for x in across if inked(pixels[x, y])) / len(across) for y in range(height)]

    left, right = widest([value > COVERAGE for value in columns])
    top, bottom = widest([value > COVERAGE for value in rows])
    return left, top, right, bottom


def main() -> int:
    if not CARDS.is_dir():
        raise SystemExit(f"missing {CARDS}")

    failures = 0
    for source, target in SOURCES.items():
        path = CARDS / source
        if not path.is_file():
            print(f"  {source}: not found, skipped")
            continue

        with Image.open(path) as image:
            box = print_box(image)
            face = image.convert("RGB").crop(box)
            face.resize(SIZE, Image.LANCZOS).save(CARDS / target, "JPEG", quality=92)

        w, h = box[2] - box[0], box[3] - box[1]
        ratio = w / h
        print(f"  {source} -> {target}  cut {w}x{h} at {box[0]},{box[1]}  ratio {ratio:.3f}")
        # A silently wrong card face is worse than a loud failure: it would
        # sit on the board looking almost right.
        if not RATIO[0] < ratio < RATIO[1]:
            print(f"    WRONG: {ratio:.3f} is not a card's 0.714", file=sys.stderr)
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
