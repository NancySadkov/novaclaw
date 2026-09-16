import { describe, expect, test } from "bun:test"
import { SkillInvocation } from "./invocation"
import { Wildcard } from "../util/wildcard"

// The two switches are INDEPENDENT, so every test below moves exactly one of them and pins the
// other. A tri-state would pass a test that only ever walks the diagonal; these walk all four
// corners on purpose.
//
// ⚠️ Hostile fixtures are the same set `packages/app/src/apps/skills.test.ts` uses (markup, a bidi
// override, a very long name), because the two surfaces read the same attacker-controlled string
// and a defence that lives in only one of them is not a defence.

// Written as escapes; authoring the literal characters would put them in every grep over this file.
const RTL_OVERRIDE = "\u202E"
const ZERO_WIDTH = "\u200B"

describe("identify — the stable ID is the name, verbatim, or nothing", () => {
  test("an ordinary name is its own ID", () => {
    expect(SkillInvocation.identify("pdf")).toEqual({ ok: true, id: "pdf" })
    expect(SkillInvocation.identify("Deep Research v2")).toEqual({ ok: true, id: "Deep Research v2" })
  })

  test("case is PRESERVED — folding would let one skill inherit another's saved choice", () => {
    expect(SkillInvocation.idOf("Writer")).toBe("Writer")
    expect(SkillInvocation.idOf("writer")).toBe("writer")
    expect(SkillInvocation.idOf("Writer")).not.toBe(SkillInvocation.idOf("writer"))
  })

  test("a bidi override or a zero-width character makes a name unaddressable", () => {
    expect(SkillInvocation.identify(`safe${RTL_OVERRIDE}gnp.exe`)).toEqual({ ok: false, reason: "invisible" })
    expect(SkillInvocation.identify(`pd${ZERO_WIDTH}f`)).toEqual({ ok: false, reason: "invisible" })
    expect(SkillInvocation.identify("line\nbreak")).toEqual({ ok: false, reason: "invisible" })
    expect(SkillInvocation.identify("nul\x00byte")).toEqual({ ok: false, reason: "invisible" })
  })

  test("a name carrying a wildcard is refused — the permission rule would over-match", () => {
    expect(SkillInvocation.identify("pdf*")).toEqual({ ok: false, reason: "wildcard" })
    expect(SkillInvocation.identify("pdf?")).toEqual({ ok: false, reason: "wildcard" })
    // The reason this matters, proven against the matcher the engine actually uses rather than
    // asserted in a comment: a deny written for `pdf*` would refuse an unrelated skill.
    expect(Wildcard.match("pdfExfil", "pdf*")).toBe(true)
  })

  test("a name that is not NFC is refused rather than normalized", () => {
    // "e" + COMBINING ACUTE renders as "é" but is a different string from U+00E9.
    expect(SkillInvocation.identify("cafe\u0301")).toEqual({ ok: false, reason: "unnormalized" })
    expect(SkillInvocation.identify("caf\u00E9")).toEqual({ ok: true, id: "caf\u00E9" })
  })

  test("an empty or whitespace-only name has no key to write", () => {
    expect(SkillInvocation.identify("")).toEqual({ ok: false, reason: "empty" })
    expect(SkillInvocation.identify("   ")).toEqual({ ok: false, reason: "empty" })
  })

  test("a very long name is refused rather than truncated (truncation folds two names into one)", () => {
    const long = "a".repeat(SkillInvocation.MAX_ID_LENGTH + 1)
    expect(SkillInvocation.identify(long)).toEqual({ ok: false, reason: "too-long" })
    expect(SkillInvocation.idOf("a".repeat(SkillInvocation.MAX_ID_LENGTH))).toBe("a".repeat(SkillInvocation.MAX_ID_LENGTH))
    // Two long names that differ only past the bound must NOT collapse to one id.
    expect(SkillInvocation.idOf(long + "x")).toBeUndefined()
  })

  test("markup in a name is addressable — it is a display problem, not an identity one", () => {
    // Solid escapes it on screen; there is nothing about `<img …>` that breaks a settings key,
    // and refusing it would silently drop a real skill's controls.
    expect(SkillInvocation.idOf('<img src=x onerror="alert(1)">')).toBe('<img src=x onerror="alert(1)">')
  })
})

describe("showsToUser — the human's own list, ON by default", () => {
  test("no store at all shows everything", () => {
    expect(SkillInvocation.showsToUser(undefined, "pdf")).toBe(true)
    expect(SkillInvocation.showsToUser({}, "pdf")).toBe(true)
  })

  test("a saved false hides it; a saved true shows it", () => {
    expect(SkillInvocation.showsToUser({ pdf: { show: false } }, "pdf")).toBe(false)
    expect(SkillInvocation.showsToUser({ pdf: { show: true } }, "pdf")).toBe(true)
  })

  test("another skill's entry does not answer for this one", () => {
    expect(SkillInvocation.showsToUser({ other: { show: false } }, "pdf")).toBe(true)
  })

  test("a skill named __proto__ reads its OWN entry, never Object.prototype", () => {
    // `store["__proto__"]` on an ordinary object is a truthy object that nobody saved. `hasOwn`
    // is what makes this a real read rather than a coincidence.
    expect(SkillInvocation.showsToUser({}, "__proto__")).toBe(true)
    const store = JSON.parse('{"__proto__":{"show":false}}') as SkillInvocation.Store
    expect(SkillInvocation.showsToUser(store, "__proto__")).toBe(false)
  })

  test("a polluted Object.prototype cannot answer for a skill nobody saved", () => {
    // This is what `Object.hasOwn` is FOR, and without a test the guard is invisible: any code in
    // the process that writes `Object.prototype.show` would otherwise flip every skill in the
    // install off at once, through a store that contains nothing. Restored in `finally` so a
    // failure here cannot leak into the rest of the file.
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "show")
    try {
      Object.defineProperty(Object.prototype, "show", { value: false, configurable: true, writable: true })
      expect(SkillInvocation.showsToUser({}, "pdf")).toBe(true)
      expect(SkillInvocation.showsToUser({}, "__proto__")).toBe(true)
      expect(SkillInvocation.entry({}, "pdf")).toBeUndefined()
    } finally {
      if (descriptor) Object.defineProperty(Object.prototype, "show", descriptor)
      else delete (Object.prototype as Record<string, unknown>)["show"]
    }
  })

  test("an unaddressable name always falls back to the default", () => {
    expect(SkillInvocation.showsToUser({ [`bad${ZERO_WIDTH}`]: { show: false } }, `bad${ZERO_WIDTH}`)).toBe(true)
  })

  test("a malformed stored value is ignored rather than coerced", () => {
    const store = JSON.parse('{"pdf": "off"}') as SkillInvocation.Store
    expect(SkillInvocation.showsToUser(store, "pdf")).toBe(true)
  })
})

/**
 * The PRECEDENCE TABLE for "Show it for me to run": the instance store, then the shipped default.
 *
 * ⚠️ Every row also pins `by`, because principle 12(d) turns on it: a user who cannot tell whether
 * their own switch moved cannot fix it.
 */
describe("visibility — the instance store and the default", () => {
  const cases: readonly {
    readonly name: string
    readonly instance: SkillInvocation.Store | undefined
    readonly show: boolean
    readonly by: SkillInvocation.ShownBy
  }[] = [
    { name: "absent store", instance: undefined, show: true, by: "default" },
    { name: "empty store", instance: {}, show: true, by: "default" },
    { name: "the store hides it", instance: { pdf: { show: false } }, show: false, by: "instance" },
    { name: "the store shows it", instance: { pdf: { show: true } }, show: true, by: "instance" },
    { name: "the store names a DIFFERENT skill", instance: { docx: { show: false } }, show: true, by: "default" },
  ]

  for (const row of cases)
    test(row.name, () => {
      const seen = SkillInvocation.visibility(row.instance, "pdf")
      expect({ show: seen.show, by: seen.by }).toEqual({ show: row.show, by: row.by })
      expect(SkillInvocation.showsToUser(row.instance, "pdf")).toBe(row.show)
    })
})

describe("showWrite — a patch to set, the REMOVE verb to clear", () => {
  test("off is a merge patch", () => {
    expect(SkillInvocation.showWrite("pdf", false)).toEqual({ kind: "set", patch: { pdf: { show: false } } })
  })

  test("on is a PATH for the deletion verb, never a null in the patch", () => {
    // ⚠️ The live route answers 400 `Expected object, got null` for a `{pdf: null}` patch — v0.2.0
    // item 4.3 refused `null`-as-tombstone, so clearing is `POST /api/config/remove`.
    const write = SkillInvocation.showWrite("pdf", true)
    expect(write).toEqual({ kind: "clear", path: ["skill_invocation", "pdf"] })
    expect(JSON.stringify(write)).not.toContain("null")
  })

  test("the path names the same config key the reader reads", () => {
    expect(SkillInvocation.SECTION).toBe("skill_invocation")
    expect(SkillInvocation.clearPath("pdf")).toEqual(["skill_invocation", "pdf"])
  })

  test("an unaddressable name produces no write at all", () => {
    expect(SkillInvocation.showWrite(`bad${RTL_OVERRIDE}`, false)).toEqual({ kind: "unaddressable" })
    expect(SkillInvocation.showWrite(`bad${RTL_OVERRIDE}`, true)).toEqual({ kind: "unaddressable" })
  })

  test("a __proto__ key lands as an OWN property, not as a prototype", () => {
    const write = SkillInvocation.showWrite("__proto__", false)
    const patch = (write as { patch: Record<string, unknown> }).patch
    expect(Object.hasOwn(patch, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(patch)).toBe(Object.prototype)
  })

  test("segments are NOT dot-joined — a skill name routinely carries dots", () => {
    expect(SkillInvocation.showWrite("read.pdf.v2", true)).toEqual({
      kind: "clear",
      path: ["skill_invocation", "read.pdf.v2"],
    })
  })
})

describe("permissionRules — 'Nova may choose this' is one exact-name deny", () => {
  test("off appends a deny naming the skill exactly", () => {
    expect(SkillInvocation.permissionRules([], "pdf", false)).toEqual([
      { action: "skill", resource: "pdf", effect: "deny" },
    ])
  })

  test("on REMOVES our deny and never appends an allow", () => {
    const rules: SkillInvocation.Rule[] = [{ action: "skill", resource: "pdf", effect: "deny" }]
    expect(SkillInvocation.permissionRules(rules, "pdf", true)).toEqual([])
  })

  test("turning one skill on does not punch a hole in the operator's broad deny", () => {
    // The tempting implementation appends `{skill, pdf, allow}`. Because `evaluate` takes the LAST
    // match, that would override a deliberate blanket `skill: deny` — "let Nova use this one"
    // silently becoming "weaken the policy". Removing our own rule restores what the rest said.
    const rules: SkillInvocation.Rule[] = [
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "pdf", effect: "deny" },
    ]
    const next = SkillInvocation.permissionRules(rules, "pdf", true)
    expect(next).toEqual([{ action: "skill", resource: "*", effect: "deny" }])
    expect(next.some((rule) => rule.effect === "allow")).toBe(false)
  })

  test("unrelated rules and other actions survive untouched", () => {
    const rules: SkillInvocation.Rule[] = [
      { action: "bash", resource: "pdf", effect: "deny" },
      { action: "skill", resource: "other", effect: "deny" },
    ]
    expect(SkillInvocation.permissionRules(rules, "pdf", false)).toEqual([
      ...rules,
      { action: "skill", resource: "pdf", effect: "deny" },
    ])
  })

  test("flipping off then on returns the ruleset to where it started", () => {
    const start: SkillInvocation.Rule[] = [{ action: "read", resource: "*", effect: "allow" }]
    const off = SkillInvocation.permissionRules(start, "pdf", false)
    expect(SkillInvocation.permissionRules(off, "pdf", true)).toEqual(start)
  })

  test("an unaddressable name writes NOTHING rather than an over-broad rule", () => {
    expect(SkillInvocation.permissionRules([], "pdf*", false)).toEqual([])
    expect(SkillInvocation.deniedByName([{ action: "skill", resource: "pdf*", effect: "deny" }], "pdf*")).toBe(false)
  })

  test("deniedByName reads back exactly what permissionRules wrote", () => {
    expect(SkillInvocation.deniedByName(SkillInvocation.permissionRules([], "pdf", false), "pdf")).toBe(true)
    expect(SkillInvocation.deniedByName(SkillInvocation.permissionRules([], "pdf", true), "pdf")).toBe(false)
    // A broad deny is NOT our per-skill rule. It still denies the skill — `describeEnablement`
    // reports that — but this switch did not write it and must not claim to own it.
    expect(SkillInvocation.deniedByName([{ action: "skill", resource: "*", effect: "deny" }], "pdf")).toBe(false)
  })
})

describe("the two switches are independent — all four combinations", () => {
  // One skill, one ruleset, one store. Each case sets the two halves separately and asserts BOTH,
  // so a change that quietly ties them together fails here rather than in a screenshot.
  const cases: { nova: boolean; me: boolean; preset: SkillInvocation.Preset }[] = [
    { nova: true, me: true, preset: "everywhere" },
    { nova: false, me: true, preset: "only-when-i-choose" },
    { nova: true, me: false, preset: "only-nova" },
    { nova: false, me: false, preset: "nowhere" },
  ]

  for (const { nova, me, preset } of cases)
    test(`nova=${nova} me=${me} round-trips and names itself "${preset}"`, () => {
      const rules = SkillInvocation.permissionRules([], "pdf", nova)
      const write = SkillInvocation.showWrite("pdf", me)
      const store: SkillInvocation.Store = write.kind === "set" ? write.patch : {}
      expect(!SkillInvocation.deniedByName(rules, "pdf")).toBe(nova)
      expect(SkillInvocation.showsToUser(store, "pdf")).toBe(me)
      expect(SkillInvocation.presetOf({ nova, me })).toBe(preset)
    })

  test("changing one switch leaves the other exactly where it was", () => {
    // Start from the corner that a tri-state cannot express.
    let rules = SkillInvocation.permissionRules([], "pdf", true)
    let store: SkillInvocation.Store = { pdf: { show: false } }
    expect(SkillInvocation.presetOf({ nova: !SkillInvocation.deniedByName(rules, "pdf"), me: SkillInvocation.showsToUser(store, "pdf") })).toBe("only-nova")

    rules = SkillInvocation.permissionRules(rules, "pdf", false)
    expect(SkillInvocation.showsToUser(store, "pdf")).toBe(false)

    store = { pdf: { show: true } }
    expect(SkillInvocation.deniedByName(rules, "pdf")).toBe(true)
  })

  test("the preset is a WRITE of both halves, not a third state", () => {
    expect(SkillInvocation.ONLY_WHEN_I_CHOOSE).toEqual({ nova: false, me: true })
    expect(SkillInvocation.presetOf(SkillInvocation.ONLY_WHEN_I_CHOOSE)).toBe("only-when-i-choose")
    const rules = SkillInvocation.permissionRules([], "pdf", SkillInvocation.ONLY_WHEN_I_CHOOSE.nova)
    const write = SkillInvocation.showWrite("pdf", SkillInvocation.ONLY_WHEN_I_CHOOSE.me)
    expect(SkillInvocation.deniedByName(rules, "pdf")).toBe(true)
    expect(write).toEqual({ kind: "clear", path: ["skill_invocation", "pdf"] })
  })
})

describe("unresolved — a saved choice whose skill is not installed", () => {
  test("names the orphan and keeps the ones that resolve", () => {
    const store: SkillInvocation.Store = { pdf: { show: false }, "gone-skill": { show: false } }
    expect(SkillInvocation.unresolved(store, ["pdf", "other"])).toEqual(["gone-skill"])
  })

  test("nothing saved, nothing orphaned", () => {
    expect(SkillInvocation.unresolved(undefined, ["pdf"])).toEqual([])
    expect(SkillInvocation.unresolved({}, [])).toEqual([])
  })

  test("an orphan does NOT change what an installed skill does", () => {
    const store: SkillInvocation.Store = { "gone-skill": { show: false } }
    expect(SkillInvocation.showsToUser(store, "pdf")).toBe(true)
  })

  test("a skill whose name became unaddressable counts as unresolved rather than silently matching", () => {
    const store: SkillInvocation.Store = { pdf: { show: false } }
    expect(SkillInvocation.unresolved(store, [`pd${ZERO_WIDTH}f`])).toEqual(["pdf"])
  })

  test("orphans are listed in a stable order", () => {
    const store: SkillInvocation.Store = { zebra: { show: false }, alpha: { show: false } }
    expect(SkillInvocation.unresolved(store, [])).toEqual(["alpha", "zebra"])
  })
})
