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

**One generator: `packages/desktop/scripts/generate-brand.ts`.** It requires ImageMagick 7 and is a
manual dev step, not part of the build.

```sh
bun packages/desktop/scripts/generate-brand.ts <master.png> <glyph.png>
bun packages/desktop/scripts/generate-brand.ts <master.png> --crop      # wordmark BAND below the mark
```

⚠️ **`logo-source-1024.png` in this folder is an OUTPUT, not the source.** `generate-brand.ts` writes
it from the master lockup on every run, and everything in the channel folders is derived from it. To
change the icon, edit the master logo and re-run the script — replacing `logo-source-1024.png` by
hand is overwritten the next time anyone regenerates.

⚠️ **These folders are not the only thing the run rewrites.** The same pass regenerates
`packages/app/public` (in-app logo), `packages/ui/src/assets/favicon` (browser/PWA icons) and
`packages/ui/src/assets/images` (social banners) from the same master. A partial regeneration that
touched only this folder would leave the other three stale with nothing reporting it, which is why
there is one script rather than one per output directory.

⚠️ **The glyph source is an explicit argument and the script THROWS without one.** It used to fall
back to cropping the lockup, and a master that is already a square tile with the wordmark inside it
gets its bottom corners sheared off — a mangled icon that still looks plausible in a file listing.
The script's own header comment carries the three legal forms.

> **Note.** The mark has the "NovaClaw" wordmark baked in, so at the very small sizes (16–32 px)
> the text isn't legible — the diamond silhouette still reads. A dedicated small-size glyph (the
> claw/diamond alone) could be added later for the tiny sizes if wanted.
