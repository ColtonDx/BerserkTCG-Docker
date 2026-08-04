#!/usr/bin/env python3
"""
Cut individual card images out of the scanned card-sheet PDFs.

Layout
------
Odd pages (1, 3, 5, …) hold nine card fronts in a 3x3 grid; even pages hold the
backs, which are identical and are skipped.

Numbering
---------
Volumes 1-4 are laid out bottom-left first, so a page reads

    7 8 9      <- top row
    4 5 6
    1 2 3      <- bottom row

with numbering continuing across front pages (10-18 on the next, and so on).
This was checked against the numbers printed on the cards themselves — on the
first, second and last pages of Volume 1, and on Volume 2, 3 and 4 — and holds.

Volume 5 does *not* follow that pattern: its cards run left-to-right from the
top-left and skip around, so grid position says nothing about the number. Its
real order is transcribed in `SHEET_ORDER` from the printed numbers.

Output is named `<SET>-<NUMBER>.jpg`, e.g. `BK1-007.jpg`, matching the printed
card number.

The backs
---------
`--backs` cuts the card back instead. Every card in the game shares one back —
that is what makes a face-down card hidden — so exactly one image is written,
`back.jpg`. The mode checks that claim before trusting it: it samples backs
from several sheets across the volumes and compares them, and refuses to write
anything if they turn out to differ. City cards have their own back and are not
in these scans.

Usage:
    python3 scripts/extract-cards.py [--dry-run] [--quality N] [PDF ...]
    python3 scripts/extract-cards.py --backs [--dry-run] [--quality N]
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from math import sqrt
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

Image.init()

REPO = Path(__file__).resolve().parent.parent
PDF_DIR = REPO / "art-assets" / "PDFs"
OUT_DIR = REPO / "art-assets" / "cards"

# Card numbers for the nine grid cells in reading order (left to right, top to
# bottom) — the inverse of the bottom-left-first numbering described above.
CELL_TO_CARD = [7, 8, 9, 4, 5, 6, 1, 2, 3]

# Below this much variation a cell is bare sheet rather than a card.
EMPTY_STDDEV = 12.0
# A detected band must be at least this fraction of a third of the sheet to be
# trusted as a row/column of cards.
MIN_BAND_RATIO = 0.8
# Standard deviation above which a row/column counts as card rather than sheet.
# The gap between cards measures ~0.5; card interiors run to 85+.
TEXTURE_THRESHOLD = 2.0
# Rows/columns sampled when measuring texture. Enough to be representative,
# small enough to stay quick.
TEXTURE_SAMPLES = 192

# Every card is written at this size so they all render identically. Measured
# from Volume 1, whose light cards scanned cleanest: its cards come out
# 703-704 x 1007-1009, and the whole set sits within a few pixels of that.
CARD_SIZE = (703, 1008)
# The scans are 300 DPI on US Letter, so rendering at 300 DPI reproduces the
# embedded bitmaps 1:1 with no rescaling.
RENDER_DPI = 300


@dataclass(frozen=True)
class Band:
    start: int
    end: int

    @property
    def size(self) -> int:
        return self.end - self.start


@dataclass
class Card:
    number: int
    code: str
    image: Image.Image
    page: int
    cell: int
    positional: int


# Volumes whose sheets are NOT laid out bottom-left-first in a continuous run.
#
# Each entry lists the printed card number of every slot in sheet order (page
# by page, then left to right and top to bottom within a page), transcribed
# from the numbers printed on the cards. Volumes absent from here follow the
# positional rule and are verified against it.
#
# Volume 5 needs this: its cards run left-to-right from the top-left and skip
# around (page 1 is 01, 02, 15, 16, 17, 18, 19, 21, 26), so grid position says
# nothing about the number. The transcription below is self-checking — the 80
# values form exactly the set 1..80, which `report` asserts.
SHEET_ORDER: dict[str, list[int]] = {
    "BK5": [
        1, 2, 15, 16, 17, 18, 19, 21, 26,
        28, 31, 37, 39, 40, 41, 43, 44, 46,
        52, 55, 57, 61, 62, 63, 64, 77, 78,
        79, 3, 4, 6, 7, 8, 20, 22, 29,
        30, 32, 34, 36, 47, 53, 54, 58, 59,
        60, 65, 67, 68, 74, 75, 76, 5, 23,
        48, 66, 9, 10, 11, 12, 13, 14, 24,
        25, 27, 33, 35, 38, 42, 45, 49, 50,
        51, 56, 69, 70, 71, 72, 73, 80,
    ],
}


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def page_image(pdf: Path, page: int, workdir: Path, dpi: int = RENDER_DPI) -> Image.Image:
    """
    Renders one page at 300 DPI.

    `dpi` may be raised above the native 300 when finer detail is needed —
    reading the small printed numbers benefits from 600.

    Rendering rather than pulling out embedded bitmaps keeps one code path:
    most volumes store a single full-page scan per page, but Volume 5 places
    nine separate card images per page.
    """
    prefix = workdir / f"p{page}"
    subprocess.run(
        ["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), str(pdf), str(prefix)],
        check=True,
        capture_output=True,
    )
    files = sorted(workdir.glob(f"p{page}-*"))
    if len(files) != 1:
        raise RuntimeError(f"{pdf.name} page {page}: expected 1 render, got {len(files)}")
    image = Image.open(files[0])
    image.load()
    files[0].unlink()
    return image


def background_level(gray: Image.Image) -> int:
    """Most common brightness around the border — black sheet or white paper."""
    width, height = gray.size
    edge = max(8, min(width, height) // 80)
    histogram = [0] * 256
    for strip in (
        gray.crop((0, 0, width, edge)),
        gray.crop((0, height - edge, width, height)),
        gray.crop((0, 0, edge, height)),
        gray.crop((width - edge, 0, width, height)),
    ):
        for value, count in enumerate(strip.histogram()):
            histogram[value] += count
    return histogram.index(max(histogram))


def projection(gray: Image.Image, axis: str, background: int) -> list[int]:
    """Mean difference from the background per row ('y') or column ('x')."""
    width, height = gray.size
    diff = ImageChops.difference(gray, Image.new("L", gray.size, background))
    collapsed = (
        diff.resize((1, height), Image.Resampling.BOX)
        if axis == "y"
        else diff.resize((width, 1), Image.Resampling.BOX)
    )
    return list(getattr(collapsed, "get_flattened_data", collapsed.getdata)())


def texture(gray: Image.Image, axis: str, samples: int = TEXTURE_SAMPLES) -> list[float]:
    """
    Standard deviation down each column ('x') or across each row ('y').

    This is what separates cards from the sheet they sit on. Brightness cannot:
    a card with a dark red or green border is as dark as the black sheet, so a
    brightness projection finds no edge and the card gets cropped into. The gap
    between cards, however, is *flat* — near-zero variance — while every card
    has texture, whatever its colour.

    Measured on a downsampled copy, which preserves that distinction and keeps
    this fast enough to run per page in pure Python.
    """
    width, height = gray.size

    if axis == "x":
        small = gray.resize((width, samples), Image.Resampling.BOX)
        data = list(getattr(small, "get_flattened_data", small.getdata())())
        return [_stddev(data[j::width]) for j in range(width)]

    small = gray.resize((samples, height), Image.Resampling.BOX)
    data = list(getattr(small, "get_flattened_data", small.getdata())())
    return [_stddev(data[i * samples : (i + 1) * samples]) for i in range(height)]


def _stddev(values: list[int]) -> float:
    n = len(values)
    mean = sum(values) / n
    return sqrt(max(0.0, sum(v * v for v in values) / n - mean * mean))


def find_textured(values: list[float], min_size: int) -> list[Band]:
    """Contiguous runs with texture — i.e. runs that hold a card."""
    bands: list[Band] = []
    start: int | None = None
    for i, v in enumerate(values):
        if v > TEXTURE_THRESHOLD and start is None:
            start = i
        elif v <= TEXTURE_THRESHOLD and start is not None:
            if i - start >= min_size:
                bands.append(Band(start, i))
            start = None
    if start is not None and len(values) - start >= min_size:
        bands.append(Band(start, len(values)))
    return bands


def find_bands(values: list[int], min_size: int) -> list[Band]:
    """Contiguous runs that differ from the background — i.e. hold content."""
    peak = max(values) if values else 0
    threshold = max(8.0, peak * 0.18)

    bands: list[Band] = []
    start: int | None = None
    for i, v in enumerate(values):
        if v > threshold and start is None:
            start = i
        elif v <= threshold and start is not None:
            if i - start >= min_size:
                bands.append(Band(start, i))
            start = None
    if start is not None and len(values) - start >= min_size:
        bands.append(Band(start, len(values)))
    return bands


def content_box(page: Image.Image) -> tuple[int, int, int, int]:
    """
    The sheet's bounding box within a rendered page.

    A render puts the scan on white paper, so the page carries white margins
    that would otherwise skew the grid detection.

    This is measured once, on page 1, and reused for every page of the volume.
    Measuring it per page is wrong: a partly-filled final page holds a single
    card, so its own content box *is* that card, and the grid would then place
    it in the wrong cell.
    """
    gray = page.convert("L")
    background = background_level(gray)
    rows = find_bands(projection(gray, "y", background), min_size=8)
    cols = find_bands(projection(gray, "x", background), min_size=8)
    if not rows or not cols:
        return (0, 0, *page.size)
    return cols[0].start, rows[0].start, cols[-1].end, rows[-1].end


def core(gray: Image.Image, fraction: float = 0.6) -> Image.Image:
    """The centred middle of a region, away from any neighbour bleeding in."""
    width, height = gray.size
    dx = int(width * (1 - fraction) / 2)
    dy = int(height * (1 - fraction) / 2)
    return gray.crop((dx, dy, width - dx, height - dy))


def spread(gray: Image.Image) -> float:
    """
    Standard deviation of a region's brightness.

    Computed here rather than via `ImageStat.stddev`, which raises on a
    perfectly uniform region: its variance lands on a tiny negative float and
    the square root fails. Empty cells are exactly that uniform.
    """
    variance = ImageStat.Stat(gray).var[0]
    return sqrt(max(0.0, variance))


def set_code(pdf: Path) -> str:
    """`Volume 3 Set 64 Cards.pdf` -> `BK3`, matching the printed card numbers."""
    match = re.search(r"volume\s*(\d+)", pdf.name, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Cannot determine a set code from {pdf.name!r}")
    return f"BK{int(match.group(1))}"


def page_count(pdf: Path) -> int:
    match = re.search(r"^Pages:\s+(\d+)", run(["pdfinfo", str(pdf)]), re.MULTILINE)
    if not match:
        raise RuntimeError(f"Cannot read the page count of {pdf.name}")
    return int(match.group(1))


def bands_or_thirds(values: list[int], limit: int) -> tuple[list[Band], bool]:
    """
    Splits an axis into three, and reports whether real gaps were found.

    When the cards are separated by sheet (volumes 1-4) the gaps show up as
    bands. When they are butted edge to edge (volume 5) there is nothing to
    find, and an even split is exactly right — but the caller must then *not*
    trim, since there is no surround to trim away and a card's own pale border
    would be eaten instead.
    """
    bands = find_textured(values, min_size=limit // 12)
    # Three bands are only believable if each is nearly a third of the sheet.
    # Anything less means the detection fragmented, and an even split is safer
    # than cropping every card short.
    if len(bands) == 3 and all(band.size >= limit / 3 * MIN_BAND_RATIO for band in bands):
        return bands, True
    return [Band(limit * i // 3, limit * (i + 1) // 3) for i in range(3)], False


def is_tiled(sheet: Image.Image) -> bool:
    """
    True when a volume butts its cards together with no sheet showing between.

    Volume 5 is laid out that way, and there the grid cell *is* the card, so
    trimming can only eat into it. Decided once per volume from page 1.
    """
    gray = sheet.convert("L")
    width, height = gray.size
    _, rows_gapped = bands_or_thirds(texture(gray, "y"), height)
    _, cols_gapped = bands_or_thirds(texture(gray, "x"), width)
    return not rows_gapped and not cols_gapped


def cards_on_page(sheet: Image.Image, base: int, page: int, tiled: bool = False):
    """
    Finds the cards on one sheet and reports each with its grid cell.

    Detection is per page rather than against a template taken from page 1: a
    partly-filled final page positions its cards slightly differently, and
    forcing them into page 1's cells clips them.
    """
    gray = sheet.convert("L")
    width, height = gray.size

    row_bands, _ = bands_or_thirds(texture(gray, "y"), height)

    for row_index, row in enumerate(row_bands):
        strip = gray.crop((0, row.start, width, row.end))
        col_bands, _ = bands_or_thirds(texture(strip, "x"), width)

        for col_index, col in enumerate(col_bands):
            region = (col.start, row.start, col.end, row.end)
            region_gray = gray.crop(region)

            # An empty slot is a flat expanse of sheet — black on most pages,
            # white on a partly-filled final one. Either way it has almost no
            # variation, whereas any card has a great deal.
            #
            # Measured on the middle of the cell, not all of it: an empty slot
            # beside a card catches the neighbour's edge, and that alone is
            # enough variation to look occupied.
            if spread(core(region_gray)) < EMPTY_STDDEV:
                continue

            crop = region
            if not tiled:
                # The bands already exclude the sheet between cards, but a row
                # or column that fell back to an even split still carries some.
                box = tighten(region_gray)
                if box is not None:
                    crop = (
                        col.start + box[0],
                        row.start + box[1],
                        col.start + box[2],
                        row.start + box[3],
                    )

            # `bands_or_thirds` always returns three bands in order, so the
            # band's own index is the row and column. Deriving the cell from
            # the crop's centre instead would misplace a card whose box drifts
            # across a third boundary.
            cell = row_index * 3 + col_index

            yield cell, crop, base + CELL_TO_CARD[cell], page


def fixed_crop(
    box: tuple[int, int, int, int], size: tuple[int, int], bounds: tuple[int, int]
) -> tuple[int, int, int, int]:
    """
    Re-frames a detected box to an exact size about its own centre.

    Detection is a pixel or two different on every card, and occasionally — on
    a pale card against white paper — it fails to find an edge at all and
    returns the whole grid cell. Taking a fixed size about the centre gives
    every card the same framing, so they crop consistently rather than one
    sitting smaller inside a wider margin.
    """
    width, height = size
    sheet_w, sheet_h = bounds
    centre_x = (box[0] + box[2]) // 2
    centre_y = (box[1] + box[3]) // 2

    left = centre_x - width // 2
    top = centre_y - height // 2
    # Shift back inside the sheet rather than shrinking, to keep the size exact.
    left = max(0, min(left, sheet_w - width))
    top = max(0, min(top, sheet_h - height))
    return left, top, left + width, top + height


def median_size(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int]:
    """The typical card size on a sheet, robust to a stray mis-detection."""
    if not boxes:
        raise RuntimeError("no cards found on page 1")
    widths = sorted(box[2] - box[0] for box in boxes)
    heights = sorted(box[3] - box[1] for box in boxes)
    return widths[len(widths) // 2], heights[len(heights) // 2]


def tighten(region_gray: Image.Image) -> tuple[int, int, int, int] | None:
    """
    Trims sheet from around a card using texture, not brightness.

    Returns None unless the result still covers most of the region — a much
    smaller box means the detection fragmented, and the region as given is the
    safer crop.
    """
    width, height = region_gray.size
    cols = find_textured(texture(region_gray, "x"), min_size=width // 8)
    rows = find_textured(texture(region_gray, "y"), min_size=height // 8)
    if not cols or not rows:
        return None

    left, right = cols[0].start, cols[-1].end
    top, bottom = rows[0].start, rows[-1].end
    if (right - left) < width * MIN_BAND_RATIO or (bottom - top) < height * MIN_BAND_RATIO:
        return None
    return left, top, right, bottom


def extract(pdf: Path, quality: int, dry_run: bool) -> list[Card]:
    code = set_code(pdf)
    override = SHEET_ORDER.get(code)
    pages = page_count(pdf)
    front_pages = list(range(1, pages + 1, 2))
    print(f"\n{pdf.name}  ->  {code}   ({pages} pages, {len(front_pages)} with fronts)")
    if override:
        print(f"  using the recorded sheet order for {code} ({len(override)} cards)")

    cards: list[Card] = []
    sizes: list[tuple[int, int]] = []
    seen = 0

    with tempfile.TemporaryDirectory(prefix="berserk-cards-") as tmp:
        workdir = Path(tmp)
        with page_image(pdf, 1, workdir) as first:
            sheet_box = content_box(first)
            first_sheet = first.crop(sheet_box)
            tiled = is_tiled(first_sheet)
            # Page 1 is always full and cleanly laid out, so it is the right
            # place to measure how big this volume's cards actually are.
            native = median_size(
                [box for _, box, _, _ in cards_on_page(first_sheet, 0, 1, tiled)]
            )
        if tiled:
            print("  cards are butted edge to edge; cropping to the grid without trimming")
        print(f"  card size in these scans: {native[0]}x{native[1]}")

        for index, page_no in enumerate(front_pages):
            base = index * 9
            found: list[Card] = []

            with page_image(pdf, page_no, workdir) as page:
                sheet = page.crop(sheet_box)
                for cell, box, positional, _ in cards_on_page(sheet, base, page_no, tiled):
                    image = sheet.crop(fixed_crop(box, native, sheet.size))
                    if override:
                        if seen >= len(override):
                            raise RuntimeError(f"{code}: more cards on the sheets than recorded")
                        number = override[seen]
                    else:
                        number = positional
                    seen += 1
                    found.append(Card(number, code, image, page_no, cell, positional))

                for card in found:
                    sizes.append(card.image.size)
                    if not dry_run:
                        OUT_DIR.mkdir(parents=True, exist_ok=True)
                        # Every card is written at one size so the client can
                        # lay them out without measuring each image. The crops
                        # already come out within a few pixels of this, so the
                        # resample is slight.
                        card.image.convert("RGB").resize(
                            CARD_SIZE, Image.Resampling.LANCZOS
                        ).save(
                            OUT_DIR / f"{card.code}-{card.number:03d}.jpg",
                            "JPEG",
                            quality=quality,
                            subsampling=0,
                            optimize=True,
                        )
                    card.image.close()
                    card.image = None  # type: ignore[assignment]

            cards.extend(found)
            numbers = [c.number for c in found]
            # Only collapse to a range when it really is a gapless, duplicate-free
            # run: summarising [37..41, 41, 43..45] as "037-045" would hide a bug.
            contiguous = (
                bool(numbers)
                and len(set(numbers)) == len(numbers)
                and max(numbers) - min(numbers) == len(numbers) - 1
            )
            listing = (
                f"{min(numbers):03d}-{max(numbers):03d}"
                if contiguous
                else ", ".join(f"{n:03d}" for n in numbers) or "none"
            )
            print(f"  page {page_no:>2}: {len(found)} cards  {listing}")

    if sizes:
        widths = sorted(w for w, _ in sizes)
        heights = sorted(h for _, h in sizes)
        print(
            f"  detected crops: {widths[0]}-{widths[-1]} x {heights[0]}-{heights[-1]} "
            f"-> written at {CARD_SIZE[0]}x{CARD_SIZE[1]}"
        )
    return cards


def back_from(pdf: Path, page_no: int, cell: int, workdir: Path) -> Image.Image:
    """Cuts one card off a backs page. Any cell will do — they are all the same."""
    with page_image(pdf, 1, workdir) as first:
        sheet_box = content_box(first)
        first_sheet = first.crop(sheet_box)
        tiled = is_tiled(first_sheet)
        native = median_size([box for _, box, _, _ in cards_on_page(first_sheet, 0, 1, tiled)])

    with page_image(pdf, page_no, workdir) as page:
        sheet = page.crop(sheet_box)
        cells = list(cards_on_page(sheet, 0, page_no, tiled))
        if cell >= len(cells):
            raise RuntimeError(f"{pdf.name} page {page_no}: only {len(cells)} cards on the sheet")
        box = cells[cell][1]
        return sheet.crop(fixed_crop(box, native, sheet.size)).convert("RGB").resize(
            CARD_SIZE, Image.Resampling.LANCZOS
        )


def difference(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute per-pixel difference, 0-255. Scanning noise lands in single digits."""
    stat = ImageStat.Stat(ImageChops.difference(a.convert("L"), b.convert("L")))
    return stat.mean[0]


# Above this the two images are not the same artwork, and the one-back
# assumption the whole face-down mechanic rests on would be wrong.
BACK_TOLERANCE = 14.0


def extract_backs(pdfs: list[Path], quality: int, dry_run: bool) -> bool:
    """Writes the single shared card back, after checking that it really is shared."""
    print("\ncard backs")
    samples: list[tuple[str, Image.Image]] = []

    with tempfile.TemporaryDirectory(prefix="berserk-backs-") as tmp:
        workdir = Path(tmp)
        for pdf in pdfs:
            pages = page_count(pdf)
            # Second page of the volume, and one further in, from different
            # cells — enough to catch a volume with its own back.
            for page_no, cell in ((2, 4), (min(6, pages - pages % 2), 0)):
                if page_no < 2 or page_no > pages or page_no % 2:
                    continue
                try:
                    samples.append((f"{pdf.stem} p{page_no} cell {cell}", back_from(pdf, page_no, cell, workdir)))
                except Exception as error:  # noqa: BLE001 - reported, not raised
                    print(f"  {pdf.name} page {page_no}: {error}")

        if not samples:
            print("  no backs found", file=sys.stderr)
            return False

        reference_name, reference = samples[0]
        print(f"  reference: {reference_name}")
        worst = 0.0
        for name, image in samples[1:]:
            delta = difference(reference, image)
            worst = max(worst, delta)
            verdict = "same" if delta <= BACK_TOLERANCE else "DIFFERENT"
            print(f"  {name:<34} difference {delta:5.1f}  {verdict}")

        if worst > BACK_TOLERANCE:
            print(
                f"  backs are not identical (worst {worst:.1f} > {BACK_TOLERANCE}); "
                "writing nothing",
                file=sys.stderr,
            )
            return False

        print(f"  all {len(samples)} samples agree (worst difference {worst:.1f})")
        if not dry_run:
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            out = OUT_DIR / "back.jpg"
            reference.save(out, "JPEG", quality=quality, subsampling=0, optimize=True)
            print(f"  wrote {out.relative_to(REPO)} at {CARD_SIZE[0]}x{CARD_SIZE[1]}")
        for _, image in samples:
            image.close()
    return True


def report(pdf: Path, cards: list[Card]) -> bool:
    """Sanity-checks a volume's output. Returns True if it looks complete."""
    ok = True
    by_code: dict[str, list[Card]] = defaultdict(list)
    for card in cards:
        by_code[card.code].append(card)

    expected = re.search(r"Set\s+(\d+)\s+Cards", pdf.name, re.IGNORECASE)
    expected_total = int(expected.group(1)) if expected else None

    print(f"  -> {len(cards)} cards, sets: {', '.join(sorted(by_code))}")
    if expected_total and len(cards) != expected_total:
        print(f"  !! filename says {expected_total} cards, extracted {len(cards)}")
        ok = False

    for code, group in sorted(by_code.items()):
        numbers = sorted(c.number for c in group)
        duplicates = {n for n in numbers if numbers.count(n) > 1}
        if duplicates:
            print(f"  !! {code}: duplicate numbers {sorted(duplicates)}")
            ok = False
        gaps = [n for n in range(1, max(numbers) + 1) if n not in numbers]
        if gaps:
            print(f"  .. {code}: numbers not present: {gaps}")

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdfs", nargs="*", type=Path, help="PDFs to process (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="report without writing files")
    parser.add_argument("--quality", type=int, default=90, help="JPEG quality (default 90)")
    parser.add_argument(
        "--backs", action="store_true", help="cut the shared card back instead of the fronts"
    )
    args = parser.parse_args()

    for tool in ("pdftoppm", "pdfinfo"):
        if not shutil.which(tool):
            print(f"{tool} is required", file=sys.stderr)
            return 1

    pdfs = args.pdfs or sorted(PDF_DIR.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in {PDF_DIR}", file=sys.stderr)
        return 1

    if args.backs:
        return 0 if extract_backs(pdfs, args.quality, args.dry_run) else 2

    total = 0
    all_ok = True
    for pdf in pdfs:
        cards = extract(pdf, args.quality, args.dry_run)
        all_ok &= report(pdf, cards)
        total += len(cards)

    verb = "would write" if args.dry_run else "wrote"
    print(f"\n{verb} {total} cards to {OUT_DIR}")
    return 0 if all_ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
