#!/usr/bin/env python3
"""Regenerate the NovaClaw desktop icon set from the brand logo.

One command, one dependency (Pillow):  python packages/desktop/icons/generate-icons.py

Source of truth is the shipped brand mark at packages/app/public/novaclaw-logo.png
(transparent-background square PNG). It is upscaled once to a 1024 master, then every
target — the PNG sizes, the multi-resolution Windows icon.ico, and the multi-resolution
macOS icon.icns — is derived from that master. The same mark is written into all three
channel folders (dev / prod / beta).

electron-builder.config.ts consumes icon.ico (Windows app + installer), icon.icns
(macOS), and the loose PNG sizes (Linux) out of resources/icons/<channel>.

NOTE ON QUALITY: the source logo is low resolution (~186 px) with the wordmark baked in,
so the 512/1024 renders are soft and the text stops being legible below ~96 px. Replacing
this source with a high-resolution / text-free icon master (just the diamond mark) and
re-running this script is the clean upgrade path.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]          # …/novaclaw
SRC = ROOT / "packages/app/public/novaclaw-logo.png"
ICONS = Path(__file__).resolve().parent             # …/packages/desktop/icons
CHANNELS = ["dev", "prod", "beta"]

# filename -> square edge in px
PNG_TARGETS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "dock.png": 256,           # macOS dev-mode Dock icon == 128@2x
    "icon.png": 1024,          # master / Linux
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def load_square_master(src: Path, edge: int = 1024) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    if w != h:                                       # pad to square (safety; source is square)
        side = max(w, h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
        im = canvas
    return im.resize((edge, edge), Image.LANCZOS)


def main() -> None:
    assert SRC.exists(), f"source logo not found: {SRC}"
    master = load_square_master(SRC, 1024)
    for ch in CHANNELS:
        d = ICONS / ch
        if not d.exists():
            print(f"  skip (missing) {d}")
            continue
        for name, edge in PNG_TARGETS.items():
            img = master if edge == 1024 else master.resize((edge, edge), Image.LANCZOS)
            img.save(d / name, "PNG")
        master.save(d / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])
        master.save(d / "icon.icns", format="ICNS")           # Pillow embeds the standard set
        print(f"  {ch}: {len(PNG_TARGETS)} PNGs + icon.ico ({len(ICO_SIZES)} sizes) + icon.icns")
    print(f"done — source {SRC.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
