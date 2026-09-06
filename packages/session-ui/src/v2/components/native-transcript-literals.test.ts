import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * THE TRANSCRIPT SPEAKS THE USER'S LANGUAGE — a source ratchet.
 *
 * On 2026-09-03 `native-transcript.tsx` carried ~45 raw English literals ("Done", "3 steps",
 * "Reasoning", "Todos", "Copy") beside a translator it already held, on the one surface a lay
 * user reads. Two of them ("Copy", "Copy message") had keys in `packages/ui/src/i18n/en.ts` that
 * `markdown.tsx` in the same package was already using. The i18n parity ratchet could not see any
 * of it: a string with no key never enters a key count.
 *
 * ⚠️ Source-scanned, like `permission-card.test.ts`, because this file imports a Vite worker and
 * `bun test` cannot load it. The scan is deliberately narrow — the shapes an English literal takes
 * in JSX and in the row/label tables — and it reads CODE ONLY (comment lines are dropped, since
 * writing ABOUT a literal must not trip the guard against it).
 *
 * THE RULE: `KNOWN` may only SHRINK. A new literal fails by line; the fix is a key in
 * `packages/ui/src/i18n/en.ts` and an `i18n.t(...)` / `i18n.plural(...)` at the site.
 */

const FILES = ["native-transcript.tsx", "colleague-row.ts"]

/** Remaining literals, pinned by file and by the text the scanner sees. Shrink only. */
const KNOWN: Record<string, string[]> = {
  "native-transcript.tsx": [],
  "colleague-row.ts": [],
}

/** A line whose first token opens or continues a comment is prose, not code. */
const stripComments = (source: string) => source.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, "")

const SHAPES: RegExp[] = [
  // JSX text: `>Done<`, `>Reasoning…<` — a capitalised word directly between tags, on ONE line
  // (a newline in the class would let `>` … `<` span a whole function body of code)
  />[ \t]*([A-Z][a-z][^<{\n]*?)[ \t]*</g,
  // string props that reach the screen or the screen reader
  /\b(?:aria-label|title|placeholder|alt)="([A-Z][^"]*)"/g,
  // row and label tables: `title: "Read"`, `subtitle: "…"`, `retry: "Try again"`
  /\b(?:title|subtitle|label|retry|chooseModel|technicalDetails|copyDetails|working):\s*"([A-Z][^"]*)"/g,
  // a hand-rolled English fallback beside a label: `?? "Working…"`
  /\?\?\s*"([A-Z][^"]*)"/g,
  // a hand-rolled plural: `? "step" : "steps"` (the second arm is the first plus `s`), or the bare
  // suffix `${n > 1 ? "s" : ""}`. Narrowed to the plural SHAPE: `? "pointer" : "default"` and
  // `? "retry" : "attempt"` are ordinary value ternaries, not English.
  /\?\s*"([a-z]+)"\s*:\s*"\1s"/g,
  /\?\s*"(s)"\s*:\s*""/g,
  // a template that starts a sentence: `Messaged ${who}`
  /`([A-Z][a-z]+ [^`]*)`/g,
]

function literalsIn(source: string): string[] {
  const code = stripComments(source)
  const found: string[] = []
  for (const shape of SHAPES) {
    shape.lastIndex = 0
    for (const match of code.matchAll(shape)) {
      const text = match[1]!
      // Not English: a lone symbol, a number, a data attribute value, a slot name.
      if (!/[A-Za-z]/.test(text)) continue
      found.push(text)
    }
  }
  return [...new Set(found)].sort()
}

describe("the native transcript carries no raw English literal", () => {
  for (const file of FILES) {
    test(`${file}: every literal the scanner sees is a key, or pinned in KNOWN`, () => {
      const source = fs.readFileSync(path.join(import.meta.dir, file), "utf8")
      const stray = literalsIn(source).filter((text) => !KNOWN[file]!.includes(text))
      expect(stray).toEqual([])
    })
    test(`${file}: KNOWN has no stale entry`, () => {
      const source = fs.readFileSync(path.join(import.meta.dir, file), "utf8")
      const present = new Set(literalsIn(source))
      expect(KNOWN[file]!.filter((text) => !present.has(text))).toEqual([])
    })
  }

  test("NEGATIVE CONTROL: the scanner sees the shapes it was built for", () => {
    const fixture = [
      `<span data-slot="x">Done</span>`,
      `<button aria-label="Copy message">{i18n.t("ui.message.copy")}</button>`,
      `return { title: "Read", subtitle: filePathOf(input) }`,
      `const working = () => labels?.working ?? "Working…"`,
      `{n} {n === 1 ? "step" : "steps"}`,
      'title: who ? `Messaged ${who}` : t("x")',
      `cursor: idle() ? "pointer" : "default"`,
      `// a comment that says "Done" and title: "Prose" must not count`,
      `<span>{i18n.t("ui.transcript.done")}</span>`,
    ].join("\n")
    expect(literalsIn(fixture)).toEqual(["Copy message", "Done", "Messaged ${who}", "Read", "Working…", "step"])
  })

  test("assignment nudges use the folded automated-nudge renderer", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "native-transcript.tsx"), "utf8")
    // Pin the branch and text conversion; formatting and unrelated JSX props are not behavior.
    const folded =
      /if\s*\(isSteerText\(message\.text\)\)\s*return\s+<SteerMessage\s+text=\{stripSteerProvenance\(message\.text\)\}/
    expect(source).toMatch(folded)
    expect(
      "if (isSteerText(message.text)) return <NoticeMessage text={stripSteerProvenance(message.text)} />",
    ).not.toMatch(folded)
    expect("if (isSteerText(message.text)) return <SteerMessage text={message.text} />").not.toMatch(folded)
  })
})
