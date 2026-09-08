// Text that came from SOMEBODY ELSE, made safe to put on screen.
//
// Recipes shows names, descriptions and prompts written by whoever authored or shared a recipe, which is
// the skills problem with a different noun — so this is `apps/skills.ts`'s `authorText`/`authorBody`,
// under a name that does not belong to either app.
//
// ⚠️ **`skills.ts` still carries its own copy, and `recipes.test.ts` PINS THEM EQUAL** — the same shape
// `skills.ts` already uses for `wildcardMatch` against `@novaclaw/core/util/wildcard`. Two copies of a
// containment function eventually become two DIFFERENT containment functions and the one nobody re-read
// is the hole; the test is what makes that a failing test instead of a silent divergence. (The copy was
// left in place rather than re-pointed because its regexes are written as LITERAL invisible characters,
// and an editing pass over those lines is exactly the kind of edit that damages a file invisibly.)
//
// ⚠️ **This is NOT the XSS defence.** Solid escapes text nodes and nothing here builds markup. This is the
// defence against a string that RENDERS AS SOMETHING OTHER THAN WHAT IT IS — a bidi override that makes
// `troop.exe` read as `exe.poort`, a zero-width run that pads a name past a truncation boundary, a
// newline that turns one list row into three.
//
// ⚠️ **Display only — never feed the result back into a write.** These functions delete characters. A
// caller that put a flattened prompt into an editor and then saved it would silently damage the author's
// file on every open/save round trip, which is the opposite of what a recipe is for. Editors get the raw
// string; readers get this.

/**
 * Characters that let a string misrepresent itself on screen: the bidi overrides and isolates, the
 * directional marks, and the zero-width joiners/space/BOM.
 *
 * ⚠️ **Built from ESCAPE TEXT rather than written as a character class of literals.** The literal
 * characters are invisible, so a source file containing them is a trap for the next editor and for every
 * grep over the tree; `core/test/invisible-characters.test.ts` is the ledger that says so. Assembling the
 * class from ASCII `\uXXXX` strings keeps this file pure ASCII, which is a property a test can assert.
 */
const INVISIBLE = new RegExp(
  "[" +
    [
      "\\u061C", // Arabic letter mark
      "\\u200B-\\u200F", // zero-width space/joiners, LTR/RTL marks
      "\\u202A-\\u202E", // bidi embeddings and OVERRIDES
      "\\u2066-\\u2069", // bidi isolates
      "\\uFEFF", // BOM / zero-width no-break space
    ].join("") +
    "]",
  "g",
)

/** C0/C1 controls plus every kind of line break — folded to a space for single-line display. */
const CONTROL = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]", "g")

/** The same, minus tab and newline, for a body whose line breaks are meant to survive. */
const CONTROL_KEEPING_BREAKS = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u2028\\u2029]",
  "g",
)

/**
 * One line of author text, made safe to put on screen.
 *
 * Removes the invisible/bidi characters, folds controls and newlines to spaces, collapses runs of
 * whitespace, trims, and truncates to `max` with an ellipsis. Returns `""` for nothing at all — the
 * caller decides what an empty field should say, because "no description" and "a description of three
 * zero-width spaces" must not look different by accident.
 */
export function authorText(value: string | undefined, max = 240): string {
  if (typeof value !== "string") return ""
  const flat = value.replace(INVISIBLE, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(0, max - 1)).trimEnd() + "…"
}

/**
 * Whether a string carries characters that make it read differently than it is.
 *
 * ⚠️ **This exists because a display defence cannot cover an EDITOR.** A read-only surface can flatten a
 * name before showing it; a text input cannot, because whatever is in the box is what a save writes back,
 * and flattening there would delete characters from the author's file on every open/save round trip. So
 * the raw string stays in the box and the surface says out loud that it is not what it looks like — which
 * is the teaching answer rather than the gatekeeping one.
 *
 * ⚠️ Built fresh, WITHOUT the `g` flag: a global regex carries `lastIndex` between `.test` calls, so the
 * same string would match and then not match on alternate evaluations.
 */
export const containsInvisible = (value: string | undefined): boolean =>
  typeof value === "string" && new RegExp(INVISIBLE.source).test(value)

/**
 * The multi-line body, made safe to put in a `<pre>`: invisible/bidi characters removed, controls other
 * than tab/newline removed, line endings normalized. Line breaks SURVIVE — the body is the one place a
 * reader is meant to see the text as the author laid it out.
 */
export function authorBody(value: string | undefined, maxChars = 200_000): string {
  if (typeof value !== "string") return ""
  const clean = value.replace(INVISIBLE, "").replace(/\r\n?/g, "\n").replace(CONTROL_KEEPING_BREAKS, "")
  return clean.length <= maxChars ? clean : clean.slice(0, maxChars) + "\n…"
}
