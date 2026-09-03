import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import fs from "node:fs"
import path from "node:path"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"
import { authorBody as skillsAuthorBody, authorText as skillsAuthorText } from "./skills"
import {
  authorBody,
  authorText,
  COLLECTIONS,
  containsInvisible,
  describeDeclared,
  describeExport,
  describeNeeds,
  describeVerdict,
  displayName,
  exportFilename,
  filterViews,
  groupViews,
  previewImport,
  REPRODUCIBILITY,
  sortViews,
  toView,
  type RecipeInfo,
  type SourceInfo,
  type Verdict,
  type VerifyResultInfo,
} from "./recipes"

// The Recipes app's presentation logic, over every state the page can be in.
//
// ⚠️ Every hostile character below is written as an ESCAPE. Typing the literal into a source file is how
// a zero-width character ends up in the bundle and in every grep over the tree.
const RLO = "\u202E" // right-to-left override — makes what follows render reversed
const ZWSP = "\u200B"
const BOM = "\uFEFF"

const recipe = (over: Partial<RecipeInfo> = {}): RecipeInfo => ({
  slug: "hello-c",
  name: "Hello, C",
  description: "Compiles and runs a C99 program.",
  prompt: "Write, compile and run a C99 program.",
  assets: [],
  builtin: true,
  updatedAt: 1,
  ...over,
})

const source = (over: Partial<SourceInfo> = {}): SourceInfo => ({
  slug: "hello-c",
  name: "Hello, C",
  markdown: "---\nname: Hello, C\n---\n\nWrite it.\n",
  needs: [],
  produces: [],
  collection: { id: "examples", title: "Examples", note: "note" },
  ...over,
})

const receipt = (over: Partial<VerifyResultInfo> = {}): VerifyResultInfo => ({
  slug: "hello-c",
  name: "Hello, C",
  directory: "/tmp/work",
  verdict: "working",
  checks: [],
  summary: "a sentence from the harness",
  at: 5,
  ...over,
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the shelves are the ENGINE's shelves", () => {
  // `@novaclaw/core/recipe-builtin` cannot be imported by the app bundle (it reaches `node:fs`), so the
  // vocabulary is restated in `apps/recipes.ts`. This is the ratchet that keeps the restatement true —
  // the same shape `skills.ts` uses for `wildcardMatch` against core's own.
  test("COLLECTIONS equals RecipeBuiltin.COLLECTIONS, id for id and word for word", () => {
    expect(COLLECTIONS).toEqual(RecipeBuiltin.COLLECTIONS as unknown as typeof COLLECTIONS)
    expect(COLLECTIONS.length).toBeGreaterThan(1)
  })

  test("a shipped recipe is on Examples and a user's own is on My recipes", () => {
    const views = [toView(recipe()), toView(recipe({ slug: "mine", name: "Mine", builtin: false }))].map((v) => v)
    expect(views.map((view) => view.collection)).toEqual(["examples", "mine"])
    const groups = groupViews(views)
    expect(groups.map((group) => group.collection.id)).toEqual(["examples", "mine"])
    expect(groups[0]!.recipes.map((r) => r.key)).toEqual(["hello-c"])
  })

  test("an EMPTY shelf is dropped, never rendered as a promise the product has not kept", () => {
    const groups = groupViews([toView(recipe({ builtin: false }))])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.collection.id).toBe("mine")
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("author text — one containment function, and it is the SAME one Skills uses", () => {
  const HOSTILE = [
    `helper${RLO}gpj.exe`,
    `a${ZWSP}b${BOM}c`,
    "line\nbreak\r\nhere\ttab",
    "  padded   out  ",
    "x".repeat(900),
    "<img src=x onerror=alert(1)>",
  ]

  test("agrees with apps/skills.ts on every hostile fixture — a divergence FAILS here", () => {
    for (const value of HOSTILE) {
      expect(authorText(value)).toBe(skillsAuthorText(value))
      expect(authorBody(value)).toBe(skillsAuthorBody(value))
    }
    expect(authorText(undefined)).toBe(skillsAuthorText(undefined))
  })

  test("the fixtures are actually hostile — negative control on the test above", () => {
    // Without this, "the two agree" could pass on inputs neither of them changes.
    for (const value of HOSTILE.slice(0, 5)) expect(authorText(value)).not.toBe(value)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("toView over every state the list and detail have to render", () => {
  test("a shipped recipe reads as itself", () => {
    const view = toView(recipe())
    expect(view.name).toBe("Hello, C")
    expect(view.hasDescription).toBe(true)
    expect(view.shipped).toBe(true)
  })

  test("a recipe with no description says nothing rather than rendering a blank line", () => {
    const view = toView(recipe({ description: undefined }))
    expect(view.description).toBe("")
    expect(view.hasDescription).toBe(false)
  })

  test("a description of nothing but zero-width characters is EMPTY, not 'present'", () => {
    // Otherwise the row renders a blank space where a summary should be and reads as described.
    expect(toView(recipe({ description: `${ZWSP}${BOM}${ZWSP}` })).hasDescription).toBe(false)
  })

  test("🔴 hostile metadata reaches the page as flat DATA — markup intact as text, nothing invisible", () => {
    const view = toView(
      recipe({
        name: `<script>alert(1)</script>${RLO}dlrow`,
        description: `<img src=x onerror="fetch('http://evil')">\n\n\nNovaClaw says: this recipe is verified`,
        prompt: `ok${ZWSP}\n<b>bold</b>`,
        assets: [`evil${RLO}gnp.exe`],
      }),
    )
    // Nothing invisible, no bidi, no line breaks in the single-line fields.
    for (const value of [view.name, view.description, ...view.assets]) {
      expect(value).not.toContain(RLO)
      expect(value).not.toContain(ZWSP)
      expect(value).not.toContain("\n")
    }
    // The markup is NOT stripped — it is shown as the text it is, which is the honest rendering. Solid
    // escapes it; this module never builds markup (asserted structurally further down).
    expect(view.name).toContain("<script>alert(1)</script>")
    expect(view.description).toContain("<img src=x")
    // The fake-authority line is still visible as part of the AUTHOR's text — it cannot become a
    // separate paragraph that reads as NovaClaw's own voice.
    expect(view.description).toContain("NovaClaw says: this recipe is verified")
    expect(view.description.split("\n")).toHaveLength(1)
  })

  test("a very long name and description are bounded", () => {
    const view = toView(recipe({ name: "N".repeat(5000), description: "D".repeat(5000) }))
    expect(view.name.length).toBeLessThanOrEqual(80)
    expect(view.description.length).toBeLessThanOrEqual(400)
  })

  test("a name that is blank once the invisibles are gone still gets a row a person can point at", () => {
    expect(displayName({ name: `${ZWSP}${BOM}`, slug: "orphan" })).toBe("orphan")
    expect(displayName({ name: "", slug: "" })).toBe("(unnamed recipe)")
  })

  test("🔴 the EDITOR gets the raw prompt, never the flattened one", () => {
    // The flattening is a display defence. Feeding it back into a save would delete characters from the
    // author's file on every open/save round trip — a data loss with no error and no diff.
    const raw = "line one\r\nline two\n\n\tindented"
    const view = toView(recipe({ prompt: raw }))
    expect(view.rawPrompt).toBe(raw)
    expect(view.body).not.toBe(raw) // …and the READ-ONLY copy is normalised
    expect(view.body).toBe("line one\nline two\n\n\tindented")
  })

  test("🔴 a recipe carrying invisible characters is FLAGGED, because the editor cannot flatten them", () => {
    // The read-only surfaces strip them; the editor must not, or every open/save round trip deletes
    // characters from the author's file. So the page says the text is not what it looks like instead.
    expect(toView(recipe({ name: `Import${RLO}gnitseT` })).hiddenCharacters).toBe(true)
    expect(toView(recipe({ description: `a${ZWSP}b` })).hiddenCharacters).toBe(true)
    expect(toView(recipe({ prompt: `do${BOM} it` })).hiddenCharacters).toBe(true)
    expect(toView(recipe()).hiddenCharacters).toBe(false)
    // …and it does not fire on ordinary non-ASCII prose, which would make the warning noise.
    expect(toView(recipe({ name: "Café — 100 digits of π" })).hiddenCharacters).toBe(false)
  })

  test("containsInvisible has no sticky lastIndex — the same string answers the same twice", () => {
    // A `g` regex carries `lastIndex` across `.test` calls, so a flag built on one would alternate.
    for (let index = 0; index < 4; index++) expect(containsInvisible(`a${ZWSP}b`)).toBe(true)
  })

  test("search and sort work on the words a person can actually see", () => {
    const views = sortViews([
      toView(recipe({ slug: "b", name: "Zebra" })),
      toView(recipe({ slug: "a", name: "Apple" })),
    ])
    expect(views.map((view) => view.name)).toEqual(["Apple", "Zebra"])
    expect(filterViews(views, "zeb").map((view) => view.name)).toEqual(["Zebra"])
    expect(filterViews(views, "")).toHaveLength(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the reproducibility trade is TAUGHT, in one readable sentence", () => {
  test("the headline says a run may differ AND still be right — both halves", () => {
    expect(REPRODUCIBILITY.headline).toContain("different")
    expect(REPRODUCIBILITY.headline).toMatch(/working|works/i)
  })

  test("the price names who should NOT rely on a recipe", () => {
    // AGENTS.md: "anything needing bit-exactness, a signature, or an audited artifact still wants real
    // source". A product that only lists what its idea is good for has not been honest about it.
    expect(REPRODUCIBILITY.price).toMatch(/signed|audited|checksum/i)
    expect(REPRODUCIBILITY.price).toMatch(/real source|source too/i)
  })

  test("the gain is the durability claim, in words a non-expert can hold", () => {
    expect(REPRODUCIBILITY.gain).toMatch(/again|fresh|scratch/i)
    // No jargon that only a programmer could parse.
    for (const jargon of ["ABI", "toolchain", "deterministic", "idempotent", "bit-exact"])
      expect(`${REPRODUCIBILITY.headline} ${REPRODUCIBILITY.gain} ${REPRODUCIBILITY.price}`).not.toContain(jargon)
  })

  test("running one never changes it, and the copy says so", () => {
    expect(REPRODUCIBILITY.reassurance).toMatch(/never changes it/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("what this machine has — three answers, and two of them are not 'no'", () => {
  test("a recipe whose file we could not read says SO, and blames nothing", () => {
    const view = describeNeeds(undefined)
    expect(view.state).toBe("unreadable")
    expect(view.sentence).toMatch(/could not read/i)
    expect(view.blocksRun).toBe(false)
    // ⚠️ It must not turn into a claim about the machine.
    expect(view.sentence).not.toMatch(/did not find|missing/i)
  })

  test("a recipe that declares nothing says nothing is required", () => {
    const view = describeNeeds(source())
    expect(view.state).toBe("none")
    expect(view.blocksRun).toBe(false)
  })

  test("a met need reads as ready", () => {
    const view = describeNeeds(
      source({ needs: [{ fact: "a C compiler", status: "present", looked: ["cc", "gcc"], found: "gcc" }] }),
    )
    expect(view.state).toBe("ready")
    expect(view.sentence).toContain("a C compiler")
    expect(view.blocksRun).toBe(false)
  })

  test("🔴 a missing need says WHERE WE LOOKED — never 'you do not have it'", () => {
    const view = describeNeeds(
      source({ needs: [{ fact: "a C compiler", status: "absent", looked: ["cc", "gcc", "clang"] }] }),
    )
    expect(view.state).toBe("missing")
    expect(view.blocksRun).toBe(true)
    expect(view.looked).toEqual(["cc", "gcc", "clang"])
    expect(view.sentence).toMatch(/did not find it where I looked/i)
    // The only claim the probe supports. "You do not have a C compiler" is false on a machine that has
    // one installed somewhere we did not look.
    expect(view.sentence).not.toMatch(/you do not have|you don't have|is not installed/i)
  })

  test("🔴 an UNCHECKABLE need never blocks a run and is never reported as missing", () => {
    const view = describeNeeds(source({ needs: [{ fact: "a Fortran compiler", status: "unknown", looked: [] }] }))
    expect(view.state).toBe("unsure")
    expect(view.blocksRun).toBe(false)
    expect(view.sentence).toMatch(/no way to check/i)
    expect(view.sentence).not.toMatch(/did not find|missing/i)
  })

  test("a missing need mentions the uncheckable one separately, and still blocks", () => {
    const view = describeNeeds(
      source({
        needs: [
          { fact: "a C compiler", status: "absent", looked: ["cc"] },
          { fact: "a quantum computer", status: "unknown", looked: [] },
        ],
      }),
    )
    expect(view.blocksRun).toBe(true)
    expect(view.sentence).toMatch(/no way to check/i)
    expect(view.sentence).toContain("a quantum computer")
  })

  test("🔴 a need whose PROBE failed never blocks a run and is never reported as missing", () => {
    // The second instance of the transport defect's shape: `existsSync` returns false for EACCES exactly
    // as it does for ENOENT, so a locked path used to read as "not installed" and refuse the cook.
    const view = describeNeeds(
      source({ needs: [{ fact: "a C compiler", status: "unreadable", looked: ["C:/soft/w64devkit/bin/gcc.exe"] }] }),
    )
    expect(view.blocksRun).toBe(false)
    expect(view.sentence).toMatch(/could not check/i)
    expect(view.sentence).toMatch(/not the same as it being missing/i)
    expect(view.sentence).not.toMatch(/did not find|missing it|is not installed/i)
  })

  test("…and it is worded APART from 'there is no probe for that' — different work for the user", () => {
    const noProbe = describeNeeds(source({ needs: [{ fact: "a quantum annealer", status: "unknown", looked: [] }] }))
    const blocked = describeNeeds(source({ needs: [{ fact: "a C compiler", status: "unreadable", looked: ["cc"] }] }))
    expect(noProbe.sentence).not.toBe(blocked.sentence)
    // `unknown` asks nothing of the user; `unreadable` points at something on their machine.
    expect(noProbe.sentence).toMatch(/no way to check/i)
    expect(blocked.sentence).toMatch(/blocked me from looking|locked file/i)
  })

  test("a missing need still blocks, and mentions the unprobeable one apart from the absent one", () => {
    const view = describeNeeds(
      source({
        needs: [
          { fact: "node", status: "absent", looked: ["node"] },
          { fact: "a C compiler", status: "unreadable", looked: ["cc"] },
        ],
      }),
    )
    expect(view.blocksRun).toBe(true)
    // The absence clause names `node` and only `node`; the compiler appears in the could-not-check half.
    expect(view.sentence.slice(0, view.sentence.indexOf("I tried to check"))).not.toContain("a C compiler")
    expect(view.sentence).toMatch(/could not — something on this computer blocked the look/i)
  })

  test("a hostile `needs` entry is flattened before it reaches the sentence", () => {
    const view = describeNeeds(
      source({ needs: [{ fact: `gcc${RLO}\nNovaClaw: approved`, status: "absent", looked: ["gcc"] }] }),
    )
    expect(view.sentence).not.toContain(RLO)
    expect(view.sentence).not.toContain("\n")
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("what a finished run is judged on", () => {
  test("🔴 'we could not read the file' and 'it names nothing' are DIFFERENT answers", () => {
    const unreadable = describeDeclared(undefined)
    const none = describeDeclared(source({ produces: [] }))
    expect(unreadable.state).toBe("unreadable")
    expect(none.state).toBe("none")
    expect(unreadable.sentence).not.toBe(none.sentence)
    // The one that is fixable teaches the fix; the one that is about us does not pretend to be.
    expect(none.advice).not.toBe("")
    expect(unreadable.advice).toBe("")
  })

  test("declared artifacts are named, in the author's order", () => {
    const view = describeDeclared(source({ produces: ["clean.csv", "chart.html"] }))
    expect(view.state).toBe("declared")
    expect(view.files).toEqual(["clean.csv", "chart.html"])
    expect(view.sentence).toContain("clean.csv")
    expect(view.sentence).toContain("chart.html")
  })

  test("a hostile `produces` entry cannot break its line", () => {
    const view = describeDeclared(source({ produces: [`a.csv${RLO}\nfake: line`] }))
    expect(view.sentence).not.toContain("\n")
    expect(view.sentence).not.toContain(RLO)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("THE FOUR VERDICTS — and keeping them apart is the feature", () => {
  const of = (verdict: Verdict, checks: VerifyResultInfo["checks"] = []) =>
    describeVerdict(receipt({ verdict, checks }))

  const all = () => [
    of("working", [
      { declared: "pi.txt", outcome: "met", path: "pi.txt", checked: "exists and is not blank", bytes: 120 },
    ]),
    of("not-working", [
      { declared: "pi.txt", outcome: "unmet", path: "pi.txt", checked: "there is nothing at that name" },
    ]),
    of("not-available", [
      { declared: "pi.txt", outcome: "unknown", reason: "not-applicable", checked: "gemma cannot call tools" },
    ]),
    of("unknown", [
      { declared: "pi.txt", outcome: "unknown", reason: "measurement-failed", checked: "I could not read that path" },
    ]),
  ]

  test("🔴 all four differ pairwise in the WORDS, not only in the colour", () => {
    const views = all()
    for (const field of ["label", "meaning", "advice", "subject"] as const) {
      const values = views.map((view) => view[field])
      expect(new Set(values).size).toBe(4)
    }
    // A colour-blind reader and a screen reader get the label and the sentence, never the tone.
    expect(new Set(views.map((view) => view.tone)).size).toBe(4)
  })

  test("🔴 exactly ONE verdict is a fault report, and it is not the model's", () => {
    const views = all()
    expect(views.filter((view) => view.isFault).map((view) => view.verdict)).toEqual(["not-working"])
  })

  test("🔴 NOT AVAILABLE never reads as a broken install — it says the opposite, in words", () => {
    const view = of("not-available")
    expect(view.subject).toBe("the model")
    expect(view.meaning).toMatch(/nothing is broken/i)
    // It may say "nothing is broken"; it may never say the run or the install FAILED.
    expect(view.meaning).not.toMatch(/failed|did not work/i)
    // …and it teaches the actual way forward, which is changing the MODEL.
    expect(view.advice).toMatch(/model/i)
  })

  test("🔴 UNKNOWN is never a pass and never a failure, and says both", () => {
    for (const view of [of("unknown"), of("unknown", [{ declared: "x", outcome: "unknown", checked: "?" }])]) {
      expect(view.isFault).toBe(false)
      expect(view.tone).toBe("unsure")
      expect(view.meaning).toMatch(/not a pass and not a failure/i)
      expect(view.meaning).not.toMatch(/\bworked\b|success/i)
    }
  })

  test("UNKNOWN with NO postcondition teaches the one-line fix; unknown-because-unmeasurable does not", () => {
    const nothingDeclared = of("unknown", [])
    const couldNotMeasure = of("unknown", [
      { declared: "x", outcome: "unknown", reason: "measurement-failed", checked: "?" },
    ])
    expect(nothingDeclared.advice).toMatch(/add the names/i)
    expect(couldNotMeasure.advice).not.toMatch(/add the names/i)
    expect(nothingDeclared.meaning).not.toBe(couldNotMeasure.meaning)
  })

  test("NOT WORKING names the promised files and points at the health check", () => {
    const view = of("not-working", [
      { declared: "pi.txt", outcome: "unmet", path: "pi.txt", checked: "there is nothing at that name" },
    ])
    expect(view.meaning).toContain("pi.txt")
    expect(view.advice).toMatch(/health check/i)
    expect(view.subject).toBe("this NovaClaw")
  })

  test("WORKING names what actually arrived", () => {
    const view = of("working", [
      { declared: "pi.txt", outcome: "met", path: "pi.txt", checked: "exists and is not blank", bytes: 2048 },
    ])
    expect(view.meaning).toContain("pi.txt")
    expect(view.isFault).toBe(false)
    expect(view.rows[0]!.size).toBe("2 KB")
  })

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 A RUN THAT NEVER REACHED THE MODEL SAYS NOTHING ABOUT THIS COMPUTER (measured 2026-08-18)
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // The exact screen the defect produced: six cooks died on a dead endpoint, the folder was empty, and
  // this function returned `label: "Did not work"` · `subject: "this NovaClaw"` · `isFault: true`. The
  // verdict arrives as `unknown` + `cookState: "blocked"` now, and these pin what a person then reads.

  const blockedView = (why = "Can't reach the model server at 192.168.178.40:8010.") =>
    describeVerdict(
      receipt({
        verdict: "unknown",
        cookState: "blocked",
        checks: [{ declared: "hello.c", outcome: "unknown", reason: "measurement-failed", checked: why }],
      }),
    )

  test("🔴 the regression: a blocked run is NOT a fault, and does not name this NovaClaw as the subject", () => {
    const view = blockedView()
    expect(view.isFault).toBe(false)
    expect(view.subject).toBe("the model")
    expect(view.label).not.toBe("Did not work")
    // Every accusing phrasing, over the WHOLE text a person reads. The reassurance is worded so that
    // not one of these words appears even in the negative — a screen reader hearing "…is broken" three
    // words after "not" is a real way for a reassurance to land as an accusation.
    const whole = `${view.label} ${view.meaning} ${view.advice}`
    expect(whole).not.toMatch(/did not work|broken|failed|fault|not working|missing/i)
  })

  test("…it names what stopped it, and teaches the way forward (principle 8)", () => {
    const view = blockedView()
    expect(view.meaning).toContain("192.168.178.40:8010")
    expect(view.meaning).toMatch(/nothing here points at a problem with this computer/i)
    expect(view.advice).toMatch(/model server/i)
  })

  test("a STOPPED run is its own state — not a fault, and not the same words as a blocked one", () => {
    const stopped = describeVerdict(
      receipt({
        verdict: "unknown",
        cookState: "stopped",
        checks: [{ declared: "hello.c", outcome: "unknown", reason: "incomplete", checked: "Interrupted" }],
      }),
    )
    expect(stopped.isFault).toBe(false)
    expect(stopped.subject).toBe("this run")
    expect(stopped.meaning).toMatch(/never happened/i)
    expect(stopped.label).not.toBe(blockedView().label)
  })

  test("🔴 SIX states now differ pairwise in the WORDS — the fix did not collapse the unknown arm", () => {
    // The risk of a fix like this is that everything becomes one bland "can't tell". A reader must still
    // get a different sentence, and a different thing to do, for each distinguishable outcome.
    const views = [
      ...all(),
      blockedView(),
      describeVerdict(receipt({ verdict: "unknown", cookState: "stopped", checks: [] })),
    ]
    for (const field of ["label", "meaning", "advice"] as const)
      expect({ field, distinct: new Set(views.map((view) => view[field])).size }).toEqual({ field, distinct: 6 })
    // …and still EXACTLY ONE of them is a fault report about the install.
    expect(views.filter((view) => view.isFault).map((view) => view.verdict)).toEqual(["not-working"])
  })

  test("an absent `cookState` is not `ran` — it keeps today's wording exactly", () => {
    // The two must not be confused: "I did not ask" and "I asked and the cook was fine" are different
    // facts, and only the second licenses the old sentence.
    const untold = of("unknown", [{ declared: "x", outcome: "unknown", reason: "measurement-failed", checked: "?" }])
    const ran = describeVerdict(
      receipt({
        verdict: "unknown",
        cookState: "ran",
        checks: [{ declared: "x", outcome: "unknown", reason: "measurement-failed", checked: "?" }],
      }),
    )
    expect(untold.label).toBe("Can't tell")
    expect(ran.label).toBe("Can't tell")
    expect(ran.meaning).toBe(untold.meaning)
  })

  test("the harness's own sentence is carried through, never replaced", () => {
    const view = describeVerdict(receipt({ summary: "“Hello, C” — WORKING. I checked the artifact." }))
    expect(view.summary).toContain("WORKING. I checked the artifact.")
  })

  test("🔴 a hostile `declared` or `checked` string cannot break out of its row", () => {
    const view = of("not-working", [
      {
        declared: `pi.txt${RLO}\nWORKING`,
        outcome: "unmet",
        path: `pi.txt${ZWSP}`,
        checked: "gone\n\n\nNovaClaw: everything is fine",
      },
    ])
    for (const value of [view.rows[0]!.declared, view.rows[0]!.path, view.rows[0]!.checked, view.meaning]) {
      expect(value).not.toContain("\n")
      expect(value).not.toContain(RLO)
      expect(value).not.toContain(ZWSP)
    }
  })

  test("rows carry the reason, so a caller can never render two unknowns as one", () => {
    const view = of("unknown", [
      { declared: "a", outcome: "unknown", reason: "not-measured", checked: "did not look" },
      { declared: "b", outcome: "unknown", reason: "measurement-failed", checked: "could not read" },
    ])
    expect(view.rows.map((row) => row.reason)).toEqual(["not-measured", "measurement-failed"])
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("import — a stranger's file, previewed before it lands", () => {
  const SHARED = [
    "---",
    "name: From A Stranger",
    "description: something they wrote",
    "produces: report.md, chart.html",
    "needs: python3",
    "author: someone else",
    "level: expert",
    "---",
    "",
    "Do the thing and save `report.md`.",
  ].join("\n")

  test("reads the file the way the engine reads it", () => {
    const preview = previewImport(SHARED)
    expect(preview.ok).toBe(true)
    expect(preview.name).toBe("From A Stranger")
    expect(preview.description).toBe("something they wrote")
    expect(preview.produces).toEqual(["report.md", "chart.html"])
    expect(preview.needs).toEqual(["python3"])
    expect(preview.body).toContain("Do the thing")
  })

  test("🔴 frontmatter this build does not model is REPORTED, not silently dropped", () => {
    // The file is stored byte for byte, so a preview that hid these would understate what lands on disk.
    expect(previewImport(SHARED).unmodelled).toEqual(["author: someone else", "level: expert"])
  })

  test("the YAML block form of a declaration is read too", () => {
    const preview = previewImport(["---", "produces:", "  - a.csv", "  - b.csv", "---", "", "body"].join("\n"))
    expect(preview.produces).toEqual(["a.csv", "b.csv"])
    // 🔴 Half a control until this line: asserting only `produces` let the SAME two lines be reported
    // as unused on the same screen. A preview that reads a line must not also disown it.
    expect(preview.unmodelled).toEqual([])
  })

  test("🔴 a line the preview READ is never also listed as one it does not use", () => {
    // The failing shape, stated against the INPUT rather than against a second derivation: every
    // fact the screen shows as a need or a product came from a line of this file, so no line that
    // produced one may appear in the sentence that names what NovaClaw ignores.
    const preview = previewImport(
      [
        "---",
        "name: Blocked at the door",
        "needs:",
        "  - gcc",
        "  - python3",
        "produces:",
        "  - out.txt",
        "author: someone else",
        "---",
        "",
        "Build the thing.",
      ].join("\n"),
    )
    expect(preview.needs).toEqual(["gcc", "python3"])
    expect(preview.produces).toEqual(["out.txt"])
    // Written as a relation, not a literal: it fails for any value that is claimed twice.
    const claimed = [...preview.needs, ...preview.produces]
    for (const fact of claimed) expect(preview.unmodelled.join(" · ")).not.toContain(fact)
    // …and the one line that genuinely is unused is still reported, so this is not green by silence.
    expect(preview.unmodelled).toEqual(["author: someone else"])
  })

  test("a block under a field this build does NOT model stays reported, item lines and all", () => {
    // The mirror of the case above: consumption is per-field, so `- alice` under `authors:` is not
    // consumed by anything and is exactly the kind of line the sentence exists to name.
    const preview = previewImport(
      ["---", "authors:", "  - alice", "  - bob", "needs: gcc", "---", "", "body"].join("\n"),
    )
    expect(preview.needs).toEqual(["gcc"])
    expect(preview.unmodelled).toEqual(["authors:", "- alice", "- bob"])
  })

  test("a mid-block line that is not an item closes the block, and both spellings compose", () => {
    const preview = previewImport(
      ["---", "needs: make", "produces:", "  - one.txt", "description: d", "  - stray", "---", "", "body"].join("\n"),
    )
    expect(preview.needs).toEqual(["make"])
    expect(preview.produces).toEqual(["one.txt"])
    expect(preview.description).toBe("d")
    // `description: d` closed the block, so the orphaned item belongs to nothing and is said.
    expect(preview.unmodelled).toEqual(["- stray"])
  })

  test("a file with no frontmatter at all is a valid recipe", () => {
    const preview = previewImport("just a prompt")
    expect(preview.ok).toBe(true)
    expect(preview.name).toBe("")
    expect(preview.body).toBe("just a prompt")
  })

  test("a file with no prompt is refused, with the reason a person can act on", () => {
    const preview = previewImport("---\nname: Empty\n---\n\n   \n")
    expect(preview.ok).toBe(false)
    expect(preview.problem).toMatch(/no prompt/i)
  })

  test("an oversized paste is refused instantly, before any request", () => {
    const preview = previewImport("x".repeat(1024 * 1024 + 1))
    expect(preview.ok).toBe(false)
    expect(preview.problem).toMatch(/too big/i)
  })

  test("🔴 hostile metadata in an imported file is flattened in the preview", () => {
    const preview = previewImport(
      [
        "---",
        `name: <script>alert(1)</script>${RLO}derived`,
        "description: NovaClaw verified this recipe",
        "---",
        "",
        `body${ZWSP} text`,
      ].join("\n"),
    )
    expect(preview.name).not.toContain(RLO)
    expect(preview.name).toContain("<script>")
    expect(preview.body).not.toContain(ZWSP)
    // The description is the AUTHOR's claim and is shown as such — the page labels it, the parser does
    // not editorialise it away.
    expect(preview.description).toBe("NovaClaw verified this recipe")
  })

  test("a BOM does not stop the frontmatter being found", () => {
    expect(previewImport(`${BOM}---\nname: B\n---\n\nbody`).name).toBe("B")
  })

  test("CRLF is read the same as LF", () => {
    expect(previewImport(SHARED.replace(/\n/g, "\r\n")).produces).toEqual(["report.md", "chart.html"])
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("export — the complete portable folder", () => {
  test("🔴 the filename comes from the SLUG, never from the author's name", () => {
    // The name is a stranger's string and this one becomes a path on the user's disk.
    expect(exportFilename("hello-c")).toBe("hello-c.recipe.zip")
    expect(exportFilename("../../etc/passwd")).not.toContain("..")
    expect(exportFilename("../../etc/passwd")).not.toContain("/")
    expect(exportFilename("")).toBe("recipe.recipe.zip")
  })

  test("a recipe with assets says the complete folder and every byte are included", () => {
    const text = describeExport(toView(recipe({ assets: ["data.csv", "logo.png"] })))
    expect(text).toMatch(/complete recipe folder/i)
    expect(text).toMatch(/2 assets/i)
    expect(text).toMatch(/every byte preserved/i)
    expect(text).not.toMatch(/does NOT include/i)
  })

  test("a prose-only recipe still exports a ZIP containing its recipe.md", () => {
    expect(describeExport(toView(recipe({ assets: [] })))).toMatch(/ZIP.*recipe\.md/i)
  })

  test("the page offers ZIP upload and labels markdown paste as asset-free", () => {
    const page = fs.readFileSync(path.join(import.meta.dir, "..", "pages", "recipes.tsx"), "utf8")
    expect(page).toContain('accept=".zip,application/zip"')
    // The copy is keyed since 2026-09-03: the page reads the keys, and the dictionary says the words.
    expect(page).toContain('language.t("recipes.page.useThisForAProseOnly")')
    expect(page).toContain('language.t("recipes.page.importPastedMarkdownNoAssets")')
    expect(en["recipes.page.useThisForAProseOnly"]).toContain("Paste carries recipe.md only — no assets")
    expect(en["recipes.page.importPastedMarkdownNoAssets"]).toBe("Import pasted markdown (no assets)")
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("the page builds no markup", () => {
  // A structural guard, not a style rule: every string on this page can be a stranger's, and Solid's
  // escaping is only a defence while nothing bypasses it. This fails the day someone reaches for
  // `innerHTML` to render a description "with formatting".
  test("🔴 recipes.tsx never assigns innerHTML or uses a dangerous prop", () => {
    const file = path.join(import.meta.dir, "..", "pages", "recipes.tsx")
    expect(fs.existsSync(file)).toBe(true)
    // ⚠️ COMMENTS STRIPPED FIRST. A regex over source counts prose, and this file's own header names
    // `innerHTML` while explaining that it never uses one — a check that matched that would fail on the
    // documentation of the rule it enforces.
    const code = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n")
    expect(code).toContain("export function RecipesPage") // the strip did not eat the file
    for (const forbidden of ["innerHTML", "outerHTML", "dangerouslySetInnerHTML", "document.write"])
      expect(code).not.toContain(forbidden)
  })
})
