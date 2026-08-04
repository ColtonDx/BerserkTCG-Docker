#!/usr/bin/env python3
"""
Read the printed numbers off the cards by matching glyph shapes.

STATUS: not yet reliable — do not use its output as card data. See the note at
the end of this docstring.

OCR is the wrong tool here. The digits are large and clean, but they sit
inside ornate printed boxes whose edges tesseract keeps reading as extra
digits — "2" comes back as "24" or "273". What makes these numbers tractable
instead is that every card is printed from the same template, so the digit
glyphs are pixel-for-pixel identical from card to card.

So: cut each number out of its box, normalise it to a small bitmap, and group
identical bitmaps together. Every distinct digit forms one tight cluster. A
person then labels one representative per cluster — about a dozen readings —
and those labels apply to all 448 cards with no per-card guesswork.

    python3 scripts/cluster-glyphs.py --montage sheet.png   # 1. build clusters
    python3 scripts/cluster-glyphs.py --label labels.json   # 2. apply labels

Writes `scripts/glyph-clusters.json`, which records each card's cluster per
field, and once labelled, `scripts/card-stats.json` for `build-catalogue.py`.

Where this stands
-----------------
The idea is sound but the clustering does not yet separate cleanly. Each digit
should form one tight cluster; in practice a field yields 15-35 clusters, with
a long tail of one-member groups. The cause is resolution: at 703x1008 a digit
is only about 30x40 pixels, and JPEG noise over the ornate printed box is a
large fraction of that.

The promising fix is more resolution, not more parameter tuning — the source
PDFs are 300 DPI scans and the stat boxes can be re-rendered at 600 DPI, which
doubles the glyph to ~60x80 and should make both this and plain OCR work.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

Image.init()

REPO = Path(__file__).resolve().parent.parent
CARD_DIR = REPO / "art-assets" / "cards"
CLUSTERS = REPO / "scripts" / "glyph-clusters.json"
STATS = REPO / "scripts" / "card-stats.json"

# Where each number sits, as fractions of the card. Checked against the prints.
FIELDS: dict[str, tuple[float, float, float, float]] = {
    "level": (0.905, 0.010, 0.962, 0.043),
    "range": (0.836, 0.780, 0.900, 0.824),
    "movement": (0.836, 0.850, 0.900, 0.894),
    "power": (0.795, 0.915, 0.842, 0.959),
    "hp": (0.854, 0.915, 0.901, 0.959),
}
# The level sits in a dark shield in white type; the rest are dark on parchment.
INVERTED = {"level"}

# Normalised glyph size. Big enough to tell 3 from 8, small enough to compare fast.
GLYPH = (18, 26)
# Fraction of pixels that may differ for two glyphs to count as the same digit.
MATCH_TOLERANCE = 0.10


def glyph(card: Image.Image, box: tuple[float, float, float, float], invert: bool) -> str | None:
    """A card's number as a normalised bitmap, or None if the box is empty."""
    width, height = card.size
    crop = card.crop(
        (int(width * box[0]), int(height * box[1]), int(width * box[2]), int(height * box[3]))
    ).convert("L")
    crop = crop.resize((crop.width * 3, crop.height * 3), Image.Resampling.LANCZOS)
    if invert:
        crop = ImageOps.invert(crop)

    low, high = crop.getextrema()
    if high - low < 40:  # flat box: no number printed here
        return None
    threshold = (low + high) // 2
    mask = crop.point(lambda v: 255 if v < threshold else 0)  # ink white on black

    # Blank a margin so the printed box frame cannot become part of the glyph.
    margin = max(3, min(mask.size) // 6)
    inner = Image.new("L", mask.size, 0)
    inner.paste(mask.crop((margin, margin, mask.width - margin, mask.height - margin)), (margin, margin))

    bounds = inner.getbbox()
    if bounds is None:
        return None
    if (bounds[2] - bounds[0]) < 6 or (bounds[3] - bounds[1]) < 10:
        return None

    normalised = inner.crop(bounds).resize(GLYPH, Image.Resampling.BILINEAR)
    return "".join("1" if p > 127 else "0" for p in normalised.getdata())


def distance(a: str, b: str) -> float:
    diff = sum(1 for x, y in zip(a, b) if x != y)
    return diff / len(a)


def build() -> dict:
    clusters: dict[str, list[dict]] = {field: [] for field in FIELDS}
    cards: dict[str, dict[str, int | None]] = {}

    paths = sorted(CARD_DIR.glob("*.jpg"))
    for index, path in enumerate(paths, 1):
        with Image.open(path) as card:
            card = card.convert("RGB")
            entry: dict[str, int | None] = {}
            for field, box in FIELDS.items():
                bitmap = glyph(card, box, field in INVERTED)
                if bitmap is None:
                    entry[field] = None
                    continue
                bucket = clusters[field]
                for cluster in bucket:
                    if distance(bitmap, cluster["bitmap"]) <= MATCH_TOLERANCE:
                        cluster["members"].append(path.stem)
                        entry[field] = cluster["id"]
                        break
                else:
                    bucket.append(
                        {
                            "id": len(bucket),
                            "bitmap": bitmap,
                            "members": [path.stem],
                            "example": path.stem,
                        }
                    )
                    entry[field] = len(bucket) - 1
            cards[path.stem] = entry
        if index % 50 == 0:
            print(f"  {index}/{len(paths)}", flush=True)

    summary = {
        field: [
            {"id": c["id"], "count": len(c["members"]), "example": c["example"], "bitmap": c["bitmap"]}
            for c in sorted(clusters[field], key=lambda c: -len(c["members"]))
        ]
        for field in FIELDS
    }
    CLUSTERS.write_text(json.dumps({"cards": cards, "clusters": summary}, indent=2) + "\n")
    print(f"\nwrote {CLUSTERS.relative_to(REPO)}")
    for field in FIELDS:
        counts = ", ".join(f"#{c['id']}x{c['count']}" for c in summary[field])
        print(f"  {field:<9} {len(summary[field])} clusters: {counts}")
    return {"cards": cards, "clusters": summary}


def montage(data: dict, out: Path) -> None:
    """One representative per cluster, for labelling by eye."""
    scale = 6
    pad = 14
    rows = []
    for field, clusters in data["clusters"].items():
        tiles = []
        for cluster in clusters:
            img = Image.new("L", GLYPH)
            img.putdata([255 if ch == "1" else 0 for ch in cluster["bitmap"]])
            img = ImageOps.invert(img).resize(
                (GLYPH[0] * scale, GLYPH[1] * scale), Image.Resampling.NEAREST
            )
            tiles.append((cluster["id"], cluster["count"], img))
        rows.append((field, tiles))

    cell_w = GLYPH[0] * scale + pad + 26
    cell_h = GLYPH[1] * scale + pad + 20
    width = 130 + cell_w * max(len(t) for _, t in rows)
    height = 10 + cell_h * len(rows)
    sheet = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(sheet)
    for r, (field, tiles) in enumerate(rows):
        y = 10 + r * cell_h
        draw.text((6, y + cell_h // 2), field, fill="black")
        for i, (cid, count, img) in enumerate(tiles):
            x = 130 + i * cell_w
            sheet.paste(img, (x, y))
            draw.text((x, y + GLYPH[1] * scale + 2), f"#{cid} ({count})", fill="black")
    sheet.save(out, "PNG")
    print(f"wrote {out}")


def apply_labels(labels_path: Path) -> None:
    data = json.loads(CLUSTERS.read_text())
    labels = json.loads(labels_path.read_text())

    stats: dict[str, dict[str, int | None]] = {}
    for card, fields in data["cards"].items():
        entry: dict[str, int | None] = {}
        for field, cluster_id in fields.items():
            if cluster_id is None:
                entry[field] = None
                continue
            value = labels.get(field, {}).get(str(cluster_id))
            entry[field] = int(value) if value is not None else None
        stats[card] = entry

    STATS.write_text(json.dumps(stats, indent=2, sort_keys=True) + "\n")
    total = len(stats)
    print(f"wrote {STATS.relative_to(REPO)}")
    for field in FIELDS:
        known = sum(1 for v in stats.values() if v.get(field) is not None)
        print(f"  {field:<9} {known:>3}/{total}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--montage", type=Path, help="build clusters and write a labelling sheet")
    parser.add_argument("--label", type=Path, help="apply a cluster->digit label file")
    args = parser.parse_args()

    if args.label:
        apply_labels(args.label)
        return 0

    data = build() if not CLUSTERS.exists() or args.montage else json.loads(CLUSTERS.read_text())
    if args.montage:
        montage(data, args.montage)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
