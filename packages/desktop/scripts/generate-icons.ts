import { $ } from "bun"
import path from "path"

// Regenerate every desktop app icon from the brand mark. Run after updating the logo:
//   bun packages/desktop/scripts/generate-icons.ts   (cwd anywhere)
//
// Source of truth: packages/app/public/logo.png (the authored 1024x1024 mark). It is mirrored to
// icons/logo-source-1024.png, then fanned out to icons/{dev,prod,beta}/ — the channels are identical
// (no per-channel badge today) and copy-icons.ts stages the active channel into resources/icons at
// build time. Requires ImageMagick 7 (`magick` on PATH); this is a manual/dev step, not wired into
// the build, so CI without ImageMagick is unaffected.

const root = path.resolve(import.meta.dir, "..") // packages/desktop
const brand = path.resolve(root, "../app/public/logo.png")
const source = path.resolve(root, "icons/logo-source-1024.png")
const channels = ["dev", "prod", "beta"]

// Keep the committed icon source in lockstep with the app logo.
await $`cp ${brand} ${source}`

// Windows-tile + macOS/Linux raster sizes, matching the committed icon set.
const pngSizes: Record<string, number> = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "dock.png": 256,
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

const resize = (size: number, out: string) =>
  $`magick ${source} -resize ${size}x${size} -filter Lanczos -strip PNG32:${out}`

// ImageMagick's ICNS writer is unavailable on some builds (it errors / falls back to a bare PNG), so
// assemble the modern PNG-based container by hand: `icns` + total length, then one chunk per icon
// (4-byte OSType + 4-byte big-endian length incl. the 8-byte header + PNG data). OSType -> px size,
// including the @2x variants (ic11..ic14). See Apple's Icon Image (.icns) format.
async function buildIcns(out: string, stage: string) {
  const map: Array<[string, number]> = [
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic13", 256],
    ["ic09", 512],
    ["ic14", 512],
    ["ic10", 1024],
  ]
  const cache = new Map<number, Uint8Array>()
  const chunks: Buffer[] = []
  for (const [ostype, size] of map) {
    if (!cache.has(size)) {
      const tmp = path.join(stage, `_icns_${size}.png`)
      await resize(size, tmp)
      cache.set(size, await Bun.file(tmp).bytes())
      await $`rm -f ${tmp}`
    }
    const png = cache.get(size)!
    const header = Buffer.alloc(8)
    header.write(ostype, 0, "ascii")
    header.writeUInt32BE(png.length + 8, 4)
    chunks.push(header, Buffer.from(png))
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write("icns", 0, "ascii")
  head.writeUInt32BE(body.length + 8, 4)
  await Bun.write(out, Buffer.concat([head, body]))
}

const stage = path.resolve(root, "icons/.staging")
await $`rm -rf ${stage} && mkdir -p ${stage}`
for (const [name, size] of Object.entries(pngSizes)) await resize(size, path.join(stage, name))
await $`cp ${source} ${path.join(stage, "icon.png")}`
await $`magick ${source} -define icon:auto-resize=256,128,64,48,32,24,16 ${path.join(stage, "icon.ico")}`
await buildIcns(path.join(stage, "icon.icns"), stage)

for (const ch of channels) {
  const dir = path.resolve(root, "icons", ch)
  await $`rm -rf ${dir} && mkdir -p ${dir}`
  await $`cp ${stage}/* ${dir}/`
}
await $`rm -rf ${stage}`

// The in-app brand image used on the new-session view mirrors the same mark.
await $`magick ${source} -resize 186x186 -filter Lanczos -strip PNG32:${path.resolve(root, "../app/public/novaclaw-logo.png")}`

console.log(`Regenerated desktop icons (${channels.join(", ")}) + novaclaw-logo.png from ${path.relative(root, brand)}`)
