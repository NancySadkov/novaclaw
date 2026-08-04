import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **Every source file in this repository is plain, visible text** — and this is the check that makes
 * that sentence true rather than aspirational.
 *
 * ⚠️ The incident (v0.2.0 PREP, Wave 1 / U6). The composite-map-key idiom `${a}\x00${b}` was written
 * three times with the ESCAPE REPLACED BY THE CHARACTER — a raw U+0000 byte sitting in the source.
 * Nothing fails: the code is correct, it compiles, and its own tests pass. What breaks is every tool
 * that reads the file AS TEXT:
 *
 *   · **ripgrep classifies a file containing NUL as BINARY and skips it.** `Grep` is the first
 *     instrument every agent reaches for, and it answers "no match" for a file it never opened. One
 *     byte makes a whole module invisible to search — including to the other static guards in this
 *     directory, every one of which is a text scan.
 *   · **`git diff` prints `Bin 9566 -> 9817 bytes`.** The file's changes cannot be read at all — and
 *     the owner does not review diffs (AGENTS.md), so review is exactly the layer silently removed.
 *
 * Both failures are silent, and both read as "clean".
 *
 * The three carriers were `core/src/tool/kb.ts` — whose NUL sat inside `raw.includes("\x00")`, so the
 * BINARY-FILE DETECTOR was itself a binary file — `llm/src/protocols/utils/tool-recovery.ts`, and
 * `app/src/constants/links.test.ts`. The last is why this guard is repo-wide instead of one more
 * local one: its five NULs were written by THIS project two rounds ago, while a guard that already
 * checked for NUL was green. `test/steer-provenance.test.ts` has had that check since the same idiom
 * broke `runner/extract.ts` and `runner/doom-loop.ts` — but scoped to `src/session/**`, with a walk
 * that skips `*.test.ts`. The narrow guard did not generalise; the mistake simply moved to a package
 * and a file shape it could not see. That is the argument for a repo-wide sweep that includes tests.
 *
 * ⚠️ And the class is bigger than NUL: **a character that looks correct and defeats search.** A
 * fourth carrier proved it — `core/src/messenger/pace.ts` documented its `perCall` parameter with a
 * Cyrillic U+0421 standing in for the ASCII `C`, so the one line explaining that parameter never came
 * back when you searched for it. Nothing failed there either; a homoglyph in prose costs you the
 * documentation rather than the behaviour, which is precisely why it survives.
 *
 * ── why the classes below are NUMBERS ───────────────────────────────────────────────────────────
 *
 * Because writing this guard is itself a way to catch the disease. The first draft of this file
 * expressed its classes as regex literals — `/[\x00]/`, a Cyrillic range — and the raw characters
 * were emitted instead of the escapes, so the sweep's first run reported the sweep: one NUL, seven
 * C0 controls, thirteen invisible format characters and a mixed-script word, all of them in THIS
 * file. Every class is therefore defined as a **code-point predicate over a number**, which needs no
 * character and no escape to be typed at all. The hazard is removed by construction rather than by
 * care, and `this guard is subject to itself` below keeps it that way.
 *
 * ── the scope, and why it is drawn here ─────────────────────────────────────────────────────────
 *
 * A guard that cries wolf gets disabled, so each class is one this tree can actually keep, and the
 * boundaries were measured (2026-07-28, 2505 files in scope) rather than guessed:
 *
 *   **Covered.** NUL · the other C0 controls and DEL · invisible format characters (zero-width, soft
 *   hyphen, BOM, the bidi overrides behind "Trojan Source") · a WORD mixing ASCII letters with
 *   Cyrillic or Greek ones.
 *
 *   **Deliberately NOT covered — non-ASCII text that is simply text.** A word written entirely in
 *   another script is legitimate and common here: nineteen `i18n/*.ts` locale bundles carry Cyrillic,
 *   Arabic, Thai and CJK, and `src/kernel/eevdf.test.ts` deliberately names a variable in Cyrillic.
 *   Flagging non-ASCII letters as such would fire on 32 files on day one and be switched off by the
 *   end of the week. Only MIXED-SCRIPT words are reported, because a single Cyrillic letter inside an
 *   otherwise-ASCII word is not language — it is a typo or a lookalike, and it is unsearchable. That
 *   distinction is what makes the rule keepable: measured over the same 2505 files it produced
 *   exactly one hit, `perCall`, with zero false positives.
 *
 *   **Also not covered:** emoji, box drawing, and typographic punctuation (— · → …), which this
 *   repository's comments use everywhere and which are perfectly visible; and tab/LF/CR.
 *
 *   **Binary assets are excluded BY EXTENSION, not by directory.** A whole-tree byte scan finds NUL
 *   in ~370 files, and every one that is not a source file is a genuine asset — audio, fonts, icons,
 *   share images, the `sqlite-vec` native libraries. An extension allowlist excludes them
 *   structurally: a new asset folder cannot reopen the hole the way a `packages/ui/src/assets`-shaped
 *   denylist entry could. `the sweep` below asserts both halves — the assets are absent, AND the
 *   sweep still reaches into the package that holds them.
 *
 * The scan is deliberately STATIC — read the sources with `node:fs`, boot nothing, import nothing
 * from the app graph — so it stays hermetic and runs airgapped.
 */

/** The app repo root: `packages/core/test` → `packages/core` → `packages` → repo. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

/** Everything that ships or builds. `packages/**` is the product; `script/**` is the build tooling. */
const SCAN_ROOTS = ["packages", "script"] as const

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "gen", // generated SDK client — never hand-edited (AGENTS.md → Known pitfalls #7)
  ".git",
  ".claude", // agent worktrees: copies of this tree, not this tree
  ".turbo",
  ".vite",
  "playwright-report",
  "test-results",
])

/**
 * Hand-authored text. This allowlist — not a directory denylist — is what keeps the ~370 binary
 * assets out. `.svg`/`.webmanifest` are text but are exported or generated artifacts, not logic.
 */
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".css",
  ".html",
  ".sql",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
])

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  readonly text: string
}

function collect(dir: string, out: Source[]): Source[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf(".")
    if (dot <= 0 || !EXTENSIONS.has(entry.name.slice(dot))) continue
    out.push({ name: path.relative(ROOT, full).replaceAll("\\", "/"), text: fs.readFileSync(full, "utf8") })
  }
  return out
}

const sources = SCAN_ROOTS.reduce<Source[]>((acc, root) => collect(path.join(ROOT, root), acc), [])

// ── the character classes, as code-point predicates ─────────────────────────────────────────────
// Numbers only. Nothing here requires an invisible character — or its escape — to be typed.

const TAB = 0x09
const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d
const BACKSLASH = 0x5c

/** U+0000. Its own class: the only one with no legitimate spelling in a text file at all. */
const isNul = (cp: number) => cp === 0x0000

/** The remaining C0 controls plus DEL. Tab, LF and CR are ordinary whitespace and are excluded. */
const isC0Control = (cp: number) =>
  ((cp > 0x0000 && cp <= 0x001f) || cp === 0x007f) && cp !== TAB && cp !== LINE_FEED && cp !== CARRIAGE_RETURN

/**
 * Characters that occupy no visible space: the soft hyphen, the Mongolian vowel separator, the
 * zero-width space/joiners and directional marks, the LINE/PARAGRAPH separators, the bidi
 * embeddings and OVERRIDES (the "Trojan Source" family — source that reads one way and compiles
 * another), the word joiner and invisible operators, the isolates, and the BOM.
 */
const isInvisibleFormat = (cp: number) =>
  cp === 0x00ad ||
  cp === 0x180e ||
  (cp >= 0x200b && cp <= 0x200f) ||
  cp === 0x2028 ||
  cp === 0x2029 ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff

/** Greek and Cyrillic — the two blocks whose letters have ASCII lookalikes on a normal keyboard. */
const isConfusableLetter = (cp: number) => (cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x0400 && cp <= 0x04ff)

const isAsciiLetter = (cp: number) => (cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a) /* A-Z a-z */

/** What can sit inside one identifier-shaped word: `A-Z a-z 0-9 _ $` plus the confusable letters. */
const isWordCharacter = (cp: number) =>
  isAsciiLetter(cp) ||
  (cp >= 0x0030 && cp <= 0x0039) /* 0-9 */ ||
  cp === 0x005f /* _ */ ||
  cp === 0x0024 /* $ */ ||
  isConfusableLetter(cp)

const NUL_CLASS = "a raw NUL"
const C0_CLASS = "a C0 control"
const INVISIBLE_CLASS = "an invisible format character"
const MIXED_SCRIPT_CLASS = "a mixed-script word"
const CLASS_NAMES = new Set([NUL_CLASS, C0_CLASS, INVISIBLE_CLASS, MIXED_SCRIPT_CLASS])

const codePointName = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`

/**
 * One pass over the text. Returns `class: details` for each class the text trips, so a failure says
 * both what the character is and where to look.
 *
 * ⚠️ A backslash escape does not join the word that follows it. Without that rule the Russian and
 * Ukrainian desktop locales report a mixed-script word, because a `\n` escape abuts a Cyrillic run
 * and the `n` reads as part of it — the only two false positives measured over the whole tree, and
 * both files are spelled correctly. The escaped character is still CLASSIFIED; it is only excluded
 * from word building, so a backslash can never be used to smuggle an invisible character past this.
 */
function findingsIn(text: string): string[] {
  const perClass = new Map<string, Map<number, { count: number; first: number }>>()
  const mixedWords: string[] = []
  let line = 1
  let afterBackslash = false
  let wordStart = -1
  let wordLine = 1
  let wordHasAscii = false
  let wordHasConfusable = false

  const note = (what: string, cp: number) => {
    let points = perClass.get(what)
    if (points === undefined) {
      points = new Map()
      perClass.set(what, points)
    }
    const seen = points.get(cp)
    if (seen === undefined) points.set(cp, { count: 1, first: line })
    else seen.count++
  }

  const closeWord = (end: number) => {
    if (wordStart !== -1 && wordHasAscii && wordHasConfusable)
      mixedWords.push(`${JSON.stringify(text.slice(wordStart, end))} (line ${wordLine})`)
    wordStart = -1
    wordHasAscii = false
    wordHasConfusable = false
  }

  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i)

    if (isNul(cp)) note(NUL_CLASS, cp)
    else if (isC0Control(cp)) note(C0_CLASS, cp)
    else if (isInvisibleFormat(cp)) note(INVISIBLE_CLASS, cp)

    if (!afterBackslash && isWordCharacter(cp)) {
      if (wordStart === -1) {
        wordStart = i
        wordLine = line
      }
      if (isAsciiLetter(cp)) wordHasAscii = true
      if (isConfusableLetter(cp)) wordHasConfusable = true
    } else closeWord(i)

    afterBackslash = cp === BACKSLASH
    if (cp === LINE_FEED) line++
  }
  closeWord(text.length)

  const out: string[] = []
  for (const what of [NUL_CLASS, C0_CLASS, INVISIBLE_CLASS]) {
    const points = perClass.get(what)
    if (points === undefined) continue
    out.push(
      `${what}: ${[...points]
        .map(([cp, { count, first }]) => `${codePointName(cp)} x${count} (first at line ${first})`)
        .join(", ")}`,
    )
  }
  if (mixedWords.length > 0) out.push(`${MIXED_SCRIPT_CLASS}: ${mixedWords.join(", ")}`)
  return out
}

const classesOf = (text: string) => findingsIn(text).map((line) => line.slice(0, line.indexOf(":")))

/**
 * ─── the ledger ─────────────────────────────────────────────────────────────────────────────────
 *
 * Files allowed to carry a listed class, and WHY. A RATCHET in both directions: an unlisted file
 * fails outright, and a listed file that has stopped carrying the class fails until its row is
 * deleted — so the list can only shrink.
 *
 * ⚠️ `a raw NUL` may NEVER be ledgered. There is no correct reason for one in a text source, and a
 * row sanctioning it would re-hide that file from ripgrep and from `git diff` — the whole incident.
 * `no ledger row sanctions a raw NUL` below enforces that structurally rather than by etiquette.
 *
 * Every row is a real invisible character that SHOULD become an escape. All four are outside U6's
 * file ownership (three sibling agents were editing this tree concurrently), so they are ledgered
 * and FILED rather than silently touched. Each is a two-character edit for whoever owns the file.
 */
const LEDGER = new Map<string, { readonly classes: ReadonlyArray<string>; readonly reason: string }>([
  [
    "packages/core/src/messenger/driver/irc.ts",
    {
      classes: [C0_CLASS],
      reason:
        "PENDING (U6, filed): line 89 explains the CTCP delimiter in a COMMENT — `// CTCP (\\x01 " +
        "VERSION/ACTION/…)` — with a raw U+0001 in place of the escape. The code beside it is correct and " +
        "numeric (`charCodeAt(0) === 1`), so only the comment is affected: the one line documenting CTCP " +
        "cannot be found by searching for it. Fix: write `\\x01` in the prose.",
    },
  ],
  [
    "packages/core/test/messenger-irc.test.ts",
    {
      classes: [C0_CLASS],
      reason:
        "PENDING (U6, filed): line 99 builds a CTCP fixture with the two U+0001 delimiter bytes written " +
        "raw inside a string literal. The BYTES are genuinely required — CTCP frames its payload with " +
        "them — but the escaped spelling is the identical value and is readable. Fix: escape both.",
    },
  ],
  [
    "packages/core/src/recipe.ts",
    {
      classes: [INVISIBLE_CLASS],
      reason:
        "PENDING (U6, filed): line 85 strips a leading byte-order mark with a raw U+FEFF inside the regex " +
        'literal — `markdown.replace(/^<BOM>/, "")`. The intent is right and the regex works; it simply ' +
        "cannot be read, reviewed or searched for. Fix: spell the BOM as an escape in the character class.",
    },
  ],
  [
    "packages/core/src/recipe.test.ts",
    {
      classes: [INVISIBLE_CLASS],
      reason:
        "PENDING (U6, filed): line 41 is the fixture for the above — a raw U+FEFF opening a template " +
        "literal, so the input that is supposed to CARRY a BOM looks identical to one that does not, and " +
        "the test cannot be read. Fix: spell it as an escape in the literal.",
    },
  ],
])

/** The files this incident was written for. Each must stay clean AND keep the escape it gained. */
const REPAIRED: ReadonlyArray<readonly [string, string]> = [
  // The separator must survive AS AN ESCAPE. Deleting it would pass the sweep while silently
  // reintroducing the key collision the NUL was there to prevent: `${a}${b}` collides, `${a}\x00${b}`
  // does not. This is the other direction of the ratchet.
  ["packages/core/src/tool/kb.ts", "\\x00"],
  ["packages/llm/src/protocols/utils/tool-recovery.ts", "\\x00"],
  ["packages/app/src/constants/links.test.ts", "\\x00"],
  // The homoglyph carrier: the docstring must name the parameter the signature actually declares.
  ["packages/core/src/messenger/pace.ts", "perCall"],
]

// ── the sweep ───────────────────────────────────────────────────────────────────────────────────

describe("the sweep", () => {
  test("actually has the repository to look at", () => {
    // A mistyped root, a moved test file or a bad SKIP_DIRS entry would silently empty the sweep and
    // turn every assertion below into a tautology. Measured 2026-07-28: 2505 files.
    expect(sources.length).toBeGreaterThan(2_000)
  })

  test("crosses every package boundary, and includes test files", () => {
    // The narrow guard this one generalises missed `app/src/constants/links.test.ts` on BOTH counts:
    // another package, and a `*.test.ts`. Name the shapes so neither can be lost again.
    const names = new Set(sources.map((file) => file.name))
    for (const name of [
      "packages/core/src/tool/kb.ts",
      "packages/llm/src/protocols/utils/tool-recovery.ts",
      "packages/app/src/constants/links.test.ts",
      "packages/core/src/messenger/pace.ts",
      "packages/core/test/steer-provenance.test.ts",
      "packages/protocol/test/context-key-uniqueness.test.ts",
      "script/test.ts",
    ])
      expect(names, `${name} is not in the sweep`).toContain(name)
    expect(sources.filter((file) => file.name.endsWith(".test.ts")).length).toBeGreaterThan(100)
    expect(new Set(sources.map((file) => file.name.split("/")[1])).size).toBeGreaterThan(5)
  })

  test("excludes binary assets by extension, without failing to reach the package holding them", () => {
    // Both halves matter. If the sweep simply never descended into `packages/ui`, the assets would be
    // absent for the wrong reason and the exclusion would be untested luck.
    const assets = path.join(ROOT, "packages", "ui", "src", "assets")
    expect(fs.existsSync(assets), "packages/ui/src/assets moved — re-check this exclusion").toBe(true)
    expect(fs.readdirSync(assets, { recursive: true }).length).toBeGreaterThan(500)
    expect(sources.filter((file) => file.name.startsWith("packages/ui/src/assets/"))).toEqual([])
    expect(sources.filter((file) => file.name.startsWith("packages/ui/src/")).length).toBeGreaterThan(50)
  })

  test("this guard is subject to itself", () => {
    // The first draft of this file failed exactly here, and that is the point of the assertion: the
    // classes are numeric so that writing the guard cannot author the thing it hunts.
    const self = sources.find((file) => file.name === "packages/core/test/invisible-characters.test.ts")
    expect(self, "this test file is not in its own sweep").toBeDefined()
    expect(findingsIn(self!.text)).toEqual([])
  })
})

// ── the invariant ───────────────────────────────────────────────────────────────────────────────

describe("source files stay visible to the tools that read them", () => {
  test("no unledgered file carries an invisible or confusable character", () => {
    const offenders = sources
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = findingsIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join("; ")}`]
      })
      .sort()
    // Write the ESCAPE, never the character — the escape is the identical value and is readable. For
    // a mixed-script word, one letter is from the wrong alphabet: retype the word in ASCII. If a raw
    // character is genuinely unavoidable, add a LEDGER row above WITH ITS REASON — except a NUL,
    // which is never sanctionable, because it removes the file from ripgrep and `git diff` entirely.
    expect(offenders).toEqual([])
  })

  test("the ledger can only SHRINK — a fixed or vanished entry must be deleted from it", () => {
    const stale: string[] = []
    for (const [name, entry] of LEDGER) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        stale.push(`${name} (no longer in the sweep — drop the ledger row)`)
        continue
      }
      const found = new Set(classesOf(file.text))
      for (const cls of entry.classes)
        if (!found.has(cls)) stale.push(`${name} (no longer carries ${cls} — drop it from the ledger row)`)
    }
    expect(stale).toEqual([])
  })

  test("no ledger row sanctions a raw NUL, and every row names a real class", () => {
    // Structural, not a matter of care: the class that started this cannot be waived by someone later
    // deciding their case is special, and a typo'd class name cannot silently waive nothing at all.
    const bad = [...LEDGER].flatMap(([name, entry]) =>
      entry.classes.filter((cls) => cls === NUL_CLASS || !CLASS_NAMES.has(cls)).map((cls) => `${name} → ${cls}`),
    )
    expect(bad).toEqual([])
  })

  test("every ledger row carries a reason someone can act on", () => {
    for (const [name, entry] of LEDGER) expect(entry.reason.length, name).toBeGreaterThan(80)
  })

  test("the repaired files stayed repaired", () => {
    const regressed: string[] = []
    for (const [name, expected] of REPAIRED) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) regressed.push(`${name} (missing from the sweep)`)
      else if (!file.text.includes(expected)) regressed.push(`${name} (no longer contains ${expected})`)
    }
    expect(regressed).toEqual([])
  })
})

// ── negative control ────────────────────────────────────────────────────────────────────────────

describe("the guard actually bites (negative control)", () => {
  // Built from code points on purpose. Authoring these characters directly is the defect itself.
  const nul = String.fromCharCode(0x0000)
  const ctcp = String.fromCharCode(0x0001)
  const bom = String.fromCharCode(0xfeff)
  const zeroWidthSpace = String.fromCharCode(0x200b)
  const rightToLeftOverride = String.fromCharCode(0x202e)
  /** Cyrillic capital ES — indistinguishable from an ASCII "C" in every font this repo is read in. */
  const cyrillicC = String.fromCharCode(0x0421)

  test("each class matches the copy it was written for", () => {
    expect(classesOf(`const key = \`\${a}${nul}\${b}\``)).toEqual([NUL_CLASS])
    expect(classesOf(`params: ["nova", "${ctcp}VERSION${ctcp}"]`)).toEqual([C0_CLASS])
    expect(classesOf(`markdown.replace(/^${bom}/, "")`)).toEqual([INVISIBLE_CLASS])
    expect(classesOf(`const a${zeroWidthSpace}b = 1`)).toEqual([INVISIBLE_CLASS])
    expect(classesOf(`// ${rightToLeftOverride} a Trojan Source reordering`)).toEqual([INVISIBLE_CLASS])
    expect(classesOf(` * \`per${cyrillicC}all\` overrides the typing speed`)).toEqual([MIXED_SCRIPT_CLASS])
  })

  test("a failure names the character and the line", () => {
    // An empty-list assertion cannot show that a populated one is reachable, let alone legible.
    expect(findingsIn(`line one\nconst key = \`\${a}${nul}\${b}\``)).toEqual(["a raw NUL: U+0000 x1 (first at line 2)"])
    // ⚠️ The expected word must be BUILT from the code point, never typed. Written as the ASCII
    // `perCall` this assertion fails with a diff whose two sides are visually identical — which is
    // how it failed while being written, and is the whole defect restated inside its own test.
    expect(findingsIn(`\n\n * \`per${cyrillicC}all\``)).toEqual([`a mixed-script word: "per${cyrillicC}all" (line 3)`])
    // The reported word is emphatically NOT the ASCII spelling someone would search for.
    expect(findingsIn(`\n\n * \`per${cyrillicC}all\``)[0]).not.toContain("perCall")
  })

  test("it does NOT fire on the fixed spelling, on ordinary whitespace, or on visible punctuation", () => {
    // The repaired form must be silent, or every fixed file would land straight back in the ledger.
    expect(findingsIn(`const key = \`\${a}\\x00\${b}\``)).toEqual([])
    expect(findingsIn(`if (raw.includes("\\x00"))`)).toEqual([])
    expect(findingsIn("a\tb\r\nc\n")).toEqual([])
    // Typographic punctuation and emoji are visible, and this repo's comments are made of them.
    expect(findingsIn("// ⚠️ the sweep — one hand · → … ─────")).toEqual([])
  })

  test("it does NOT fire on legitimate non-ASCII text, which is why the rule is keepable", () => {
    // Whole words in another script: nineteen locale bundles, and one deliberate Cyrillic identifier
    // in src/kernel/eevdf.test.ts. Were any of these reported, the guard would be off within a week.
    expect(findingsIn(`const счёт: Record<string, number> = { heavy: 0 }`)).toEqual([])
    expect(findingsIn(`"language.ru": "Русский", "language.uk": "Українська",`)).toEqual([])
    expect(findingsIn(`"محطة طرفية {{number}}", "ターミナル {{number}}", "ไทย"`)).toEqual([])
  })

  test("a backslash escape does not fuse with the script that follows it", () => {
    // The measured false positive, and the reason for the `afterBackslash` rule: in the ru/uk desktop
    // locales a `\n` escape abuts a Cyrillic run, and a naive tokenizer reads `n` + Cyrillic as ONE
    // mixed-script word. Built here by concatenation so the fixture cannot drift from the shape.
    const escapeN = String.fromCharCode(BACKSLASH) + "n"
    expect(findingsIn(`"restart": "Saved.${escapeN}Перезапустите приложение."`)).toEqual([])
    // …but the escape must not become a way to hide a character: the escaped char is still CLASSIFIED.
    expect(classesOf(`"x" + ${String.fromCharCode(BACKSLASH)}${zeroWidthSpace}`)).toEqual([INVISIBLE_CLASS])
  })

  test("an unledgered offender is what the sweep reports", () => {
    // The offender predicate itself, exercised on a synthetic file — the real sweep asserts an EMPTY
    // list, which alone cannot show a non-empty one is reachable.
    const synthetic: Source = { name: "packages/somewhere/rogue.ts", text: `const k = \`\${a}${nul}\${b}\`` }
    const offenders = [synthetic]
      .filter((file) => !LEDGER.has(file.name))
      .flatMap((file) => {
        const found = findingsIn(file.text)
        return found.length === 0 ? [] : [`${file.name} → ${found.join("; ")}`]
      })
    expect(offenders).toEqual(["packages/somewhere/rogue.ts → a raw NUL: U+0000 x1 (first at line 1)"])
  })

  test("a ledgered file is exempt only for the class its row names", () => {
    // A row is not a blanket pardon. `recipe.ts` may carry a BOM; a NUL appearing in it must still
    // fail — and `no ledger row sanctions a raw NUL` guarantees no row can ever grant that.
    const row = LEDGER.get("packages/core/src/recipe.ts")
    expect(row?.classes).toEqual([INVISIBLE_CLASS])
    expect(row?.classes).not.toContain(NUL_CLASS)
  })
})
