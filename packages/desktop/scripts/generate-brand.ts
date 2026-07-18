import { $ } from "bun"
import path from "path"

// Regenerate EVERY NovaClaw brand raster from one master logo. Run after editing the logo:
//   bun packages/desktop/scripts/generate-brand.ts [path/to/master-logo.png] [path/to/glyph.png]
// Default master: the repo-root logo.png (one level above the app repo). Requires ImageMagick 7.
//
// The master is the full LOCKUP (glyph + wordmark). It is used verbatim for the in-app logo and,
// centered, for the social-share banners. A GLYPH (no wordmark) drives the desktop app icons and
// the browser/PWA favicons, where a wordmark would be illegible at small sizes. The glyph source is,
// in order: the second argument, a logo-icon.png sitting next to the lockup master, or an auto-crop
// of the top of the lockup (the wordmark band is dropped, then trimmed + squared) — a separate
// glyph export wins because wordmarks that overlap the mark make every crop fraction wrong. This is
// a manual/dev step, not wired into the build, so CI without ImageMagick is unaffected.

const desktop = path.resolve(import.meta.dir, "..") // packages/desktop
const repo = path.resolve(desktop, "../..") // novaclaw/
const appPublic = path.resolve(repo, "packages/app/public")
const iconsDir = path.resolve(desktop, "icons")
const faviconDir = path.resolve(repo, "packages/ui/src/assets/favicon")
const imagesDir = path.resolve(repo, "packages/ui/src/assets/images")

const INK = "#1a1135" // brand ink — favicon background so the light-on-transparent mark stays legible
const BANNER_BG = "#0b0b12" // social-share banner background
const GLYPH_CROP = 0.795 // keep this top fraction of the lockup as the glyph (drops the wordmark band)
const GLYPH_FILL = 928 // glyph fits within this box inside the 1024 icon canvas (leaves a small margin)
const channels = ["dev", "prod", "beta"]

const master = path.resolve(process.argv[2] ?? path.join(repo, "..", "logo.png"))
if (!(await Bun.file(master).exists())) throw new Error(`master logo not found: ${master}`)
console.log("master lockup:", master)

const glyphCandidate = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(path.dirname(master), "logo-icon.png")
const glyphMaster = (await Bun.file(glyphCandidate).exists()) ? glyphCandidate : undefined
if (process.argv[3] && !glyphMaster) throw new Error(`glyph master not found: ${glyphCandidate}`)
console.log(glyphMaster ? `glyph master: ${glyphMaster}` : "glyph: auto-crop from lockup")

const resizePng = (src: string, size: number, out: string) =>
  $`magick ${src} -resize ${size}x${size} -filter Lanczos -strip PNG32:${out}`

// 1) The lockup, verbatim, is the canonical in-app logo (+ the small variant used on the new-session view).
await $`cp ${master} ${appPublic}/logo.png`
const lockup = `${appPublic}/logo.png`
await resizePng(lockup, 186, `${appPublic}/novaclaw-logo.png`)

// 2) The icon/favicon source: the dedicated glyph export when present (trimmed + squared), else
//    crop the glyph out of the TOP of the lockup. Either way it ends centred in a square canvas
//    with a little breathing room.
const glyph = `${iconsDir}/logo-source-1024.png`
if (glyphMaster) {
  await $`magick ${glyphMaster} -trim +repage -resize ${GLYPH_FILL}x${GLYPH_FILL} -background none -gravity center -extent 1024x1024 -strip PNG32:${glyph}`
} else {
  const [masterW, masterH] = (await $`magick identify -format "%w %h" ${master}`.text()).trim().split(" ").map(Number)
  const cropH = Math.round(masterH * GLYPH_CROP)
  await $`magick ${lockup} -crop ${masterW}x${cropH}+0+0 +repage -trim +repage -resize ${GLYPH_FILL}x${GLYPH_FILL} -background none -gravity center -extent 1024x1024 -strip PNG32:${glyph}`
}

// 3) Desktop app icons (all channels, identical today) from the glyph.
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
const stage = path.join(iconsDir, ".staging")
await $`rm -rf ${stage} && mkdir -p ${stage}`
for (const [name, size] of Object.entries(pngSizes)) await resizePng(glyph, size, path.join(stage, name))
await $`cp ${glyph} ${path.join(stage, "icon.png")}`
await $`magick ${glyph} -define icon:auto-resize=256,128,64,48,32,24,16 ${path.join(stage, "icon.ico")}`
await Bun.write(path.join(stage, "icon.icns"), await buildIcns(glyph, stage))
for (const ch of channels) {
  const dir = path.join(iconsDir, ch)
  await $`rm -rf ${dir} && mkdir -p ${dir} && cp ${stage}/* ${dir}/`
}
await $`rm -rf ${stage}`

// 4) Favicons from the glyph, flattened onto the brand ink (opaque, so the white mark reads on any tab).
const flat = (size: number, out: string) =>
  $`magick ${glyph} -resize ${size}x${size} -background ${INK} -flatten -strip PNG32:${out}`
await flat(180, `${faviconDir}/apple-touch-icon.png`)
await $`cp ${faviconDir}/apple-touch-icon.png ${faviconDir}/apple-touch-icon-v3.png`
await flat(96, `${faviconDir}/favicon-96x96.png`)
await $`cp ${faviconDir}/favicon-96x96.png ${faviconDir}/favicon-96x96-v3.png`
await flat(192, `${faviconDir}/web-app-manifest-192x192.png`)
await flat(512, `${faviconDir}/web-app-manifest-512x512.png`)
await $`magick ${glyph} -background ${INK} -flatten -define icon:auto-resize=48,32,16 ${faviconDir}/favicon.ico`
await $`cp ${faviconDir}/favicon.ico ${faviconDir}/favicon-v3.ico`
const svgGlyph = path.join(faviconDir, "_glyph256.png")
await flat(256, svgGlyph)
const b64 = Buffer.from(await Bun.file(svgGlyph).bytes()).toString("base64")
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><image width="512" height="512" href="data:image/png;base64,${b64}"/></svg>\n`
await Bun.write(`${faviconDir}/favicon.svg`, svg)
await Bun.write(`${faviconDir}/favicon-v3.svg`, svg)
await $`rm -f ${svgGlyph}`

// 5) Social-share banners: the lockup centred on the banner background, at each committed size.
// (Bun's shell reserves `(`, so resize the lockup to a temp then composite — no sub-image parens.)
const bannerTmp = path.join(imagesDir, "_lockup_tmp.png")
for (const [name, w, h] of [
  ["social-share.png", 1280, 720],
  ["social-share-black.png", 1280, 721],
  ["social-share-zen.png", 1200, 630],
] as const) {
  await resizePng(lockup, Math.round(h * 0.82), bannerTmp)
  await $`magick -size ${w}x${h} xc:${BANNER_BG} ${bannerTmp} -gravity center -composite -strip ${path.join(imagesDir, name)}`
}
await $`rm -f ${bannerTmp}`

console.log(`Regenerated: app logo + novaclaw-logo, glyph icons (${channels.join(", ")}), favicons, social banners.`)

// The modern PNG-based ICNS container, assembled by hand (some ImageMagick builds can't write ICNS).
// `icns` + total length, then one chunk per icon: 4-byte OSType + 4-byte BE length (incl. 8-byte
// header) + PNG data. OSType -> px size (includes the @2x variants). See Apple's .icns format.
async function buildIcns(src: string, stageDir: string) {
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
      const tmp = path.join(stageDir, `_icns_${size}.png`)
      await resizePng(src, size, tmp)
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
  return Buffer.concat([head, body])
}
