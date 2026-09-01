export * as KbAbsorbEval from "./absorb-eval"

/**
 * Scoring absorption quality — an instrument, not product code.
 *
 * 🔴 **Why this exists.** My first precision scorer was a hand-listed set of stat-block field labels,
 * and it reported "99% concrete". A later run then GAINED `racial hit dice`, `grapple check` and
 * `lifting and carrying limit` — all field labels, all scored as concrete, purely because they were
 * not on my list. Fixing a scoring rule before an experiment protects against scoring-to-flatter; it
 * does nothing about COVERAGE. A hand-listed classifier measures what its author remembered.
 *
 * So the label set is DERIVED FROM THE DOCUMENT. A record-style document prints its own field labels,
 * once per record, which makes them separable from content by frequency alone: measured on the owner's
 * monster manual, every structural label (`Hit Dice`, `Challenge Rating`, `Treasure`, `Advancement`)
 * occurs 29–31 times — once per stat block — while genuine named abilities (`Breath Weapon (Su)`,
 * `Cause Avalanche (Su)`) occur once or twice.
 */

/** A colon-terminated line short enough to be a label rather than prose. */
const LABEL_LINE = /^(.{2,34}):$/

/**
 * Field labels the DOCUMENT declares, by repetition.
 *
 * ⚠️ `minOccurrences` is the whole discipline: a label repeated across records is structure, a
 * one-off is content. Set it too low and real abilities (which appear once or twice) are scored as
 * scaffolding, which would flatter a prompt that dropped them.
 */
export const deriveFieldLabels = (document: string, minOccurrences = 5): ReadonlySet<string> => {
  const counts = new Map<string, number>()
  for (const line of document.split(/\r?\n/)) {
    const match = LABEL_LINE.exec(line.trim())
    if (!match) continue
    const label = match[1]!.trim().toLowerCase()
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, n]) => n >= minOccurrences).map(([label]) => label))
}

/**
 * Ability-score names the document uses, derived from `Str 11, Dex 17` style runs.
 *
 * Derived rather than listed for the same reason as the labels: a hard-coded `Str|Dex|Con` set is a
 * d20 assumption, and this instrument should score any record-style document.
 */
export const deriveScoreNames = (document: string, minOccurrences = 5): ReadonlySet<string> => {
  const counts = new Map<string, number>()
  // ⚠️ Keyed on the RUN, not on "a capitalised word before a number". The looser pattern derived
  // `darkvision`, because `Darkvision 60 ft.` also repeats once per record — so a real ability was
  // scored as structure. An ability line is a comma-separated run of `Name Number` pairs; a lone
  // `Word 60` on its own line is not. Found by this module's own test.
  // ⚠️ The value may be SIGNED. `Fort +4, Ref +7, Will +4` is the saves run, and without the optional
  // sign the whole line was skipped — so `fort`/`ref`/`will` scored as CONCRETE. That gap made the
  // derived rule report 89% where a hand-list said 64%: two instruments, two answers, and the
  // disagreement was the only reason either got checked.
  const PAIR = "[A-Z][a-zA-Z]{1,11}[ \\t]+[+-]?\\d{1,3}"
  for (const run of document.matchAll(new RegExp(`(?:${PAIR}[ \\t]*,[ \\t]*){2,}${PAIR}`, "g"))) {
    for (const pair of run[0].matchAll(new RegExp(`(${PAIR})`, "g"))) {
      const name = pair[1]!.split(/[ \t]+/)[0]!.toLowerCase()
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return new Set([...counts].filter(([, n]) => n >= minOccurrences).map(([name]) => name))
}

/** Everything the document treats as structure rather than content. */
export const deriveScaffolding = (document: string, minOccurrences = 5): ReadonlySet<string> =>
  new Set([...deriveFieldLabels(document, minOccurrences), ...deriveScoreNames(document, minOccurrences)])

/**
 * Canonical form for VARIANT counting only — never for identity.
 *
 * ⛔ Deliberately not what `entityID` does. Putting English morphology inside an identity hash makes
 * identity depend on a heuristic, and would merge things that merely look alike. This is a ruler.
 */
export const canonical = (name: string): string => {
  let n = name.trim().toLowerCase()
  n = n.replace(/\s*\([^)]*\)\s*$/, "")
  n = n.replace(/\s+\d+(\.\d+)?\s*(ft\.?|feet|hp|lb\.?)?$/, "")
  n = n.replace(/^\[|\]$/g, "").replace(/'s$/, "")
  // ⚠️ Only after a CONSONANT. `Chaos` -> `chao` was the bug: an `ss|us|is` blocklist cannot cover
  // every vowel+s word, and a ruler that mangles real names inflates the fragmentation it measures.
  if (n.length > 4 && /[^aeiou]s$/.test(n)) n = n.slice(0, -1)
  return n.trim()
}

export interface Score {
  readonly total: number
  readonly concrete: ReadonlyArray<string>
  readonly scaffolding: ReadonlyArray<string>
  /** Ids beyond one per distinct thing — the cost of variant fragmentation. */
  readonly surplusIds: number
}

export const score = (names: ReadonlyArray<string>, scaffolding: ReadonlySet<string>): Score => {
  const isScaffolding = (name: string) => scaffolding.has(canonical(name)) || scaffolding.has(name.trim().toLowerCase())
  const distinct = new Set(names.map(canonical))
  return {
    total: names.length,
    concrete: names.filter((name) => !isScaffolding(name)),
    scaffolding: names.filter(isScaffolding),
    surplusIds: names.length - distinct.size,
  }
}
