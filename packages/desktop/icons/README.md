# Desktop icons

App icons for the three build channels (`dev` / `prod` / `beta`). Each folder holds a full
set derived from the NovaClaw brand mark:

- `icon.ico` — Windows app + installer (multi-res 16–256), consumed by `electron-builder.config.ts`.
- `icon.icns` — macOS app (multi-res 16–1024).
- `icon.png` — 1024 master / Linux.
- `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png` — loose Linux sizes.
- `dock.png` — macOS dev-mode Dock icon (`app.dock.setIcon`, == `128x128@2x`).
- `Square*Logo.png`, `StoreLogo.png` — Windows Store / MSIX tiles.

## Regenerate

Source of truth: `logo-source-1024.png` in this folder (the high-res NovaClaw mark, 1024×1024
transparent PNG). To rebuild every file in every channel from it (requires Python + Pillow —
`pip install pillow`):

```sh
python packages/desktop/icons/generate-icons.py
```

The script derives all sizes + the multi-res `.ico`/`.icns` as crisp downscales from the master.
To change the icon, replace `logo-source-1024.png` with a new 1024×1024 mark and re-run — no
other tooling.

> **Note.** The mark has the "NovaClaw" wordmark baked in, so at the very small sizes (16–32 px)
> the text isn't legible — the diamond silhouette still reads. A dedicated small-size glyph (the
> claw/diamond alone) could be added later for the tiny sizes if wanted.
