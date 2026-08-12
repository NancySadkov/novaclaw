/**
 * Which fonts this machine can actually render — settings-ux rule 2, *offer what exists*.
 *
 * ## Why not the obvious two APIs
 *
 * Both were tried in the running app on 2026-08-12 before this existed, and both are wrong here:
 *
 * · **`queryLocalFonts()`** exists in Chromium but its permission reports `denied` by default, and
 *   it throws `SecurityError: Page needs to be visible` besides. It needs a permission grant, a
 *   visible page and a gesture — so the web build cannot use it at all, and making a font list
 *   depend on a permission prompt trades one incantation for another.
 * · **`document.fonts.check()`** answers **true for a font that does not exist** (measured with
 *   `ThisFontDoesNotExist12345`). It reports whether the font set can render the string, not whether
 *   the family resolves. An "available" tick built on it would say yes to everything, which is worse
 *   than no tick.
 *
 * ## What does work
 *
 * Render a probe string in `"<family>", <generic>` and in `<generic>` alone; if the widths differ,
 * the family resolved. Verified: Arial/Consolas/Cascadia Code/Segoe UI true, nonsense false.
 *
 * ⚠️ **A BUNDLED webfont measures as absent until it loads.** `JetBrainsMono Nerd Font Mono` — the
 * app's own default — measured false while Inter measured true, purely because of load timing. So
 * fonts we ship are never subjected to this test: we know they are there, and reporting the default
 * as missing would be a false statement about the product's own asset.
 */

/**
 * Fonts this app ships, so their presence is a fact rather than a measurement — split by ROLE.
 *
 * ⚠️ Offering every bundled font to every row put a monospace face in the interface-font list. "Offer
 * what exists" does not mean offer everything: a list that includes obviously wrong answers is
 * harder to choose from than a shorter honest one.
 */
export const BUNDLED_SANS = ["Inter"] as const
export const BUNDLED_MONO = ["JetBrainsMono Nerd Font Mono"] as const

/** Common families worth offering when the machine has them. Measured, never assumed. */
export const CANDIDATE_MONO = [
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Courier New",
  "DejaVu Sans Mono",
  "Fira Code",
  "IBM Plex Mono",
  "JetBrains Mono",
  "Menlo",
  "Monaco",
  "SF Mono",
  "Source Code Pro",
  "Ubuntu Mono",
] as const

/** Interface families worth offering when present. Same discipline: measured, never assumed. */
export const CANDIDATE_SANS = [
  "Arial",
  "Calibri",
  "Cantarell",
  "Georgia",
  "Helvetica Neue",
  "IBM Plex Sans",
  "Noto Sans",
  "Roboto",
  "SF Pro Text",
  "Segoe UI",
  "Source Sans Pro",
  "Ubuntu",
  "Verdana",
] as const

/**
 * The offered list: everything we ship, plus the candidates this machine actually has, plus whatever
 * is already set — because a value the user chose must never vanish from its own picker.
 */
export const offeredFonts = (input: {
  readonly bundled: readonly string[]
  readonly candidates: readonly string[]
  readonly present: (family: string) => boolean
  readonly current?: string | undefined
}): string[] => {
  const out = [...input.bundled, ...input.candidates.filter((family) => input.present(family))]
  const current = input.current?.trim()
  if (current && !out.includes(current)) out.push(current)
  return [...new Set(out)]
}

/**
 * Does this family resolve? Compares a probe's rendered width against three generic fallbacks: a
 * family that resolves changes the width for at least one of them.
 */
export const makeFontProbe = (): ((family: string) => boolean) => {
  const context = document.createElement("canvas").getContext("2d")
  if (!context) return () => false
  // Glyphs whose widths differ sharply between typefaces; a bland string can measure identical in
  // two real fonts and report a present family as absent.
  const probe = "mmmmmmmmmmlliWWWW@#$%"
  const widthIn = (stack: string) => {
    context.font = `72px ${stack}`
    return context.measureText(probe).width
  }
  return (family: string) =>
    ["monospace", "sans-serif", "serif"].some((generic) => widthIn(`"${family}", ${generic}`) !== widthIn(generic))
}
