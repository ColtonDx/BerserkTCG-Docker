#!/usr/bin/env python3
"""
Read the numbers printed on every card: level, range, movement, power and hp.

Works from the source PDFs re-rendered at 600 DPI rather than from the cut
card images. At the cards' native 300 DPI a printed digit is only about 30x40
pixels, and JPEG noise over the ornate printed box is a large share of that —
enough to defeat both OCR and glyph matching. At 600 DPI the same digit is
roughly 60x80 and separates cleanly.

Every card is printed from one template, so a given digit is the same shape on
every card. Each number is cut from its box, normalised, and grouped with the
ones it matches; each distinct digit forms one cluster. A person labels one
representative per cluster — a couple of dozen readings — and those labels
apply to all 448 cards.

    python3 scripts/read-card-numbers.py --montage sheet.png   # 1. cluster
    python3 scripts/read-card-numbers.py --label labels.json   # 2. label

Step 2 writes `scripts/card-stats.json`, which `build-catalogue.py` merges into
the card database.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

Image.init()

REPO = Path(__file__).resolve().parent.parent
CLUSTERS = REPO / "scripts" / "glyph-clusters.json"
STATS = REPO / "scripts" / "card-stats.json"

# Load the extractor so card detection and numbering stay in one place.
_spec = importlib.util.spec_from_file_location("extract_cards", REPO / "scripts" / "extract-cards.py")
extract_cards = importlib.util.module_from_spec(_spec)
sys.modules["extract_cards"] = extract_cards
_spec.loader.exec_module(extract_cards)

RENDER_DPI = 600

# Where each number sits, as fractions of the card. Verified against the prints.
FIELDS: dict[str, tuple[float, float, float, float]] = {
    "level": (0.905, 0.010, 0.962, 0.043),
    "range": (0.836, 0.780, 0.900, 0.824),
    "movement": (0.836, 0.850, 0.900, 0.894),
    "power": (0.795, 0.915, 0.842, 0.959),
    "hp": (0.854, 0.915, 0.901, 0.959),
}
# The level is white type in a dark shield; the rest are dark on parchment.
INVERTED = {"level"}

# Normalised glyph grid, and how much of it two glyphs may differ by.
GLYPH = (20, 28)
TOLERANCE = 0.14


def glyph(card: Image.Image, box: tuple[float, float, float, float], invert: bool) -> str | None:
    """A card's printed number as a normalised bitmap, or None if the box is bare."""
    width, height = card.size
    crop = card.crop(
        (int(width * box[0]), int(height * box[1]), int(width * box[2]), int(height * box[3]))
    ).convert("L")
    # A light blur costs nothing at this resolution and removes JPEG speckle,
    # which is what kept identical digits from matching at 300 DPI.
    crop = crop.filter(ImageFilter.GaussianBlur(1.4))
    if invert:
        crop = ImageOps.invert(crop)

    low, high = crop.getextrema()
    if high - low < 40:  # flat box: nothing printed here
        return None
    threshold = low + (high - low) * 0.45
    mask = crop.point(lambda v: 255 if v < threshold else 0)  # ink white on black

    # Blank a margin so the printed box frame cannot join the glyph.
    margin = max(4, min(mask.size) // 5)
    inner = Image.new("L", mask.size, 0)
    inner.paste(
        mask.crop((margin, margin, mask.width - margin, mask.height - margin)), (margin, margin)
    )

    bounds = inner.getbbox()
    if bounds is None:
        return None
    if (bounds[2] - bounds[0]) < 10 or (bounds[3] - bounds[1]) < 20:
        return None

    normalised = inner.crop(bounds).resize(GLYPH, Image.Resampling.BILINEAR)
    return "".join("1" if p > 127 else "0" for p in normalised.getdata())


def overlap_distance(a: str, b: str) -> float:
    """
    How unlike two glyphs are, measured over their ink only.

    Comparing every pixel lets the shared blank background dominate, so two
    different digits come out looking similar. Scoring the ink alone is what
    separates them.
    """
    ink_a = {i for i, c in enumerate(a) if c == "1"}
    ink_b = {i for i, c in enumerate(b) if c == "1"}
    union = len(ink_a | ink_b)
    if not union:
        return 1.0
    return 1.0 - len(ink_a & ink_b) / union


def cards_of(pdf: Path, workdir: Path):
    """Yields (card_id, card image at 600 DPI) using the extractor's numbering."""
    code = extract_cards.set_code(pdf)
    override = extract_cards.SHEET_ORDER.get(code)
    pages = extract_cards.page_count(pdf)
    front_pages = list(range(1, pages + 1, 2))

    with extract_cards.page_image(pdf, 1, workdir, RENDER_DPI) as first:
        box = extract_cards.content_box(first)
        sheet = first.crop(box)
        tiled = extract_cards.is_tiled(sheet)
        native = extract_cards.median_size(
            [b for _, b, _, _ in extract_cards.cards_on_page(sheet, 0, 1, tiled)]
        )

    seen = 0
    for index, page_no in enumerate(front_pages):
        base = index * 9
        with extract_cards.page_image(pdf, page_no, workdir, RENDER_DPI) as page:
            sheet = page.crop(box)
            for cell, card_box, positional, _ in extract_cards.cards_on_page(
                sheet, base, page_no, tiled
            ):
                number = override[seen] if override else positional
                seen += 1
                crop = extract_cards.fixed_crop(card_box, native, sheet.size)
                yield f"{code}-{number:03d}", sheet.crop(crop)


def build() -> dict:
    clusters: dict[str, list[dict]] = {field: [] for field in FIELDS}
    cards: dict[str, dict[str, int | None]] = {}

    pdfs = sorted((REPO / "art-assets" / "PDFs").glob("*.pdf"))
    for pdf in pdfs:
        print(f"  {pdf.name} at {RENDER_DPI} DPI", flush=True)
        with tempfile.TemporaryDirectory(prefix="berserk-numbers-") as tmp:
            for card_id, card in cards_of(pdf, Path(tmp)):
                entry: dict[str, int | None] = {}
                for field, box in FIELDS.items():
                    bitmap = glyph(card, box, field in INVERTED)
                    if bitmap is None:
                        entry[field] = None
                        continue
                    bucket = clusters[field]
                    for cluster in bucket:
                        if overlap_distance(bitmap, cluster["bitmap"]) <= TOLERANCE:
                            cluster["members"].append(card_id)
                            entry[field] = cluster["id"]
                            break
                    else:
                        bucket.append(
                            {"id": len(bucket), "bitmap": bitmap, "members": [card_id]}
                        )
                        entry[field] = len(bucket) - 1
                cards[card_id] = entry
                card.close()

    summary = {
        field: [
            {"id": c["id"], "count": len(c["members"]), "bitmap": c["bitmap"], "example": c["members"][0]}
            for c in sorted(clusters[field], key=lambda c: -len(c["members"]))
        ]
        for field in FIELDS
    }
    CLUSTERS.write_text(json.dumps({"cards": cards, "clusters": summary}, indent=2) + "\n")
    print(f"\nwrote {CLUSTERS.relative_to(REPO)} — {len(cards)} cards")
    for field in FIELDS:
        sizes = ", ".join(f"#{c['id']}x{c['count']}" for c in summary[field][:14])
        print(f"  {field:<9} {len(summary[field]):>3} clusters: {sizes}")
    return {"cards": cards, "clusters": summary}


def montage(data: dict, out: Path, minimum: int = 1) -> None:
    scale = 5
    rows = []
    for field, clusters in data["clusters"].items():
        tiles = []
        for cluster in clusters:
            if cluster["count"] < minimum:
                continue
            img = Image.new("L", GLYPH)
            img.putdata([255 if ch == "1" else 0 for ch in cluster["bitmap"]])
            img = ImageOps.invert(img).resize(
                (GLYPH[0] * scale, GLYPH[1] * scale), Image.Resampling.NEAREST
            )
            tiles.append((cluster["id"], cluster["count"], img))
        rows.append((field, tiles))

    cell_w = GLYPH[0] * scale + 30
    cell_h = GLYPH[1] * scale + 30
    width = 140 + cell_w * max(len(t) for _, t in rows)
    height = 16 + cell_h * len(rows)
    sheet = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(sheet)
    for r, (field, tiles) in enumerate(rows):
        y = 16 + r * cell_h
        draw.text((6, y + cell_h // 2), field, fill="black")
        for i, (cid, count, img) in enumerate(tiles):
            x = 140 + i * cell_w
            sheet.paste(img, (x, y))
            draw.text((x, y + GLYPH[1] * scale + 4), f"#{cid} x{count}", fill="black")
    sheet.save(out, "PNG")
    print(f"wrote {out}")


# How close an unlabelled glyph must be to a labelled one to adopt its digit.
# Same digit typically scores under 0.2; different digits sit well above 0.4.
NEAREST_LIMIT = 0.33


def apply_labels(labels_path: Path) -> None:
    data = json.loads(CLUSTERS.read_text())
    labels = json.loads(labels_path.read_text())

    # Noise splits one digit across several clusters, so the labelled ones do
    # not cover everything. An unlabelled glyph that closely matches a labelled
    # one is the same digit; anything further off is left unknown.
    resolved: dict[str, dict[int, int]] = {}
    adopted: dict[str, int] = {}
    for field, clusters in data["clusters"].items():
        known = {
            int(c["id"]): (labels.get(field, {}).get(str(c["id"])), c["bitmap"])
            for c in clusters
            if labels.get(field, {}).get(str(c["id"])) is not None
        }
        mapping: dict[int, int] = {cid: value for cid, (value, _) in known.items()}
        for cluster in clusters:
            cid = int(cluster["id"])
            if cid in mapping:
                continue
            best, best_distance = None, 1.0
            for value, bitmap in known.values():
                distance = overlap_distance(cluster["bitmap"], bitmap)
                if distance < best_distance:
                    best, best_distance = value, distance
            if best is not None and best_distance <= NEAREST_LIMIT:
                mapping[cid] = int(best)
                adopted[field] = adopted.get(field, 0) + cluster["count"]
        resolved[field] = mapping

    stats: dict[str, dict[str, int | None]] = {}
    unlabelled: dict[str, set[int]] = {}
    for card, fields in data["cards"].items():
        entry: dict[str, int | None] = {}
        for field, cluster_id in fields.items():
            if cluster_id is None:
                entry[field] = None
                continue
            value = resolved.get(field, {}).get(int(cluster_id))
            if value is None:
                unlabelled.setdefault(field, set()).add(cluster_id)
                entry[field] = None
            else:
                entry[field] = int(value)
        stats[card] = entry

    STATS.write_text(json.dumps(stats, indent=2, sort_keys=True) + "\n")
    total = len(stats)
    print(f"wrote {STATS.relative_to(REPO)}")
    for field in FIELDS:
        known = sum(1 for v in stats.values() if v.get(field) is not None)
        extra = f", {adopted[field]} by nearest match" if adopted.get(field) else ""
        missing = f", {len(unlabelled[field])} clusters still unknown" if field in unlabelled else ""
        print(f"  {field:<9} {known:>3}/{total}{extra}{missing}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--montage", type=Path, help="cluster and write a labelling sheet")
    parser.add_argument("--label", type=Path, help="apply a cluster->digit label file")
    parser.add_argument("--min-count", type=int, default=1, help="hide tiny clusters in the sheet")
    parser.add_argument("--reuse", action="store_true", help="reuse existing clusters")
    args = parser.parse_args()

    if args.label:
        apply_labels(args.label)
        return 0

    data = json.loads(CLUSTERS.read_text()) if args.reuse and CLUSTERS.exists() else build()
    if args.montage:
        montage(data, args.montage, args.min_count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
