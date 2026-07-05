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

Source of truth: the shipped brand mark at `packages/app/public/novaclaw-logo.png`. To rebuild
every file in every channel from it (requires Python + Pillow — `pip install pillow`):

```sh
python packages/desktop/icons/generate-icons.py
```

The script upscales the logo to a 1024 master and derives all sizes + the multi-res `.ico`/`.icns`
from it. Change the logo (or point the script at a new source) and re-run — no other tooling.

> **Quality note.** The current source logo is low-resolution (~186 px) with the wordmark baked
> in, so the 512/1024 renders are soft and the text is illegible below ~96 px. The clean upgrade
> is a high-resolution, text-free icon master (the diamond mark alone); drop it in as the source
> and re-run the script.

## Leftovers

The `android/` and `ios/` subfolders are stale Tauri assets (still OpenCode-branded) — the app
ships as Electron and does not use them. Safe to delete in a future cleanup.
